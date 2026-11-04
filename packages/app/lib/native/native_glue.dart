// Glue between the Android layer (native_bridge.dart) and the app: routes from notifications,
// bubbles and the widget; the launcher badge = things waiting for you (APP-SPEC §5.6); and the
// share target ("שתף אל… ← עובד", chat.md §3); the in-app update (app_update.dart). No-ops on the web.
import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/backend_select.dart';
import '../data/store.dart';
import '../l10n/app_localizations.dart';
import '../ui/media/share_review.dart';
import '../model/models.dart';
import '../ui/chat/chat_screen.dart';
import '../ui/decisions/decisions_screen.dart' show DecisionStack, openDecisions;
import '../ui/nav.dart';
import 'app_update.dart';
import 'native_bridge.dart';

/// The running app's glue (settings and the system strip read it).
NativeGlue? kGlue;

class NativeGlue {
  NativeGlue(this.store, this.navigatorKey);
  final AppStore store;
  final GlobalKey<NavigatorState> navigatorKey;
  final _subs = <StreamSubscription>[];
  int? _lastCount;

  /// Whether Android notifications are allowed; drives the "ההתראות כבויות" strip (§4.1).
  final notificationsOff = ValueNotifier<bool>(false);

  /// A newer APK on hq; drives the update strip (§4.1).
  final update = AppUpdate();
  AppLifecycleListener? _life;

  Future<void> start() async {
    final b = NativeBridge.instance;
    if (!b.supported) return;
    store.addListener(_syncCount);
    _subs.add(b.routeStream.listen(open));
    _subs.add(b.onShared.listen(_share));
    notificationsOff.value = !(await b.notificationsEnabled());
    await syncConfig();
    unawaited(update.check(force: true));
    _life = AppLifecycleListener(onResume: () => unawaited(update.resumed()));
    // Cold start from a notification or a share: wait for the first frame, then go there.
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final r = await b.getInitialRoute();
      if (r != null) open(r);
      final s = await b.getSharedPayload();
      if (s != null) _share(s);
    });
  }

  /// Hands the hq address and this device's token to the native side, so notifications, the
  /// widget and the tiles work without Flutter running. Not signed in: native is
  /// cleared. Only calls configure when native is unconfigured or holds something else. Call it
  /// again after settings change.
  Future<void> syncConfig() async {
    final b = NativeBridge.instance;
    if (!b.supported) return;
    try {
      final p = await SharedPreferences.getInstance();
      final url = (p.getString(kHqUrl) ?? '').trim();
      final token = (p.getString(kHqToken) ?? '').trim();
      // Signed out: native stays unconfigured, so nothing is posted.
      if (url.isEmpty || token.isEmpty) {
        if (await b.getConfig() != null) await b.clearConfig();
        return;
      }
      final current = await b.getConfig();
      if (current?.baseUrl == url && current?.token == token) return;
      await b.configure(baseUrl: url, token: token);
      // Just signed in (or moved server): ask that hq about a newer version now.
      unawaited(update.check(force: true));
    } on PlatformException {
      // A malformed URL in settings: native keeps what it had; the settings screen shows the error.
    }
  }

  void dispose() {
    _life?.dispose();
    update.dispose();
    store.removeListener(_syncCount);
    for (final s in _subs) {
      s.cancel();
    }
  }

  void _syncCount() {
    final n = store.data?.waitingCount;
    if (n == null || n == _lastCount) return;
    _lastCount = n;
    NativeBridge.instance.setWaitingCount(n);
  }

  BuildContext? get _ctx => navigatorKey.currentContext;

  /// `/wait/<inboxId>`, `/chat/<identityId>`, `/handoff/<inboxId>`, `/`.
  void open(String route) {
    final ctx = _ctx;
    if (ctx == null) return;
    final parts = Uri.parse(route).pathSegments;
    if (parts.length == 2 && parts[0] == 'wait') {
      // A notification of a question or a GO: that item, on top of the pile (task 986), not a conversation that may be empty.
      if (!DecisionStack.shown) navigatorKey.currentState!.popUntil((r) => r.isFirst);
      final open = navigatorKey.currentContext ?? ctx;
      final w = store.data?.waiting.where((w) => '${w.inboxId}' == parts[1]).firstOrNull;
      if (w != null && w.kind == WaitKind.login) return Nav.handoff(open, w);
      openDecisions(open, at: 'inbox:${parts[1]}');
    } else if (parts.length == 2 && parts[0] == 'chat' && parts[1] == kSystemId) {
      // A notification from the system: what waits for him, not a conversation that doesn't exist (#55).
      navigatorKey.currentState!.popUntil((r) => r.isFirst);
      if ((store.data?.waitingCount ?? 0) > 0) {
        openDecisions(navigatorKey.currentContext ?? ctx);
      } else {
        NavScope.read(ctx).go(AppTab.chats);
      }
    } else if (parts.length == 2 && parts[0] == 'chat') {
      navigatorKey.currentState!.popUntil((r) => r.isFirst);
      Nav.chat(ctx, parts[1]);
    } else if (parts.length == 2 && parts[0] == 'handoff') {
      final w =
          store.data?.waiting.where((w) => '${w.inboxId}' == parts[1] || w.id == parts[1] || (w.kind == WaitKind.login && w.from == parts[1])).firstOrNull ??
          store.data?.waiting.where((w) => w.kind == WaitKind.login).firstOrNull;
      if (w != null) Nav.handoff(ctx, w);
    } else {
      navigatorKey.currentState!.popUntil((r) => r.isFirst);
      NavScope.read(ctx).go(AppTab.chats);
    }
  }

  Future<void> _share(SharedPayload s) async {
    final ctx = _ctx;
    final d = store.data;
    if (ctx == null || d == null) return;
    final l = AppLocalizations.of(ctx);
    final to = await showModalBottomSheet<String>(
      context: ctx,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => ShareReview(payload: s, store: store),
    );
    if (to == null) return;
    if (s.text?.isNotEmpty == true) {
      final current = d.chats[to]?.draft ?? '';
      store.setDraft(to, current.isEmpty ? s.text! : '$current\n${s.text}');
    }
    final files = [...s.files, if (s.imagePath != null) SharedFile(path: s.imagePath!, name: s.imagePath!.split('/').last, mime: 'application/octet-stream', bytes: 0)];
    for (final file in files) {
      try {
        final f = XFile(file.path), size = await XFile(file.path).length();
        if (size > maxImageBytes) {
          store.notice(l.mediaTooLarge(file.name));
          store.touch();
          continue;
        }
        final prefix = BytesBuilder(copy: false);
        await for (final part in f.openRead(0, size.clamp(0, 8192))) {
          prefix.add(part);
        }
        await store.addImage(
          to,
          Attachment(name: file.name, bytes: size, mime: imageMime(prefix.takeBytes()) ?? file.mime, meta: const {'app_source': 'share', 'app_original': true}),
          sourcePath: file.path,
        );
      } catch (_) {
        store.notice(l.mediaReadFailed(file.name));
        store.touch();
      }
    }
    ChatScreen.pendingQuote[to] = null;
    if (_ctx != null) Nav.chat(_ctx!, to, focus: true);
  }
}
