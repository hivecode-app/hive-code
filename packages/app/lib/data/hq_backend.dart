// Backend against packages/hq (HTTP + one WebSocket, token auth, B.8). Endpoints as on the hq
// lane's branch (packages/hq/src/api.ts):
//   GET  /api/org /api/board /api/inbox /api/asks /api/toggles /api/messages?identity= /api/events?identity=&after=
//   POST /api/asks/:id/answer  /api/inbox/:id/{done,dismiss,ack}  /api/messages/tell  /api/shifts/:id/interrupt
//   PUT  /api/toggles/:key
//   WS   /ws?after=<seq>  (replay, then {type:'live'}, then live events; deltas have seq 0)
// The app reaches hq through Caddy at <base>/hq (see tool/deploy.sh).
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../model/models.dart';
import '../theme/icons.dart';
import 'backend.dart';
import 'engine_model.dart';

class HqBackend extends Backend {
  HqBackend({required this.baseUrl, required this.token, http.Client? client}) : _http = client ?? http.Client();

  /// e.g. `https://app.hq.example.com/<secret>/hq`
  final String baseUrl;
  final String token;
  final http.Client _http;

  CompanyData? _data;
  SystemStatus _status = const SystemStatus(LinkState.connecting);
  WebSocketChannel? _ws;
  StreamSubscription? _wsSub;
  Timer? _retry;
  Timer? _refresh;
  int _seq = 0;
  int _replayed = 0;
  bool _disposed = false;
  DateTime? _downSince;
  final _engines = <String, EngineModel>{};

  /// Between connecting and hq's {type:'live'}: replayed events change data but don't redraw the
  /// screen one by one; one redraw comes with 'live'.
  bool _replaying = false;
  /// Redraws held back during a replay. The 4s guard releases these, while [_replaying] (which
  /// keeps the first replay out of chats and unread counts) lasts until hq says live.
  bool _holdRedraws = false;
  bool _skipEngineReplay = false;
  bool _connectedOnce = false;
  Timer? _replayGuard;
  Timer? _onlineAgain;

  @override
  void notifyListeners() {
    if (_holdRedraws || _disposed) return;
    super.notifyListeners();
  }
  final _boardShift = <String, String>{}; // identity -> live shift id
  final _askToInbox = <String, int>{};

  /// hq refused this device's token (revoked in settings → devices on any device). The app goes
  /// back to the sign-in screen (main.dart).
  bool get unauthorized => _unauthorized;
  bool _unauthorized = false;

  void _refused() {
    if (_unauthorized || _disposed) return;
    _unauthorized = true;
    _replaying = false;
    _holdRedraws = false;
    _retry?.cancel();
    notifyListeners();
  }

  @override
  CompanyData? get data => _data;
  @override
  SystemStatus get status => _status;
  @override
  String get label => Uri.tryParse(baseUrl)?.host ?? baseUrl;

  Map<String, String> get _headers => {'authorization': 'Bearer $token', 'content-type': 'application/json'};

  Future<dynamic> _get(String path) async {
    final r = await _http.get(Uri.parse('$baseUrl$path'), headers: _headers).timeout(const Duration(seconds: 10));
    if (r.statusCode == 401) _refused();
    if (r.statusCode != 200) throw HqError(r.statusCode, r.body);
    return jsonDecode(utf8.decode(r.bodyBytes));
  }

  Future<CommandResult> _send(String method, String path, [Map<String, dynamic>? body]) async {
    try {
      final req = http.Request(method, Uri.parse('$baseUrl$path'))
        ..headers.addAll(_headers)
        ..body = jsonEncode(body ?? {});
      final r = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 10)));
      if (r.statusCode == 200) return const CommandResult.ok();
      if (r.statusCode == 401) {
        _refused();
        return const CommandResult.fail('המכשיר הזה נותק מהחברה. צריך להיכנס שוב.');
      }
      if (r.statusCode == 404 || r.statusCode == 409) return const CommandResult.fail('הפריט כבר טופל או שאינו קיים יותר.');
      return const CommandResult.fail('השרת לא קיבל את הפעולה. אפשר לנסות שוב.');
    } catch (_) {
      return const CommandResult.fail('אין חיבור לשרת, ולכן הפעולה לא נשלחה. אפשר לנסות שוב.');
    }
  }

  @override
  Future<void> start() async {
    try {
      await _load();
      notifyListeners(); // the snapshot shows at once; the WebSocket only adds what is new
      _connect();
    } catch (_) {
      _setDown();
      _scheduleRetry();
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _replayGuard?.cancel();
    _onlineAgain?.cancel();
    _retry?.cancel();
    _refresh?.cancel();
    _wsSub?.cancel();
    _ws?.sink.close();
    _http.close();
    super.dispose();
  }

  void _setDown() {
    _replaying = false; // a failed connection must still say so on screen
    _holdRedraws = false;
    _downSince ??= DateTime.now();
    final t = _downSince!;
    _status = SystemStatus(LinkState.offline, since: '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}');
  }

  void _scheduleRetry() {
    _retry?.cancel();
    if (_disposed || _unauthorized) return;
    _retry = Timer(const Duration(seconds: 5), () async {
      if (_unauthorized) return;
      try {
        // A refused WS handshake (device revoked while the link was down) looks like any network
        // error; one plain request tells them apart, and a 401 there sends the app to sign-in.
        if (_data == null) {
          await _load();
          notifyListeners(); // show the snapshot before the WebSocket replays
        } else {
          await _get('/api/toggles');
        }
        _connect();
      } catch (_) {
        _scheduleRetry();
      }
      notifyListeners();
    });
  }

  // ── snapshot ─────────────────────────────────────────────────────────────

  Future<void> _load() async {
    final results = await Future.wait([_get('/api/board'), _get('/api/inbox'), _get('/api/asks'), _get('/api/toggles')]);
    final board = (results[0]['identities'] as List).cast<Map<String, dynamic>>();
    final inbox = (results[1]['items'] as List).cast<Map<String, dynamic>>();
    final asks = (results[2]['asks'] as List).cast<Map<String, dynamic>>();
    final toggles = (results[3]['toggles'] as List).cast<Map<String, dynamic>>();
    final prev = _data;
    _data = mapSnapshot(board: board, inbox: inbox, asks: asks, toggles: toggles, previous: prev);
    final open = openIdentity, openChat = open == null ? null : _data!.chats[open];
    if (open != null && openChat != null && !_midFetch.containsKey(open)) _syncAsks(openChat, open, _data!);
    if (open != null && _openFailed.contains(open)) unawaited(openConversation(open));
    for (final b in board) {
      final sh = b['shift'] as Map?;
      if (sh != null && sh['state'] == 'live') _boardShift[b['id'] as String] = sh['id'] as String;
    }
    for (final i in inbox) {
      if (i['ref'] != null) _askToInbox[i['ref'] as String] = i['id'] as int;
    }
    unawaited(_loadLastLines());
  }

  /// Last line and time per conversation, newest first, Yoav pinned (APP-SPEC §4.3).
  Future<void> _loadLastLines() async {
    final d = _data;
    if (d == null) return;
    try {
      final res = await _get('/api/messages?identity=owner&limit=200');
      final seen = <String>{};
      for (final m in (res['messages'] as List).cast<Map<String, dynamic>>()) {
        final other = m['from_identity'] == 'owner' ? m['to_identity'] as String : m['from_identity'] as String;
        if (!seen.add(other)) continue;
        final i = d.conversations.indexWhere((c) => c.identityId == other);
        final c = ConversationSummary(
          identityId: other,
          lastLine: (m['from_identity'] == 'owner' ? 'את/ה: ' : '') + (m['body'] as String).split('\n').first,
          time: _hm(m['created_at'] as int),
          lastIsMine: m['from_identity'] != 'owner',
          unread: m['to_identity'] == 'owner' && m['state'] != 'handled' ? 1 : 0,
          pinned: other == 'yoav',
        );
        if (i >= 0) {
          d.conversations[i] = c;
        } else {
          d.conversations.add(c);
        }
      }
      // Recent first, then the rest; Yoav stays pinned in the list widget.
      final order = [for (final m in (res['messages'] as List)) (m['from_identity'] == 'owner' ? m['to_identity'] : m['from_identity']) as String];
      int rank(ConversationSummary c) {
        final r = order.indexOf(c.identityId);
        return r < 0 ? 1 << 20 : r;
      }
      d.conversations.sort((a, b) => rank(a).compareTo(rank(b)));
      notifyListeners();
    } catch (_) {}
  }

  void _refreshSoon() {
    _refresh?.cancel();
    _refresh = Timer(const Duration(milliseconds: 300), () async {
      try {
        await _load();
        notifyListeners();
      } catch (_) {}
    });
  }

  // ── live ─────────────────────────────────────────────────────────────────

  void _connect() {
    _wsSub?.cancel();
    final u = Uri.parse(baseUrl);
    // First connect: no cursor, so hq sends only its recent tail (the snapshot already has the
    // state). Sending after=0 made it replay its whole history, 6,000 events and growing, on every
    // start. A reconnect resumes from the last seq it saw, so nothing is lost.
    final first = !_connectedOnce;
    final ws = u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws', path: '${u.path}/ws', queryParameters: {if (!first) 'after': '$_seq', 'token': token});
    _status = const SystemStatus(LinkState.connecting);
    _replayed = 0;
    _replaying = true;
    _holdRedraws = true;
    _skipEngineReplay = first;
    _replayGuard?.cancel();
    _replayGuard = Timer(const Duration(seconds: 4), () {
      if (_disposed || !_holdRedraws) return;
      _holdRedraws = false;
      notifyListeners();
    });
    try {
      _ws = WebSocketChannel.connect(ws);
      // A failed handshake also reaches the stream's onError below, which retries.
      _ws!.ready.catchError((_) {});
    } catch (_) {
      _setDown();
      _scheduleRetry();
      return;
    }
    _wsSub = _ws!.stream.listen(
      (raw) => _onEvent(jsonDecode(raw as String) as Map<String, dynamic>),
      onError: (_) {
        _setDown();
        notifyListeners();
        _scheduleRetry();
      },
      onDone: () {
        if (_disposed) return;
        if (_ws?.closeCode == 4401) return _refused(); // this device was revoked
        _setDown();
        notifyListeners();
        _scheduleRetry();
      },
    );
  }

  void _onEvent(Map<String, dynamic> e) {
    final type = e['type'] as String? ?? '';
    if (type == 'live') {
      _replaying = false;
      _holdRedraws = false;
      _connectedOnce = true;
      _replayGuard?.cancel();
      final liveSeq = (e['seq'] as num?)?.toInt() ?? 0;
      if (liveSeq > _seq) _seq = liveSeq;
      final wasDown = _downSince != null;
      _downSince = null;
      _status = wasDown ? SystemStatus(LinkState.reconnected, updated: _replayed) : const SystemStatus(LinkState.online);
      if (wasDown) {
        _onlineAgain?.cancel();
        _onlineAgain = Timer(const Duration(seconds: 3), () {
          if (!_disposed && _status.state == LinkState.reconnected) {
            _status = const SystemStatus(LinkState.online);
            notifyListeners();
          }
        });
        _refreshSoon();
      }
      final open = openIdentity;
      if (open != null && (wasDown || _openFailed.contains(open))) unawaited(openConversation(open));
      notifyListeners();
      return;
    }
    final seq = (e['seq'] as num?)?.toInt() ?? 0;
    if (seq > _seq) {
      _seq = seq;
      _replayed++;
    }
    final identity = e['identity'] as String?;
    final d = _data;
    if (d == null) return;

    if (type.startsWith('inbox.') || type.startsWith('ask.') || type == 'shift.state' || type == 'toggle.changed' || type.startsWith('watchdog.')) {
      _refreshSoon();
    }
    // The first replay is history the snapshot and openConversation already cover: building chats
    // from it only cost time at start.
    if (_skipEngineReplay && _replaying && type.startsWith('engine.')) return;
    if (identity != null && (type.startsWith('engine.') || type == 'shift.state') && _buffer(identity, e)) return;
    if (identity != null && (type.startsWith('engine.') || type == 'shift.state')) {
      final chat = d.chats.putIfAbsent(identity, () => Conversation(identityId: identity, items: []));
      _engineFor(identity, chat).apply(e);
      notifyListeners();
    }
    if (type == 'message.state') {
      final data = (e['data'] as Map).cast<String, dynamic>();
      if (_buffer(data['to'] as String?, e)) return;
      final chat = d.chats[data['to']];
      final m = chat?.items.whereType<UserMsg>().where((m) => m.id == data['id']).firstOrNull;
      if (m != null) {
        m.delivery = mapDelivery(data['state'] as String?);
        notifyListeners();
      }
    }
    if (type == 'message.new') {
      final m = (e['data'] as Map).cast<String, dynamic>();
      final from = m['from_identity'] as String, to = m['to_identity'] as String;
      if (to == 'owner' && m['kind'] != 'system') {
        if (_buffer(from, e)) return;
        final chat = d.chats.putIfAbsent(from, () => Conversation(identityId: from, items: []));
        if (!chat.items.any((i) => i.id == 'msg:${m['id']}')) {
          if (!streamedAlready(chat.items, m)) {
            chat.items.add(TextMsg(id: 'msg:${m['id']}', ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int), text: m['body'] as String));
          }
          if (openIdentity == from) unawaited(_send('POST', '/api/messages/${Uri.encodeComponent(m['id'] as String)}/handled'));
          _bumpConversation(from, m['body'] as String, m['created_at'] as int);
          notifyListeners();
        }
      } else {
        // The owner's own messages from another device, system lines, and messages between
        // workers: they belong to an open conversation (the one they involve), or wait for it.
        final chatId = from == 'owner' ? to : (to == 'owner' ? from : (openIdentity == from || openIdentity == to ? openIdentity : null));
        if (chatId == null || _buffer(chatId, e)) return;
        final chat = d.chats[chatId];
        if (chat == null) return;
        final item = _messageItem(m, d, chat.items);
        if (item != null && !chat.items.any((i) => i.id == item.id)) {
          chat.items.add(item);
          notifyListeners();
        }
      }
    }
  }

  /// One stored message as a chat item, the same way whether it came in the history or live.
  /// Null when the worker's streamed text already shows it.
  ChatItem? _messageItem(Map<String, dynamic> m, CompanyData d, List<ChatItem> existing) {
    final ts = DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int);
    if (m['from_identity'] == 'owner') {
      return UserMsg(
        id: m['id'] as String,
        ts: ts,
        text: m['body'] as String,
        delivery: mapDelivery(m['state'] as String?),
        priority: Priority.values.byName((m['priority'] as String?) ?? 'next'),
      );
    }
    if (m['to_identity'] == 'owner') {
      if (m['kind'] == 'system') return EventLine(id: 'msg:${m['id']}', ts: ts, text: m['body'] as String);
      return streamedAlready(existing, m) ? null : TextMsg(id: 'msg:${m['id']}', ts: ts, text: m['body'] as String);
    }
    final body = withoutIds((m['body'] as String).replaceAll('\n', ' '));
    return EventLine(
      id: 'msg:${m['id']}',
      ts: ts,
      icon: 'forward',
      text: '${d.who(m['from_identity'] as String).name} ← ${d.who(m['to_identity'] as String).name}: ${body.length > 90 ? '${body.substring(0, 90)}…' : body}',
    );
  }

  // While a conversation's history is loading, its live events wait here and are applied to the
  // new copy when it lands (applying them to the old copy lost them when it was replaced).
  final _midFetch = <String, List<Map<String, dynamic>>>{};
  bool _buffer(String? identity, Map<String, dynamic> e) {
    final q = identity == null ? null : _midFetch[identity];
    if (q == null) return false;
    q.add(e);
    return true;
  }

  EngineModel _engineFor(String identity, Conversation chat) => _engines.putIfAbsent(
        identity,
        () => EngineModel(items: chat.items, gender: _data!.who(identity).gender, onLive: (l) => chat.live = l),
      );

  /// The conversation on screen (read = handled for what arrives while it is open).
  String? get openIdentity => _shown.lastOrNull;
  final _shown = <String>[];

  @override
  void showConversation(String identityId) => _shown.add(identityId);

  void _bumpConversation(String id, String line, int ts) {
    final d = _data;
    if (d == null) return;
    final i = d.conversations.indexWhere((c) => c.identityId == id);
    final c = ConversationSummary(
      identityId: id,
      lastLine: line.split('\n').first,
      time: _hm(ts),
      lastIsMine: true,
      // The first replay's tail is old news (already handled): don't mark it unread.
      unread: openIdentity == id || (_skipEngineReplay && _replaying) ? 0 : 1,
      pinned: i >= 0 && d.conversations[i].pinned,
    );
    if (i >= 0) {
      d.conversations[i] = c;
    } else {
      d.conversations.add(c);
    }
  }

  @override
  Future<void> openConversation(String identityId) async {
    if (!_opening.add(identityId)) return; // already fetching it
    try {
      await _openConversation(identityId);
    } finally {
      _opening.remove(identityId);
    }
  }

  final _opening = <String>{};

  Future<void> _openConversation(String identityId) async {
    final d = _data;
    if (d == null) return;
    _midFetch[identityId] = [];
    try {
      final res = await Future.wait([
        _get('/api/messages?identity=${Uri.encodeQueryComponent(identityId)}&limit=200'),
        _get('/api/events?identity=${Uri.encodeQueryComponent(identityId)}&after=${_seq > 20000 ? _seq - 20000 : 0}&limit=2000'),
      ]);
      final old = d.chats[identityId];
      final chat = Conversation(identityId: identityId, items: [], draft: old?.draft ?? '');
      final eng = EngineModel(items: chat.items, gender: d.who(identityId).gender, onLive: (l) => chat.live = l);
      for (final e in (res[1]['events'] as List).cast<Map<String, dynamic>>()) {
        eng.apply(e);
      }
      for (final m in (res[0]['messages'] as List).cast<Map<String, dynamic>>().reversed) {
        final item = _messageItem(m, d, chat.items);
        if (item != null) chat.items.add(item);
        // He read it: mark it handled so the worker's mailbox closes the loop (B.4).
        if (m['to_identity'] == 'owner' && m['kind'] != 'system' && m['state'] != 'handled') {
          unawaited(_send('POST', '/api/messages/${Uri.encodeComponent(m['id'] as String)}/handled'));
        }
      }
      _syncAsks(chat, identityId, _data ?? d); // the snapshot may have moved on while this loaded
      // Messages sent from here: keep the furthest delivery state either copy has seen, and keep
      // the ones hq doesn't have yet (in the queue, waiting for the link, or failed).
      final mine = {for (final m in chat.items.whereType<UserMsg>()) m.id: m};
      for (final m in (old?.items ?? const <ChatItem>[]).whereType<UserMsg>()) {
        final there = mine[m.id];
        if (there != null) {
          there.delivery = furtherDelivery(there.delivery, m.delivery);
        } else if (const {Delivery.queued, Delivery.pendingConnection, Delivery.failed}.contains(m.delivery)) {
          mine[m.id] = m;
          chat.items.add(m);
        }
      }
      chat.items.sort((a, b) => a.ts.compareTo(b.ts));
      d.chats[identityId] = chat;
      _engines[identityId] = eng;
      _openFailed.remove(identityId);
      // What arrived while this loaded, applied to the new copy (the engine skips seqs it has).
      final waiting = _midFetch.remove(identityId) ?? const [];
      for (final e in waiting) {
        _onEvent(e);
      }
      notifyListeners();
    } catch (_) {
      // Keep what we have; the system strip already says the link is down. The next 'live'
      // (link back) opens it again.
      _openFailed.add(identityId);
      final waiting = _midFetch.remove(identityId) ?? const [];
      for (final e in waiting) {
        _onEvent(e);
      }
    }
  }

  final _openFailed = <String>{};

  @override
  void closeConversation(String identityId) {
    final i = _shown.lastIndexOf(identityId);
    if (i >= 0) _shown.removeAt(i);
  }

  /// Question cards follow the inbox: one appears when a worker asks while the chat is open, and
  /// one answered elsewhere (home, another device, a manager) stops asking here.
  void _syncAsks(Conversation chat, String identityId, CompanyData d) {
    final open = {for (final w in d.waiting.where((w) => w.from == identityId && w.askId != null)) w.askId!: w};
    var added = false;
    for (final card in chat.items.whereType<AskCard>()) {
      if (card.state == AskState.open && card.askId != null && !open.containsKey(card.askId)) card.state = AskState.answered;
    }
    final have = {for (final c in chat.items.whereType<AskCard>()) c.askId};
    for (final a in open.values) {
      if (have.contains(a.askId)) continue;
      // At the time it was asked, not "now": a card stamped now sorted below everything and buried
      // every new message under it.
      chat.items.add(AskCard(id: 'ask:${a.askId}', ts: a.createdAt ?? DateTime.now(), askId: a.askId, from: identityId, question: a.body, options: a.options, blocking: a.blocking));
      added = true;
    }
    if (added) chat.items.sort((a, b) => a.ts.compareTo(b.ts));
  }

  // ── commands ─────────────────────────────────────────────────────────────

  @override
  Future<CommandResult> answerAsk(String askId, AskOption option, {String? from}) =>
      _send('POST', '/api/asks/${Uri.encodeComponent(askId)}/answer', {'answer': option.label, 'by': 'owner'}).then(_after);

  @override
  Future<CommandResult> freeAnswer(String askId, String text) =>
      _send('POST', '/api/asks/${Uri.encodeComponent(askId)}/answer', {'answer': text, 'by': 'owner'}).then(_after);

  @override
  Future<CommandResult> go(WaitItem item) async {
    final r = item.askId != null && !item.askId!.startsWith('inbox:')
        ? await _send('POST', '/api/asks/${Uri.encodeComponent(item.askId!)}/answer', {'answer': 'GO', 'by': 'owner'})
        : await _send('POST', '/api/inbox/${item.inboxId}/done', {'note': 'GO'});
    if (r.ok) item.state = WaitState.answered;
    return _after(r);
  }

  @override
  Future<CommandResult> notNow(WaitItem item) async {
    item.state = WaitState.notNow;
    notifyListeners();
    if (item.inboxId == null) return const CommandResult.ok();
    return _send('POST', '/api/inbox/${item.inboxId}/ack');
  }

  @override
  Future<CommandResult> retry(WaitItem item) => _send('POST', '/api/inbox/${item.inboxId}/done', {'note': 'retry'}).then(_after);

  @override
  Future<CommandResult> handoffDone(WaitItem item) => _send('POST', '/api/inbox/${item.inboxId}/done', {'note': 'done'}).then(_after);

  @override
  Future<AccountsView?> accounts() async {
    try {
      final j = await _get('/api/accounts') as Map<String, dynamic>;
      return AccountsView(
        pinned: j['pinned'] as String?,
        active: j['active'] as String?,
        accounts: [
          for (final a in (j['accounts'] as List).cast<Map<String, dynamic>>())
            AccountInfo(
              name: a['name'] as String,
              label: (a['label'] as String?) ?? a['name'] as String,
              usable: a['usable'] == true,
              blocked: a['blocked_until'] != null,
              room: a['room'] as num?,
              note: a['note'] as String?,
            ),
        ],
      );
    } catch (_) {
      return null;
    }
  }

  @override
  Future<CommandResult> pinAccount(String? name) => _send('PUT', '/api/accounts/pinned', {'name': name});

  CommandResult _after(CommandResult r) {
    if (r.ok) _refreshSoon();
    return r;
  }

  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    final chat = _data?.chats.putIfAbsent(identityId, () => Conversation(identityId: identityId, items: []));
    chat?.items.add(msg);
    msg.delivery = Delivery.queued;
    notifyListeners();
    final r = await _send('POST', '/api/messages/tell', {
      'msg_id': msg.id,
      'from': 'owner',
      'to': identityId,
      'body': msg.replyTo == null ? msg.text : '> ${msg.replyTo!.text}\n\n${msg.text}',
      'priority': msg.priority.name,
    });
    if (!r.ok) msg.delivery = Delivery.failed;
    notifyListeners();
    return r;
  }

  @override
  Future<CommandResult> retract(String identityId, String msgId) async =>
      const CommandResult.fail('השרת עוד לא תומך במשיכת הודעה, ולכן היא תימסר כרגיל.');

  @override
  Future<CommandResult> stop(String identityId) async {
    final shift = _boardShift[identityId];
    if (shift == null) return const CommandResult.fail('אין לעובד משמרת פעילה, ולכן אין מה לעצור.');
    return _send('POST', '/api/shifts/${Uri.encodeComponent(shift)}/interrupt');
  }

  @override
  Future<CommandResult> setAutomation(String key, bool enabled) => _send('PUT', '/api/toggles/${Uri.encodeComponent(key)}', {'enabled': enabled});

  @override
  Future<CommandResult> setFocus(bool on) async {
    final r = await _send('PUT', '/api/toggles/focus', {'enabled': on});
    if (r.ok) _data?.focus = on;
    notifyListeners();
    return r;
  }

  @override
  Future<CommandResult> wake(String teamId) async => const CommandResult.fail('השרת עוד לא תומך בהערת צוות מהאפליקציה.');
}

class HqError implements Exception {
  HqError(this.status, this.body);
  final int status;
  final String body;
  @override
  String toString() => 'HqError($status)';
}

Delivery mapDelivery(String? s) => switch (s) {
      'queued' => Delivery.queued,
      'delivered' => Delivery.delivered,
      'seen' => Delivery.read,
      'handled' => Delivery.handled,
      'failed' => Delivery.failed,
      _ => Delivery.queued,
    };

/// A reply hq stored from the worker's own text (chat.md §2.3א) is the bubble that already streamed in:
/// `text_ref` is that text's engine messageId. One item, never two.
bool streamedAlready(List<ChatItem> items, Map<String, dynamic> m) {
  final ref = m['text_ref'] as String?;
  return ref != null && items.any((i) => i is TextMsg && i.id == 't:$ref');
}

WorkerStatus mapStatus(String? s) => switch (s) {
      'working' => WorkerStatus.working,
      'waiting_for_you' => WorkerStatus.waiting,
      'blocked' => WorkerStatus.blocked,
      'stuck' => WorkerStatus.stuck,
      'restarting' => WorkerStatus.restarting,
      'free' => WorkerStatus.free,
      'resting' => WorkerStatus.resting,
      'done' => WorkerStatus.done,
      _ => WorkerStatus.free,
    };

String _hm(int ms) {
  final t = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

/// hq DTOs -> the app's model. Pure, unit-tested (test/hq_mapping_test.dart).
CompanyData mapSnapshot({
  required List<Map<String, dynamic>> board,
  required List<Map<String, dynamic>> inbox,
  required List<Map<String, dynamic>> asks,
  required List<Map<String, dynamic>> toggles,
  CompanyData? previous,
}) {
  const teamNames = {'mgmt': 'הנהלה', 'management': 'הנהלה', 'monitor': 'ניטור', 'monitoring': 'ניטור', 'personal': 'הצוות האישי', 'improve': 'מחלקת השיפור', 'improvement': 'מחלקת השיפור', 'lumo': 'לומו', 'tikibot': 'טיקיבוט', 'voice': 'voice-bot', 'agent-company': 'החברה'};
  // The team badge on every monogram. By team id first (hq's real ids and the older short ones),
  // then a member's own symbol if the app has that icon; never an icon it doesn't have (that drew
  // "?" on the whole personal team, QA-LOG item 3).
  const teamSymbols = {
    'management': 'explore', 'mgmt': 'explore', 'monitoring': 'shield', 'monitor': 'shield', 'personal': 'folder_shared',
    'improvement': 'build', 'improve': 'build', 'agent-company': 'architecture', 'lumo': 'local_shipping',
    'tikibot': 'smart_toy', 'voice': 'graphic_eq', 'voice-bot': 'graphic_eq',
  };
  final teams = <String, Team>{};
  final ids = <String, Identity>{};
  final presence = <String, Presence>{};
  for (final b in board) {
    final id = b['id'] as String;
    final team = (b['team'] as String?) ?? 'company';
    final own = b['symbol'] as String?;
    final symbol = teamSymbols[team] ?? (own != null && kIcons.containsKey(own) ? own : 'build');
    teams.putIfAbsent(team, () => Team(id: team, name: teamNames[team] ?? team, symbol: symbol, permanent: b['team_kind'] == 'permanent'));
    if (b['lifecycle'] == 'lead' && teams[team]!.leadId == null) {
      teams[team] = Team(id: team, name: teams[team]!.name, symbol: teams[team]!.symbol, leadId: id, permanent: teams[team]!.permanent);
    }
    final gender = (b['gender'] as String?) == 'f' ? Gender.f : Gender.m;
    ids[id] = Identity(
      id: id,
      name: b['name'] as String? ?? id,
      title: b['title'] as String? ?? '',
      teamId: team,
      gender: gender,
      temp: b['lifecycle'] == 'ephemeral',
      taskRef: b['team_kind'] == 'task' ? team : null,
    );
    final shift = b['shift'] as Map?;
    final shiftNo = shift == null ? null : int.tryParse((shift['id'] as String).split('-').last);
    presence[id] = Presence(
      status: mapStatus(b['status'] as String?),
      blockedOn: b['blocked_on'] as String?,
      shift: shiftNo,
      shiftSince: shift?['started_at'] is int ? _hm(shift!['started_at'] as int) : null,
      activity: (b['task'] as Map?)?['title'] as String?,
    );
  }

  String kickerFor(Map<String, dynamic> i) {
    final kind = i['kind'] as String;
    return switch (kind) {
      'incident' => 'דחוף בפרודקשן',
      'go' => 'GO לפרודקשן',
      'login' => 'כניסה לאתר',
      'delivery_failure' => 'הודעה לא נמסרה',
      'shift_failure' => 'עובד לא חזר אחרי קריסה',
      _ => i['blocking'] == true ? 'חוסם' : 'שאלה',
    };
  }

  final askById = {for (final a in asks) a['id'] as String: a};
  final waiting = <WaitItem>[];
  for (final i in inbox) {
    if (i['state'] != 'open') continue;
    final kind = switch (i['kind'] as String) {
      'incident' => i['urgency'] == 'urgent' ? WaitKind.urgentProd : WaitKind.failure,
      'go' => WaitKind.go,
      'login' => WaitKind.login,
      'delivery_failure' || 'shift_failure' => WaitKind.failure,
      'ask' || 'escalation_note' => i['blocking'] == true ? WaitKind.blockingAsk : WaitKind.softAsk,
      _ => WaitKind.softAsk,
    };
    final ask = askById[i['ref']];
    final options = <AskOption>[
      if (kind == WaitKind.go || kind == WaitKind.urgentProd) const AskOption(id: 'go', label: 'GO', primary: true),
      if (ask != null) for (final o in (ask['options'] as List).cast<String>()) AskOption(id: o, label: o),
    ];
    waiting.add(WaitItem(
      id: 'inbox:${i['id']}',
      inboxId: i['id'] as int,
      askId: ask != null ? ask['id'] as String : null,
      kind: kind,
      from: (i['from_identity'] as String?) ?? 'yoav',
      time: _hm(i['created_at'] as int),
      createdAt: DateTime.fromMillisecondsSinceEpoch(i['created_at'] as int),
      kicker: kickerFor(i),
      body: (ask?['question'] as String?) ?? ((i['body'] as String?)?.isNotEmpty == true ? i['body'] as String : i['title'] as String),
      options: options,
      domain: kind == WaitKind.login ? (i['title'] as String?) : null,
    ));
  }

  final automations = [
    for (final t in toggles)
      Automation(
        key: t['key'] as String,
        team: 'מערכת',
        sentence: (t['description'] as String?) ?? t['key'] as String,
        meta: t['manual'] == true && t['enabled'] == false ? 'כובתה ידנית · ${_hm(t['updated_at'] as int)}' : (t['enabled'] == true ? 'פעילה' : 'כבויה'),
        enabled: t['enabled'] == true,
      ),
  ];
  final focus = toggles.any((t) => t['key'] == 'focus' && t['enabled'] == true);
  final night = toggles.any((t) => t['key'] == 'night' && t['enabled'] == true);

  final convs = [
    for (final b in board)
      ConversationSummary(
        identityId: b['id'] as String,
        // Nothing said yet: no second line (it used to repeat the title right above it).
        lastLine: ((b['task'] as Map?)?['title'] as String?) ?? '',
        time: b['last_seen_at'] is int ? _hm(b['last_seen_at'] as int) : '',
        pinned: b['id'] == 'yoav',
      ),
  ];

  final orgTeams = [
    for (final t in teams.values)
      OrgTeam(
        teamId: t.id,
        line: '${t.leadId != null ? ids[t.leadId]!.name : ''}${t.leadId != null ? ' · ' : ''}${ids.values.where((i) => i.teamId == t.id).length} עובדים',
        statusIcon: '',
        statusWord: '',
        members: [for (final i in ids.values.where((i) => i.teamId == t.id)) OrgMember(identityId: i.id, line: i.title)],
      ),
  ];

  return CompanyData(
    teams: teams,
    identities: ids,
    presence: presence,
    waiting: waiting,
    decisions: const [],
    digest: const [],
    digestSince: '',
    activity: const [],
    conversations: convs,
    chats: previous?.chats ?? {},
    tickets: const [],
    ticketDetails: const {},
    boardSubtitle: 'כל החברה',
    orgTeams: orgTeams,
    orgSubtitle: '${presence.values.where((p) => p.status != WorkerStatus.resting).length} עובדים פעילים · ${presence.values.where((p) => p.status == WorkerStatus.resting).length} נחים',
    capacity: const [],
    automations: automations,
    focus: focus,
    night: night ? 'לילה פעיל' : null,
  );
}

/// Internal message ids mean nothing to the owner: "(מזהה agent-company-t5-2:mvfww7y1-010ec676ca)"
/// and bare ids of that shape are dropped from the one-line view of messages between workers.
String withoutIds(String s) => s
    .replaceAll(RegExp(r'\s*\((?:מזהה|id|ref)[: ]+[^)]*\)'), '')
    .replaceAll(RegExp(r'\b[\w.-]+-\d+:[a-z0-9]{6,}-[a-z0-9]{6,}\b'), '')
    .replaceAll(RegExp(r' {2,}'), ' ')
    .trim();

/// The further of two delivery states of the same message (a late copy never moves a tick back).
Delivery furtherDelivery(Delivery a, Delivery b) {
  if (a == Delivery.failed || b == Delivery.failed) return a == Delivery.failed ? b : a;
  return a.index >= b.index ? a : b;
}
