// App state on top of a Backend: the 3-second undo on every one-tap answer (APP-SPEC §4.2),
// drafts that survive restarts, the durable outbox (§10.1), and the desktop selection.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../model/models.dart';
import 'backend.dart';

/// One answer waiting out its 3 seconds. The UI renders [label] in place of the buttons.
class PendingAnswer {
  PendingAnswer(this.key, this.to, this.isGo, this.secondsLeft, this.fire);
  final String key;
  final String to;
  final bool isGo;
  int secondsLeft;
  final Future<void> Function() fire;
  Timer? timer;

  String get label => isGo ? "GO יישלח ל$to בעוד $secondsLeft שנ'" : "יישלח ל$to בעוד $secondsLeft שנ'";
}

class AppStore extends ChangeNotifier {
  AppStore(this.backend, {this.undoSeconds = 3, SharedPreferences? prefs}) : _prefs = prefs { // ignore: prefer_initializing_formals
    backend.addListener(notifyListeners);
  }

  final Backend backend;
  final int undoSeconds;
  SharedPreferences? _prefs;

  CompanyData? get data => backend.data;
  SystemStatus get status => backend.status;

  final Map<String, PendingAnswer> _pending = {};
  PendingAnswer? pending(String key) => _pending[key];

  /// Desktop: which conversation is open in the main column.
  String? selectedConversation;

  /// Desktop selection with a default: the first conversation with something unread, else Yoav.
  String get currentConversation {
    final convs = data?.conversations ?? const [];
    return selectedConversation ?? (convs.where((c) => c.unread > 0).firstOrNull ?? convs.where((c) => c.pinned).firstOrNull ?? convs.firstOrNull)?.identityId ?? 'yoav';
  }

  /// Last error to show as a dismissable bar ("הבנתי"), never a self-hiding snackbar (design-taste E16).
  String? error;

  Future<void> start() async {
    try {
      _prefs ??= await SharedPreferences.getInstance();
    } catch (_) {
      // Tests without a mock store: drafts stay in memory.
    }
    await backend.start();
    _restoreDrafts();
  }

  @override
  void dispose() {
    for (final p in _pending.values) {
      p.timer?.cancel();
    }
    backend.removeListener(notifyListeners);
    super.dispose();
  }

  // ── 3s undo ──────────────────────────────────────────────────────────────

  void startUndo(String key, String to, Future<CommandResult> Function() action, {bool isGo = false}) {
    cancelUndo(key, notify: false);
    final p = PendingAnswer(key, to, isGo, undoSeconds, () async {
      final r = await action();
      if (!r.ok) error = r.error;
    });
    _pending[key] = p;
    p.timer = Timer.periodic(const Duration(seconds: 1), (t) {
      p.secondsLeft--;
      if (p.secondsLeft <= 0) {
        t.cancel();
        _pending.remove(key);
        p.fire().whenComplete(notifyListeners);
      }
      notifyListeners();
    });
    notifyListeners();
  }

  void cancelUndo(String key, {bool notify = true}) {
    _pending.remove(key)?.timer?.cancel();
    if (notify) notifyListeners();
  }

  String nameOf(String id) => data?.who(id).name ?? id;

  void answerWait(WaitItem item, AskOption option) {
    final to = nameOf(item.from);
    if (option.id == 'go') {
      startUndo(item.id, to, () async {
        final r = await backend.go(item);
        item.answerLine = item.doneLine ?? 'GO נשלח';
        return r;
      }, isGo: true);
    } else {
      startUndo(item.id, to, () async {
        final r = await backend.answerAsk(item.askId ?? item.id, option, from: item.from);
        item.answerLine = 'ענית: ${option.label} · $to ממשיך';
        return r;
      });
    }
  }

  void answerCard(AskCard card, AskOption option) {
    final to = nameOf(card.from);
    final key = 'card:${card.id}';
    if (option.id == 'go') {
      startUndo(key, to, () async {
        final w = data?.waiting.where((w) => w.askId == card.askId).firstOrNull;
        card.state = AskState.answered;
        card.answer = 'GO';
        if (w != null) return backend.go(w);
        return backend.answerAsk(card.askId ?? card.id, option);
      }, isGo: true);
    } else {
      startUndo(key, to, () async {
        card.state = AskState.answered;
        card.answer = option.label;
        return backend.answerAsk(card.askId ?? card.id, option, from: card.from);
      });
    }
  }

  Future<void> notNow(WaitItem item) async => _check(await backend.notNow(item));

  Future<void> _check(CommandResult r) async {
    if (!r.ok) {
      error = r.error;
      notifyListeners();
    }
  }

  /// Local UI-only change (e.g. an undo of "לא עכשיו") that screens must redraw for.
  void touch() => notifyListeners();

  void clearError() {
    error = null;
    notifyListeners();
  }

  // ── messages ─────────────────────────────────────────────────────────────

  int _n = 0;

  Future<UserMsg> send(String identityId, String text, Priority priority, {Quote? quote}) async {
    final msg = UserMsg(
      id: 'm-${DateTime.now().millisecondsSinceEpoch}-${_n++}',
      ts: DateTime.now(),
      text: text,
      priority: priority,
      replyTo: quote,
      delivery: Delivery.queued,
    );
    setDraft(identityId, '');
    final online = status.state == LinkState.online || status.state == LinkState.demo || status.state == LinkState.reconnected;
    if (!online) {
      // Durable outbox: shown with a clock and "ממתינה לחיבור" until the link is back.
      msg.delivery = Delivery.pendingConnection;
      data?.chats[identityId]?.items.add(msg);
      _saveOutbox(identityId, msg);
      notifyListeners();
      return msg;
    }
    final r = await backend.send(identityId, msg);
    if (!r.ok) {
      msg.delivery = Delivery.failed;
      error = r.error;
    }
    notifyListeners();
    return msg;
  }

  /// "משיכה חזרה": the text goes back to the composer (chat.md §2.1).
  Future<String?> retract(String identityId, UserMsg msg) async {
    final r = await backend.retract(identityId, msg.id);
    if (!r.ok) {
      error = r.error;
      notifyListeners();
      return null;
    }
    setDraft(identityId, msg.text);
    return msg.text;
  }

  Future<void> stop(String identityId) async => _check(await backend.stop(identityId));

  Future<void> toggleAutomation(Automation a) async {
    final on = !a.enabled;
    final now = DateTime.now();
    final hm = '${now.hour.toString().padLeft(2, '0')}:${now.minute.toString().padLeft(2, '0')}';
    if (!on) {
      a.prevMeta = a.meta;
      a.meta = 'כובתה ידנית · $hm';
    } else {
      a.meta = a.prevMeta ?? 'הודלקה · $hm';
    }
    a.enabled = on;
    notifyListeners();
    final r = await backend.setAutomation(a.key, on);
    if (!r.ok) {
      a.enabled = !on;
      error = r.error;
      notifyListeners();
    }
  }

  Future<void> toggleFocus() async {
    final d = data;
    if (d == null) return;
    _check(await backend.setFocus(!d.focus));
  }

  // ── drafts and outbox, persisted ─────────────────────────────────────────

  void setDraft(String identityId, String text) {
    final c = data?.chats[identityId];
    if (c == null) return;
    c.draft = text;
    _prefs?.setString('draft:$identityId', text);
  }

  void _restoreDrafts() {
    final p = _prefs;
    final d = data;
    if (p == null || d == null) return;
    for (final c in d.chats.values) {
      final saved = p.getString('draft:${c.identityId}');
      if (saved != null) c.draft = saved;
    }
    final raw = p.getString('outbox');
    if (raw != null) {
      for (final e in (jsonDecode(raw) as List).cast<Map<String, dynamic>>()) {
        final c = d.chats[e['to']];
        if (c == null || c.items.any((i) => i.id == e['id'])) continue;
        c.items.add(UserMsg(id: e['id'], ts: DateTime.fromMillisecondsSinceEpoch(e['ts']), text: e['text'], delivery: Delivery.pendingConnection));
      }
    }
    notifyListeners();
  }

  void _saveOutbox(String to, UserMsg m) {
    final p = _prefs;
    if (p == null) return;
    final list = (jsonDecode(p.getString('outbox') ?? '[]') as List).cast<Map<String, dynamic>>();
    list.add({'to': to, 'id': m.id, 'ts': m.ts.millisecondsSinceEpoch, 'text': m.text});
    p.setString('outbox', jsonEncode(list));
  }

  /// Called when the link comes back: flush the outbox in order.
  Future<void> flushOutbox() async {
    final d = data;
    if (d == null) return;
    for (final c in d.chats.values) {
      for (final m in c.items.whereType<UserMsg>().where((m) => m.delivery == Delivery.pendingConnection).toList()) {
        c.items.remove(m);
        final r = await backend.send(c.identityId, m);
        if (!r.ok) m.delivery = Delivery.failed;
      }
    }
    _prefs?.remove('outbox');
    notifyListeners();
  }
}

class StoreScope extends InheritedNotifier<AppStore> {
  const StoreScope({super.key, required AppStore store, required super.child}) : super(notifier: store);

  static AppStore of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<StoreScope>()!.notifier!;
  static AppStore read(BuildContext context) => context.getInheritedWidgetOfExactType<StoreScope>()!.notifier!;
}
