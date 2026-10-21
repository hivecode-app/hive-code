// App state on top of a Backend: the 3-second undo on every one-tap answer (APP-SPEC §4.2),
// drafts that survive restarts, the durable outbox (§10.1), and the desktop selection.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../model/company_time.dart' as company_time;
import '../model/models.dart';
import '../theme/tokens.dart';
import 'backend.dart';
import 'error_report.dart';

/// One answer waiting out its 3 seconds. The UI renders [label] in place of the buttons.
class PendingAnswer {
  PendingAnswer(this.key, this.to, this.isGo, this.secondsLeft, this.fire, [this.text, this.line]) : at = company_time.CompanyTime.now();
  final String key;

  /// A decision's folded line while it can still be taken back ("אישרת"), and when he tapped (#258).
  final String? line;
  final DateTime at;
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
  AppStore(this.backend, {this.undoSeconds = 3, this.decisionUndoSeconds = 5, SharedPreferences? prefs}) : _prefs = prefs { // ignore: prefer_initializing_formals
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

  /// A GO or a question decided in one tap: the card folds at once, with "ביטול" this long (#258).
  final int decisionUndoSeconds;
  SharedPreferences? _prefs;

  CompanyData? get data => backend.data;
  SystemStatus get status => backend.status;

  final Map<String, PendingAnswer> _pending = {};
  PendingAnswer? pending(String key) => _pending[key];

  /// Desktop: which conversation is open in the main column.
  String? selectedConversation;

  /// v2 desktop: the main column shows the home (the app opens on it); opening a conversation closes it.
  bool homeOpen = kDesignV2;

  /// Desktop selection with a default: the first conversation with something unread (not muted), else the manager.
  /// The default sticks once data is in: opening it reads it, and the selection must not then jump to the next unread one.
  String get currentConversation {
    final convs = data?.conversations ?? const [];
    final pick = selectedConversation ??
        (convs.where((c) => c.unread > 0 && !c.muted).firstOrNull ?? convs.where((c) => c.pinned).firstOrNull ?? convs.firstOrNull)?.identityId;
    if (pick != null && data != null) selectedConversation = pick;
    return pick ?? data?.managerId ?? '';
  }

  /// Last error to show as a dismissable bar ("הבנתי"), never a self-hiding snackbar (design-taste E16).
  /// Every one set here is shown, and so goes to hq by itself (error_report.dart).
  String? get error => _error;
  String? _error;
  set error(String? e) {
    _error = e;
    errorReported = e != null;
    if (e != null) reportShown('bar', e);
  }

  /// The bar's error went to hq ("נשלח לטיפול" under it); not so for a [notice].
  bool errorReported = false;

  /// A command hq refused: on the bar, and sent. One that did not reach hq (no link, hq restarting) is
  /// shown only: a phone without signal is not a fault, and hq being down is the monitoring's.
  void _failed(CommandResult r) {
    if (r.transient) {
      notice(r.error ?? '');
    } else {
      error = r.error;
    }
  }

  /// The same bar for something that is not a fault (a limit he reached, a recording too short): not sent.
  void notice(String text) {
    _error = text;
    errorReported = false;
  }

  Future<void> start() async {
    try {
      _prefs ??= await SharedPreferences.getInstance();
    } catch (_) {
      // Tests without a mock store: drafts stay in memory.
    }
    _convSort = ConvSort.values.asNameMap()[_prefs?.getString(kConvSortKey)] ?? ConvSort.recent;
    final seen = _prefs?.getInt(kStatusSeenKey);
    statusSeenAt ??= seen == null ? null : DateTime.fromMillisecondsSinceEpoch(seen);
    final chats = _prefs?.getInt(kChatsSeenKey);
    _chatsSeenLocal ??= chats == null ? null : DateTime.fromMillisecondsSinceEpoch(chats);
    await backend.start();
    _restoreDrafts();
    if (_online) unawaited(flushOutbox()); // came up online: what waited from last time goes now
  }

  @override
  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    for (final p in _pending.values) {
      p.timer?.cancel();
    }
    backend.removeListener(_onBackend);
    super.dispose();
  }

  // ── 3s undo ──────────────────────────────────────────────────────────────

  void startUndo(String key, String to, Future<CommandResult> Function() action, {bool isGo = false, String Function(int)? text, String? line, int? seconds}) {
    cancelUndo(key, notify: false);
    final p = PendingAnswer(key, to, isGo, seconds ?? undoSeconds, () async {
      final r = await action();
      if (!r.ok) _failed(r);
    }, text, line);
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

  /// One undo per decision, wherever he tapped it ("מחכה לך" or the card in the conversation): the
  /// same question shows the same folded line and the same "ביטול" in both (#258).
  static String decisionKey(String? askId, String id) => 'decide:${askId ?? id}';

  /// The decision on its way for this question, if any (within its 5 seconds).
  PendingAnswer? decision(String? askId, String id) => _pending[decisionKey(askId, id)];

  /// The folded line of a decision: "אישרת" for a GO, "ענית: X" for an answer.
  static String decidedLine(AskOption option) => option.id == 'go' ? 'אישרת' : 'ענית: ${option.label}';

  void answerWait(WaitItem item, AskOption option) {
    final to = nameOf(item.from);
    final key = decisionKey(item.askId, item.id);
    final card = _cardOf(item.from, item.askId);
    final at = company_time.CompanyTime.now();
    if (item.kind == WaitKind.awaiting) {
      // A finished task (#219): "בוצע" or "נכשל" folds like any decision, with the same 5 seconds.
      final done = option.id == 'done';
      startUndo(key, to, () async {
        item.failed = !done;
        final r = await backend.awaitingOutcome(item, done);
        item.answerLine = done ? 'בוצע' : 'נכשל';
        return r;
      }, line: done ? 'בוצע' : 'נכשל', seconds: decisionUndoSeconds);
    } else if (option.id == 'go') {
      startUndo(key, to, () async {
        final r = await backend.go(item);
        item.answerLine = item.doneLine ?? 'GO נשלח';
        _closeCard(card, 'GO', at);
        return r;
      }, isGo: true, line: decidedLine(option), seconds: decisionUndoSeconds);
    } else {
      startUndo(key, to, () async {
        final r = await backend.answerAsk(item.askId ?? item.id, option, from: item.from);
        item.answerLine = 'ענית: ${option.label} · $to ממשיך';
        _closeCard(card, option.label, at);
        return r;
      }, line: decidedLine(option), seconds: decisionUndoSeconds);
    }
  }

  void answerCard(AskCard card, AskOption option) {
    final to = nameOf(card.from);
    final key = decisionKey(card.askId, card.id);
    final at = company_time.CompanyTime.now();
    if (option.id == 'go') {
      startUndo(key, to, () async {
        final w = data?.waiting.where((w) => w.askId == card.askId).firstOrNull;
        _closeCard(card, 'GO', at);
        if (w != null) return backend.go(w);
        return backend.answerAsk(card.askId ?? card.id, option);
      }, isGo: true, line: decidedLine(option), seconds: decisionUndoSeconds);
    } else {
      startUndo(key, to, () async {
        _closeCard(card, option.label, at);
        return backend.answerAsk(card.askId ?? card.id, option, from: card.from);
      }, line: decidedLine(option), seconds: decisionUndoSeconds);
    }
  }

  AskCard? _cardOf(String from, String? askId) =>
      askId == null ? null : data?.chats[from]?.items.whereType<AskCard>().where((c) => c.askId == askId).lastOrNull;

  static void _closeCard(AskCard? card, String answer, DateTime at) {
    if (card == null) return;
    card.state = AskState.answered;
    card.answer = answer;
    card.answeredAt = at;
  }

  Future<void> notNow(WaitItem item) async => _check(await backend.notNow(item));

  /// "בדקתי" on "מה לבדוק" (#108): off the list now; back, with the error, when the server didn't take it.
  Future<void> checked(AwaitingTask t) async => _check(await backend.checked(t));
  Future<void> resume(WaitItem item) async => _check(await backend.resume(item));
  /// Closing is for good and wakes the worker: it waits the same 3 seconds as any one-tap answer.
  void dismiss(WaitItem item) =>
      startUndo(item.id, nameOf(item.from), () => backend.dismiss(item), text: (s) => "ייסגר בעוד $s שנ'");

  Future<void> _check(CommandResult r) async {
    if (!r.ok) {
      _failed(r);
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
      notice('אפשר לצרף עד $maxImages תמונות להודעה אחת.');
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
      id: 'm-${company_time.CompanyTime.now().millisecondsSinceEpoch}-${_n++}',
      ts: company_time.CompanyTime.now(),
      text: text,
      priority: priority,
      replyTo: quote,
      delivery: Delivery.queued,
      attachments: [...attachments],
    );
    setDraft(identityId, '');
    if (quote?.askId != null) return _answer(identityId, msg, quote!.askId!);
    return _deliver(identityId, msg);
  }

  /// "ניסיון נוסף" on a message that was not delivered: the same message, with the same id, so hq
  /// takes it once even if the first try did get there.
  Future<UserMsg> resend(String identityId, UserMsg msg) async {
    if (msg.replyTo?.askId != null) return _answer(identityId, msg, msg.replyTo!.askId!);
    return _deliver(identityId, msg);
  }

  /// Messages on their way to hq right now (one send at a time per message).
  final _inFlight = <String>{};

  Future<CommandResult> _try(String identityId, UserMsg msg) async {
    _inFlight.add(msg.id);
    try {
      return await backend.send(identityId, msg);
    } finally {
      _inFlight.remove(msg.id);
    }
  }

  Future<UserMsg> _deliver(String identityId, UserMsg msg) async {
    // Behind one that waits or is on its way, a new message waits its turn.
    final waiting = data?.chats[identityId]?.items.any((i) => i is UserMsg && (i.delivery == Delivery.pendingConnection || _inFlight.contains(i.id))) ?? false;
    if (!_online || waiting) {
      // Durable outbox: shown with a clock and "ממתינה לחיבור" until the link is back. Behind a
      // message that waits it waits too, so it does not arrive first.
      _wait(identityId, msg);
      if (_online) unawaited(flushOutbox());
      notifyListeners();
      return msg;
    }
    final r = await _try(identityId, msg);
    if (!r.ok && r.transient) {
      // It did not reach hq (the link fell, hq restarting): it waits and goes again by itself. The
      // id goes with it, so a try that did get there is not taken twice.
      _wait(identityId, msg);
    } else {
      if (!r.ok) {
        msg.delivery = Delivery.failed;
        _failed(r);
      }
      // Its answer is in (taken or refused): what waited behind it goes now.
      if (!_disposed && (data?.chats[identityId]?.items.any((i) => i is UserMsg && i.delivery == Delivery.pendingConnection) ?? false)) {
        unawaited(flushOutbox());
      }
    }
    notifyListeners();
    return msg;
  }

  /// Into the outbox: on screen as "ממתינה לחיבור", saved on the device, and tried again.
  void _wait(String identityId, UserMsg msg) {
    msg.delivery = Delivery.pendingConnection;
    final items = data?.chats[identityId]?.items;
    if (items != null && !items.contains(msg)) items.add(msg);
    final d = data;
    if (d != null) _rewriteOutbox(d);
    _scheduleRetry();
  }

  /// A reply that quotes a question answers it. Never queued: an answer to a question that may be
  /// gone by then needs a yes or no now, and a refusal says why (#55).
  Future<UserMsg> _answer(String identityId, UserMsg msg, String askId) async {
    final chat = data?.chats[identityId];
    if (chat != null && !chat.items.contains(msg)) chat.items.add(msg); // "ניסיון נוסף" is the same bubble
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
      _failed(r);
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
      _failed(r);
    }
    notifyListeners();
    return r;
  }

  /// "משיכה חזרה": the text goes back to the composer (chat.md §2.1).
  Future<String?> retract(String identityId, UserMsg msg) async {
    if (_inFlight.contains(msg.id)) {
      // Already on its way: hq may have it, so it is not taken off here as if it never went.
      notice('ההודעה כבר בדרך לשרת, ולכן אי אפשר למשוך אותה.');
      notifyListeners();
      return null;
    }
    if (msg.delivery == Delivery.pendingConnection) {
      // Still on this device: it comes out of the outbox, and hq never hears of it.
      data?.chats[identityId]?.items.remove(msg);
      final d = data;
      if (d != null) _rewriteOutbox(d);
      setDraft(identityId, msg.text);
      notifyListeners();
      return msg.text;
    }
    final r = await backend.retract(identityId, msg.id);
    if (!r.ok) {
      _failed(r);
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
    final hm = company_time.hm(company_time.CompanyTime.now());
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
      _failed(r);
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
    statusSeenAt = at ?? company_time.CompanyTime.now();
    _prefs?.setInt(kStatusSeenKey, statusSeenAt!.millisecondsSinceEpoch);
  }

  // ── the chats screen's "מאז שהיית פה", kept in hq for every device ──────

  static const kChatsSeenKey = 'chats.seen';
  DateTime? _chatsSeenLocal;

  /// When he last left the chats screen (another tab, the app to the background): the head's "מאז שהיית פה"
  /// is what finished after it. hq's value, shared by his devices; this device's own until hq has one.
  DateTime? get chatsSeenAt {
    final a = backend.seenAt('chats'), b = _chatsSeenLocal;
    if (a == null || b == null) return a ?? b;
    return a.isAfter(b) ? a : b;
  }

  void markChatsSeen([DateTime? at]) {
    final t = at ?? company_time.CompanyTime.now();
    _chatsSeenLocal = t;
    _prefs?.setInt(kChatsSeenKey, t.millisecondsSinceEpoch);
    unawaited(backend.markSeen('chats', t));
    touch();
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
        c.items.add(UserMsg(
          id: e['id'],
          ts: DateTime.fromMillisecondsSinceEpoch(e['ts']),
          text: e['text'],
          priority: Priority.values.asNameMap()[e['priority']] ?? Priority.next,
          delivery: Delivery.pendingConnection,
          attachments: [
            for (final a in (e['attachments'] as List? ?? const []).cast<Map<String, dynamic>>())
              Attachment(name: a['name'], bytes: a['bytes'], mime: a['mime'], id: a['id']),
          ],
        ));
      }
    }
    notifyListeners();
  }

  /// A waiting message as the device keeps it. Images go with their upload ids; one that is not up
  /// yet has only its bytes, which are not kept, so that message waits in memory only (null).
  static Map<String, dynamic>? _outboxEntry(String to, UserMsg m) {
    if (m.attachments.any((a) => a.id == null)) return null;
    return {
      'to': to,
      'id': m.id,
      'ts': m.ts.millisecondsSinceEpoch,
      'text': m.text,
      'priority': m.priority.name,
      if (m.attachments.isNotEmpty) 'attachments': [for (final a in m.attachments) {'id': a.id, 'name': a.name, 'bytes': a.bytes, 'mime': a.mime}],
    };
  }

  bool _flushing = false;

  /// Tries again while something waits: 2s, 4s, 8s... up to a minute. A link that comes back
  /// sends at once as well (_onBackend); this covers hq restarting under a link that looked up.
  Timer? _retryTimer;
  int _retryStep = 0;

  void _scheduleRetry() {
    if (_disposed || _retryTimer != null) return;
    final secs = [2, 4, 8, 15, 30, 60][_retryStep.clamp(0, 5)];
    _retryStep++;
    _retryTimer = Timer(Duration(seconds: secs), () {
      _retryTimer = null;
      unawaited(flushOutbox());
    });
  }

  /// The saved outbox = what still waits in memory, plus entries for conversations not loaded yet.
  void _rewriteOutbox(CompanyData d) {
    final p = _prefs;
    if (p == null) return;
    final kept = (jsonDecode(p.getString('outbox') ?? '[]') as List).cast<Map<String, dynamic>>().where((e) => !d.chats.containsKey(e['to']));
    final waiting = [
      for (final c in d.chats.values)
        for (final m in c.items.whereType<UserMsg>().where((m) => m.delivery == Delivery.pendingConnection))
          ?_outboxEntry(c.identityId, m),
    ];
    final all = [...kept, ...waiting];
    if (all.isEmpty) {
      p.remove('outbox');
    } else {
      p.setString('outbox', jsonEncode(all));
    }
  }

  /// Called when the link comes back, and by the retry timer: flush the outbox in order. A message
  /// hq refuses is marked failed with the reason on screen; one that still does not reach it waits
  /// again, and so does everything after it (the order stays).
  Future<void> flushOutbox() async {
    final d = data;
    if (d == null || _flushing) return;
    _flushing = true;
    var waiting = false;
    try {
      for (final c in d.chats.values.toList()) {
        // One already on its way here goes first; what comes after it waits for its answer.
        if (c.items.any((i) => _inFlight.contains(i.id))) continue;
        for (final m in c.items.whereType<UserMsg>().where((m) => m.delivery == Delivery.pendingConnection).toList()) {
          if (waiting) break;
          // Pulled back ("משיכה חזרה") while the ones before it went: it does not go.
          if (!(d.chats[c.identityId]?.items.contains(m) ?? false) || m.delivery != Delivery.pendingConnection) continue;
          final r = await _try(c.identityId, m);
          if (r.ok) {
            _retryStep = 0;
          } else {
            m.delivery = r.transient ? Delivery.pendingConnection : Delivery.failed;
            if (r.transient) waiting = true;
            if (!r.transient) _failed(r);
          }
        }
        if (waiting) break;
      }
      _rewriteOutbox(d);
    } finally {
      _flushing = false;
    }
    // A conversation with a send still on its way is left to that send: its answer carries on.
    final more = d.chats.values.any((c) =>
        !c.items.any((i) => _inFlight.contains(i.id)) && c.items.any((i) => i is UserMsg && i.delivery == Delivery.pendingConnection));
    if (waiting) {
      _scheduleRetry();
    } else if (more && !_disposed) {
      // Added while this ran, and hq answers: it goes now, not on the next timer.
      unawaited(flushOutbox());
    } else {
      _retryStep = 0;
    }
    if (!_disposed) notifyListeners();
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
