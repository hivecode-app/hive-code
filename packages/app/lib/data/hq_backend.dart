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
  final _boardShift = <String, String>{}; // identity -> live shift id
  final _askToInbox = <String, int>{};

  @override
  CompanyData? get data => _data;
  @override
  SystemStatus get status => _status;
  @override
  String get label => Uri.tryParse(baseUrl)?.host ?? baseUrl;

  Map<String, String> get _headers => {'authorization': 'Bearer $token', 'content-type': 'application/json'};

  Future<dynamic> _get(String path) async {
    final r = await _http.get(Uri.parse('$baseUrl$path'), headers: _headers).timeout(const Duration(seconds: 10));
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
      if (r.statusCode == 401) return const CommandResult.fail('השרת לא קיבל את הטוקן. יש לבדוק אותו בהגדרות.');
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
      _connect();
    } catch (_) {
      _setDown();
      _scheduleRetry();
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    _refresh?.cancel();
    _wsSub?.cancel();
    _ws?.sink.close();
    _http.close();
    super.dispose();
  }

  void _setDown() {
    _downSince ??= DateTime.now();
    final t = _downSince!;
    _status = SystemStatus(LinkState.offline, since: '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}');
  }

  void _scheduleRetry() {
    _retry?.cancel();
    if (_disposed) return;
    _retry = Timer(const Duration(seconds: 5), () async {
      try {
        if (_data == null) await _load();
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
    final ws = u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws', path: '${u.path}/ws', queryParameters: {'after': '$_seq', 'token': token});
    _status = const SystemStatus(LinkState.connecting);
    _replayed = 0;
    try {
      _ws = WebSocketChannel.connect(ws);
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
        _setDown();
        notifyListeners();
        _scheduleRetry();
      },
    );
  }

  void _onEvent(Map<String, dynamic> e) {
    final type = e['type'] as String? ?? '';
    if (type == 'live') {
      final wasDown = _downSince != null;
      _downSince = null;
      _status = wasDown ? SystemStatus(LinkState.reconnected, updated: _replayed) : const SystemStatus(LinkState.online);
      if (wasDown) {
        Timer(const Duration(seconds: 3), () {
          if (_status.state == LinkState.reconnected) {
            _status = const SystemStatus(LinkState.online);
            notifyListeners();
          }
        });
        _refreshSoon();
      }
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
    if (identity != null && (type.startsWith('engine.') || type == 'shift.state')) {
      final chat = d.chats.putIfAbsent(identity, () => Conversation(identityId: identity, items: []));
      _engineFor(identity, chat).apply(e);
      notifyListeners();
    }
    if (type == 'message.state') {
      final data = (e['data'] as Map).cast<String, dynamic>();
      final chat = d.chats[data['to']];
      final m = chat?.items.whereType<UserMsg>().where((m) => m.id == data['id']).firstOrNull;
      if (m != null) {
        m.delivery = mapDelivery(data['state'] as String?);
        notifyListeners();
      }
    }
    if (type == 'message.new') {
      final m = (e['data'] as Map).cast<String, dynamic>();
      if (m['to_identity'] == 'owner' && m['kind'] != 'system') {
        final from = m['from_identity'] as String;
        final chat = d.chats.putIfAbsent(from, () => Conversation(identityId: from, items: []));
        if (!chat.items.any((i) => i.id == 'msg:${m['id']}')) {
          chat.items.add(TextMsg(id: 'msg:${m['id']}', ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int), text: m['body'] as String));
          if (openIdentity == from) unawaited(_send('POST', '/api/messages/${Uri.encodeComponent(m['id'] as String)}/handled'));
          _bumpConversation(from, m['body'] as String, m['created_at'] as int);
          notifyListeners();
        }
      }
    }
  }

  EngineModel _engineFor(String identity, Conversation chat) => _engines.putIfAbsent(
        identity,
        () => EngineModel(items: chat.items, gender: _data!.who(identity).gender, onLive: (l) => chat.live = l),
      );

  /// The conversation on screen (read = handled for what arrives while it is open).
  String? openIdentity;

  void _bumpConversation(String id, String line, int ts) {
    final d = _data;
    if (d == null) return;
    final i = d.conversations.indexWhere((c) => c.identityId == id);
    final c = ConversationSummary(
      identityId: id,
      lastLine: line.split('\n').first,
      time: _hm(ts),
      lastIsMine: true,
      unread: openIdentity == id ? 0 : 1,
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
    openIdentity = identityId;
    final d = _data;
    if (d == null) return;
    try {
      final res = await Future.wait([
        _get('/api/messages?identity=${Uri.encodeQueryComponent(identityId)}&limit=200'),
        _get('/api/events?identity=${Uri.encodeQueryComponent(identityId)}&after=${_seq > 20000 ? _seq - 20000 : 0}&limit=2000'),
      ]);
      final chat = Conversation(identityId: identityId, items: [], draft: d.chats[identityId]?.draft ?? '');
      final eng = EngineModel(items: chat.items, gender: d.who(identityId).gender, onLive: (l) => chat.live = l);
      for (final e in (res[1]['events'] as List).cast<Map<String, dynamic>>()) {
        eng.apply(e);
      }
      for (final m in (res[0]['messages'] as List).cast<Map<String, dynamic>>().reversed) {
        final ts = DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int);
        if (m['from_identity'] == 'owner') {
          chat.items.add(UserMsg(
            id: m['id'] as String,
            ts: ts,
            text: m['body'] as String,
            delivery: mapDelivery(m['state'] as String?),
            priority: Priority.values.byName((m['priority'] as String?) ?? 'next'),
          ));
        } else if (m['to_identity'] == 'owner') {
          if (m['kind'] == 'system') {
            chat.items.add(EventLine(id: 'msg:${m['id']}', ts: ts, text: m['body'] as String));
          } else {
            chat.items.add(TextMsg(id: 'msg:${m['id']}', ts: ts, text: m['body'] as String));
          }
          // He read it: mark it handled so the worker's mailbox closes the loop (B.4).
          if (m['state'] != 'handled') unawaited(_send('POST', '/api/messages/${Uri.encodeComponent(m['id'] as String)}/handled'));
        } else {
          final body = (m['body'] as String).replaceAll('\n', ' ');
          chat.items.add(EventLine(
            id: 'msg:${m['id']}',
            ts: ts,
            icon: 'forward',
            text: '${d.who(m['from_identity'] as String).name} ← ${d.who(m['to_identity'] as String).name}: ${body.length > 90 ? '${body.substring(0, 90)}…' : body}',
          ));
        }
      }
      for (final a in d.waiting.where((w) => w.from == identityId && w.askId != null)) {
        chat.items.add(AskCard(id: 'ask:${a.askId}', ts: DateTime.now(), askId: a.askId, from: identityId, question: a.body, options: a.options, blocking: a.blocking));
      }
      chat.items.sort((a, b) => a.ts.compareTo(b.ts));
      d.chats[identityId] = chat;
      _engines[identityId] = eng;
      notifyListeners();
    } catch (_) {
      // Keep what we have; the system strip already says the link is down.
    }
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

WorkerStatus mapStatus(String? s) => switch (s) {
      'working' => WorkerStatus.working,
      'waiting_for_you' => WorkerStatus.waiting,
      'blocked' => WorkerStatus.blocked,
      'stuck' => WorkerStatus.stuck,
      'restarting' => WorkerStatus.restarting,
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
  const teamSymbols = {'mgmt': 'explore', 'monitor': 'shield', 'personal': 'folder_shared', 'improve': 'build', 'lumo': 'local_shipping', 'tikibot': 'smart_toy', 'voice': 'graphic_eq'};
  final teams = <String, Team>{};
  final ids = <String, Identity>{};
  final presence = <String, Presence>{};
  for (final b in board) {
    final id = b['id'] as String;
    final team = (b['team'] as String?) ?? 'company';
    final symbol = (b['symbol'] as String?)?.isNotEmpty == true && RegExp(r'^[a-z_]+$').hasMatch(b['symbol'] as String) ? b['symbol'] as String : (teamSymbols[team] ?? 'build');
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
        lastLine: ((b['task'] as Map?)?['title'] as String?) ?? (ids[b['id']]?.title ?? ''),
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
