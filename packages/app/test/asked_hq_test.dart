// "ביקשת" (#118) against an hq: the board's `asked` comes in, and `asked.changed` reloads it. Apart from the
// widget tests: their binding blocks real HTTP.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> _asked(String id, {String state = 'open', String identity = 'ido', int at = 0, int count = 1, Map<String, dynamic>? reply}) => {
      'id': id, 'identity': identity, 'body': 'בקשה $id', 'created_at': at, 'count': count, 'state': state, 'reply': reply,
    };

Future<void> _until(bool Function() ok, {int ms = 5000}) async {
  for (var i = 0; i < ms ~/ 20 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  test('hq: the board\'s asked comes in, and `asked.changed` reloads it', () async {
    SharedPreferences.setMockInitialValues({'language': 'he', 'new_interface': false});
    var asked = [_asked('m1', identity: 'noa', at: 1)];
    final sockets = <WebSocket>[];
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        final ws = await WebSocketTransformer.upgrade(req);
        sockets.add(ws);
        ws.add(jsonEncode({'type': 'live', 'seq': 1}));
        return;
      }
      final Object body = switch (path) {
        '/api/board' => {...jsonDecode(File('test/fixtures/samples/hq/board.json').readAsStringSync()) as Map<String, dynamic>, 'asked': asked},
        '/api/toggles' => jsonDecode(File('test/fixtures/samples/hq/toggles.json').readAsStringSync()) as Object,
        '/api/inbox' => {'items': []},
        '/api/asks' => {'asks': []},
        _ => {'messages': [], 'events': []},
      };
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
      await req.response.close();
    });
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${server.port}', token: 't');
    addTearDown(b.dispose);
    await b.start();
    await _until(() => b.data?.asked.length == 1 && sockets.isNotEmpty);
    expect(b.data!.asked.single.state, AskedState.open);

    asked = [_asked('m1', identity: 'noa', at: 1, state: 'answered', reply: {'id': 'r1', 'body': 'הנה', 'created_at': 2})];
    sockets.last.add(jsonEncode({'type': 'asked.changed', 'seq': 2, 'data': {}}));
    await _until(() => b.data?.asked.firstOrNull?.state == AskedState.answered);
    expect(b.data!.asked.single.reply!.id, 'r1');

    asked = [];
    sockets.last.add(jsonEncode({'type': 'asked.changed', 'seq': 3, 'data': {}}));
    await _until(() => b.data?.asked.isEmpty ?? false);
    expect(b.data!.asked, isEmpty);
  });
}
