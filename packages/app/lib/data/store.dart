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
  PendingAnswer(this.key, this.to, this.isGo, this.secondsLeft, this.fire, [this.text]);
  final String key;
  final String to;
  final bool isGo;
  int secondsLeft;
  final Future<void> Function() fire;
  Timer? timer;

  /// Its own line instead of "יישלח ל…" (closing a card: "ייסגר בעוד 3 שנ'").
  final String Function(int secondsLeft)? text;

  String get label => text != null ? text!(secondsLeft) : isGo ? "GO יישלח ${toName(to)} בעוד $secondsLeft שנ'" : "יישלח ${toName(to)} בעוד $secondsLeft שנ'";
}

/// How the conversation list is ordered. [recent] is the data's order (newest message first).
enum ConvSort { recent, working, waiting, name }

class AppStore extends ChangeNotifier {
  AppStore(this.backend, {this.undoSeconds = 3, SharedPreferences? prefs}) : _prefs = prefs { // ignore: prefer_initializing_formals
    backend.addListener(_onBackend);
  }

  bool _wasOnline = false;

  /// Redraw, and when the link comes back, send what waited for it (§10.1). Without this the
  /// outbox was never flushed and a message stayed "ממתינה לחיבור" for good (#55).
  void _onBackend() {
    if (_disposed) return;
    final on = _online;
    if (on && !_wasOnline) unawaited(flushOutbox());
    _wasOnline = on;
    notifyListeners();
  }

  bool get _online => status.state == LinkState.online || status.state == LinkState.demo || status.state == LinkState.reconnected;

  final Backend backend;
  final int undoSeconds;
  SharedPreferences? _prefs;

  CompanyData? get data => backend.data;
  SystemStatus get status => backend.status;

  final Map<String, PendingAnswer> _pending = {};
  PendingAnswer? pending(String key) => _pending[key];

  /// Desktop: which conversation is open in the main column.
  String? selectedConversation;

  /// Desktop selection with a default: the first conversation with something unread (not muted), else Yoav.
  /// The default sticks once data is in: opening it reads it, and the selection must not then jump to the next unread one.
  String get currentConversation {
    final convs = data?.conversations ?? const [];
    final pick = selectedConversation ??
        (convs.where((c) => c.unread > 0 && !c.muted).firstOrNull ?? convs.where((c) => c.pinned).firstOrNull ?? convs.firstOrNull)?.identityId;
    if (pick != null && data != null) selectedConversation = pick;
    return pick ?? 'yoav';
  }

  /// Last error to show as a dismissable bar ("הבנתי"), never a self-hiding snackbar (design-taste E16).
  String? error;

  Future<void> start() async {
    try {
      _prefs ??= await SharedPreferences.getInstance();
    } catch (_) {
      // Tests without a mock store: drafts stay in memory.
    }
    _convSort = ConvSort.values.asNameMap()[_prefs?.getString(kConvSortKey)] ?? ConvSort.recent;
    final seen = _prefs?.getInt(kStatusSeenKey);
    statusSeenAt ??= seen == null ? null : DateTime.fromMillisecondsSinceEpoch(seen);
    await backend.start();
    _restoreDrafts();
    if (_online) unawaited(flushOutbox()); // came up online: what waited from last time goes now
  }

  @override
  void dispose() {
    _disposed = true;
    for (final p in _pending.values) {
      p.timer?.cancel();
    }
    backend.removeListener(_onBackend);
    super.dispose();
  }

  // ── 3s undo ──────────────────────────────────────────────────────────────

  void startUndo(String key, String to, Future<CommandResult> Function() action, {bool isGo = false, String Function(int)? text}) {
    cancelUndo(key, notify: false);
    final p = PendingAnswer(key, to, isGo, undoSeconds, () async {
      final r = await action();
      if (!r.ok) error = r.error;
    }, text);
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
  Future<void> resume(WaitItem item) async => _check(await backend.resume(item));
  /// Closing is for good and wakes the worker: it waits the same 3 seconds as any one-tap answer.
  void dismiss(WaitItem item) =>
      startUndo(item.id, nameOf(item.from), () => backend.dismiss(item), text: (s) => "ייסגר בעוד $s שנ'");

  Future<void> _check(CommandResult r) async {
    if (!r.ok) {
      error = r.error;
      notifyListeners();
    }
  }

  /// Local UI-only change (e.g. an undo of "לא עכשיו") that screens must redraw for. A no-op once
  /// disposed (a chat leaving the screen during sign-out asks for one).
  void touch() {
    if (!_disposed) notifyListeners();
  }

  bool _disposed = false;

  void clearError() {
    error = null;
    notifyListeners();
  }

  // ── messages ─────────────────────────────────────────────────────────────

  int _n = 0;

  // ── images waiting in the composer (WhatsApp: a preview, removable, sent with the next message) ──

  /// At most this many per message, like hq (mailbox.ts).
  static const maxImages = 10;

  final Map<String, List<Attachment>> _images = {};
  List<Attachment> images(String identityId) => _images[identityId] ?? const [];

  void addImage(String identityId, Attachment a) {
    final list = _images.putIfAbsent(identityId, () => []);
    if (list.length >= maxImages) {
      error = 'אפשר לצרף עד $maxImages תמונות להודעה אחת.';
    } else {
      list.add(a);
    }
    notifyListeners();
  }

  void removeImage(String identityId, Attachment a) {
    _images[identityId]?.remove(a);
    notifyListeners();
  }

  Future<UserMsg> send(String identityId, String text, Priority priority, {Quote? quote, List<Attachment> attachments = const []}) async {
    final msg = UserMsg(
      id: 'm-${DateTime.now().millisecondsSinceEpoch}-${_n++}',
      ts: DateTime.now(),
      text: text,
      priority: priority,
      replyTo: quote,
      delivery: Delivery.queued,
      attachments: [...attachments],
    );
    setDraft(identityId, '');
    if (quote?.askId != null) return _answer(identityId, msg, quote!.askId!);
    if (!_online && attachments.isNotEmpty) {
      // The outbox keeps text only: an image waits on screen as "לא נמסר", with "ניסיון נוסף".
      msg.delivery = Delivery.failed;
      data?.chats[identityId]?.items.add(msg);
      error = 'אין חיבור לשרת, ולכן התמונה לא נשלחה. אפשר לנסות שוב כשהחיבור יחזור.';
      notifyListeners();
      return msg;
    }
    if (!_online) {
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

  /// A reply that quotes a question answers it. Never queued: an answer to a question that may be
  /// gone by then needs a yes or no now, and a refusal says why (#55).
  Future<UserMsg> _answer(String identityId, UserMsg msg, String askId) async {
    final chat = data?.chats[identityId];
    chat?.items.add(msg);
    notifyListeners();
    final r = await backend.freeAnswer(askId, msg.text, attachments: msg.attachments);
    if (r.ok) {
      msg.delivery = Delivery.delivered;
      final said = msg.text.isEmpty && msg.attachments.isNotEmpty ? 'תמונה' : msg.text;
      for (final c in chat?.items.whereType<AskCard>() ?? const <AskCard>[]) {
        if (c.askId == askId) {
          c.state = AskState.answered;
          c.answer = said;
        }
      }
      for (final w in data?.waiting.where((w) => w.askId == askId) ?? const <WaitItem>[]) {
        w.state = WaitState.answered;
        w.answerLine = 'ענית: $said';
      }
    } else {
      msg.delivery = Delivery.failed;
      error = r.error;
    }
    notifyListeners();
    return msg;
  }

  /// Free text typed as the answer to [item] (home row, or a question without options).
  Future<CommandResult> answerText(WaitItem item, String text) async {
    final askId = item.askId;
    if (askId == null) return const CommandResult.fail('לפריט הזה אין שאלה לענות עליה.');
    final r = await backend.freeAnswer(askId, text);
    if (r.ok) {
      item.state = WaitState.answered;
      item.answerLine = 'ענית: $text';
    } else {
      error = r.error;
    }
    notifyListeners();
    return r;
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

  Future<void> mute(String identityId, MuteFor duration) async {
    _check(await backend.mute(identityId, duration));
    notifyListeners();
  }

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

  // ── conversation list order, kept on this device ─────────────────────────

  static const kConvSortKey = 'convs.sort';
  ConvSort _convSort = ConvSort.recent;
  ConvSort get convSort => _convSort;

  void setConvSort(ConvSort s) {
    if (s == _convSort) return;
    _convSort = s;
    _prefs?.setString(kConvSortKey, s.name);
    notifyListeners();
  }

  // ── the status screen's "since your last visit", kept on this device ─────

  static const kStatusSeenKey = 'status.seen';

  /// When he last left the status screen: what finished after it is "מאז הביקור הקודם".
  DateTime? statusSeenAt;

  void markStatusSeen([DateTime? at]) {
    statusSeenAt = at ?? DateTime.now();
    _prefs?.setInt(kStatusSeenKey, statusSeenAt!.millisecondsSinceEpoch);
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
        c.items.add(UserMsg(id: e['id'], ts: DateTime.fromMillisecondsSinceEpoch(e['ts']), text: e['text'], priority: Priority.values.asNameMap()[e['priority']] ?? Priority.next, delivery: Delivery.pendingConnection));
      }
    }
    notifyListeners();
  }

  void _saveOutbox(String to, UserMsg m) {
    final p = _prefs;
    if (p == null) return;
    final list = (jsonDecode(p.getString('outbox') ?? '[]') as List).cast<Map<String, dynamic>>();
    list.add({'to': to, 'id': m.id, 'ts': m.ts.millisecondsSinceEpoch, 'text': m.text, 'priority': m.priority.name});
    p.setString('outbox', jsonEncode(list));
  }

  bool _flushing = false;

  /// The saved outbox = what still waits in memory, plus entries for conversations not loaded yet.
  void _rewriteOutbox(CompanyData d) {
    final p = _prefs;
    if (p == null) return;
    final kept = (jsonDecode(p.getString('outbox') ?? '[]') as List).cast<Map<String, dynamic>>().where((e) => !d.chats.containsKey(e['to']));
    final waiting = [
      for (final c in d.chats.values)
        for (final m in c.items.whereType<UserMsg>().where((m) => m.delivery == Delivery.pendingConnection))
          {'to': c.identityId, 'id': m.id, 'ts': m.ts.millisecondsSinceEpoch, 'text': m.text, 'priority': m.priority.name},
    ];
    final all = [...kept, ...waiting];
    if (all.isEmpty) {
      p.remove('outbox');
    } else {
      p.setString('outbox', jsonEncode(all));
    }
  }

  /// Called when the link comes back: flush the outbox in order. A message the server refuses is
  /// marked failed with the reason on screen, never left waiting for a link that is already up.
  Future<void> flushOutbox() async {
    final d = data;
    if (d == null || _flushing) return;
    _flushing = true;
    try {
      for (final c in d.chats.values.toList()) {
        for (final m in c.items.whereType<UserMsg>().where((m) => m.delivery == Delivery.pendingConnection).toList()) {
          c.items.remove(m);
          final r = await backend.send(c.identityId, m);
          if (!r.ok) {
            // The link went down mid-flush: it waits again. Up and still refused: failed, with why.
            m.delivery = _online ? Delivery.failed : Delivery.pendingConnection;
            if (!c.items.contains(m)) c.items.add(m);
            if (m.delivery == Delivery.failed) error = r.error;
          }
        }
      }
      _rewriteOutbox(d);
    } finally {
      _flushing = false;
    }
    notifyListeners();
  }
}

/// The store for everything below, with a version that ticks on every change. Widgets that call
/// [of] rebuild when the version they see changes.
class StoreScope extends InheritedWidget {
  const StoreScope({super.key, required this.store, required this.version, required super.child});
  final AppStore store;
  final int version;

  static AppStore of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<StoreScope>()!.store;
  static AppStore read(BuildContext context) => context.getInheritedWidgetOfExactType<StoreScope>()!.store;

  /// Null on screens that come before there is a store (sign-in, devices).
  static AppStore? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<StoreScope>()?.store;

  @override
  bool updateShouldNotify(StoreScope old) => old.version != version || old.store != store;
}

/// Root of the app: listens to the store and publishes a new version per change. Several changes in
/// one frame (a burst of WebSocket events, tokens) cost one rebuild.
class StoreHost extends StatefulWidget {
  const StoreHost({super.key, required this.store, required this.child});
  final AppStore store;
  final Widget child;
  @override
  State<StoreHost> createState() => _StoreHostState();
}

class _StoreHostState extends State<StoreHost> {
  int _version = 0;

  @override
  void initState() {
    super.initState();
    widget.store.addListener(_changed);
  }

  @override
  void didUpdateWidget(StoreHost old) {
    super.didUpdateWidget(old);
    if (old.store != widget.store) {
      old.store.removeListener(_changed);
      widget.store.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.store.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() => _version++);
  }

  @override
  Widget build(BuildContext context) => StoreScope(store: widget.store, version: _version, child: widget.child);
}

/// Holds store updates back from a part of the screen nobody can see: a tab that is not showing,
/// or the screen under a page (a chat) pushed over it. While it is hidden the widgets below keep the
/// version they last saw and do not rebuild; when it shows again they catch up in one rebuild.
/// Without it every streaming token rebuilt all four tabs under the open chat. Dialogs, menus and
/// sheets don't count as covering: what is behind them stays visible, so it stays live.
class StoreGate extends StatefulWidget {
  const StoreGate({super.key, this.active, required this.child});

  /// Null: active unless this widget's route is fully covered by another page.
  final bool? active;
  final Widget child;
  @override
  State<StoreGate> createState() => _StoreGateState();
}

class _StoreGateState extends State<StoreGate> {
  int? _shown;

  @override
  Widget build(BuildContext context) {
    final outer = context.dependOnInheritedWidgetOfExactType<StoreScope>()!;
    final active = widget.active ?? !_covered(ModalRoute.of(context));
    if (active || _shown == null) _shown = outer.version;
    return StoreScope(store: outer.store, version: _shown!, child: widget.child);
  }

  /// A page route pushed over ours runs our secondary animation to the end; a dialog, menu or
  /// sheet doesn't (they are not page transitions), so the screen behind them stays live.
  bool _covered(ModalRoute<Object?>? route) {
    if (route == null || route.isCurrent) return false;
    final s = route.secondaryAnimation;
    if (s == null) return false;
    if (!_listening) {
      _listening = true;
      s.addStatusListener(_coverChanged);
      _secondary = s;
    }
    return s.status == AnimationStatus.completed;
  }

  bool _listening = false;
  Animation<double>? _secondary;
  void _coverChanged(AnimationStatus _) {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _secondary?.removeStatusListener(_coverChanged);
    super.dispose();
  }
}
