import '../model/task_progress.dart';
import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';

import 'search.dart';

// Backend against packages/hq (HTTP + one WebSocket, token auth, B.8). Endpoints as on the hq
// lane's branch (packages/hq/src/api.ts):
//   GET  /api/org /api/board /api/inbox /api/asks /api/toggles /api/messages?identity= /api/events?identity=&after=[&tail=1]
//   POST /api/asks/:id/answer  /api/inbox/:id/{done,dismiss,snooze,ack}  /api/messages/tell  /api/shifts/:id/interrupt
//   POST /api/uploads (raw image bytes) → {upload:{id,…}}  ·  GET /api/uploads/:id (the bytes)
//   PUT  /api/toggles/:key
//   GET  /api/conversations  ·  POST /api/conversations/:id/{read,mute}  ·  PUT /api/presence {identity}
//   GET  /api/home  (the head of the conversations screen: hq's recipe of blocks, home.ts)
//   WS   /ws?after=<seq>  (replay, then {type:'live'}, then live events; deltas have seq 0)
// The app reaches hq through Caddy at <base>/hq (deploy/caddy/agent-company.caddy).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../model/company_time.dart' as company_time;
import '../model/home_recipe.dart';
import '../model/map_day.dart';
import '../model/resources.dart';
import '../model/models.dart';
import '../theme/icons.dart';
import 'backend.dart';
import 'engine_model.dart';
import 'error_report.dart';

class HqBackend extends Backend {
  HqBackend({required this.baseUrl, required this.token, http.Client? client}) : _http = client ?? http.Client();

  @override
  Future<List<SearchHit>> search(String query) async {
    final uri = Uri.parse('$baseUrl/api/search').replace(queryParameters: {'q': query});
    final res = await _http.get(uri, headers: {'authorization': 'Bearer $token'}).timeout(const Duration(seconds: 15));
    if (res.statusCode != 200) throw StateError('search: ${res.statusCode}');
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    return [for (final row in j['results'] as List) SearchHit.fromJson(Map<String, dynamic>.from(row as Map))];
  }

  @override
  Future<List<TaskProgress>> taskProgress() async => taskRows((await _get('/api/tasks'))['pipeline']).map(TaskProgress.fromJson).toList();
  @override
  Future<TaskProgress?> taskDetail(int id) async => TaskProgress.fromJson(Map<String, dynamic>.from((await _get('/api/tasks/$id'))['task'] as Map));
  @override
  Future<TaskActivity> taskActivity(int id) async => TaskActivity.fromJson(Map<String, dynamic>.from(await _get('/api/tasks/$id/activity')));
  @override
  Future<CommandResult> startTask(int id) => _send('POST', '/api/tasks/$id/start');
  @override
  Future<List<OrgPerson>> organization() async {
    final people = taskRows((await _get('/api/org/tree'))['people']).map(OrgPerson.fromJson).toList();
    _orgPeople = people;
    _orgBoundData = null;
    _includeOrgPeople();
    return people;
  }
  @override
  Future<bool> revealMessage(String identity, String message) async {
    final j = await _get('/api/messages/${Uri.encodeComponent(message)}/source');
    if (j['identity'] != identity || _data == null) return false;
    final d = _data!, chat = d.chats.putIfAbsent(identity, () => Conversation(identityId: identity, items: []));
    final earlier = <ChatItem>[];
    for (final m in taskRows(j['messages']).reversed) {
      chat.refs[m['id'] as String] = RefMessage(from: m['from_identity'] as String, to: m['to_identity'] as String, body: m['body'] as String,
        ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int));
      if (!chat.items.any((x) => (x.id == m['id'] || x.id == 'msg:${m['id']}'))) {
        final item = _messageItem(m, d, [...chat.items, ...earlier]);
        if (item != null) earlier.add(item);
      }
    }
    chat.items.insertAll(0, earlier);
    notifyListeners();
    return chat.refs.containsKey(message);
  }

  @override
  void relocalize() {
    final s = _snapshotRaw, previous = _data;
    if (s == null || previous == null) return;
    final board = Map<String, dynamic>.from(s['board'] as Map);
    companyNames = CompanyNames.fromJson(board['names']);
    _data = mapSnapshot(
      board: _list(board, 'identities'),
      inbox: inboxOf(Map<String, dynamic>.from(s['inbox'] as Map)),
      asks: _list(Map<String, dynamic>.from(s['asks'] as Map), 'asks'),
      toggles: _list(Map<String, dynamic>.from(s['toggles'] as Map), 'toggles'),
      tasks: _list(board, 'tasks'),
      projects: _list(board, 'projects'),
      awaiting: _list(board, 'awaiting'),
      asked: _list(board, 'asked'),
      openTasks: board['open_tasks'] is List ? _list(board, 'open_tasks') : null,
      manager: board['manager'] as String? ?? '',
      ownerLanguage: board['owner_language'] == 'he' ? 'he' : 'en',
      previous: previous,
    );
    _data!
      ..home = previous.home
      ..recent = previous.recent
      ..estimates = previous.estimates;
    if (_lastLines != null) _applyLastLines(_data!, _lastLines!);
    notifyListeners();
  }

  /// e.g. `https://app.hq.example.com/<secret>/hq`
  @override
  String get storageScope => baseUrl;
  final String baseUrl;
  final String token;
  final http.Client _http;

  CompanyData? _data;
  CompanyData? _orgBoundData;
  List<OrgPerson> _orgPeople = [];
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

  /// hq says `{type:'ping'}` every 20 s. A phone that slept or changed networks keeps a socket that looks
  /// open and carries nothing: the screen froze on old states with no "לא מחובר". Once hq is known to
  /// ping, this long without a word means the link is dead, and it is replaced.
  static const kSilence = Duration(seconds: 50);
  @visibleForTesting
  Duration silence = kSilence;
  Timer? _silence;
  bool _hqPings = false;

  /// The next 'live' reloads the snapshot and the open conversation, as after a drop: set when the
  /// link is replaced without having been seen down (back from the background, a silent socket).
  bool _resync = false;
  DateTime? _hiddenAt;

  /// Every socket opened is a new generation; a retry from an older one does nothing.
  int _linkGen = 0;
  DateTime? _linkAt;

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
  CompanyData? get data { _includeOrgPeople(); return _data; }
  // Snapshot refresh and language changes must not erase people absent from the live board.
  void _includeOrgPeople() {
    final d = _data;
    if (d == null || identical(_orgBoundData, d)) return;
    for (final p in _orgPeople) {
      if (!p.active || !d.identities.containsKey(p.id)) {
        d.identities[p.id] = Identity(id: p.id, name: p.name, title: p.title, teamId: p.project ?? '', temp: p.tasks.isNotEmpty);
      }
      if (p.tasks.isNotEmpty && p.tasks.every((t) => t.state == 'done')) {
        d.presence.putIfAbsent(p.id, () => const Presence(status: WorkerStatus.done));
      }
    }
    _orgBoundData = d;
  }
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

  /// [onJson] gets the reply's body when hq took it (what it did: e.g. whether anyone was told).
  Future<CommandResult> _send(String method, String path, [Map<String, dynamic>? body, void Function(Map<String, dynamic>)? onJson]) async {
    try {
      final req = http.Request(method, Uri.parse('$baseUrl$path'))
        ..headers.addAll(_headers)
        ..body = jsonEncode(body ?? {});
      final r = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 10)));
      if (r.statusCode == 200) {
        if (onJson != null) {
          try {
            onJson(jsonDecode(utf8.decode(r.bodyBytes)) as Map<String, dynamic>);
          } catch (_) {}
        }
        return const CommandResult.ok();
      }
      if (r.statusCode == 401) {
        _refused();
        return CommandResult.localized(() => UiCopy.copy.thisDeviceWas);
      }
      if (r.statusCode == 404 || r.statusCode == 409) return CommandResult.localized(() => UiCopy.copy.thisItemWas, gone: true);
      // 502-504: the proxy is up and hq is not (a restart). The request never reached it.
      if (r.statusCode >= 502 && r.statusCode <= 504) return CommandResult.localized(() => UiCopy.copy.noConnectionServerAction, transient: true);
      return CommandResult.localized(() => UiCopy.copy.serverDidNotAccept);
    } catch (_) {
      return CommandResult.localized(() => UiCopy.copy.noConnectionServerAction, transient: true);
    }
  }

  /// What he was shown goes to hq (error_report.dart); 0 when it did not get there.
  Future<int> _postError(Map<String, dynamic> body) async {
    final r = await _http.post(Uri.parse('$baseUrl/api/client-errors'), headers: _headers, body: jsonEncode(body)).timeout(const Duration(seconds: 10));
    return r.statusCode;
  }

  @override
  Future<void> start() async {
    ErrorReports.instance.attach(_postError);
    // The last snapshot on this device shows at once (quality.md: "מחכה לך" from cache in <=1s);
    // the fresh one replaces it a moment later.
    await _restoreCache();
    try {
      await _load();
      notifyListeners(); // the snapshot shows at once; the WebSocket only adds what is new
      unawaited(_loadHome(opened: true));
      _connect();
      _homeTick = Timer.periodic(const Duration(minutes: 1), (_) {
        if (_visible && !_disposed) unawaited(_loadHome(looking: true));
      });
    } catch (_) {
      _setDown();
      _scheduleRetry();
      notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    ErrorReports.instance.detach(_postError);
    _homeTick?.cancel();
    _replayGuard?.cancel();
    _onlineAgain?.cancel();
    _silence?.cancel();
    _saveTimer?.cancel();
    _heartbeat?.cancel();
    _convsSoon?.cancel();
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
    // On data from the device cache, "since" is when that data was current, not when the link failed.
    _downSince ??= _fromCache ?? company_time.CompanyTime.now();
    final t = _downSince!;
    final hm = company_time.hm(t);
    // Cached data can be days old: "אתמול 22:10" or "18/10 22:10", never a bare time that reads as today.
    final since = switch (company_time.daysAgo(t, company_time.CompanyTime.now())) {
      0 => hm,
      1 => UiCopy.copy.yesterday4(hm),
      _ => '${company_time.dm(t)} $hm',
    };
    _status = SystemStatus(LinkState.offline, since: since);
  }

  void _scheduleRetry() {
    _retry?.cancel();
    if (_disposed || _unauthorized) return;
    final gen = _linkGen;
    _retry = Timer(const Duration(seconds: 5), () async {
      if (_unauthorized) return;
      // A socket opened while this waited on hq (back from the background) is the link now: never replace it.
      bool stale() => _disposed || gen != _linkGen;
      try {
        // A refused WS handshake (device revoked while the link was down) looks like any network
        // error; one plain request tells them apart, and a 401 there sends the app to sign-in.
        if (_data == null) {
          await _load();
          notifyListeners(); // show the snapshot before the WebSocket replays
        } else {
          await _get('/api/toggles');
        }
        if (stale()) return;
        _connect();
      } catch (_) {
        if (stale()) return;
        _scheduleRetry();
      }
      notifyListeners();
    });
  }

  // ── snapshot ─────────────────────────────────────────────────────────────

  /// A list field that an older hq (or an older cached snapshot) may not have.
  static List<Map<String, dynamic>> _list(dynamic m, String k) => m is Map && m[k] is List ? (m[k] as List).cast<Map<String, dynamic>>() : const [];

  Future<void> _load() async {
    final results = await Future.wait([_get('/api/board'), _get('/api/inbox'), _get('/api/asks'), _get('/api/toggles')]);
    final board = (results[0]['identities'] as List).cast<Map<String, dynamic>>();
    final inbox = inboxOf(results[1]);
    final asks = (results[2]['asks'] as List).cast<Map<String, dynamic>>();
    final toggles = (results[3]['toggles'] as List).cast<Map<String, dynamic>>();
    // org.yaml `timezone` (#121): before the mapping, so "today" and every hour in it are his.
    company_time.CompanyTime.apply(results[0]['timezone']);
    final prev = _data;
    if (results[0] is Map && (results[0] as Map).containsKey('names')) companyNames = CompanyNames.fromJson(results[0]['names']);
    _data = mapSnapshot(
      board: board,
      inbox: inbox,
      asks: asks,
      toggles: toggles,
      tasks: _list(results[0], 'tasks'),
      projects: _list(results[0], 'projects'),
      awaiting: _list(results[0], 'awaiting'),
      asked: _list(results[0], 'asked'),
      openTasks: results[0]['open_tasks'] is List ? _list(results[0], 'open_tasks') : null,
      manager: (results[0]['manager'] as String?) ?? '',
      ownerLanguage: results[0]['owner_language'] == 'he' ? 'he' : 'en',
      previous: prev,
    );
    // Order and last lines from the last messages fetch, right away: without them the list showed
    // board order, then jumped into recency order when the messages came back (on every event).
    final lines = _lastLines;
    if (lines != null) {
      try {
        _applyLastLines(_data!, lines);
      } catch (_) {
        _lastLines = null; // never let a bad copy block every reload
      }
    }
    // "בדקתי" still on its way: a board fetched before hq took it must not bring the row back for a moment.
    if (_checking.isNotEmpty) {
      _data!.awaiting = [
        for (final x in _data!.awaiting)
          if (!_checking.contains(x.id)) x,
      ];
    }
    _snapshotRaw = {'board': results[0], 'inbox': results[1], 'asks': results[2], 'toggles': results[3]};
    // The head keeps the recipe it had until the fresh one is in: no flash of the default on every reload.
    _data!.home = prev?.home;
    _data!.estimates = _estimates;
    unawaited(_loadEstimates());
    unawaited(_loadHome());
    _fromCache = null;
    if (!_fresh.isCompleted) _fresh.complete();
    final open = openIdentity, openChat = open == null ? null : _data!.chats[open];
    if (open != null && openChat != null && !_midFetch.containsKey(open)) syncAskCards(openChat, open, _data!);
    if (open != null && _openFailed.contains(open)) unawaited(openConversation(open));
    for (final b in board) {
      final sh = b['shift'] as Map?;
      if (sh != null && sh['state'] == 'live') _boardShift[b['id'] as String] = sh['id'] as String;
    }
    for (final i in inbox) {
      if (i['ref'] != null) _askToInbox[i['ref'] as String] = i['id'] as int;
    }
    unawaited(_loadLastLines());
    unawaited(_loadSeen());
  }

  @override
  Future<MapDay?> companyDay(String date) async {
    try {
      return MapDay.fromJson((await _get('/api/company-day?date=${Uri.encodeQueryComponent(date)}')) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<ResourcesView?> resources() async {
    try {
      return ResourcesView.fromJson((await _get('/api/resources')) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  @override
  Future<MapBody?> companyMessage(String id) async {
    try {
      final j = (await _get('/api/company-day/messages/${Uri.encodeComponent(id)}')) as Map<String, dynamic>;
      return MapBody(id, j['body'] as String);
    } catch (_) {
      return null;
    }
  }

  /// The week's estimates by task (`GET /api/estimates`); empty from an hq without it.
  Map<int, Estimate> _estimates = {};
  String? _estimatesSig;

  Future<void> _loadEstimates() async {
    try {
      final since = DateTime.now().subtract(const Duration(days: 7)).millisecondsSinceEpoch;
      final res = (await _get('/api/estimates?since=$since&limit=1000')) as Map<String, dynamic>;
      final rows = res['estimates'];
      if (rows is! List) return;
      final sig = jsonEncode(rows);
      final next = Estimate.byTask(rows.whereType<Map<String, dynamic>>());
      _estimates = next;
      _data?.estimates = next;
      if (sig != _estimatesSig) {
        _estimatesSig = sig;
        notifyListeners();
      }
    } catch (_) {
      // An older hq (404) or a blip: the last copy stands.
    }
  }

  /// When he last left each screen, from hq (`GET /api/seen`); empty from an hq without it.
  final Map<String, DateTime> _seen = {};

  @override
  DateTime? seenAt(String screen) => _seen[screen];

  Future<void> _loadSeen() async {
    try {
      final res = (await _get('/api/seen')) as Map<String, dynamic>;
      final seen = res['seen'];
      if (seen is! Map) return;
      var changed = false;
      for (final e in seen.entries) {
        if (e.value is int) changed |= _seenAt(e.key as String, e.value as int);
      }
      if (changed) notifyListeners();
    } catch (_) {
      // An older hq (404) or a blip: this device's own value stands in.
    }
  }

  /// Only forward, as in hq. True when it moved.
  bool _seenAt(String screen, int ms) {
    final t = DateTime.fromMillisecondsSinceEpoch(ms), was = _seen[screen];
    if (was != null && !t.isAfter(was)) return false;
    _seen[screen] = t;
    return true;
  }

  @override
  Future<void> markSeen(String screen, DateTime at) async {
    _seenAt(screen, at.millisecondsSinceEpoch);
    await _send('PUT', '/api/seen/${Uri.encodeComponent(screen)}', {'at': at.millisecondsSinceEpoch});
  }

  /// The head of the conversations screen (GET /api/home): hq's recipe with live data applied. Asked again
  /// on every snapshot reload and once a minute while the app is in front (a recipe goes stale after 30 minutes).
  Map<String, dynamic>? _homeRaw;
  Timer? _homeTick;

  /// [opened]: he is looking at the app now (it started, or came to the front). hq counts a new visit from it
  /// ("מאז שהיית פה"), so a reload in the background must not say it. [looking]: the minute's reload while he is
  /// in front, which keeps the visit going; a reload on an event says neither (the app may be open behind).
  Future<void> _loadHome({bool opened = false, bool looking = false}) async {
    try {
      final j = (await _get(
        opened
            ? '/api/home?opened=1'
            : looking
            ? '/api/home?looking=1'
            : '/api/home',
      )) as Map<String, dynamic>;
      final d = _data;
      if (d == null) return;
      d.home = HomeRecipe.fromJson(j);
      _homeRaw = j;
      notifyListeners();
      _saveSoon();
    } catch (_) {
      // An older hq (404) or a blip: the head keeps what it had.
    }
  }

  /// Last line and time per conversation, newest first, Yoav pinned (APP-SPEC §4.3).
  Future<void> _loadLastLines() async {
    final d = _data;
    if (d == null) return;
    try {
      final res = (await _get('/api/messages?identity=owner&limit=200')) as Map<String, dynamic>;
      await _loadConvs();
      final now = _data;
      if (now == null) return;
      _applyLastLines(now, res);
      _lastLines = _latestPerConversation(res);
      notifyListeners();
      _saveSoon();
    } catch (_) {}
  }

  /// hq's unread count and mute per conversation (GET /api/conversations); null from an hq without it.
  Map<String, Map<String, dynamic>>? _convs;

  Future<void> _loadConvs() async {
    try {
      final res = (await _get('/api/conversations')) as Map<String, dynamic>;
      _convs = {for (final c in _list(res, 'conversations')) c['identity'] as String: c};
    } catch (_) {
      // An older hq (404) or a blip: the counts keep what they had.
    }
  }

  /// A conversation read or muted on any device: fresh counts from hq, applied in place.
  Timer? _convsSoon;
  void _refreshConvs() {
    _convsSoon?.cancel();
    _convsSoon = Timer(const Duration(milliseconds: 300), () async {
      await _loadConvs();
      final d = _data, convs = _convs;
      if (d == null || convs == null) return;
      for (final (i, c) in d.conversations.indexed) {
        final st = convs[c.identityId];
        if (st != null) d.conversations[i] = c.copyWith(unread: openIdentity == c.identityId && _visible ? 0 : st['unread'] as int? ?? 0, muted: st['muted_until'] != null);
      }
      notifyListeners();
    });
  }

  /// The owner's latest messages (raw /api/messages), kept for ordering the conversation list.
  Map<String, dynamic>? _lastLines;
  Map<String, dynamic>? _snapshotRaw;

  /// Last line and time per conversation, newest first, Yoav pinned (APP-SPEC §4.3).
  void _applyLastLines(CompanyData d, Map<String, dynamic> res) {
    final seen = <String>{};
    for (final m in (res['messages'] as List).cast<Map<String, dynamic>>()) {
      final other = m['from_identity'] == 'owner' ? m['to_identity'] as String : m['from_identity'] as String;
      if (other == kSystemId || !seen.add(other)) continue; // the system has no conversation (#55)
      final i = d.conversations.indexWhere((c) => c.identityId == other);
      final st = _convs?[other];
      final own = m['from_identity'] == 'owner' ? ownLine(m) : null;
      // A card he closed with a tap is not words of his: no "אתה: " and no ticks (task 205).
      final mine = own != null && !own.tapped;
      final c = ConversationSummary(
        identityId: other,
        lastLine: (mine ? UiCopy.copy.you2 : '') + (own?.text ?? lastLineOf(m)),
        time: _hm(m['created_at'] as int),
        at: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int),
        delivery: mine ? mapDelivery(m['state'] as String?) : null,
        text: own?.text ?? lastLineOf(m),
        msgId: m['id'] as String?,
        lastIsMine: !mine,
        // hq's count, read on any device; an hq without it: the latest message, until it is handled.
        unread: openIdentity == other && _visible
            ? 0
            : st != null
            ? st['unread'] as int? ?? 0
            : (m['to_identity'] == 'owner' && m['state'] != 'handled' ? 1 : 0),
        pinned: other == d.managerId,
        muted: st?['muted_until'] != null,
      );
      if (i >= 0) {
        d.conversations[i] = c;
      } else {
        d.conversations.add(c);
      }
    }
    d.recent = [
      for (final m in (res['messages'] as List).cast<Map<String, dynamic>>())
        if ((m['from_identity'] == 'owner' ? m['to_identity'] : m['from_identity']) case final String id when id != kSystemId)
          (
            id: id,
            text: m['from_identity'] == 'owner' ? ownLine(m).text : lastLineOf(m),
            at: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int),
            mine: m['from_identity'] == 'owner' && !ownLine(m).tapped,
          ),
    ];
    // Recent first, then the rest; Yoav stays pinned in the list widget.
    final order = [for (final m in (res['messages'] as List)) (m['from_identity'] == 'owner' ? m['to_identity'] : m['from_identity']) as String];
    int rank(ConversationSummary c) {
      final r = order.indexOf(c.identityId);
      return r < 0 ? 1 << 20 : r;
    }

    d.conversations.sort((a, b) => rank(a).compareTo(rank(b)));
  }

  // ── the last snapshot on this device ─────────────────────────────────────

  static const kCacheKey = 'hq.snapshot.v1';

  Future<void> _restoreCache() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(kCacheKey);
      if (raw == null) return;
      final c = jsonDecode(raw) as Map<String, dynamic>;
      if (c['url'] != baseUrl) return;
      List<Map<String, dynamic>> list(String k, String f) => ((c[k] as Map)[f] as List).cast<Map<String, dynamic>>();
      company_time.CompanyTime.apply((c['board'] as Map)['timezone']);
      if (c['board'] is Map && (c['board'] as Map).containsKey('names')) companyNames = CompanyNames.fromJson(c['board']['names']);
      _data = mapSnapshot(
        board: list('board', 'identities'),
        inbox: inboxOf(c['inbox']),
        asks: list('asks', 'asks'),
        toggles: list('toggles', 'toggles'),
        tasks: _list(c['board'], 'tasks'),
        projects: _list(c['board'], 'projects'),
        awaiting: _list(c['board'], 'awaiting'),
        asked: _list(c['board'], 'asked'),
        openTasks: (c['board'] as Map)['open_tasks'] is List ? _list(c['board'], 'open_tasks') : null,
        manager: ((c['board'] as Map)['manager'] as String?) ?? '',
        ownerLanguage: (c['board'] as Map)['owner_language'] == 'he' ? 'he' : 'en',
      );
      if (c['home'] is Map) {
        try {
          _data!.home = HomeRecipe.fromJson((c['home'] as Map).cast<String, dynamic>());
          _homeRaw = (c['home'] as Map).cast<String, dynamic>();
        } catch (_) {}
      }
      final lines = c['messages'] as Map<String, dynamic>?;
      if (lines != null) {
        try {
          _applyLastLines(_data!, lines);
          _lastLines = lines;
        } catch (_) {}
      }
      _fromCache = c['saved'] is int ? DateTime.fromMillisecondsSinceEpoch(c['saved'] as int) : company_time.CompanyTime.now();
      notifyListeners();
    } catch (_) {
      // A cache that doesn't parse is just not used.
    }
  }

  /// When the data on screen came from the device cache: when that snapshot was saved.
  DateTime? _fromCache;
  Timer? _saveTimer;

  /// Inbox events come in bursts; the cache is written at most every 3 seconds.
  void _saveSoon() {
    if (_saveTimer?.isActive ?? false) return;
    _saveTimer = Timer(const Duration(seconds: 3), _saveCache);
  }

  Future<void> _saveCache() async {
    final snap = _snapshotRaw;
    if (snap == null || _disposed) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      try {
        await prefs.setString(
          kCacheKey,
          jsonEncode({
            'url': baseUrl,
            'saved': company_time.CompanyTime.now().millisecondsSinceEpoch,
            ...snap,
            if (_lastLines != null) 'messages': _lastLines,
            if (_homeRaw != null) 'home': _homeRaw,
          }),
        );
      } catch (_) {
        await prefs.remove(kCacheKey); // a cache that can't be written must not go on aging
      }
    } catch (_) {
      // No preferences store here (a bare test): nothing to cache into.
    }
  }

  /// Only what the conversation list needs: each conversation's latest message, first line only.
  static Map<String, dynamic> _latestPerConversation(Map<String, dynamic> res) {
    final seen = <String>{};
    final out = <Map<String, dynamic>>[];
    for (final m in (res['messages'] as List).cast<Map<String, dynamic>>()) {
      final other = m['from_identity'] == 'owner' ? m['to_identity'] : m['from_identity'];
      if (!seen.add(other as String)) continue;
      out.add({
        'from_identity': m['from_identity'],
        'to_identity': m['to_identity'],
        'id': m['id'],
        // His: two lines, enough for [ownLine] to tell a tapped card ("סיים: …") from one with his note.
        'body': m['from_identity'] == 'owner' ? (m['body'] as String).split('\n').take(2).join('\n') : lastLineOf(m),
        if (m['attachments'] != null) 'attachments': m['attachments'],
        'created_at': m['created_at'],
        'state': m['state'],
      });
    }
    return {'messages': out};
  }

  /// What an inbox event does (a snapshot reload), for tests.
  @visibleForTesting
  Future<void> debugReload() async {
    await _load();
    notifyListeners();
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

  /// [quiet]: a link that looks fine is being replaced; the status stays as it is until it fails.
  void _connect({bool quiet = false}) {
    _linkGen++;
    _linkAt = company_time.CompanyTime.now();
    _wsSub?.cancel();
    _ws?.sink.close();
    final u = Uri.parse(baseUrl);
    // First connect: no cursor, so hq sends only its recent tail (the snapshot already has the
    // state). Sending after=0 made it replay its whole history, 6,000 events and growing, on every
    // start. A reconnect resumes from the last seq it saw, so nothing is lost.
    final first = !_connectedOnce;
    final ws = u.replace(scheme: u.scheme == 'https' ? 'wss' : 'ws', path: '${u.path}/ws', queryParameters: {if (!first) 'after': '$_seq', 'token': token});
    if (!quiet || _status.state != LinkState.online) _status = const SystemStatus(LinkState.connecting);
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
    _heard();
    _wsSub = _ws!.stream.listen(
      (raw) {
        _heard();
        _onEvent(jsonDecode(raw as String) as Map<String, dynamic>);
      },
      onError: (_) {
        _silence?.cancel();
        _setDown();
        notifyListeners();
        _scheduleRetry();
      },
      onDone: () {
        if (_disposed) return;
        _silence?.cancel();
        if (_ws?.closeCode == 4401) return _refused(); // this device was revoked
        _setDown();
        notifyListeners();
        _scheduleRetry();
      },
    );
  }

  /// Something came over the socket: the silence clock starts again.
  void _heard() {
    _silence?.cancel();
    if (!_hqPings || _disposed) return;
    _silence = Timer(silence, () {
      if (_disposed || _unauthorized) return;
      // In the background nobody looks: replaced quietly, no "לא מחובר" for the moment he comes back to.
      if (_visible) {
        _setDown();
        notifyListeners();
      }
      _replaceLink();
    });
  }

  /// A new socket now, resuming from the last seq; the 'live' after it reloads what the screen shows.
  void _replaceLink() {
    _retry?.cancel();
    _silence?.cancel();
    _resync = true;
    _connect(quiet: true);
  }

  @visibleForTesting
  void debugReplaceLink() => _replaceLink();

  void _onEvent(Map<String, dynamic> e) {
    final type = e['type'] as String? ?? '';
    if (type == 'ping') {
      if (!_hqPings) {
        _hqPings = true;
        _heard();
      }
      return;
    }
    if (type == 'live') {
      _replaying = false;
      _holdRedraws = false;
      _connectedOnce = true;
      _replayGuard?.cancel();
      final liveSeq = (e['seq'] as num?)?.toInt() ?? 0;
      if (liveSeq > _seq) _seq = liveSeq;
      final wasDown = _downSince != null;
      final resync = wasDown || _resync;
      _resync = false;
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
      }
      // What happened while the link was gone (a delivery, a shift that ended, a tool that finished) is
      // in hq's state, not only in the replay: the board and the open conversation are fetched again.
      if (resync) _refreshSoon();
      final open = openIdentity;
      if (open != null && (resync || _openFailed.contains(open))) unawaited(openConversation(open));
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

    if (type.startsWith('inbox.') || type.startsWith('ask.') || type == 'shift.state' || type == 'task.pr' || type == 'tasks.progress' || type == 'task.new' || type == 'task.state' || type == 'toggle.changed' || type.startsWith('watchdog.')
        || type == 'home.composed' || type == 'task.awaiting' || type == 'deploy.recorded' || type == 'asked.changed'
        // A new quota read (every 10 minutes): the home's "המכסה" card.
        ||
        type == 'accounts.quota' ||
        type == 'codex.quota'
        // A turn that ended: the header's "עובד"/"פנוי" comes from the board.
        ||
        type == 'engine.result') {
      _refreshSoon();
    }
    if (type == 'upload.ready' && e['data'] is Map) {
      final raw = (e['data'] as Map)['upload'];
      if (raw is Map) {
        final ready = Attachment.fromJson(raw.cast<String, dynamic>());
        for (final chat in d.chats.values) {
          for (final message in chat.items) {
            final attachments = switch (message) {
              UserMsg m => m.attachments,
              TextMsg m => m.attachments,
              _ => <Attachment>[],
            };
            for (var i = 0; i < attachments.length; i++) {
              final old = attachments[i];
              if (old.id == ready.id) {
                attachments[i] = Attachment(name: ready.name, bytes: ready.bytes, mime: ready.mime, id: ready.id, meta: ready.meta, data: old.data, transfer: old.transfer);
              }
            }
          }
        }
        notifyListeners();
      }
    }
    if (type == 'message.updated' && e['data'] is Map) {
      final raw = (e['data'] as Map).cast<String, dynamic>();
      final chat = d.chats[raw['from_identity']];
      final message = chat?.items.whereType<TextMsg>().where((m) => m.id == 'msg:${raw['id']}').firstOrNull;
      if (message != null) {
        message.text = raw['body'] as String;
        message.artifact = (raw['artifact'] as Map?)?.cast<String, dynamic>();
      }
      artifactRevision.value++;
      notifyListeners();
    }
    if (type == 'artifact.expired' || type == 'artifact.updated') {
      final payload = e['data'] as Map;
      for (final chat in d.chats.values) {
        for (final message in chat.items.whereType<TextMsg>()) {
          if (type == 'artifact.expired' && message.artifact?['id'] == payload['id']) message.artifact = {...message.artifact!, 'expired': true};
          if (type == 'artifact.updated' && payload['artifact'] is Map && message.artifact?['id'] == payload['artifact']['id']) {
            message.artifact = (payload['artifact'] as Map).cast<String, dynamic>();
          }
        }
      }
      artifactRevision.value++;
      notifyListeners();
    }
    if (type == 'conv.read' || type == 'conv.muted') _refreshConvs();
    // "ביקשת": hq says asked.changed itself; an answer coming in or a read of an answered one also reloads,
    // so the row never waits on that event (an hq from before it, or one lost in a reconnect).
    if (type == 'conv.read' && d.asked.any((a) => a.state == AskedState.answered && a.identity == identity)) _refreshSoon();
    if (type == 'message.new' && e['data'] is Map) {
      final m = e['data'] as Map;
      if (m['to_identity'] == 'owner' && m['kind'] != 'system' && d.asked.any((a) => a.state == AskedState.open && a.identity == m['from_identity'])) _refreshSoon();
    }
    if (type == 'seen.changed' && e['data'] is Map) {
      final data = e['data'] as Map;
      if (data['screen'] is String && data['at'] is int && _seenAt(data['screen'] as String, data['at'] as int)) notifyListeners();
    }
    // The first replay is history the snapshot and openConversation already cover: building chats
    // from it only cost time at start.
    // A conversation that is open or loading is not covered by it: its engine dedupes by seq, and a
    // tool_result skipped here left "מריץ פקודה" spinning for good.
    if (_skipEngineReplay && _replaying && type.startsWith('engine.') && !_engines.containsKey(identity) && !_midFetch.containsKey(identity)) return;
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
        m.waitingOn = WaitingOn.parse(data['waiting_on']) ?? m.waitingOn;
        notifyListeners();
      }
      // The ticks on his row move with the message (queued, delivered, read).
      final i = d.conversations.indexWhere((c) => c.msgId != null && c.msgId == data['id']);
      if (i >= 0 && d.conversations[i].delivery != null) {
        final c = d.conversations[i];
        d.conversations[i] = c.copyWith(delivery: furtherDelivery(c.delivery ?? Delivery.queued, mapDelivery(data['state'] as String?)));
        for (final m in (_lastLines?['messages'] as List?)?.cast<Map<String, dynamic>>() ?? const <Map<String, dynamic>>[]) {
          if (m['id'] == data['id']) m['state'] = data['state'];
        }
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
          final streamed = streamedAs(chat.items, m);
          if (streamed == null) {
            chat.items.add(
              TextMsg(
                id: 'msg:${m['id']}',
                ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int),
                text: m['body'] as String,
                artifact: (m['artifact'] as Map?)?.cast<String, dynamic>(),
                attachments: attachmentsOf(m),
              ),
            );
          } else if (streamed.attachments.isEmpty) {
            streamed.attachments = attachmentsOf(m);
          }
          // A note is what he already saw stream in a turn he did not start, kept: no unread, no move to the top.
          if (m['kind'] != 'note') {
            if (openIdentity == from) {
              unawaited(_send('POST', '/api/messages/${Uri.encodeComponent(m['id'] as String)}/handled'));
              if (_visible) _markRead(from);
            }
            _bumpConversation(from, m['body'] as String, m['created_at'] as int);
          }
          notifyListeners();
        }
      } else {
        // What he sends, from any device, brings its conversation to the top as "אתה: ", as in WhatsApp.
        if (from == 'owner' && to != kSystemId) _bumpMine(m);
        // The owner's own messages from another device, system lines, and messages between
        // workers: they belong to an open conversation (the one they involve), or wait for it.
        final chatId = from == 'owner' ? to : (to == 'owner' ? from : (openIdentity == from || openIdentity == to ? openIdentity : null));
        if (chatId == null || _buffer(chatId, e)) return;
        final chat = d.chats[chatId];
        if (chat == null) return;
        if (m['id'] is String && m['body'] is String && m['created_at'] is int) {
          chat.refs[m['id'] as String] = RefMessage(from: from, to: to, body: m['body'] as String, ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int));
        }
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
  ChatItem? _messageItem(Map<String, dynamic> m, CompanyData d, List<ChatItem> existing, {List<UserMsg> typed = const []}) {
    final ts = DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int);
    final card = m['from_identity'] == 'owner' && m['kind'] == 'answer' ? cardFor(existing, m['ref'] as String?) : null;
    if (card != null) return answerItem(m, card, d.who(card.from).name, [...existing, ...typed]);
    if (m['from_identity'] == 'owner') {
      // An answer whose card is no longer in the chat (answered, so out of the open asks) is still his words
      // alone: hq's "תשובה לשאלה <id>: " wrapping is for the worker.
      final body = m['kind'] == 'answer' ? answerText(m['body'] as String).$1 : m['body'] as String;
      return UserMsg(
        id: m['id'] as String,
        ts: ts,
        text: body,
        delivery: mapDelivery(m['state'] as String?),
        priority: Priority.values.byName((m['priority'] as String?) ?? 'next'),
        attachments: attachmentsOf(m),
        waitingOn: WaitingOn.parse(m['waiting_on']),
      );
    }
    if (m['to_identity'] == 'owner') {
      if (m['kind'] == 'system') return EventLine(id: 'msg:${m['id']}', ts: ts, text: m['body'] as String);
      final streamed = streamedAs(existing, m);
      if (streamed == null) {
        return TextMsg(id: 'msg:${m['id']}', ts: ts, text: m['body'] as String, artifact: (m['artifact'] as Map?)?.cast<String, dynamic>(), attachments: attachmentsOf(m));
      }
      // The text already streamed in; the images exist only in the stored copy.
      if (streamed.attachments.isEmpty) streamed.attachments = attachmentsOf(m);
      return null;
    }
    return InternalMsg(
      id: 'msg:${m['id']}',
      ts: ts,
      from: m['from_identity'] as String,
      to: m['to_identity'] as String,
      body: withoutIds(m['body'] as String),
      ref: m['ref'] as String?,
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

  EngineModel _engineFor(String identity, Conversation chat) =>
      _engines.putIfAbsent(identity, () => EngineModel(items: chat.items, gender: _data!.who(identity).gender, onLive: (l) => chat.live = l));

  /// The conversation on screen (read = handled for what arrives while it is open).
  String? get openIdentity => _shown.lastOrNull;
  final _shown = <String>[];

  @override
  void showConversation(String identityId) {
    _shown.add(identityId);
    _onScreenChanged();
  }

  /// The app is in front (AppLifecycleListener in main.dart): an open conversation is read only while he sees it.
  bool _visible = true;
  Timer? _heartbeat;

  @override
  void setVisible(bool visible) {
    if (_visible == visible) return;
    _visible = visible;
    if (!visible) _hiddenAt = company_time.CompanyTime.now();
    final away = _hiddenAt == null ? Duration.zero : company_time.CompanyTime.now().difference(_hiddenAt!);
    if (visible && _data != null) unawaited(_loadHome(opened: true));
    // Back from the background: the socket may have died without a word while the phone slept. A fresh
    // one, and a reload, so he never looks at the states from before he left (a focus blink is not "away").
    // (Not when one was just opened: the silence clock can fire as the phone wakes, before this is heard.)
    final fresh = _linkAt != null && company_time.CompanyTime.now().difference(_linkAt!) < const Duration(seconds: 3);
    if (visible && _data != null && _connectedOnce && !_unauthorized && !fresh && away >= const Duration(seconds: 10)) _replaceLink();
    _onScreenChanged();
  }

  /// Read what is on screen, and tell hq which conversation is there so a message in it doesn't alert him.
  /// Said again every 30 s while it stays (hq forgets a screen after 60 s: a killed app must not mute him).
  void _onScreenChanged() {
    final open = _visible ? openIdentity : null;
    if (open != null) _markRead(open);
    _sayPresence(open);
    _heartbeat?.cancel();
    _heartbeat = open == null
        ? null
        : Timer.periodic(const Duration(seconds: 30), (_) {
            final now = _visible ? openIdentity : null;
            if (now != null) _sayPresence(now);
          });
  }

  /// One presence request at a time, the latest value last: switching chats sends "closed" and "opened" back to
  /// back, and if they crossed on the way hq would keep the wrong one for 30 s.
  String? _presenceWanted;
  bool _presenceBusy = false;
  void _sayPresence(String? identity) {
    _presenceWanted = identity;
    if (_presenceBusy) return;
    _presenceBusy = true;
    unawaited(() async {
      try {
        String? sent;
        do {
          sent = _presenceWanted;
          await _send('PUT', '/api/presence', {'identity': sent});
        } while (!_disposed && sent != _presenceWanted);
      } finally {
        _presenceBusy = false;
      }
    }());
  }

  void _markRead(String identityId) {
    final d = _data;
    final i = d?.conversations.indexWhere((c) => c.identityId == identityId) ?? -1;
    if (i >= 0 && d!.conversations[i].unread > 0) {
      d.conversations[i] = d.conversations[i].copyWith(unread: 0);
      // Called from a screen being built (ChatScreen.didChangeDependencies): redraw after this frame's build.
      scheduleMicrotask(notifyListeners);
    }
    final st = _convs?[identityId];
    if (st != null) st['unread'] = 0;
    unawaited(_send('POST', '/api/conversations/${Uri.encodeComponent(identityId)}/read'));
  }

  @override
  Future<CommandResult> mute(String identityId, MuteFor duration) async {
    final r = await _send('POST', '/api/conversations/${Uri.encodeComponent(identityId)}/mute', {'for': duration.wire}, (j) {
      final c = j['conversation'];
      if (c is Map<String, dynamic>) (_convs ??= {})[identityId] = c;
    });
    final d = _data;
    final i = d?.conversations.indexWhere((c) => c.identityId == identityId) ?? -1;
    if (r.ok && i >= 0) {
      d!.conversations[i] = d.conversations[i].copyWith(muted: duration != MuteFor.off);
      notifyListeners();
    }
    return r;
  }

  /// His own message as the conversation's last line, with its delivery state (the row's ticks). A card he
  /// closed with a tap ("סיימת: …") moves the conversation up too, without "אתה: " and without ticks.
  void _bumpMine(Map<String, dynamic> m) {
    final d = _data;
    if (d == null) return;
    final id = m['to_identity'] as String, ts = m['created_at'] as int;
    final i = d.conversations.indexWhere((c) => c.identityId == id);
    final prev = i >= 0 ? d.conversations[i] : null;
    if (prev?.at != null && prev!.at!.millisecondsSinceEpoch > ts) return;
    final own = ownLine(m), line = own.text;
    // So a reload (or the cache at the next start) doesn't put back the line before his.
    _keepLast(id, {
      'id': m['id'],
      'from_identity': 'owner',
      'to_identity': id,
      'body': (m['body'] as String).split('\n').take(2).join('\n'),
      'attachments': m['attachments'],
      'created_at': ts,
      'state': m['state'],
    });
    final c = ConversationSummary(
      identityId: id,
      lastLine: own.tapped ? line : UiCopy.copy.you3(line),
      time: _hm(ts),
      at: DateTime.fromMillisecondsSinceEpoch(ts),
      delivery: own.tapped ? null : mapDelivery(m['state'] as String?),
      text: line,
      msgId: m['id'] as String?,
      unread: prev?.unread ?? 0,
      pinned: prev?.pinned ?? false,
      muted: prev?.muted ?? false,
    );
    if (i >= 0) d.conversations.removeAt(i);
    d.conversations.insert(0, c);
    _addRecent(d, (id: id, text: line, at: c.at!, mine: !own.tapped));
    notifyListeners();
  }

  /// [_lastLines] with [m] as [id]'s latest message.
  void _keepLast(String id, Map<String, dynamic> m) {
    final kept = _lastLines;
    if (kept == null) return;
    _lastLines = {
      'messages': [m, ...(kept['messages'] as List).cast<Map<String, dynamic>>().where((x) => (x['from_identity'] == 'owner' ? x['to_identity'] : x['from_identity']) != id)],
    };
  }

  /// A message for search, once: the first replay after a connect sends the last ones again.
  static void _addRecent(CompanyData d, RecentLine r) {
    if (d.recent.any((x) => x.id == r.id && x.at == r.at && x.text == r.text)) return;
    d.recent.insert(0, r);
  }

  void _bumpConversation(String id, String line, int ts) {
    final d = _data;
    if (d == null) return;
    final kept = _lastLines;
    if (kept != null) {
      // So the next reload doesn't put back the older line.
      final list = [...(kept['messages'] as List).cast<Map<String, dynamic>>()]
        ..removeWhere((m) => (m['from_identity'] == 'owner' ? m['to_identity'] : m['from_identity']) == id)
        ..insert(0, {
          'from_identity': id,
          'to_identity': 'owner',
          'body': line.split('\n').first,
          'created_at': ts,
          'state': openIdentity == id || (_skipEngineReplay && _replaying) ? 'handled' : 'delivered',
        });
      _lastLines = {'messages': list};
    }
    final i = d.conversations.indexWhere((c) => c.identityId == id);
    final prev = i >= 0 ? d.conversations[i] : null;
    // The first replay's tail is old news (the snapshot already counted it): only a live message adds one.
    final read = (openIdentity == id && _visible) || (_skipEngineReplay && _replaying);
    final unread = read ? (openIdentity == id ? 0 : prev?.unread ?? 0) : (prev?.unread ?? 0) + 1;
    final st = _convs?[id];
    if (st != null) st['unread'] = unread; // so a reload before hq's next count doesn't take it back
    final c = ConversationSummary(
      identityId: id,
      lastLine: line.split('\n').first,
      time: _hm(ts),
      at: DateTime.fromMillisecondsSinceEpoch(ts),
      text: line.split('\n').first,
      lastIsMine: true,
      unread: unread,
      pinned: prev?.pinned ?? false,
      muted: prev?.muted ?? false,
    );
    // Newest first, as in WhatsApp: a new message brings its conversation to the top of "אחרון".
    if (i >= 0) d.conversations.removeAt(i);
    d.conversations.insert(0, c);
    _addRecent(d, (id: id, text: line.split('\n').first, at: c.at!, mine: false));
  }

  @override
  Future<void> openConversation(String identityId) async {
    final current = _opening[identityId];
    if (current != null) return current;
    final job = _openConversation(identityId);
    _opening[identityId] = job;
    try { await job; } finally { _opening.remove(identityId); }
  }

  final _opening = <String, Future<void>>{};

  Future<void> _openConversation(String identityId) async {
    final d = _data;
    if (d == null) return;
    _midFetch[identityId] = [];
    try {
      final res = await Future.wait([
        _get('/api/messages?identity=${Uri.encodeQueryComponent(identityId)}&limit=200'),
        _get('/api/events?identity=${Uri.encodeQueryComponent(identityId)}&after=${_seq > 20000 ? _seq - 20000 : 0}&limit=2000&tail=1'),
      ]);
      final old = d.chats[identityId];
      final chat = Conversation(identityId: identityId, items: [], draft: old?.draft ?? '');
      final eng = EngineModel(items: chat.items, gender: d.who(identityId).gender, onLive: (l) => chat.live = l);
      final events = (res[1]['events'] as List).cast<Map<String, dynamic>>();
      for (final e in events) {
        eng.apply(e);
      }
      // Questions and GO requests stay in the conversation after they are answered, like any message.
      chat.items.addAll(historyCards(events, identityId));
      // Answers typed on this device are merged back below: seen here, the server's copy of one is not shown twice.
      final typed = [
        for (final m in (old?.items ?? const <ChatItem>[]).whereType<UserMsg>())
          if (m.replyTo?.askId != null) m,
      ];
      for (final m in (res[0]['messages'] as List).cast<Map<String, dynamic>>().reversed) {
        if (m['id'] is String && m['body'] is String && m['created_at'] is int) {
          chat.refs[m['id'] as String] = RefMessage(
            from: m['from_identity'] as String? ?? '',
            to: m['to_identity'] as String? ?? '',
            body: m['body'] as String,
            ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int),
          );
        }
        final item = _messageItem(m, d, chat.items, typed: typed);
        if (item != null) chat.items.add(item);
        // He read it: mark it handled so the worker's mailbox closes the loop (B.4).
        if (m['to_identity'] == 'owner' && m['kind'] != 'system' && m['state'] != 'handled') {
          unawaited(_send('POST', '/api/messages/${Uri.encodeComponent(m['id'] as String)}/handled'));
        }
      }
      syncAskCards(chat, identityId, _data ?? d); // the snapshot may have moved on while this loaded
      // Messages sent from here: keep the furthest delivery state either copy has seen, and keep
      // the ones hq doesn't have yet (in the queue, waiting for the link, or failed).
      final mine = {for (final m in chat.items.whereType<UserMsg>()) m.id: m};
      for (final m in (old?.items ?? const <ChatItem>[]).whereType<UserMsg>()) {
        final there = mine[m.id];
        if (there != null) {
          there.delivery = furtherDelivery(there.delivery, m.delivery);
        } else if (const {Delivery.queued, Delivery.pendingConnection, Delivery.failed}.contains(m.delivery) || m.replyTo?.askId != null) {
          mine[m.id] = m;
          chat.items.add(m);
        }
      }
      chat.items.sort((a, b) => a.ts.compareTo(b.ts));
      d.chats[identityId] = chat;
      _engines[identityId] = eng;
      _openFailed.remove(identityId);
      // What arrived while this loaded, applied to the new copy (the engine skips seqs it has). Deltas are
      // live-only (no seq): those of a text the history already has in full would open it a second time (#68).
      final done = {
        for (final t in chat.items.whereType<TextMsg>())
          if (!t.streaming) t.id,
      };
      final waiting = _midFetch.remove(identityId) ?? const [];
      for (final e in waiting) {
        if (e['type'] == 'engine.delta' && done.contains('t:${(e['data'] as Map?)?['messageId']}')) continue;
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
    if (!_disposed) _onScreenChanged();
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /// Completes when a snapshot from the server (not the device cache) is in.
  final _fresh = Completer<void>();

  /// An answer, a GO or a retry taken on what the cache showed waits for the fresh snapshot, and
  /// goes out only if the item is still open there: otherwise "already handled", never a silent
  /// no-op that looks like success.
  Future<CommandResult?> _stale(String? askId, int? inboxId, {bool answer = true}) async {
    if (_fresh.isCompleted) return null; // taken on fresh data: as usual
    try {
      await _fresh.future.timeout(const Duration(seconds: 10));
    } catch (_) {
      return CommandResult.localized(() => UiCopy.copy.noConnectionServerAction);
    }
    final d = _data;
    final open = d != null && d.waiting.any((w) => (askId != null && w.askId == askId) || (inboxId != null && w.inboxId == inboxId));
    if (open) return null;
    return CommandResult.fail(answer ? UiCopy.copy.thisItemWasAlready : UiCopy.copy.thisItemWasAlreadyHandled);
  }

  @override
  Future<CommandResult> answerAsk(String askId, AskOption option, {String? from}) async =>
      await _stale(askId, null) ?? await _send('POST', '/api/asks/${Uri.encodeComponent(askId)}/answer', {'answer': option.label, 'by': 'owner'}).then(_after);

  @override
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []}) async {
    final stale = await _stale(askId, null);
    if (stale != null) return stale;
    final (up, _) = await _uploadAll(attachments);
    if (up == null) return CommandResult.localized(() => UiCopy.copy.filesCouldNot);
    // A GO is an inbox item: his words close it, and the worker gets them as they are.
    final path = askId.startsWith('inbox:') ? '/api/inbox/${askId.substring(6)}/answer' : '/api/asks/${Uri.encodeComponent(askId)}/answer';
    return _send('POST', path, {
      'answer': text,
      'by': 'owner',
      if (up.isNotEmpty) 'attachments': [for (final a in up) a.id],
    }).then(_after);
  }

  @override
  Future<CommandResult> go(WaitItem item) async {
    final stale = await _stale(item.askId, item.inboxId);
    if (stale != null) return stale;
    final r = item.askId != null && !item.askId!.startsWith('inbox:')
        ? await _send('POST', '/api/asks/${Uri.encodeComponent(item.askId!)}/answer', {'answer': 'GO', 'by': 'owner'})
        : await _send('POST', '/api/inbox/${item.inboxId}/done', {'note': 'GO'});
    if (r.ok) item.state = WaitState.answered;
    return _after(r);
  }

  @override
  Future<CommandResult> awaitingOutcome(WaitItem item, String outcome) async {
    final stale = await _stale(null, item.inboxId);
    if (stale != null) return stale;
    final r = await _send('POST', '/api/inbox/${item.inboxId}/$outcome', {});
    if (r.ok) item.state = WaitState.answered;
    return _after(r);
  }

  /// Tasks whose "בדקתי" is on its way to hq.
  final _checking = <int>{};

  @override
  Future<CommandResult> checked(AwaitingTask t) async {
    final d = _data;
    if (d == null) return CommandResult.localized(() => UiCopy.copy.noConnectionServer2);
    final orig = d.awaiting.where((x) => x.id == t.id).firstOrNull ?? t;
    _checking.add(t.id);
    d.awaiting = [
      for (final x in d.awaiting)
        if (x.id != t.id) x,
    ];
    notifyListeners();
    final r = await _send('POST', '/api/tasks/${t.id}/checked', {});
    _checking.remove(t.id);
    // Refused: back on the list as it was, in whatever snapshot is current now (a reload meanwhile kept it out).
    final now = _data;
    if (!r.ok && now != null && !now.awaiting.any((x) => x.id == t.id)) {
      now.awaiting = [...now.awaiting, orig]..sort((a, b) => b.at.compareTo(a.at));
      notifyListeners();
    }
    // Taken: one more board, so one fetched before hq took it (and finished after) is not the last word.
    return _after(r);
  }

  @override
  Future<CommandResult> notNow(WaitItem item) => _snooze(item, true);

  @override
  Future<CommandResult> resume(WaitItem item) => _snooze(item, false);

  /// Kept in hq (#74): a refresh or another device shows it as he left it. Shown at once; put back
  /// when hq didn't take it.
  Future<CommandResult> _snooze(WaitItem item, bool on) async {
    final was = item.state;
    item.state = on ? WaitState.notNow : WaitState.open;
    notifyListeners();
    if (item.inboxId == null) return const CommandResult.ok();
    final r = await _send('POST', '/api/inbox/${item.inboxId}/snooze', {'on': on});
    if (!r.ok && item.state == (on ? WaitState.notNow : WaitState.open)) {
      item.state = was;
      notifyListeners();
    }
    return r;
  }

  @override
  Future<CommandResult> dismiss(WaitItem item) async {
    if (item.inboxId == null) return CommandResult.localized(() => UiCopy.copy.thisItemCannot);
    final stale = await _stale(null, item.inboxId, answer: false);
    if (stale != null) return stale;
    var told = false;
    final r = await _send('POST', '/api/inbox/${item.inboxId}/dismiss', {}, (j) => told = j['message'] != null);
    if (r.ok) {
      item.state = WaitState.answered;
      // Only when hq did tell someone (an incident or a system item has no one to tell).
      final who = _data?.who(item.from);
      item.answerLineBuilder = () => told ? UiCopy.copy.closedMessage(who?.name ?? item.from, who?.gender == Gender.f ? UiCopy.copy.received : UiCopy.copy.received2) : UiCopy.copy.closed;
    }
    return _after(r);
  }

  @override
  Future<CommandResult> retry(WaitItem item) async =>
      await _stale(null, item.inboxId, answer: false) ?? await _send('POST', '/api/inbox/${item.inboxId}/done', {'note': 'retry'}).then(_after);

  @override
  Future<CommandResult> handoffDone(WaitItem item) async =>
      await _stale(null, item.inboxId, answer: false) ?? await _send('POST', '/api/inbox/${item.inboxId}/done', {'note': 'done'}).then(_after);

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
    if (chat != null && !chat.items.contains(msg)) chat.items.add(msg); // a retry is the same bubble
    // A retry from the outbox stays "ממתינה לחיבור" (and in the saved outbox) until hq answers.
    if (msg.delivery != Delivery.pendingConnection) msg.delivery = Delivery.queued;
    notifyListeners();
    // Images go up first; the message carries their ids. One that fails fails the message, with
    // "ניסיון נוסף" (what is already up is not uploaded again).
    final (up, transient) = await _uploadAll(msg.attachments);
    if (up == null) {
      msg.delivery = transient ? Delivery.pendingConnection : Delivery.failed;
      notifyListeners();
      return CommandResult.localized(() => UiCopy.copy.filesCouldNot, transient: transient);
    }
    msg.attachments = up;
    if (msg.cancelled) return const CommandResult.ok();
    final r = await _send('POST', '/api/messages/tell', {
      'msg_id': msg.id,
      'from': 'owner',
      'to': identityId,
      'body': msg.replyTo == null ? msg.text : '> ${msg.replyTo!.text}\n\n${msg.text}',
      'priority': msg.priority.name,
      if (msg.ref != null) 'ref': msg.ref,
      if (up.isNotEmpty) 'attachments': [for (final a in up) a.id],
    });
    if (!r.ok) {
      msg.delivery = r.transient ? Delivery.pendingConnection : Delivery.failed;
    } else if (msg.delivery == Delivery.pendingConnection) {
      msg.delivery = Delivery.queued; // hq has it; its events take it from here
    }
    notifyListeners();
    return r;
  }

  /// Every image that is not up yet goes up; the list with their ids, or null when one did not get
  /// there, and whether that was the link (worth sending again) rather than hq refusing it.
  Future<(List<Attachment>?, bool)> _uploadAll(List<Attachment> list) async {
    final up = <Attachment>[];
    for (var i = 0; i < list.length; i++) {
      final a = list[i];
      if (a.id != null) {
        up.add(a);
        continue;
      }
      try {
        final done = await uploadAttachment(a);
        if (done == null) return (null, false);
        list[i] = done;
        up.add(done);
      } on UploadFailure catch (e) {
        return (null, e.transient);
      } catch (_) {
        return (null, true);
      }
    }
    return (up, false);
  }

  @override
  Future<Attachment?> uploadAttachment(Attachment a, {Future<void> Function()? changed}) async {
    if (a.id != null) return a;
    final t = a.transfer;
    Future<Uint8List?> read(int start, int end) async {
      if (a.data != null) return Uint8List.sublistView(a.data!, start, end);
      return await t?.readRange?.call(start, end);
    }

    Future<Map<String, dynamic>> call(String method, String path, {Object? body, bool raw = false}) async {
      final request = http.Request(method, Uri.parse('$baseUrl$path'));
      request.headers.addAll({'authorization': 'Bearer $token', 'content-type': raw ? 'application/octet-stream' : 'application/json'});
      if (body != null) {
        if (raw) {
          request.bodyBytes = body as List<int>;
        } else {
          request.body = jsonEncode(body);
        }
      }
      final r = await (() async => await http.Response.fromStream(await _http.send(request)))().timeout(const Duration(seconds: 90));
      if (r.statusCode == 401) _refused();
      if (r.statusCode != 200) throw UploadFailure(r.statusCode);
      return (jsonDecode(utf8.decode(r.bodyBytes)) as Map).cast<String, dynamic>();
    }

    // Small files retain the single-request API. Large ones persist the session before sending bytes.
    if (a.bytes <= 8 * 1024 * 1024) {
      final data = await read(0, a.bytes);
      if (data == null || data.length != a.bytes) throw UploadFailure(400);
      final r = await _http
          .post(Uri.parse('$baseUrl/api/uploads'), headers: {'authorization': 'Bearer $token', 'content-type': a.mime, 'x-file-name': Uri.encodeComponent(a.name)}, body: data)
          .timeout(const Duration(seconds: 90));
      if (r.statusCode == 401) _refused();
      if (r.statusCode != 200) throw UploadFailure(r.statusCode);
      final m = (jsonDecode(utf8.decode(r.bodyBytes)) as Map)['upload'] as Map;
      if (a.isImage) _rememberAttachment(m['id'] as String, data);
      return Attachment.fromJson({...a.toJson(), ...m.cast<String, dynamic>()}, data: a.data, transfer: t);
    }
    var session = t?.session;
    Map<String, dynamic>? state;
    if (session != null) {
      try {
        state = (await call('GET', '/api/uploads/$session/status'))['upload'] as Map<String, dynamic>;
      } on UploadFailure catch (e) {
        if (e.status != 404) rethrow;
        t?.session = null;
      } // Only an expired session starts afresh.
    }
    if (state == null) {
      state = (await call('POST', '/api/uploads', body: {'name': a.name, 'bytes': a.bytes}))['upload'] as Map<String, dynamic>;
      session = state['id'] as String;
      if (t != null) t.session = session;
      await changed?.call();
    }
    if (state['upload'] != null) return Attachment.fromJson((state['upload'] as Map).cast<String, dynamic>(), data: a.data, transfer: t);
    final partBytes = state['part_bytes'] as int;
    final parts = (state['parts'] as List).cast<int>().toSet();
    final count = (a.bytes / partBytes).ceil();
    for (var n = 0; n < count; n++) {
      if (!parts.contains(n)) {
        final start = n * partBytes, end = ((n + 1) * partBytes).clamp(0, a.bytes);
        final bytes = await read(start, end);
        if (bytes == null || bytes.length != end - start) throw UploadFailure(400);
        await call('PUT', '/api/uploads/$session/parts/$n', body: bytes, raw: true);
      }
      if (t != null) t.progress = (n + 1) / count;
      await changed?.call();
    }
    final done = (await call('POST', '/api/uploads/$session/complete', body: {}))['upload'] as Map;
    return Attachment.fromJson(done.cast<String, dynamic>(), data: a.data, transfer: t);
  }

  @override
  Future<Map<String, dynamic>?> artifact(String id) async {
    final r = await _http.get(Uri.parse('$baseUrl/api/artifacts/${Uri.encodeComponent(id)}'), headers: {'authorization': 'Bearer $token'}).timeout(const Duration(seconds: 30));
    if (r.statusCode == 404) return null;
    if (r.statusCode != 200) throw StateError('artifact metadata');
    return ((jsonDecode(utf8.decode(r.bodyBytes)) as Map)['artifact'] as Map?)?.cast<String, dynamic>();
  }

  @override
  Future<Map<String, dynamic>> openArtifact(String id, int version) async {
    final r = await _http
        .post(
          Uri.parse('$baseUrl/api/artifacts/${Uri.encodeComponent(id)}/open'),
          headers: {'authorization': 'Bearer $token', 'content-type': 'application/json'},
          body: jsonEncode({'version': version}),
        )
        .timeout(const Duration(seconds: 30));
    if (r.statusCode != 200) throw ArtifactAccessFailure(r.statusCode);
    return (jsonDecode(utf8.decode(r.bodyBytes)) as Map).cast<String, dynamic>();
  }

  @override
  Future<bool> keepArtifact(String id) async => (await _send('POST', '/api/artifacts/${Uri.encodeComponent(id)}/keep', {'keep': true})).ok;
  @override
  Future<Uint8List?> artifactThumb(String id) async {
    final r = await _http
        .get(Uri.parse('$baseUrl/api/artifacts/${Uri.encodeComponent(id)}/thumb?revision=${artifactRevision.value}'), headers: {'authorization': 'Bearer $token'})
        .timeout(const Duration(seconds: 30));
    return r.statusCode == 200 ? r.bodyBytes : null;
  }

  Future<Uint8List?> _mediaBytes(String id, String suffix) async {
    final r = await _http
        .get(Uri.parse('$baseUrl/api/uploads/${Uri.encodeComponent(id)}/$suffix'), headers: {'authorization': 'Bearer $token'})
        .timeout(const Duration(seconds: 90));
    return r.statusCode == 200 ? r.bodyBytes : null;
  }

  @override
  ({Uri url, Map<String, String> headers})? mediaSource(String id) =>
      (url: Uri.parse('$baseUrl/api/uploads/${Uri.encodeComponent(id)}'), headers: {'authorization': 'Bearer $token'});
  @override
  Future<String?> attachmentTranscript(String id) async {
    final bytes = await _mediaBytes(id, 'transcript');
    return bytes == null ? null : utf8.decode(bytes);
  }

  @override
  Future<Uint8List?> attachmentPreview(String id) => _mediaBytes(id, 'preview');
  @override
  Future<List<String>> archiveEntries(String id) async {
    final bytes = await _mediaBytes(id, 'entries');
    if (bytes == null) throw StateError('archive');
    return ((jsonDecode(utf8.decode(bytes)) as Map)['entries'] as List).cast<String>();
  }

  @override
  Future<Uint8List?> archiveEntry(String id, String name) => _mediaBytes(id, 'entry?name=${Uri.encodeComponent(name)}');
  @override
  Future<Uint8List?> attachmentThumb(String id) async {
    try {
      final r = await _http
          .get(Uri.parse('$baseUrl/api/uploads/${Uri.encodeComponent(id)}/thumb'), headers: {'authorization': 'Bearer $token'})
          .timeout(const Duration(seconds: 30));
      return r.statusCode == 200 ? r.bodyBytes : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<Map<String, dynamic>>> files({String? chat, int? task, String? kind}) async {
    final result = <Map<String, dynamic>>[];
    int? offset = 0;
    while (offset != null) {
      final uri = Uri.parse('$baseUrl/api/files')
          .replace(queryParameters: {'offset': '$offset', 'chat': ?chat, 'task': task == null ? null : '$task', 'kind': ?kind}..removeWhere((key, value) => value == null));
      final r = await _http.get(uri, headers: {'authorization': 'Bearer $token'}).timeout(const Duration(seconds: 30));
      if (r.statusCode != 200) throw StateError('files');
      final body = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
      result.addAll((body['files'] as List).cast<Map<String, dynamic>>());
      final next = body['next'] as int?;
      if (next != null && next <= offset) throw StateError('invalid file cursor');
      offset = next;
    }
    return result;
  }

  /// Images already on this device, by upload id: sent from here, or fetched once.
  final _images = <String, Uint8List>{};
  void _rememberAttachment(String id, Uint8List bytes) {
    if (bytes.length > 8 * 1024 * 1024) return;
    _images.remove(id);
    while (_images.isNotEmpty && _images.values.fold<int>(bytes.length, (sum, b) => sum + b.length) > 32 * 1024 * 1024) {
      _images.remove(_images.keys.first);
    }
    _images[id] = bytes;
  }

  @visibleForTesting
  Duration originalIdleTimeout = const Duration(seconds: 30);

  @override
  Future<Uint8List?> attachmentData(String id) async {
    final hit = _images[id];
    if (hit != null) return hit;
    try {
      final request = http.Request('GET', Uri.parse('$baseUrl/api/uploads/${Uri.encodeComponent(id)}'))..headers['authorization'] = 'Bearer $token';
      final r = await _http.send(request).timeout(const Duration(seconds: 30));
      if (r.statusCode != 200) {
        await r.stream.listen(null).cancel();
        if (r.statusCode == 401) _refused();
        return null;
      }
      // 30s without a byte is a dead connection; a 200MB original on a phone network can take minutes.
      final bytes = await http.ByteStream(r.stream.timeout(originalIdleTimeout)).toBytes();
      _rememberAttachment(id, bytes);
      return bytes;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<CommandResult> retract(String identityId, String msgId) async => CommandResult.localized(() => UiCopy.copy.thisServerDoes);

  @override
  Future<CommandResult> stop(String identityId) async {
    final shift = _boardShift[identityId];
    if (shift == null) return CommandResult.localized(() => UiCopy.copy.thisWorkerHas);
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
  Future<CommandResult> wake(String teamId) async => CommandResult.localized(() => UiCopy.copy.thisServerDoesNot);
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
bool streamedAlready(List<ChatItem> items, Map<String, dynamic> m) => streamedAs(items, m) != null;

/// That streamed bubble, or null.
/// The stored reply holds every text block of the turn, but the streamed bubbles stay as they are, each where
/// the owner read it relative to the tool rows: they are the truth on screen and nothing moves or merges.
/// The stored message only marks the bubble of its last block (`text_ref`) as saved.
TextMsg? streamedAs(List<ChatItem> items, Map<String, dynamic> m) {
  final ref = m['text_ref'] as String?;
  return ref == null ? null : items.whereType<TextMsg>().where((i) => i.id == 't:$ref').firstOrNull;
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

String _hm(int ms) => company_time.hm(DateTime.fromMillisecondsSinceEpoch(ms));

/// hq DTOs -> the app's model. Pure, unit-tested (test/hq_mapping_test.dart).
/// `/api/inbox`: what is his (`items`) and the tasks to check (`checks`, task 986). An older hq sends all of it in `items`.
List<Map<String, dynamic>> inboxOf(dynamic r) => [
  if (r is Map && r['items'] is List) ...(r['items'] as List).cast<Map<String, dynamic>>(),
  if (r is Map && r['checks'] is List) ...(r['checks'] as List).cast<Map<String, dynamic>>(),
];

/// Blocked on him and only on him (hq's inbox.ts forOwner): a question, a GO, a sign-in, not a fault the system caught;
/// and a fault the manager can't take ([manager]'s own fall, every account full), which would otherwise reach nobody.
bool isHis(WaitItem w, {String manager = ''}) => switch (w.kind) {
  WaitKind.go || WaitKind.login => true,
  WaitKind.blockingAsk || WaitKind.softAsk => !isCaughtFault(w.from, w.askId),
  // A failed delivery or shift (by its kicker, kickerFor below); "the manager decided" (escalation_note) is not one.
  WaitKind.urgentProd || WaitKind.failure =>
    w.ref == 'accounts-all-full' ||
        (manager.isNotEmpty &&
            w.from == manager &&
            (const {'delivery_failure', 'shift_failure'}.contains(w.sourceKind) || (w.sourceKind == null && const {InputCopy.v20, InputCopy.v21}.contains(w.kicker)))),
  _ => false,
};

CompanyData mapSnapshot({
  required List<Map<String, dynamic>> board,
  required List<Map<String, dynamic>> inbox,
  required List<Map<String, dynamic>> asks,
  required List<Map<String, dynamic>> toggles,
  List<Map<String, dynamic>> tasks = const [],
  List<Map<String, dynamic>> projects = const [],
  List<Map<String, dynamic>> awaiting = const [],
  List<Map<String, dynamic>> asked = const [],

  /// `open_tasks` (#128); null from an hq before it: derived from [tasks].
  List<Map<String, dynamic>>? openTasks,
  String manager = '',
  String ownerLanguage = 'en',
  CompanyData? previous,
  DateTime? now,
}) {
  final teamNamesBuiltIn = {
    'mgmt': UiCopy.copy.management,
    'management': UiCopy.copy.management,
    'monitor': UiCopy.copy.monitoring,
    'monitoring': UiCopy.copy.monitoring,
    'personal': UiCopy.copy.personalTeam,
    'improve': UiCopy.copy.improvementTeam,
    'improvement': UiCopy.copy.improvementTeam,
    'design': UiCopy.copy.design,
    'agent-company': UiCopy.copy.company2,
  };
  // A project and its team show the owner's name for the project (org.yaml `projects[].name`, from hq).
  // An older hq sends no name: the built-in names, then the id.
  final projectNames = <String, String>{
    for (final p in projects)
      if (p['id'] is String && p['name'] is String && (p['name'] as String).isNotEmpty) p['id'] as String: p['name'] as String,
  };
  final teamNames = <String, String>{
    ...teamNamesBuiltIn,
    for (final p in projects)
      if (p['team'] is String && projectNames.containsKey(p['id'])) p['team'] as String: projectNames[p['id']]!,
  };
  // The team badge on every monogram. The company's own teams take their fixed ones (hq's real ids and the
  // older short ones), a project's team its org.yaml symbol (hq sends it with the project), then a
  // member's own symbol; never an icon the app doesn't have (that drew "?" on the whole personal team,
  // QA-LOG item 3).
  final projectSymbols = <String, String>{
    for (final p in projects)
      if (p['symbol'] is String && kIcons.containsKey(p['symbol'])) (p['team'] is String ? p['team'] as String : p['id'] as String): p['symbol'] as String,
  };
  const teamSymbols = {
    'management': 'explore',
    'mgmt': 'explore',
    'monitoring': 'shield',
    'monitor': 'shield',
    'personal': 'folder_shared',
    'improvement': 'build',
    'improve': 'build',
    'design': 'palette',
    'agent-company': 'architecture',
  };
  final teams = <String, Team>{};
  final ids = <String, Identity>{};
  final presence = <String, Presence>{};
  // A task worker's own team is its task ("agent-company-t40"), an id that means nothing to the owner. It shows as the
  // team it works for (#40, "קרן · voice-bot"): the project's team, or for an errand with no project the
  // team of whoever opened it (a personal-team helper shows "הצוות האישי").
  final projectTeam = <String, String>{
    for (final p in projects)
      if (p['id'] is String) p['id'] as String: p['team'] is String ? p['team'] as String : p['id'] as String,
  };
  final projectOfTeam = {for (final e in projectTeam.entries) e.value: e.key};
  final byId = {for (final b in board) b['id'] as String: b};
  String? hostTeam(Map<String, dynamic> b, [int depth = 0]) {
    final project = b['project'] as String?;
    if (project != null) return projectTeam[project] ?? project;
    final opener = byId[b['reports_to']];
    if (opener == null) return null;
    // Opened by another task worker: that worker's own host, never its task id.
    if (opener['team_kind'] == 'task') return depth < 3 ? hostTeam(opener, depth + 1) : null;
    return opener['team'] as String?;
  }

  // A task worker without a project (an errand) takes the tone of the team it works for, as it takes its symbol.
  final teamTone = <String, String>{
    for (final b in board)
      if (b['tone'] is String && b['team'] is String && b['team_kind'] != 'task') b['team'] as String: b['tone'] as String,
  };
  for (final b in board) {
    final id = b['id'] as String;
    final team = (b['team'] as String?) ?? 'company';
    final own = b['symbol'] as String?;
    final host = b['team_kind'] == 'task' ? hostTeam(b) : null;
    final project = b['project'] as String?;
    final symbol = teamSymbols[host ?? team] ?? projectSymbols[host ?? team] ?? (own != null && kIcons.containsKey(own) ? own : 'build');
    final named = host ?? team;
    final teamName = teamNames[named] ?? (project != null ? projectNames[project] : null) ?? named;
    final tone = b['tone'] as String? ?? teamTone[host ?? team];
    teams.putIfAbsent(team, () => Team(id: team, name: teamName, symbol: symbol, permanent: b['team_kind'] == 'permanent', tone: tone));
    if (b['lifecycle'] == 'lead' && teams[team]!.leadId == null) {
      final t = teams[team]!;
      teams[team] = Team(id: team, name: t.name, symbol: t.symbol, leadId: id, permanent: t.permanent, tone: t.tone);
    }
    final gender = switch (b['gender'] as String?) { 'f' => Gender.f, 'm' => Gender.m, _ => titleGender(b['title'] as String? ?? '') };
    ids[id] = Identity(
      id: id,
      name: b['name'] as String? ?? id,
      title: b['title'] as String? ?? '',
      teamId: team,
      gender: gender,
      temp: b['lifecycle'] == 'ephemeral',
      taskRef: b['team_kind'] == 'task' ? team : null,
      project: project ?? (host == null ? null : projectOfTeam[host]),
      host: host,
    );
    final shift = b['shift'] as Map?;
    final shiftNo = shift == null ? null : int.tryParse((shift['id'] as String).split('-').last);
    presence[id] = Presence(
      status: mapStatus(b['status'] as String?),
      blockedOn: b['blocked_on'] as String?,
      shift: shiftNo,
      shiftSince: shift?['started_at'] is int ? _hm(shift!['started_at'] as int) : null,
      activity: ((b['current_task'] ?? b['task']) as Map?)?['title'] as String?,
      currentTask: (b['current_task'] as Map?)?['title'] as String?,
      queued: b['queued'] is int ? b['queued'] as int : 0,
      machine: shift?['machine'] as String?,
      stuckSince: b['stuck_since'] is int ? DateTime.fromMillisecondsSinceEpoch(b['stuck_since'] as int) : null,
    );
  }

  String kickerFor(Map<String, dynamic> i) {
    final kind = i['kind'] as String;
    return switch (kind) {
      'incident' when i['ref'] == 'accounts-all-full' => UiCopy.copy.allAccountsTheir,
      'incident' => UiCopy.copy.urgentProductionIssue,
      'go' => UiCopy.copy.releaseApproval,
      'login' => UiCopy.copy.websiteSign2,
      'delivery_failure' => UiCopy.copy.messageNotDelivered,
      'shift_failure' => UiCopy.copy.workerDidNot,
      'awaiting' => UiCopy.copy.check,
      // The system asks with its own title ("תפסתי תקלה", error-watch.ts): it has no name to stand for it.
      'ask' when isCaughtFault(i['from_identity'] as String?, i['ref'] as String?) && (i['title'] as String?)?.isNotEmpty == true => i['title'] as String,
      _ => i['blocking'] == true ? UiCopy.copy.blocking : UiCopy.copy.question,
    };
  }

  final askById = {for (final a in asks) a['id'] as String: a};
  // Only an escalated ask carries the note (an answered one is done, and has no card).
  String? noteOf(Map<String, dynamic>? ask) {
    final n = ask?['state'] == 'escalated' ? (ask?['manager_note'] as String?)?.trim() : null;
    return n == null || n.isEmpty ? null : n;
  }

  final waiting = <WaitItem>[];
  for (final i in inbox) {
    if (i['state'] != 'open') continue;
    final kind = switch (i['kind'] as String) {
      // "All the accounts are full" is not a fault in prod to approve a fix for: no GO on it, only what it says.
      'incident' when i['ref'] == 'accounts-all-full' => WaitKind.failure,
      'incident' => i['urgency'] == 'urgent' ? WaitKind.urgentProd : WaitKind.failure,
      'go' => WaitKind.go,
      'login' => WaitKind.login,
      // "the manager decided for you" is the manager's line, not something waiting on him (task 986).
      'delivery_failure' || 'shift_failure' || 'escalation_note' => WaitKind.failure,
      'ask' => i['blocking'] == true ? WaitKind.blockingAsk : WaitKind.softAsk,
      'awaiting' => WaitKind.awaiting,
      _ => WaitKind.failure,
    };
    final ask = askById[i['ref']];
    final options = <AskOption>[
      if (kind == WaitKind.go || kind == WaitKind.urgentProd) AskOption(id: 'go', label: UiCopy.copy.approve2, primary: true),
      if (kind == WaitKind.awaiting) ...kAwaitingOptions,
      // The system's card for a fault (error-watch.ts): its first answer ("לטפל") is the main one.
      if (ask != null)
        for (final (n, o) in (ask['options'] as List).cast<String>().indexed)
          AskOption(id: o, label: o, primary: n == 0 && isCaughtFault(i['from_identity'] as String?, i['ref'] as String?)),
    ];
    final headline = ((i['headline'] as String?) ?? (ask?['headline'] as String?))?.trim();
    waiting.add(
      WaitItem(
        id: 'inbox:${i['id']}',
        action: i['action'] as String?,
        inboxId: i['id'] as int,
        sourceKind: i['kind'] as String,
        // A GO has no ask behind it: it is answered through its inbox item, in the conversation too.
        askId: ask != null ? ask['id'] as String : (kind == WaitKind.go ? 'inbox:${i['id']}' : null),
        headline: headline == null || headline.isEmpty ? null : headline,
        ref: i['ref'] as String?,
        managerNote: noteOf(ask),
        managerNoteBy: noteOf(ask) == null ? null : manager,
        kind: kind,
        from: (i['from_identity'] as String?) ?? manager,
        time: _hm(i['created_at'] as int),
        createdAt: DateTime.fromMillisecondsSinceEpoch(i['created_at'] as int),
        kicker: kickerFor(i),
        body: (ask?['question'] as String?) ?? ((i['body'] as String?)?.isNotEmpty == true ? i['body'] as String : i['title'] as String),
        options: options,
        domain: kind == WaitKind.login ? (i['title'] as String?) : null,
        link: i['link'] as String?,
        links: [
          for (final l in (i['links'] as List? ?? const []).whereType<Map>())
            if (WaitLinkKind.values.asNameMap()[l['kind']] case final kind? when l['url'] is String && (l['url'] as String).startsWith('https://'))
              WaitLink(kind, l['url'] as String),
        ],
        // "לא עכשיו" lives in hq (#74): it stays put across refreshes and devices.
        state: i['snoozed_at'] != null ? WaitState.notNow : WaitState.open,
      ),
    );
  }

  final automations = [
    for (final t in toggles)
      Automation(
        key: t['key'] as String,
        team: UiCopy.copy.system,
        sentence: (t['description'] as String?) ?? t['key'] as String,
        meta: t['manual'] == true && t['enabled'] == false ? UiCopy.copy.disabledManually(_hm(t['updated_at'] as int)) : (t['enabled'] == true ? UiCopy.copy.enabled : UiCopy.copy.disabled),
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
        pinned: b['id'] == manager,
      ),
  ];

  // The tasks hq is running (the board, APP-SPEC §4.5, and the project teams in org). Finished ones
  // leave both. What finished in the last week stays (doneAt), for "מאז הביקור הקודם" after a day away (#53).
  final clock = now ?? company_time.CompanyTime.now();
  final today = company_time.dayStart(clock).millisecondsSinceEpoch;
  final tickets = <Ticket>[];
  final taskOf = <String, String>{}; // worker -> the task it works on
  for (final t in tasks) {
    final state = t['state'] as String? ?? 'queued';
    final updated = t['updated_at'] as int? ?? 0;
    // `closed`: the issue closed in GitHub. Nobody works on it and it is not done by us.
    if (state == 'closed' || (state == 'done' && updated < today - const Duration(days: 6).inMilliseconds)) continue;
    final idn = t['identity'] as String?;
    final who = idn == null ? null : ids[idn];
    final title = t['title'] as String? ?? '';
    if (state != 'done' && idn != null) taskOf.putIfAbsent(idn, () => title);
    // A running task has a worker on it; a resting one has a worker waiting for a reply (it wakes on a
    // message), often the owner's: both show the worker's own state. Every other open state (queued,
    // night_wait, open, interrupted, and any state this app does not know yet) waits for a slot: "בתור".
    final withWorker = state == 'running' || state == 'resting';
    final status = state == 'done' ? WorkerStatus.done : (withWorker ? (presence[idn]?.status ?? WorkerStatus.free) : WorkerStatus.free);
    final group = switch ((state, status)) {
      ('done', _) => TicketGroup.doneToday, // "done", today or this week: doneAt says when
      _ when !withWorker => TicketGroup.queued,
      (_, WorkerStatus.waiting) => TicketGroup.waiting,
      (_, WorkerStatus.blocked || WorkerStatus.stuck) => TicketGroup.attention,
      _ => TicketGroup.working,
    };
    final project = t['project'] as String? ?? '';
    final started = t['started_at'] as int?;
    tickets.add(
      Ticket(
        number: 't${t['id']}',
        title: title,
        project: project,
        projectName: projectNames[project] ?? project,
        group: group,
        assignee: who?.name ?? '',
        sub: who == null || who.title.isEmpty ? null : who.title,
        status: status,
        endLine: state == 'done' ? UiCopy.copy.done11(_hm(updated)) : (started != null ? UiCopy.copy.started(_hm(started)) : null),
        assigneeId: idn,
        startedAt: started == null ? null : DateTime.fromMillisecondsSinceEpoch(started),
        doneAt: state == 'done' ? DateTime.fromMillisecondsSinceEpoch(updated) : null,
        summary: t['summary'] as String?,
        openedBy: _openedBy(t['labels']),
      ),
    );
  }

  final projectList = [
    for (final p in projects)
      if (p['id'] is String) ProjectInfo(id: p['id'] as String, name: projectNames[p['id']], active: p['status'] == 'active', teamId: projectTeam[p['id']]),
  ];

  // Org (APP-SPEC §4.6): the permanent teams, then each project's team: its lead, its standing
  // workers (each with its state, its current task and how many wait for it), then the workers on
  // its open tasks with the task as the second line. A task team is not a team of its own here,
  // and one whose task closed is gone.
  final teamKind = {for (final b in board) (b['team'] as String?) ?? 'company': b['team_kind'] as String?};
  final orgTeams = <OrgTeam>[];
  for (final t in teams.values) {
    final kind = teamKind[t.id];
    if (kind == 'task') continue;
    final lead = t.leadId != null ? ids[t.leadId] : null;
    if (kind == 'project') {
      final project = board.where((b) => b['team'] == t.id).map((b) => b['project'] as String?).firstWhere((p) => p != null, orElse: () => t.id);
      final standing = [
        for (final b in board)
          if (b['team'] == t.id && b['id'] != lead?.id) b['id'] as String,
      ];
      final workers = [
        for (final b in board)
          if (b['team_kind'] == 'task' && b['project'] == project && taskOf.containsKey(b['id'])) b['id'] as String,
      ];
      final people = (lead != null ? 1 : 0) + standing.length + workers.length;
      final openCount = tickets.where((k) => k.project == project && k.group != TicketGroup.doneToday).length;
      orgTeams.add(
        OrgTeam(
          teamId: t.id,
          line: [
            if (lead != null) lead.name,
            people == 1 ? UiCopy.copy.oneWorker : UiCopy.copy.workers2(people),
            openCount == 0 ? UiCopy.copy.noOpenTasks : (openCount == 1 ? UiCopy.copy.oneOpenTask : UiCopy.copy.openTasks2(openCount)),
          ].join(' · '),
          statusIcon: '',
          statusWord: '',
          members: [
            if (lead != null) OrgMember(identityId: lead.id, line: lead.title),
            for (final s in standing) OrgMember(identityId: s, line: ids[s]!.title),
            for (final w in workers) OrgMember(identityId: w, line: taskOf[w]!),
          ],
        ),
      );
      continue;
    }
    final members = ids.values.where((i) => i.teamId == t.id).toList();
    orgTeams.add(
      OrgTeam(
        teamId: t.id,
        line: [
          if (lead != null) lead.name,
          members.length == 1 ? UiCopy.copy.oneWorker : UiCopy.copy.workers2(members.length),
        ].join(' · '),
        statusIcon: '',
        statusWord: '',
        members: [for (final i in members) OrgMember(identityId: i.id, line: i.title)],
      ),
    );
  }
  // Permanent teams first, management on top (the order of company.md); project teams after them.
  const permanentOrder = ['management', 'mgmt', 'monitoring', 'monitor', 'personal', 'improvement', 'improve', 'design'];
  int rank(OrgTeam t) {
    if (teamKind[t.teamId] == 'project') return 200;
    final i = permanentOrder.indexOf(t.teamId);
    return i < 0 ? 100 : i;
  }

  orgTeams.sort((a, b) => rank(a) - rank(b));

  // Counted over the workers that exist now: a closed task's worker is neither active nor resting.
  final live = presence.entries.where((e) => e.value.status != WorkerStatus.done && (teamKind[ids[e.key]?.teamId] != 'task' || taskOf.containsKey(e.key)));
  final active = live.where((e) => e.value.status != WorkerStatus.resting).length;
  final open = tickets.where((t) => t.group != TicketGroup.doneToday).length;
  final doneToday = tickets.where((t) => t.doneAt != null && !t.doneAt!.isBefore(company_time.dayStart(clock))).length;

  return CompanyData(
    managerId: manager,
    ownerLanguage: ownerLanguage,
    ownerName: companyNames.placeholder ? '' : companyNames.owner,
    teams: teams,
    identities: ids,
    presence: presence,
    // task 986: only what is blocked on him waits for him. A fault of the system is the manager's (an older hq still sends it).
    waiting: [
      for (final w in waiting)
        if (isHis(w, manager: manager)) w,
    ],
    checks: [
      for (final w in waiting)
        if (w.kind == WaitKind.awaiting) w,
    ],
    decisions: const [],
    digest: const [],
    digestSince: '',
    activity: const [],
    conversations: convs,
    chats: previous?.chats ?? {},
    tickets: tickets,
    ticketDetails: const {},
    boardSubtitle: [
      UiCopy.copy.wholeCompany,
      open == 1 ? UiCopy.copy.oneOpenTask : UiCopy.copy.openTasks2(open),
      if (doneToday > 0) (doneToday == 1 ? UiCopy.copy.oneDoneToday : UiCopy.copy.doneToday3(doneToday)),
    ].join(' · '),
    orgTeams: orgTeams,
    orgSubtitle: UiCopy.copy.activeWorkersResting(active, live.length - active),
    projects: projectList,
    capacity: const [],
    automations: automations,
    focus: focus,
    night: night ? UiCopy.copy.nightModeActive : null,
    awaiting: [for (final a in awaiting) ?AwaitingTask.fromHq(a)],
    asked: [for (final a in asked) ?AskedRequest.fromHq(a)],
    openTasks: openTasks == null ? null : [for (final t in openTasks) ?OpenTask.fromHq(t)],
  );
}

/// Internal message ids mean nothing to the owner: "(מזהה agent-company-t5-2:mvfww7y1-010ec676ca)"
/// and bare ids of that shape are dropped from the one-line view of messages between workers.
/// The images a stored message carries (hq: `attachments`, [{id,name,mime,bytes}] or null).
List<Attachment> attachmentsOf(Map<String, dynamic> m) => [for (final a in ((m['attachments'] as List?) ?? const []).cast<Map<String, dynamic>>()) Attachment.fromJson(a)];

/// A conversation's last line: the first line of the text, or "תמונה" for an image sent alone.
String lastLineOf(Map<String, dynamic> m) {
  final first = (m['body'] as String).split('\n').first;
  if (first.isNotEmpty) return first;
  final files = attachmentsOf(m);
  if (files.any((a) => !a.isImage)) return files.length == 1 ? files.single.name : UiCopy.copy.mediaEntries('${files.length}');
  final n = files.length;
  return n > 1 ? UiCopy.copy.images(n) : (n == 1 ? UiCopy.copy.image : '');
}

String withoutIds(String s) =>
    s.replaceAll(RegExp(InputCopy.v22), '').replaceAll(RegExp(r'\b[\w.-]+-\d+:[a-z0-9]{6,}-[a-z0-9]{6,}\b'), '').replaceAll(RegExp(r' {2,}'), ' ').trim();

/// The further of two delivery states of the same message (a late copy never moves a tick back).
Delivery furtherDelivery(Delivery a, Delivery b) {
  if (a == Delivery.failed || b == Delivery.failed) return a == Delivery.failed ? b : a;
  return a.index >= b.index ? a : b;
}

/// The question and GO cards of a conversation, from its events (`inbox.new`, `ask.new`): what was asked,
/// in the order it was asked. Whether each is still open comes from the inbox (`syncAskCards`).
List<AskCard> historyCards(List<Map<String, dynamic>> events, String identityId) {
  final options = <String, List<String>>{};
  for (final e in events) {
    if (e['type'] != 'ask.new') continue;
    final a = (e['data'] as Map).cast<String, dynamic>();
    options[a['id'] as String] = ((a['options'] as List?) ?? const []).cast<String>();
  }
  final out = <AskCard>[];
  for (final e in events) {
    if (e['type'] != 'inbox.new') continue;
    final i = (e['data'] as Map).cast<String, dynamic>();
    if (i['from_identity'] != identityId) continue;
    final ts = DateTime.fromMillisecondsSinceEpoch(i['created_at'] as int);
    final headline = (i['headline'] as String?)?.trim();
    final h = headline == null || headline.isEmpty ? null : headline;
    final body = (i['body'] as String?)?.isNotEmpty == true ? i['body'] as String : i['title'] as String;
    if (i['kind'] == 'go') {
      out.add(
        GoCard(action: i['action'] as String?, id: 'go:${i['id']}', ts: ts, askId: 'inbox:${i['id']}', ref: i['ref'] as String?, from: identityId, headline: h, details: body),
      );
    } else if (i['kind'] == 'ask' && i['ref'] != null) {
      final ref = i['ref'] as String;
      out.add(
        AskCard(
          id: 'ask:$ref',
          ts: ts,
          askId: ref,
          from: identityId,
          headline: h,
          question: body,
          blocking: i['blocking'] == true,
          options: [for (final o in options[ref] ?? const <String>[]) AskOption(id: o, label: o)],
        ),
      );
    }
  }
  return out;
}

/// The card his answer message points at (its ref), if it is in this conversation.
AskCard? cardFor(List<ChatItem> items, String? ref) => ref == null ? null : items.whereType<AskCard>().where((c) => c.ref == ref).lastOrNull;

/// What he answered, without what hq wraps around it for the worker (mailbox.ts answer/reply/complete).
/// `tapped`: a button or a closing action, not words he typed (no bubble of his own).
(String, bool) answerText(String body) {
  for (final re in _answerEnvelopes) {
    final m = re.firstMatch(body);
    if (m != null) return (m.group(1)!.trim(), false);
  }
  // Closed without doing it (dismiss) or done without a note: the card's line says so.
  final n = companyNames, owner = n.owner;
  if (body.startsWith('$owner ${n.o(InputCopy.v23, InputCopy.v24)}: ') || body.startsWith(InputCopy.closedWithoutAnswer(owner, n.o(InputCopy.v25, InputCopy.v26)))) {
    return (UiCopy.copy.closed, true);
  }
  if (body.startsWith('$owner ${n.o(InputCopy.v27, InputCopy.v28)}: ')) return (UiCopy.copy.done8, true);
  return (body, false);
}

/// His message as a row's last line (task 205): the words he wrote, without what hq wraps around an answer.
/// A card he closed with a tap is what he did, "סיימת: GO …", and `tapped`: no "אתה: " and no ticks, since
/// those are for words of his (hq writes "רן סיים: …" from him to the worker, mailbox.ts complete).
({String text, bool tapped}) ownLine(Map<String, dynamic> m) {
  final body = (m['body'] as String?) ?? '';
  // hq's "סיים: / דחה: / סגר" is always a closing tap (mailbox.complete): its note is a button's word ("GO",
  // "retry", "done"), never his own; what he types goes through reply, wrapped differently.
  final n = companyNames, first = body.split('\n').first;
  for (final (he, you) in [
    (n.o(InputCopy.completed[0], InputCopy.completed[1]), UiCopy.copy.youFinished),
    (n.o(InputCopy.deferred[0], InputCopy.deferred[1]), UiCopy.copy.deferred3),
    (n.o(InputCopy.closed[0], InputCopy.closed[1]), UiCopy.copy.youClosed),
  ]) {
    if (first.startsWith('${n.owner} $he')) return (text: '$you${first.substring('${n.owner} $he'.length)}', tapped: true);
  }
  final (said, _) = answerText(body);
  return (text: said == body ? lastLineOf(m) : said.split('\n').first, tapped: false);
}

/// hq's wrappings (mailbox.ts), built from the names in force; rebuilt only when they change.
List<RegExp> get _answerEnvelopes {
  final n = companyNames;
  if (!identical(n, _envelopesFor)) {
    final owner = RegExp.escape(n.owner);
    _envelopes = [
      RegExp(InputCopy.v29),
      RegExp(InputCopy.answerPattern(owner)),
      // The card's title can run to several lines (ingest.ts); the note, a button's word, is the last one.
      RegExp('^$owner ${n.o(InputCopy.v27, InputCopy.v28)}: [\\s\\S]*\\n([^\\n]*)\$'),
    ];
    _envelopesFor = n;
  }
  return _envelopes;
}

CompanyNames? _envelopesFor;
List<RegExp> _envelopes = const [];

/// His answer to a card: the card closes with it ("ענית: X"). Words he typed are also his message, a reply
/// to the card (as when he sent them); a button's answer is the card's line only, as when he tapped it.
ChatItem? answerItem(Map<String, dynamic> m, AskCard card, String author, List<ChatItem> existing) {
  final (text, closed) = answerText(m['body'] as String);
  card.state = AskState.answered;
  card.answer = text;
  if (m['created_at'] is int) card.answeredAt = DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int);
  final tapped = closed || text == 'GO' || text == InputCopy.v30 || card.options.any((o) => o.label == text);
  // Sent from this device: its own bubble is already here.
  final mine = existing.whereType<UserMsg>().any((u) => u.replyTo?.askId != null && u.replyTo!.askId == card.askId);
  if (tapped || mine) return null;
  return UserMsg(
    id: m['id'] as String,
    ts: DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int),
    text: text,
    delivery: mapDelivery(m['state'] as String?),
    replyTo: Quote(author: author, text: (card.headline ?? card.question).split('\n').first, itemId: card.id, askId: card.askId, go: card is GoCard),
    attachments: attachmentsOf(m),
  );
}

/// Who opened a task: its `opened-by:<id>` label (hq sends labels as a JSON array string).
String? _openedBy(Object? labels) {
  List<Object?> list;
  try {
    list = labels is String ? (jsonDecode(labels) as List) : (labels is List ? labels : const []);
  } catch (_) {
    return null;
  }
  for (final l in list) {
    if (l is String && l.startsWith('opened-by:')) return l.substring(10);
  }
  return null;
}

/// Question and GO cards follow the inbox: one appears in the conversation of whoever asked, and
/// one answered elsewhere (home, another device, a manager) stops asking here.
void syncAskCards(Conversation chat, String identityId, CompanyData d) {
  // A task to check is a card here too, under the line that says what to check (task 986).
  final open = {
    for (final w in d.waiting.where((w) => w.from == identityId && w.askId != null)) w.askId!: w,
    for (final w in d.checks.where((w) => w.from == identityId)) checkAskId(w): w,
  };
  var added = false;
  for (final card in chat.items.whereType<AskCard>()) {
    if (card.state == AskState.open && card.askId != null && !open.containsKey(card.askId)) card.state = AskState.answered;
  }
  // By the key it is open under: a check's own askId is null, and comparing that added the same card again on
  // every snapshot, two rows with one key, and the list behind the chat broke (error 802d88feff).
  final have = {for (final c in chat.items.whereType<AskCard>()) c.askId};
  final ids = {for (final i in chat.items) i.id};
  for (final MapEntry(key: askId, value: a) in open.entries) {
    if (have.contains(askId)) continue;
    // At the time it was asked, not "now": a card stamped now sorted below everything and buried
    // every new message under it.
    final ts = a.createdAt ?? company_time.CompanyTime.now();
    final card = a.kind == WaitKind.awaiting
        ? CheckCard(id: 'check:${a.inboxId}', ts: ts, askId: askId, from: identityId, headline: a.headline, details: a.body)
        : a.kind == WaitKind.go
        ? GoCard(action: a.action, id: 'go:${a.inboxId}', ts: ts, askId: askId, ref: a.ref, from: identityId, headline: a.headline, details: a.body)
        : AskCard(id: 'ask:$askId', ts: ts, askId: askId, from: identityId, headline: a.headline, question: a.body, options: a.options, blocking: a.blocking);
    // A row's id is its key in the list: never two.
    if (!ids.add(card.id)) continue;
    chat.items.add(card);
    added = true;
  }
  if (added) chat.items.sort((a, b) => a.ts.compareTo(b.ts));
}

class ArtifactAccessFailure implements Exception {
  ArtifactAccessFailure(this.status);
  final int status;
}

/// hq does not send a gender yet; his titles carry it ("ראשת צוות", "מנכ"לית", "מפתחת"): a first word ending in ת is
/// feminine. Only a fallback for when the board says nothing.
Gender titleGender(String title) {
  final first = title.trim().split(RegExp(r'\s+')).first;
  return first.length > 2 && first.codeUnitAt(first.length - 1) == 0x05EA /* ת */ ? Gender.f : Gender.m;
}
