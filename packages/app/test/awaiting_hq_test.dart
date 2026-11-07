// "בדקתי" (#108) against an hq that keeps the list like the real one (awaiting.ts: POST /api/tasks/:id/checked
// takes a task off; /api/board returns what is left). Apart from the widget tests: their binding blocks real HTTP.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> _task(int id, String kind, {String? note, String? summary, int at = 0}) => {
      'id': id, 'ref': null, 'project': 'agent-company', 'title': 'אפליקציה: משימה $id', 'summary': summary, 'identity': 'agent-company-t$id',
      'awaiting': kind, 'awaiting_note': note, 'awaiting_at': at, 'pr': '$id',
    };

class _Hq {
  late HttpServer server;
  final calls = <String>[];
  bool refuse = false;

  /// While set, "בדקתי" waits for it before hq takes it (a board fetched meanwhile still has the task).
  Completer<void>? hold;
  final awaiting = [_task(64, 'check', note: 'לפתוח את הכרטיס בטלפון', summary: 'רואים מה לבדוק'), _task(63, 'deploy', at: 1)];

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        final ws = await WebSocketTransformer.upgrade(req);
        ws.add(jsonEncode({'type': 'live', 'seq': 1}));
        return;
      }
      Object? body;
      final checked = RegExp(r'^/api/tasks/(\d+)/checked$').firstMatch(path);
      if (req.method == 'POST' && checked != null) {
        calls.add('checked ${checked[1]}');
        await hold?.future;
        if (refuse) {
          req.response.statusCode = 500;
          body = {'error': 'boom'};
        } else {
          awaiting.removeWhere((t) => t['id'] == int.parse(checked[1]!));
          body = {'ok': true};
        }
      } else if (path == '/api/board') {
        body = {...jsonDecode(File('test/fixtures/samples/hq/board.json').readAsStringSync()) as Map<String, dynamic>, 'awaiting': awaiting};
      } else if (path == '/api/toggles') {
        body = jsonDecode(File('test/fixtures/samples/hq/toggles.json').readAsStringSync());
      } else if (path == '/api/inbox') {
        body = {'items': []};
      } else if (path == '/api/asks') {
        body = {'asks': []};
      } else {
        body = {'messages': [], 'events': []};
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
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
  test('hq: "בדקתי" goes to the server, survives a reload, and comes back when the server refused', () async {
    SharedPreferences.setMockInitialValues({'language': 'he'});
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${hq.server.port}', token: 't');
    addTearDown(b.dispose);
    await b.start();
    await until(() => b.data?.awaiting.length == 2);
    expect(b.data!.awaiting.map((t) => t.id), [64, 63]);

    expect((await b.checked(b.data!.awaiting.first)).ok, isTrue);
    expect(hq.calls, ['checked 64']);
    expect(b.data!.awaiting.map((t) => t.id), [63]);
    await b.debugReload();
    expect(b.data!.awaiting.map((t) => t.id), [63], reason: 'the server keeps it');

    hq.refuse = true;
    final r = await b.checked(b.data!.awaiting.first);
    expect(r.ok, isFalse);
    expect(b.data!.awaiting.map((t) => t.id), [63], reason: 'back on the list');
  });

  test('hq: a reload while "בדקתי" is on its way does not bring the row back', () async {
    SharedPreferences.setMockInitialValues({'language': 'he'});
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${hq.server.port}', token: 't');
    addTearDown(b.dispose);
    await b.start();
    await until(() => b.data?.awaiting.length == 2);
    hq.hold = Completer();
    final pending = b.checked(b.data!.awaiting.first);
    await until(() => hq.calls.isNotEmpty);
    await b.debugReload();
    expect(b.data!.awaiting.map((t) => t.id), [63], reason: 'the board still had it; the app keeps it off');
    hq.hold!.complete();
    expect((await pending).ok, isTrue);
    await b.debugReload();
    expect(b.data!.awaiting.map((t) => t.id), [63]);
  });
}
