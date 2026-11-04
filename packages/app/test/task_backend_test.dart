import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/model/task_progress.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('real HTTP adapter loads task data and an old exact source without replacing current history', () async {
    SharedPreferences.setMockInitialValues({});
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final sockets = <WebSocket>[];
    final paths = <String>[];
    final task = {
      'id': 1,
      'title': 'Map fix',
      'body': 'Description',
      'stage': 'review',
      'state': 'running',
      'worker': 'yoav',
      'prs': <dynamic>[],
      'requests': <dynamic>[],
    };
    Map<String, dynamic> message(String id, int at) => {
      'id': id,
      'from_identity': 'yoav',
      'to_identity': 'owner',
      'kind': 'tell',
      'body': id == 'old' ? 'Preserved review note' : 'Current message',
      'created_at': at,
      'state': 'handled',
    };
    server.listen((req) async {
      paths.add(req.uri.path);
      if (req.uri.path == '/ws') {
        final ws = await WebSocketTransformer.upgrade(req);
        sockets.add(ws);
        ws.add(jsonEncode({'type': 'live', 'seq': 1}));
        return;
      }
      expect(req.headers.value('authorization'), 'Bearer test-token');
      final fixture = switch (req.uri.path) {
        '/api/board' => 'board',
        '/api/inbox' => 'inbox',
        '/api/asks' => 'asks',
        '/api/toggles' => 'toggles',
        _ => null,
      };
      dynamic response;
      if (fixture != null) {
        response = jsonDecode(
          File('test/fixtures/samples/hq/$fixture.json').readAsStringSync(),
        );
      } else {
        response = switch (req.uri.path) {
          '/api/tasks' => {
            'pipeline': [
              task,
              {...task, 'id': 2, 'stage': null},
            ],
          },
          '/api/tasks/1' => {'task': task},
          '/api/tasks/1/activity' => {
            'messages': [
              {
                'id': 'old',
                'identity': 'yoav',
                'body': 'Preserved review note',
              },
            ],
            'files': [],
            'events': [],
          },
          '/api/tasks/1/start' => {'task': task},
          '/api/org/tree' => {
            'people': [
              {
                'id': 'finished',
                'name': 'Completed worker',
                'title': 'Reviewer',
                'active': 0,
                'reports_to': 'yoav',
                'tasks': [
                  {'id': 9, 'title': 'Earlier work', 'state': 'done'},
                ],
              },
            ],
          },
          '/api/messages/old/source' => {
            'identity': 'yoav',
            'target': 'old',
            'messages': [message('old', 1)],
          },
          '/api/messages' => {
            'messages': [message('recent', 2000000)],
          },
          _ => {'events': [], 'messages': [], 'conversations': []},
        };
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(response));
      await req.response.close();
    });
    final backend = HqBackend(
      baseUrl: 'http://127.0.0.1:${server.port}',
      token: 'test-token',
    );
    addTearDown(() async {
      backend.dispose();
      for (final ws in sockets) {
        await ws.close();
      }
      await server.close(force: true);
    });
    await backend.start();
    expect((await backend.taskProgress()).map((t) => t.stage).toList(), [
      TaskStage.review,
      null,
    ]);
    expect((await backend.taskDetail(1))!.title, 'Map fix');
    expect((await backend.taskActivity(1)).messages.single['id'], 'old');
    expect((await backend.startTask(1)).ok, true);
    expect((await backend.organization()).single.active, false);
    expect(backend.data!.identities['finished']!.name, 'Completed worker');
    expect(backend.data!.presence['finished']!.status, WorkerStatus.done);
    backend.relocalize();
    expect(
      backend.data!.identities['finished']!.name,
      'Completed worker',
      reason:
          'a language change retains people who are absent from the live board',
    );
    await backend.openConversation('yoav');
    expect(
      backend.data!.chats['yoav']!.items.whereType<TextMsg>().any(
        (m) => m.id == 'msg:old',
      ),
      false,
    );
    expect(await backend.revealMessage('yoav', 'old'), true);
    final chat = backend.data!.chats['yoav']!;
    expect(
      chat.items.whereType<TextMsg>().map((m) => m.id),
      containsAll(['msg:old', 'msg:recent']),
    );
    expect(chat.refs['old']!.body, 'Preserved review note');
    await backend.revealMessage('yoav', 'old');
    expect(
      chat.items.where((m) => m.id == 'msg:old').length,
      1,
      reason: 'source retries do not duplicate a message',
    );
    expect(paths, contains('/api/messages/old/source'));
  });
}
