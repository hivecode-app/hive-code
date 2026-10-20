// The app opens on the last snapshot it saw (quality.md: "מחכה לך" from cache in <=1s), and the
// conversation list keeps its order when a snapshot reloads (it used to show board order, then jump).
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Hq {
  late HttpServer server;
  Duration delay = Duration.zero;
  final boardLoads = <DateTime>[];
  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        final ws = await WebSocketTransformer.upgrade(req);
        ws.add(jsonEncode({'type': 'live', 'seq': 1}));
        return;
      }
      if (path == '/api/board') {
        boardLoads.add(DateTime.now());
        await Future<void>.delayed(delay);
      }
      final name = switch (path) { '/api/board' => 'board', '/api/inbox' => 'inbox', '/api/asks' => 'asks', '/api/toggles' => 'toggles', _ => null };
      final body = name != null
          ? File('test/fixtures/samples/hq/$name.json').readAsStringSync()
          : jsonEncode({
              // Rotem wrote last, then Yoav: the list's order.
              'messages': [
                {'id': '2', 'from_identity': 'rotem', 'to_identity': 'owner', 'body': 'בוקר טוב', 'created_at': 2000, 'state': 'handled'},
                {'id': '1', 'from_identity': 'yoav', 'to_identity': 'owner', 'body': 'קיבלתי', 'created_at': 1000, 'state': 'handled'},
              ],
              'events': [],
            });
      req.response.headers.contentType = ContentType.json;
      req.response.write(body);
      await req.response.close();
    });
  }
}

Future<void> until(bool Function() ok, {int ms = 5000}) async {
  for (var i = 0; i < ms ~/ 20 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  test('the second start shows the last snapshot before the server answers', () async {
    SharedPreferences.setMockInitialValues({});
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final url = 'http://127.0.0.1:${hq.server.port}';

    final first = HqBackend(baseUrl: url, token: 't');
    await first.start();
    await until(() => first.data!.conversations.first.lastLine == 'בוקר טוב');
    final prefs = await SharedPreferences.getInstance();
    await until(() => prefs.getString(HqBackend.kCacheKey) != null, ms: 6000); // saves are debounced
    expect(prefs.getString(HqBackend.kCacheKey), isNotNull);
    first.dispose();

    hq.delay = const Duration(seconds: 2); // a slow network
    final second = HqBackend(baseUrl: url, token: 't');
    addTearDown(second.dispose);
    final sw = Stopwatch()..start();
    final starting = second.start();
    await until(() => second.data != null, ms: 1500);
    expect(second.data, isNotNull, reason: 'shown from the cache');
    expect(sw.elapsedMilliseconds, lessThan(1000));
    expect(second.data!.conversations.first.identityId, 'rotem', reason: 'in the order it had');
    await starting;
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a reload keeps the conversation order (no board-order flash)', () async {
    SharedPreferences.setMockInitialValues({});
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${hq.server.port}', token: 't');
    addTearDown(b.dispose);
    await b.start();
    await until(() => b.data!.conversations.first.identityId == 'rotem');
    final orders = <List<String>>[];
    b.addListener(() => orders.add([for (final c in b.data!.conversations.take(2)) c.identityId]));
    hq.delay = const Duration(milliseconds: 100);
    // Any inbox event reloads the snapshot.
    await b.debugReload();
    await Future<void>.delayed(const Duration(milliseconds: 400));
    expect(orders, isNotEmpty);
    expect(orders.every((o) => o.first == 'rotem'), isTrue, reason: 'never a frame in board order: $orders');
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('an answer taken on cached data waits for fresh data, and is refused if already handled', () async {
    // A cache whose inbox still holds item 7, which the server has since closed.
    final board = File('test/fixtures/samples/hq/board.json').readAsStringSync();
    final toggles = File('test/fixtures/samples/hq/toggles.json').readAsStringSync();
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final url = 'http://127.0.0.1:${hq.server.port}';
    SharedPreferences.setMockInitialValues({
      HqBackend.kCacheKey: jsonEncode({
        'url': url,
        'saved': DateTime(2026, 10, 20, 9, 5).millisecondsSinceEpoch,
        'board': jsonDecode(board),
        'toggles': jsonDecode(toggles),
        'asks': {'asks': []},
        'inbox': {
          'items': [
            {'id': 7, 'kind': 'go', 'state': 'open', 'from_identity': 'yoav', 'title': 'GO', 'body': 'פריסה', 'created_at': 1000},
          ],
        },
      }),
    });
    hq.delay = const Duration(milliseconds: 600);
    final b = HqBackend(baseUrl: url, token: 't');
    addTearDown(b.dispose);
    final starting = b.start();
    await until(() => b.data != null);
    final cached = b.data!.waiting.single;
    final r = await b.go(cached); // tapped on the cached card
    expect(r.ok, isFalse);
    expect(r.error, contains('כבר טופל'));
    await starting;
  }, timeout: const Timeout(Duration(seconds: 20)));
}
