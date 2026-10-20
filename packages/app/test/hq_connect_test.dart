// How HqBackend comes up against hq (a local fake server with the recorded fixtures):
// the snapshot shows before the WebSocket says live; the first WebSocket asks for no history (hq
// sends its recent tail); a replay redraws the screen once rather than once per event; a reconnect
// resumes from the seq hq reported; a socket that never says live doesn't freeze the screen.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeHq {
  final wsQueries = <Map<String, String>>[];
  final sockets = <WebSocket>[];
  late HttpServer server;

  /// Replay sent on every WebSocket, then live after [liveAfter] (null: never).
  List<Map<String, dynamic>> replay = [];
  Duration? liveAfter = Duration.zero;

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        wsQueries.add(req.uri.queryParameters);
        final ws = await WebSocketTransformer.upgrade(req);
        sockets.add(ws);
        for (final e in replay) {
          ws.add(jsonEncode(e));
        }
        final d = liveAfter;
        if (d != null) Future<void>.delayed(d, () => ws.add(jsonEncode({'type': 'live', 'seq': 9000})));
        return;
      }
      final name = switch (path) { '/api/board' => 'board', '/api/inbox' => 'inbox', '/api/asks' => 'asks', '/api/toggles' => 'toggles', _ => null };
      final body = name != null ? File('test/fixtures/hq/$name.json').readAsStringSync() : jsonEncode({'messages': [], 'events': []});
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

void main() {
  test('snapshot first; no history on start; one redraw per replay; resume after reconnect', () async {
    final fake = _FakeHq()
      ..liveAfter = const Duration(milliseconds: 600)
      // Owner messages redraw the conversation list one by one if replays aren't batched.
      ..replay = [
        for (var i = 1; i <= 300; i++)
          {'seq': 8700 + i, 'type': 'message.new', 'identity': 'yoav', 'data': {'id': 'r$i', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'text', 'body': 'שורה $i', 'created_at': 0}},
      ];
    await fake.start();
    addTearDown(() => fake.server.close(force: true));

    final hq = HqBackend(baseUrl: fake.url, token: 't');
    addTearDown(hq.dispose);
    var redraws = 0;
    var sawDataBeforeLive = false;
    hq.addListener(() {
      redraws++;
      if (hq.data != null && hq.status.state == LinkState.connecting) sawDataBeforeLive = true;
    });
    await hq.start();
    await until(() => hq.status.state == LinkState.online);
    expect(hq.status.state, LinkState.online);
    expect(sawDataBeforeLive, isTrue, reason: 'the snapshot shows before the WebSocket is live');
    expect(fake.wsQueries.first.containsKey('after'), isFalse, reason: 'no full replay on start');
    expect(redraws, lessThanOrEqualTo(4), reason: '300 replayed messages, not 300 redraws');

    // The link drops; the reconnect asks for what came after 9000.
    await fake.sockets.first.close();
    await until(() => fake.wsQueries.length >= 2, ms: 10000);
    expect(fake.wsQueries.length, 2);
    expect(fake.wsQueries.last['after'], '9000');
  }, timeout: const Timeout(Duration(seconds: 30)));

  test('a WebSocket that never says live does not freeze the screen', () async {
    final fake = _FakeHq()..liveAfter = null;
    await fake.start();
    addTearDown(() => fake.server.close(force: true));
    final hq = HqBackend(baseUrl: fake.url, token: 't');
    addTearDown(hq.dispose);
    await hq.start();
    var redraws = 0;
    hq.addListener(() => redraws++);
    // Something changes while the replay hangs; it must reach the screen within the guard.
    await until(() => fake.sockets.isNotEmpty);
    fake.sockets.first.add(jsonEncode({'seq': 1, 'type': 'message.new', 'identity': 'yoav', 'data': {'id': 'x', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'text', 'body': 'שלום', 'created_at': 0}}));
    await until(() => redraws > 0, ms: 6000);
    expect(redraws, greaterThan(0));
  }, timeout: const Timeout(Duration(seconds: 30)));
}
