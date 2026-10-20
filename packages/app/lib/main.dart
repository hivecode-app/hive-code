import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'data/auth_client.dart';
import 'data/backend.dart';
import 'data/backend_select.dart';
import 'data/hq_backend.dart';
import 'data/store.dart';
import 'native/badge.dart';
import 'native/native_bridge.dart';
import 'native/native_glue.dart';
import 'native/window_focus.dart';
import 'theme/theme.dart';
import 'theme/tokens.dart';
import 'ui/auth/sign_in_screen.dart';
import 'ui/convs/conversations_screen.dart';
import 'ui/nav.dart';
import 'ui/shell.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(AuthGate(initial: await selectBackend(), hqUrl: gatewayUrl()));
}

/// Sign-in or the app (#23). A device without a token signs in; a device whose token hq refuses
/// (revoked in settings → devices) forgets it and comes back here.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key, required this.initial, required this.hqUrl, this.client});

  /// null: sign in first.
  final Backend? initial;
  final String hqUrl;

  /// Tests pass one with a fake HTTP client and passkeys.
  final AuthClient? client;

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  late final client = widget.client ?? AuthClient(widget.hqUrl);
  AppStore? store;
  String? note;

  @override
  void initState() {
    super.initState();
    kSignOut = (note) {
      if (mounted && store != null) _signOut(note);
    };
    if (widget.initial != null) _open(widget.initial!);
  }

  void _open(Backend b) {
    final s = AppStore(b);
    b.addListener(_watch);
    s.start();
    store = s;
  }

  void _watch() {
    final b = store?.backend;
    if (b is HqBackend && b.unauthorized) _signOut();
  }

  Future<void> _signOut([String note = 'המכשיר הזה נותק מהחברה. אפשר להיכנס שוב.']) async {
    final s = store!;
    s.backend.removeListener(_watch);
    setState(() {
      store = null;
      this.note = note;
    });
    await clearSession();
    await NativeBridge.instance.clearConfig();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      s.dispose();
      s.backend.dispose();
    });
  }

  Future<void> _signedIn(Session session) async {
    try {
      await saveSession(session);
    } catch (e) {
      // Still open with the token in hand (#52: a broken prefs plugin used to drop the owner
      // back on sign-in with no word); only the next cold start will ask again.
      debugPrint('saveSession failed: $e');
    }
    if (!mounted) return;
    setState(() => _open(HqBackend(baseUrl: session.baseUrl, token: session.token)));
  }

  @override
  void dispose() {
    kSignOut = null;
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
    if (s != null) return CompanyApp(key: ObjectKey(s), store: s);
    return _Frame(
      home: SignInScreen(
        client: client,
        note: note,
        pairCode: note == null ? pairCodeFromUrl() : null, // after a sign-out the link's code is spent
        onSignedIn: _signedIn,
      ),
    );
  }
}

/// MaterialApp with the app's theme and locale, for the sign-in screen.
class _Frame extends StatelessWidget {
  const _Frame({required this.home});
  final Widget home;
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'החברה',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Palette.light),
        darkTheme: buildTheme(Palette.darkPalette),
        locale: const Locale('he'),
        supportedLocales: const [Locale('he')],
        localizationsDelegates: const [
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
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
    // An open conversation is read, and doesn't alert, only while the app is in front and has focus: a desktop
    // window left open behind another one (inactive) must not read his messages or keep them from alerting.
    // The lifecycle only hears changes and, on the web, can miss the first focus: start from the truth and
    // follow the window's own focus events too (window_focus.dart).
    // The app going away while the chats screen is in front ends his visit there ("מאז שהיית פה").
    var shown = windowFocused();
    void sync() {
      final now = windowFocused();
      if (shown && !now && (nav.wide || nav.tab == AppTab.chats)) widget.store.markChatsSeen(ConversationsScreen.clock());
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
        child: MaterialApp(
          navigatorKey: navigatorKey,
          title: 'החברה',
          debugShowCheckedModeBanner: false,
          theme: buildTheme(Palette.light),
          darkTheme: buildTheme(Palette.darkPalette),
          themeMode: widget.themeMode,
          locale: const Locale('he'),
          supportedLocales: const [Locale('he')],
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          builder: (context, child) {
            // Android font size is honoured up to 130% (APP-SPEC §7.3).
            final mq = MediaQuery.of(context);
            final scale = mq.textScaler.clamp(maxScaleFactor: 1.3);
            return MediaQuery(data: mq.copyWith(textScaler: scale), child: child!);
          },
          home: widget.home ?? const StoreGate(child: Shell()),
        ),
      ),
    );
  }
}
