// #34 (company-engine): the app stopped showing what is true. A phone's socket died in its sleep with no
// close and no error, so the screen kept "נח" for a worker who answered, "בתור" for a message he had
// handled, and "מריץ פקודה" for a tool long done. Here: a socket that goes silent is replaced, coming back
// from the background replaces it too, and either way the board and the open conversation are fetched
// again; a replay of the open conversation is not skipped.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/company_time.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeHq {
  final wsQueries = <Map<String, String>>[];
  final sockets = <WebSocket>[];
  late HttpServer server;
  int boards = 0;
  int toggles = 0;
  Duration togglesDelay = Duration.zero;

  /// What hq says now: adi's board status, and the state of the one message he sent her.
  String adiStatus = 'resting';
  String msgState = 'queued';
  List<Map<String, dynamic>> events = [];

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        wsQueries.add(req.uri.queryParameters);
        final ws = await WebSocketTransformer.upgrade(req);
        sockets.add(ws);
        ws.add(jsonEncode({'type': 'live', 'seq': 9000}));
        return;
      }
      String body;
      if (path == '/api/toggles') {
        toggles++;
        await Future<void>.delayed(togglesDelay);
      }
      if (path == '/api/board') {
        boards++;
        final b = jsonDecode(File('test/fixtures/samples/hq/board.json').readAsStringSync()) as Map<String, dynamic>;
        for (final i in (b['identities'] as List).cast<Map<String, dynamic>>()) {
          if (i['id'] == 'adi') i['status'] = adiStatus;
        }
        body = jsonEncode(b);
      } else if (const {'/api/inbox', '/api/asks', '/api/toggles'}.contains(path)) {
        body = File('test/fixtures/samples/hq${path.substring(4)}.json').readAsStringSync();
      } else if (path == '/api/messages' && req.uri.queryParameters['identity'] == 'adi') {
        body = jsonEncode({'messages': [
          {'id': 'm-1', 'from_identity': 'owner', 'to_identity': 'adi', 'kind': 'text', 'body': 'מה המצב?', 'state': msgState, 'priority': 'next', 'created_at': 1000},
        ]});
      } else if (path == '/api/events' && req.uri.queryParameters['identity'] == 'adi') {
        body = jsonEncode({'events': events});
      } else {
        body = jsonEncode({'messages': [], 'events': []});
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(body);
      await req.response.close();
    });
  }

  String get url => 'http://127.0.0.1:${server.port}';
}

Future<void> until(bool Function() ok, {int ms = 8000}) async {
  for (var i = 0; i < ms ~/ 20 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

UserMsg? sent(HqBackend hq) => hq.data!.chats['adi']?.items.whereType<UserMsg>().where((m) => m.id == 'm-1').firstOrNull;

Future<(_FakeHq, HqBackend)> opened() async {
  final fake = _FakeHq();
  await fake.start();
  addTearDown(() => fake.server.close(force: true));
  final hq = HqBackend(baseUrl: fake.url, token: 't');
  addTearDown(hq.dispose);
  await hq.start();
  await until(() => hq.status.state == LinkState.online);
  hq.showConversation('adi');
  await hq.openConversation('adi');
  expect(sent(hq)?.delivery, Delivery.queued);
  expect(hq.data!.presence['adi']?.status, WorkerStatus.resting);
  return (fake, hq);
}

void main() {
  test('a socket that goes silent is replaced, and what changed meanwhile shows', () async {
    final (fake, hq) = await opened();
    hq.silence = const Duration(milliseconds: 600);
    fake.sockets.first.add(jsonEncode({'type': 'ping', 'seq': 0})); // this hq pings
    // While the socket says nothing: the message was handled and adi is working.
    fake
      ..msgState = 'handled'
      ..adiStatus = 'working';
    final boards = fake.boards;
    await until(() => fake.wsQueries.length >= 2);
    expect(fake.wsQueries.last['after'], '9000', reason: 'it resumes, nothing is lost');
    await until(() => sent(hq)?.delivery == Delivery.handled && hq.data!.presence['adi']?.status == WorkerStatus.working);
    expect(sent(hq)?.delivery, Delivery.handled);
    expect(hq.data!.presence['adi']?.status, WorkerStatus.working);
    expect(fake.boards, greaterThan(boards));
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('an hq that never pings is not taken for a silent one', () async {
    final (fake, hq) = await opened();
    hq.silence = const Duration(milliseconds: 300);
    hq.debugReplaceLink(); // arms the clock as any new socket does
    await until(() => fake.wsQueries.length >= 2);
    await Future<void>.delayed(const Duration(milliseconds: 1200));
    expect(fake.wsQueries.length, 2);
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('back from the background: a new socket and a reload; a focus blink is not that', () async {
    var now = DateTime(2026, 10, 21, 12);
    CompanyTime.clock = () => now;
    addTearDown(() => CompanyTime.clock = DateTime.now);
    final (fake, hq) = await opened();

    hq.setVisible(false);
    now = now.add(const Duration(seconds: 2));
    hq.setVisible(true);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    expect(fake.wsQueries.length, 1, reason: 'two seconds away');

    hq.setVisible(false);
    fake
      ..msgState = 'handled'
      ..adiStatus = 'working';
    now = now.add(const Duration(minutes: 5));
    hq.setVisible(true);
    await until(() => fake.wsQueries.length >= 2);
    expect(fake.wsQueries.last['after'], '9000');
    expect(hq.status.state, isNot(LinkState.offline), reason: 'no "לא מחובר" flash for a link that was fine');
    await until(() => sent(hq)?.delivery == Delivery.handled && hq.data!.presence['adi']?.status == WorkerStatus.working);
    expect(sent(hq)?.delivery, Delivery.handled);
    expect(hq.data!.presence['adi']?.status, WorkerStatus.working);
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('a reload after a shift handed over mid-tool shows no running command', () async {
    final (fake, hq) = await opened();
    Map<String, dynamic> e(int seq, String type, Map<String, dynamic> data) => {'seq': seq, 'ts': 1000 + seq, 'type': type, 'identity': 'adi', 'data': data};
    fake.events = [
      e(1, 'shift.state', {'shift': 'adi-4', 'state': 'live'}),
      e(2, 'engine.tool_use', {'shift': 'adi-4', 'seq': 1, 'ev': {'kind': 'tool_use', 'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'npm test'}}}),
      e(3, 'shift.state', {'shift': 'adi-5', 'state': 'starting'}),
      e(4, 'shift.state', {'shift': 'adi-5', 'state': 'live'}),
    ];
    await hq.openConversation('adi');
    final chat = hq.data!.chats['adi']!;
    expect(chat.live.busy, isFalse);
    expect(chat.items.whereType<ToolGroup>().single.outcome, Outcome.interrupted);
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('a retry already on its way does not replace the socket that came back meanwhile', () async {
    final (fake, hq) = await opened();
    // The link drops; the retry asks hq first (5 s later), and that answer is slow.
    fake.togglesDelay = const Duration(seconds: 2);
    final asked = fake.toggles;
    await fake.sockets.first.close();
    await until(() => fake.toggles > asked, ms: 10000);
    // While it waits, he brings the app to the front: a new socket now.
    hq.debugReplaceLink();
    await until(() => hq.status.state == LinkState.online || hq.status.state == LinkState.reconnected);
    expect(fake.wsQueries.length, 2);
    // The retry's answer lands: it must not open a third socket, now or 5 s later.
    await Future<void>.delayed(const Duration(seconds: 7));
    expect(fake.wsQueries.length, 2);
    expect(hq.status.state, isNot(LinkState.connecting));
  }, timeout: const Timeout(Duration(seconds: 40)));
}
