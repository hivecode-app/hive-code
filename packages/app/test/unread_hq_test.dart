// Unread, read and mute against hq (#task-50): the counts come from hq, a new message counts up and brings its
// conversation to the top, opening it reads it on hq and tells hq it is on screen (so it doesn't alert), the
// background clears that, a read on another device clears it here, and mute is kept on hq.
// A plain test (no widget binding): the widget binding turns every real HTTP request into a 400.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeHq {
  late HttpServer server;
  final calls = <String>[];
  final sockets = <WebSocket>[];
  Map<String, Map<String, dynamic>> convs = {
    'adi': {'identity': 'adi', 'unread': 2, 'muted_until': null},
    'yoav': {'identity': 'yoav', 'unread': 1, 'muted_until': 99999999999999},
  };

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        final ws = await WebSocketTransformer.upgrade(req);
        sockets.add(ws);
        ws.add(jsonEncode({'type': 'live', 'seq': 100}));
        return;
      }
      final body = await utf8.decodeStream(req);
      if (req.method != 'GET') calls.add('${req.method} $path ${body.isEmpty ? '' : body}'.trim());
      final name = switch (path) { '/api/board' => 'board', '/api/inbox' => 'inbox', '/api/asks' => 'asks', '/api/toggles' => 'toggles', _ => null };
      Object out;
      if (name != null) {
        out = jsonDecode(File('test/fixtures/samples/hq/$name.json').readAsStringSync()) as Object;
      } else if (path == '/api/seen') {
        out = {'seen': {'chats': 5000}};
      } else if (path == '/api/conversations') {
        out = {'conversations': convs.values.toList()};
      } else if (path == '/api/messages' && req.uri.queryParameters['identity'] == 'owner') {
        out = {
          'messages': [
            {'id': 'a2', 'from_identity': 'adi', 'to_identity': 'owner', 'kind': 'tell', 'body': 'העדכון עלה', 'created_at': 2000, 'state': 'delivered'},
            {'id': 'y1', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'tell', 'body': 'בוקר', 'created_at': 1000, 'state': 'delivered'},
            {'id': 'o1', 'from_identity': 'owner', 'to_identity': 'agent-company-t1', 'kind': 'tell', 'body': 'שלום', 'created_at': 500, 'state': 'delivered'},
          ],
        };
      } else if (path.endsWith('/mute')) {
        out = {'conversation': {'identity': path.split('/')[3], 'unread': 0, 'muted_until': 1}};
      } else {
        out = {'messages': [], 'events': [], 'ok': true};
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(out));
      await req.response.close();
    });
  }

  void send(Map<String, dynamic> e) {
    for (final s in sockets) {
      s.add(jsonEncode(e));
    }
  }

  String get url => 'http://127.0.0.1:${server.port}';
}

Future<void> until(bool Function() ok, {int ms = 5000}) async {
  for (var i = 0; i < ms ~/ 20 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

int unreadOf(HqBackend hq, String id) => hq.data!.conversation(id)?.unread ?? -1;

void main() {
  test('hq backend: counts, a new message counts up and goes first, open reads it, presence, read elsewhere, mute', () async {
    final fake = _FakeHq();
    await fake.start();
    addTearDown(() => fake.server.close(force: true));
    final hq = HqBackend(baseUrl: fake.url, token: 't');
    addTearDown(hq.dispose);
    await hq.start();
    await until(() => hq.status.state == LinkState.online && unreadOf(hq, 'adi') == 2);

    expect(unreadOf(hq, 'adi'), 2);
    expect(hq.data!.conversation('yoav')!.muted, isTrue);
    expect(hq.data!.unreadCount, 2, reason: 'the muted one shows its count but stays out of the total');

    // A message from a worker whose conversation is closed: one more, and it goes to the top.
    fake.send({'seq': 101, 'type': 'message.new', 'identity': 'owner', 'data': {
      'id': 't1', 'from_identity': 'agent-company-t1', 'to_identity': 'owner', 'kind': 'tell', 'body': 'סיימתי', 'created_at': 3000}});
    await until(() => unreadOf(hq, 'agent-company-t1') == 1);
    expect(unreadOf(hq, 'agent-company-t1'), 1);
    expect(hq.data!.conversations.first.identityId, 'agent-company-t1');
    fake.send({'seq': 102, 'type': 'message.new', 'identity': 'owner', 'data': {
      'id': 't2', 'from_identity': 'agent-company-t1', 'to_identity': 'owner', 'kind': 'tell', 'body': 'ועוד', 'created_at': 3100}});
    await until(() => unreadOf(hq, 'agent-company-t1') == 2);
    expect(unreadOf(hq, 'agent-company-t1'), 2);

    // Opening reads it on hq and says which conversation is on screen.
    hq.showConversation('adi');
    expect(unreadOf(hq, 'adi'), 0);
    await until(() => fake.calls.any((c) => c.startsWith('PUT /api/presence')));
    expect(fake.calls, contains('POST /api/conversations/adi/read {}'));
    expect(fake.calls, contains('PUT /api/presence {"identity":"adi"}'));

    // A message in the open conversation: read at once, no count.
    fake.calls.clear();
    fake.send({'seq': 103, 'type': 'message.new', 'identity': 'owner', 'data': {
      'id': 'a3', 'from_identity': 'adi', 'to_identity': 'owner', 'kind': 'tell', 'body': 'עוד עדכון', 'created_at': 4000}});
    await until(() => fake.calls.contains('POST /api/conversations/adi/read {}'));
    expect(fake.calls, contains('POST /api/conversations/adi/read {}'));
    expect(unreadOf(hq, 'adi'), 0);

    // The app goes to the background: nothing is on screen, and what comes now counts.
    fake.calls.clear();
    hq.setVisible(false);
    await until(() => fake.calls.isNotEmpty);
    expect(fake.calls, contains('PUT /api/presence {"identity":null}'));
    fake.send({'seq': 104, 'type': 'message.new', 'identity': 'owner', 'data': {
      'id': 'a4', 'from_identity': 'adi', 'to_identity': 'owner', 'kind': 'tell', 'body': 'בזמן שלא הסתכלת', 'created_at': 5000}});
    await until(() => unreadOf(hq, 'adi') == 1);
    expect(unreadOf(hq, 'adi'), 1);
    hq.setVisible(true);
    expect(unreadOf(hq, 'adi'), 0, reason: 'back in front with the chat open: read');
    hq.closeConversation('adi');

    // Read on another device: hq says so, and the count here goes.
    fake.convs['agent-company-t1'] = {'identity': 'agent-company-t1', 'unread': 0, 'muted_until': null};
    fake.send({'seq': 105, 'type': 'conv.read', 'identity': 'agent-company-t1', 'data': {'identity': 'agent-company-t1'}});
    await until(() => unreadOf(hq, 'agent-company-t1') == 0);
    expect(unreadOf(hq, 'agent-company-t1'), 0);

    final r = await hq.mute('agent-company-t1', MuteFor.week);
    expect(r.ok, isTrue);
    expect(fake.calls, contains('POST /api/conversations/agent-company-t1/mute {"for":"week"}'));
    expect(hq.data!.conversation('agent-company-t1')!.muted, isTrue);
  });

  test('hq backend: "since you were here" comes from hq, follows another device, and is told when he leaves', () async {
    final fake = _FakeHq();
    await fake.start();
    addTearDown(() => fake.server.close(force: true));
    final hq = HqBackend(baseUrl: fake.url, token: 't');
    addTearDown(hq.dispose);
    await hq.start();
    await until(() => hq.seenAt('chats') != null);
    expect(hq.seenAt('chats'), DateTime.fromMillisecondsSinceEpoch(5000));
    // Left the chats screen on the laptop.
    fake.send({'seq': 101, 'type': 'seen.changed', 'identity': null, 'data': {'screen': 'chats', 'at': 8000}});
    await until(() => hq.seenAt('chats') == DateTime.fromMillisecondsSinceEpoch(8000));
    expect(hq.seenAt('chats'), DateTime.fromMillisecondsSinceEpoch(8000));
    fake.send({'seq': 102, 'type': 'seen.changed', 'identity': null, 'data': {'screen': 'chats', 'at': 6000}});
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(hq.seenAt('chats'), DateTime.fromMillisecondsSinceEpoch(8000), reason: 'only forward');
    // Left it here.
    await hq.markSeen('chats', DateTime.fromMillisecondsSinceEpoch(9000));
    expect(fake.calls, contains('PUT /api/seen/chats {"at":9000}'));
    expect(hq.seenAt('chats'), DateTime.fromMillisecondsSinceEpoch(9000));
  });
}
