import 'ui/onboarding/setup.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'l10n/ui_copy.dart';
import 'l10n/app_localizations.dart';
import 'ui/product/shell.dart';
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'data/app_preferences.dart';
import 'data/auth_client.dart';
import 'data/backend.dart';
import 'data/backend_select.dart';
import 'data/error_report.dart';
import 'data/hq_backend.dart';
import 'data/store.dart';
import 'model/company_time.dart';
import 'native/badge.dart';
import 'native/native_bridge.dart';
import 'native/native_glue.dart';
import 'native/window_focus.dart';
import 'theme/theme.dart';
import 'theme/tokens.dart';
import 'ui/auth/sign_in_screen.dart';
import 'ui/nav.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // error-catcher: a crash in the app goes to hq like any error shown to him (error_report.dart).
  ErrorReports.instance.catchCrashes();
  unawaited(NativeBridge.instance.appVersionCode().then((v) {
    if (v != null) ErrorReports.instance.appVersion = 'android $v';
  }, onError: (_) {}));
  var locale = const Locale('en');
  try {
    final prefs = await SharedPreferences.getInstance();
    locale = Locale(startLanguage(prefs));
  } catch (_) { /* A first start can continue with English defaults. */ }
  runApp(AuthGate(locale: locale, initial: await selectBackend(), hqUrl: await initialServer(), pairLink: await NativeBridge.instance.getPairLink()));
}

/// Sign-in or the app (#23). A device without a token signs in; a device whose token hq refuses
/// (revoked in settings → devices) forgets it and comes back here. Switching servers (settings, or a
/// pairing link for another server) shows the sign-in screen while the current session stays, and
/// drops that session only once the new server let this device in.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key, required this.initial, required this.hqUrl, this.client, this.pairLink, this.askServer = !kIsWeb, this.locale = const Locale('en')});

  /// null: sign in first.
  final Backend? initial;
  final Locale locale;

  /// The server sign-in starts with ('' = none yet: the app asks for it).
  final String hqUrl;

  /// Tests pass one with a fake HTTP client and passkeys.
  final AuthClient? client;

  /// The pairing link the app was opened with (hq's pairing page → agentcompany://pair).
  final String? pairLink;

  /// The app asks for the server; the web build always uses its own origin.
  final bool askServer;

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late final client = widget.client ?? AuthClient(widget.hqUrl);
  AppStore? store;
  late String _language = widget.locale.languageCode;
  String? note;

  /// Shown instead of the app while switching servers; the session of [store] stays meanwhile.
  bool switching = false;
  bool starting = false;
  bool startupFailed = false;

  /// What the sign-in screen starts with: a server and maybe a code, from a link. [_screen] renews it.
  late ServerTarget? target = widget.pairLink == null ? null : parseServer(widget.pairLink!);
  int _screen = 0;
  StreamSubscription<String>? _links;

  @override
  void initState() {
    super.initState();
    kSignOut = (note) {
      if (mounted && store != null) _signOut(note);
    };
    kSwitchServer = ([link]) {
      if (mounted && store != null) _offer(link == null ? null : parseServer(link), always: true);
    };
    _links = NativeBridge.instance.onPairLink.listen((l) => _offer(parseServer(l)));
    if (widget.initial != null) {
      _open(widget.initial!);
      // Opened from a pairing link while signed in: for another server that is an offer to switch.
      if (target != null) {
        final t = target;
        target = null;
        _offer(t);
      }
    }
  }

  /// A pairing link (or "החלפת שרת"): the sign-in screen with it. While signed in to that same server
  /// a link changes nothing.
  void _offer(ServerTarget? t, {bool always = false}) {
    if (t == null && !always) return;
    final s = store;
    if (s != null && !always && s.backend.label == Uri.parse(t!.origin).host) return;
    setState(() {
      target = t;
      _screen++;
      if (s != null) switching = true;
    });
  }

  void _open(Backend b) {
    final s = AppStore(b);
    b.addListener(_watch);
    store = s;
    _startStore(s);
  }

  void _startStore(AppStore s) {
    starting = true;
    startupFailed = false;
    unawaited(s.start().catchError((Object error) {
      if (mounted && identical(store, s)) startupFailed = true;
    }).whenComplete(() {
      if (mounted && identical(store, s)) {
        setState(() { starting = false; _language = s.preferences.language; });
      }
    }));
  }

  void _watch() {
    final b = store?.backend;
    if (b is HqBackend && b.unauthorized) _signOut();
  }

  /// Closes the running app's store and backend (after the frame that stops showing them).
  void _close(AppStore s) {
    s.backend.removeListener(_watch);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      s.dispose();
      s.backend.dispose();
    });
  }

  Future<void> _signOut([String? note]) async {
    final s = store!;
    _language = s.preferences.language;
    setState(() {
      store = null;
      switching = false;
      this.note = note ?? lookupAppLocalizations(Locale(_language)).deviceRevoked;
    });
    _close(s);
    await clearSession();
    await NativeBridge.instance.clearConfig();
  }

  Future<void> _signedIn(Session session) async {
    final old = store;
    if (old != null) {
      // Switched: the old token is revoked where it lives (best effort, like "יציאה"; also when it was the
      // same server again), and its data goes.
      final prev = await savedSession();
      if (prev != null && prev.token != session.token) unawaited(_leave(prev));
      await clearSession();
    }
    try {
      await saveSession(session);
    } catch (e) {
      // Still open with the token in hand (#52: a broken prefs plugin used to drop the owner
      // back on sign-in with no word); only the next cold start will ask again.
      debugPrint('saveSession failed: $e');
    }
    if (!mounted) return;
    setState(() {
      if (old != null) _close(old);
      switching = false;
      note = null;
      _open(HqBackend(baseUrl: session.baseUrl, token: session.token));
    });
  }

  /// Revokes this device's token on a server it no longer uses.
  Future<void> _leave(Session s) async {
    final c = AuthClient.at(s.baseUrl, client);
    try {
      final me = (await c.devices(s.token)).devices.where((d) => d.current).firstOrNull;
      if (me != null) await c.revokeDevice(s.token, me.id);
    } on AuthFailure {
      // Offline: that server's devices screen can revoke it later.
    } finally {
      c.close();
    }
  }

  @override
  void dispose() {
    kSignOut = null;
    kSwitchServer = null;
    _links?.cancel();
    final s = store;
    if (s != null) {
      s.backend.removeListener(_watch);
      s.dispose();
      s.backend.dispose();
    }
    client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = store;
    if (s != null && !switching && startupFailed) {
      return _Frame(locale: Locale(s.preferences.language),
        home: Scaffold(body: Center(child: Builder(builder: (context) => Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(padding: const EdgeInsets.all(24), child: Text(UiCopy.copy.noConnectionServerAction)),
          FilledButton(onPressed: () => setState(() => _startStore(s)), child: Text(AppLocalizations.of(context).retry)),
        ])))));
    }
    if (s != null && !switching && !starting) return CompanyApp(key: ObjectKey(s), store: s);
    if (s != null && !switching && starting) return _Frame(locale: Locale(_language), home: const Scaffold(body: Center(child: CircularProgressIndicator())));
    return _Frame(
      locale: Locale(s?.preferences.language ?? _language),
      home: SignInScreen(
        key: ValueKey(_screen),
        client: client,
        note: note,
        askServer: widget.askServer,
        server: switching ? target?.origin : (target?.origin ?? widget.hqUrl),
        pairCode: target?.code ?? (note == null ? pairCodeFromUrl() : null), // after a sign-out the link's code is spent
        current: switching ? s?.backend.label : null,
        onCancel: switching ? () => setState(() => switching = false) : null,
        onSignedIn: _signedIn,
      ),
    );
  }
}

/// MaterialApp with the app's theme and locale, for the sign-in screen.
class _Frame extends StatelessWidget {
  const _Frame({required this.home, this.locale = const Locale('en')});
  final Locale locale;
  final Widget home;
  @override
  Widget build(BuildContext context) => MaterialApp(
        onGenerateTitle: (context) => AppLocalizations.of(context).productName,
        debugShowCheckedModeBanner: false,
        theme: buildTheme(productPalette(Brightness.light), product: true),
        darkTheme: buildTheme(productPalette(Brightness.dark), product: true),
        locale: locale,
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        builder: (context, child) { UiCopy.configure(locale.languageCode); return child!; },
        home: home,
      );
}

class CompanyApp extends StatefulWidget {
  const CompanyApp({super.key, required this.store, this.themeMode = ThemeMode.system, this.home});
  final AppStore store;

  /// Dark mode follows the device (owner decision, 20/10/2026). Tests pin it.
  final ThemeMode themeMode;
  final Widget? home;

  Backend get backend => store.backend;

  @override
  State<CompanyApp> createState() => _CompanyAppState();
}

class _CompanyAppState extends State<CompanyApp> {
  final nav = AppNav();
  final navigatorKey = GlobalKey<NavigatorState>();
  late final glue = NativeGlue(widget.store, navigatorKey);

  AppLifecycleListener? _life;
  void Function()? _offFocus;
  int? _badge;

  @override
  void initState() {
    super.initState();
    kGlue = glue;
    glue.start();
    // Where he was when an error showed: the tab, or on a desktop the conversation open in the main column.
    // In his words: hq writes it on the card ("שגיאה באפליקציה במסך שיחות").
    ErrorReports.instance.screenOf = () {
      if (!nav.wide) {
        final l = lookupAppLocalizations(Locale(widget.store.preferences.language));
        return switch (nav.tab) { AppTab.chats => l.chats, AppTab.tasks => l.tasks, AppTab.status => l.team };
      }
      final id = widget.store.selectedConversation;
      final name = id == null ? null : widget.store.data?.identities[id]?.name;
      return widget.store.homeOpen || name == null ? UiCopy.copy.home : UiCopy.copy.chat2(name);
    };
    // An open conversation is read, and doesn't alert, only while the app is in front and has focus: a desktop
    // window left open behind another one (inactive) must not read his messages or keep them from alerting.
    // The lifecycle only hears changes and, on the web, can miss the first focus: start from the truth and
    // follow the window's own focus events too (window_focus.dart).
    // The app going away while the chats screen is in front ends his visit there ("מאז שהיית פה").
    var shown = windowFocused();
    void sync() {
      final now = windowFocused();
      if (shown && !now && (nav.wide || nav.tab == AppTab.chats)) widget.store.markChatsSeen(CompanyTime.now());
      shown = now;
      widget.backend.setVisible(now);
    }
    _life = AppLifecycleListener(onStateChange: (_) => sync());
    _offFocus = onWindowFocusChange(sync);
    sync();
    widget.store.addListener(_syncBadge);
  }

  /// The icon's number on the web app: what waits for him plus what he hasn't read.
  void _syncBadge() {
    final d = widget.store.data;
    if (d == null) return;
    final n = d.waitingCount + d.unreadCount;
    if (n == _badge) return;
    _badge = n;
    setAppBadge(n);
  }

  @override
  void dispose() {
    _life?.dispose();
    _offFocus?.call();
    widget.store.removeListener(_syncBadge);
    glue.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StoreHost(
      store: widget.store,
      child: NavScope(
        nav: nav,
        child: ListenableBuilder(listenable: widget.store.preferences, builder: (context, _) => MaterialApp(
          navigatorKey: navigatorKey,
          onGenerateTitle: (context) => AppLocalizations.of(context).productName,
          debugShowCheckedModeBanner: false,
          theme: buildTheme(productPalette(Brightness.light), product: true),
          darkTheme: buildTheme(productPalette(Brightness.dark), product: true),
          themeMode: widget.themeMode == ThemeMode.system ? widget.store.preferences.themeMode : widget.themeMode,
          locale: Locale(widget.store.preferences.language),
          supportedLocales: AppLocalizations.supportedLocales,
          localizationsDelegates: const [
          AppLocalizations.delegate,
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          builder: (context, child) {
            UiCopy.configure(widget.store.preferences.language);
            final app = child!;
            // v2: the background a screen fades through between two screens (lib/theme/motion.dart).
            return kDesignV2 ? ColoredBox(color: Theme.of(context).scaffoldBackgroundColor, child: app) : app;
          },
          home: widget.home ?? StoreGate(child: widget.store.backend is HqBackend ? const SetupGate(child: ProductShell()) : const ProductShell()),
        )),
      ),
    );
  }
}
