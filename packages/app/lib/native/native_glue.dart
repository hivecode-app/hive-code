// Glue between the Android layer (native_bridge.dart) and the app: routes from notifications,
// bubbles and the widget; the launcher badge = things waiting for you (APP-SPEC §5.6); and the
// share target ("שתף אל… ← עובד", chat.md §3). No-ops on the web.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/backend_select.dart';
import '../data/store.dart';
import '../model/models.dart';
import '../theme/tokens.dart';
import '../ui/chat/chat_screen.dart';
import '../ui/common.dart';
import '../ui/nav.dart';
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

  Future<void> start() async {
    final b = NativeBridge.instance;
    if (!b.supported) return;
    store.addListener(_syncCount);
    _subs.add(b.routeStream.listen(open));
    _subs.add(b.onShared.listen(_share));
    notificationsOff.value = !(await b.notificationsEnabled());
    await syncConfig();
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
    } on PlatformException {
      // A malformed URL in settings: native keeps what it had; the settings screen shows the error.
    }
  }

  void dispose() {
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

  /// `/chat/<identityId>`, `/handoff/<inboxId>`, `/`.
  void open(String route) {
    final ctx = _ctx;
    if (ctx == null) return;
    final parts = Uri.parse(route).pathSegments;
    if (parts.length == 2 && parts[0] == 'chat') {
      navigatorKey.currentState!.popUntil((r) => r.isFirst);
      Nav.chat(ctx, parts[1]);
    } else if (parts.length == 2 && parts[0] == 'handoff') {
      final w = store.data?.waiting.where((w) => '${w.inboxId}' == parts[1] || w.id == parts[1] || (w.kind == WaitKind.login && w.from == parts[1])).firstOrNull ??
          store.data?.waiting.where((w) => w.kind == WaitKind.login).firstOrNull;
      if (w != null) Nav.handoff(ctx, w);
    } else {
      navigatorKey.currentState!.popUntil((r) => r.isFirst);
      NavScope.read(ctx).go(AppTab.home);
    }
  }

  Future<void> _share(SharedPayload s) async {
    final ctx = _ctx;
    final d = store.data;
    if (ctx == null || d == null) return;
    var to = s.identityId;
    // Picker: Yoav first, then the recent conversations (chat.md §3 share target).
    to ??= await showModalBottomSheet<String>(
      context: ctx,
      backgroundColor: ctx.p.bg,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('שליחה אל', style: T.name.copyWith(color: c.p.text))),
          for (final conv in [...d.conversations.where((x) => x.pinned), ...d.conversations.where((x) => !x.pinned)])
            ListTile(
              leading: Monogram.of(d, conv.identityId, size: AvSize.sm),
              title: Text('${d.who(conv.identityId).name} · ${d.who(conv.identityId).title}', style: T.row2.copyWith(color: c.p.text)),
              onTap: () => Navigator.pop(c, conv.identityId),
            ),
        ]),
      ),
    );
    if (to == null) return;
    if (s.text != null && s.text!.isNotEmpty) {
      final chat = d.chats[to];
      final draft = chat == null || chat.draft.isEmpty ? s.text! : '${chat.draft}\n${s.text}';
      store.setDraft(to, draft);
    }
    if (s.imagePath != null) {
      store.error = 'התמונה נשמרה במכשיר. שליחת תמונות תעבוד כשהשרת יקבל העלאות.';
      store.touch();
    }
    ChatScreen.pendingQuote[to] = null;
    if (_ctx != null) Nav.chat(_ctx!, to, focus: true);
  }
}
