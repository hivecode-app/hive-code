// An open chat stays current without refetching (it used to refetch on every change, in a loop):
// what arrives while its history loads is kept, questions appear and close while it is open, and
// messages of every kind show up live. Against a local fake hq.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

class _Hq {
  late HttpServer server;
  WebSocket? ws;
  Duration messagesDelay = Duration.zero;
  List<Map<String, dynamic>> inbox = [];
  List<Map<String, dynamic>> asks = [];
  final requests = <String>[];

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      requests.add(path);
      if (path == '/ws') {
        ws = await WebSocketTransformer.upgrade(req);
        ws!.add(jsonEncode({'type': 'live', 'seq': 100}));
        return;
      }
      Object body;
      switch (path) {
        case '/api/board':
          body = jsonDecode(File('test/fixtures/hq/board.json').readAsStringSync()) as Object;
        case '/api/toggles':
          body = jsonDecode(File('test/fixtures/hq/toggles.json').readAsStringSync()) as Object;
        case '/api/inbox':
          body = {'items': inbox};
        case '/api/asks':
          body = {'asks': asks};
        case '/api/messages':
          await Future<void>.delayed(messagesDelay);
          body = {
            'messages': [
              {'id': 'old', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'text', 'body': 'ישנה', 'created_at': 1000, 'state': 'handled'},
            ],
          };
        default:
          body = {'events': [], 'ok': true};
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
      await req.response.close();
    });
  }

  void send(Map<String, dynamic> e) => ws!.add(jsonEncode(e));
  String get url => 'http://127.0.0.1:${server.port}';
}

Map<String, dynamic> msgNew(String id, String from, String to, String body, {String kind = 'text', int at = 5000}) =>
    {'seq': 0, 'type': 'message.new', 'data': {'id': id, 'from_identity': from, 'to_identity': to, 'kind': kind, 'body': body, 'created_at': at, 'state': 'queued'}};

Future<void> until(bool Function() ok, {int ms = 5000}) async {
  for (var i = 0; i < ms ~/ 20 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

Future<(HqBackend, _Hq)> up() async {
  final hq = _Hq();
  await hq.start();
  addTearDown(() => hq.server.close(force: true));
  final b = HqBackend(baseUrl: hq.url, token: 't');
  addTearDown(b.dispose);
  await b.start();
  await until(() => b.status.state == LinkState.online && hq.ws != null);
  return (b, hq);
}

List<String> ids(HqBackend b) => [for (final i in b.data!.chats['yoav']?.items ?? const <ChatItem>[]) i.id];

void main() {
  test('a reply that arrives while the history loads is kept', () async {
    final (b, hq) = await up();
    hq.messagesDelay = const Duration(milliseconds: 400);
    final opening = b.openConversation('yoav');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    hq.send(msgNew('reply', 'yoav', 'owner', 'קיבלתי'));
    await opening;
    await until(() => ids(b).contains('msg:reply'));
    expect(ids(b), containsAllInOrder(['msg:old', 'msg:reply']));
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a question asked while the chat is open appears; one answered elsewhere closes', () async {
    final (b, hq) = await up();
    b.showConversation('yoav'); // as ChatScreen does
    await b.openConversation('yoav');
    expect(b.data!.chats['yoav']!.items.whereType<AskCard>(), isEmpty);

    hq.asks = [{'id': 'a1', 'question': 'לפתוח צוות?', 'options': ['כן', 'לא']}];
    hq.inbox = [{'id': 1, 'kind': 'ask', 'state': 'open', 'blocking': true, 'from_identity': 'yoav', 'title': 'q', 'body': '', 'ref': 'a1', 'created_at': 3000}];
    hq.send({'seq': 101, 'type': 'inbox.new', 'data': {}});
    await until(() => b.data!.chats['yoav']!.items.whereType<AskCard>().isNotEmpty);
    final card = b.data!.chats['yoav']!.items.whereType<AskCard>().single;
    expect(card.state, AskState.open);
    expect(card.ts, DateTime.fromMillisecondsSinceEpoch(3000), reason: 'sits where it was asked');

    hq.inbox = [];
    hq.asks = [];
    hq.send({'seq': 102, 'type': 'ask.answered', 'data': {}});
    await until(() => card.state != AskState.open);
    expect(card.state, AskState.answered);
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('the owner\'s message from another device, system lines and worker messages show live', () async {
    final (b, hq) = await up();
    b.showConversation('yoav'); // as ChatScreen does
    await b.openConversation('yoav');
    hq.send(msgNew('m-other-device', 'owner', 'yoav', 'מהמחשב'));
    hq.send(msgNew('sys1', 'yoav', 'owner', 'המשמרת התחלפה', kind: 'system'));
    hq.send(msgNew('w1', 'yoav', 'dana', 'תבדקי את זה'));
    await until(() => ids(b).contains('msg:w1'));
    expect(ids(b), containsAll(['m-other-device', 'msg:sys1', 'msg:w1']));
    expect(b.data!.chats['yoav']!.items.whereType<UserMsg>().single.text, 'מהמחשב');
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a message sent while the history loads stays on screen', () async {
    final (b, hq) = await up();
    hq.messagesDelay = const Duration(milliseconds: 400);
    final opening = b.openConversation('yoav');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    await b.send('yoav', UserMsg(id: 'm-mid', ts: DateTime.fromMillisecondsSinceEpoch(6000), text: 'באמצע'));
    await opening;
    expect(ids(b), contains('m-mid'));
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a closed chat is no longer "open": what arrives for it stays unread', () async {
    final (b, hq) = await up();
    b.showConversation('yoav');
    await b.openConversation('yoav');
    expect(b.openIdentity, 'yoav');
    b.closeConversation('dana');
    expect(b.openIdentity, 'yoav', reason: 'closing another chat changes nothing');
    // Yoav → Dana → back: Yoav is open again. Yoav twice (a second Yoav pushed) → back: still open.
    b.showConversation('dana');
    expect(b.openIdentity, 'dana');
    b.closeConversation('dana');
    expect(b.openIdentity, 'yoav');
    b.showConversation('yoav');
    b.closeConversation('yoav');
    expect(b.openIdentity, 'yoav');
    b.closeConversation('yoav');
    expect(b.openIdentity, isNull);
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a late copy never moves a delivery tick back', () {
    expect(furtherDelivery(Delivery.delivered, Delivery.read), Delivery.read);
    expect(furtherDelivery(Delivery.handled, Delivery.queued), Delivery.handled);
    expect(furtherDelivery(Delivery.failed, Delivery.delivered), Delivery.delivered);
  });
}
