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
  List<Map<String, dynamic>> events = [];
  List<Map<String, dynamic>> messages = [];
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
          body = jsonDecode(File('test/fixtures/samples/hq/board.json').readAsStringSync()) as Object;
        case '/api/toggles':
          body = jsonDecode(File('test/fixtures/samples/hq/toggles.json').readAsStringSync()) as Object;
        case '/api/inbox':
          body = {'items': inbox};
        case '/api/asks':
          body = {'asks': asks};
        case '/api/messages':
          await Future<void>.delayed(messagesDelay);
          body = {
            'messages': [
              ...messages,
              {'id': 'old', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'text', 'body': 'ישנה', 'created_at': 1000, 'state': 'handled'},
            ],
          };
        case '/api/events':
          body = {'events': events};
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
  // hq's texts in these fixtures name רן: the names his org.yaml gives (an older hq's board has none).
  setUpAll(() => companyNames = const CompanyNames(ownerId: 'ran', owner: 'רן', ownerGender: Gender.m, managerId: 'yoav', manager: 'יואב', managerGender: Gender.m));

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

  test('#68: a reply that streams while the open chat reloads (hq restarted mid-turn) shows once', () async {
    final (b, hq) = await up();
    b.showConversation('yoav'); // as ChatScreen does
    const reply = 'כן. צריך להתקין את ה-APK החדש.';
    Map<String, dynamic> delta(String t) => {'seq': 0, 'type': 'engine.delta', 'identity': 'yoav', 'data': {'shift': 'yoav-4', 'kind': 'text_delta', 'text': t, 'messageId': 'msg_apk'}};
    final text = {'seq': 201, 'ts': 5000, 'type': 'engine.text', 'identity': 'yoav', 'data': {'shift': 'yoav-4', 'seq': 7, 'ev': {'kind': 'text', 'text': reply, 'messageId': 'msg_apk'}}};
    final result = {'seq': 203, 'ts': 5001, 'type': 'engine.result', 'identity': 'yoav', 'data': {'shift': 'yoav-4', 'seq': 8, 'ev': {'kind': 'result', 'subtype': 'success', 'isError': false, 'text': reply}}};
    final stored = {'id': 'm-17-reply', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'tell', 'body': reply, 'ref': 'm-17', 'text_ref': 'msg_apk', 'created_at': 5002, 'state': 'delivered'};
    // By the time hq answers the reload, the turn is over: its history has the final text and the stored reply.
    hq.events = [text, result];
    hq.messages = [stored];
    hq.messagesDelay = const Duration(milliseconds: 400);
    final opening = b.openConversation('yoav');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    // ...and what streamed live meanwhile reaches the app during the fetch.
    hq.send(delta('כן. צריך '));
    hq.send(delta('להתקין את ה-APK החדש.'));
    hq.send(text);
    hq.send({'seq': 202, 'type': 'message.new', 'identity': 'owner', 'data': stored});
    hq.send(result);
    await opening;
    await Future<void>.delayed(const Duration(milliseconds: 100));
    final texts = b.data!.chats['yoav']!.items.whereType<TextMsg>().where((t) => t.text.contains('APK')).toList();
    expect(texts.map((t) => t.id), ['t:msg_apk'], reason: 'one bubble, not the history copy plus a stream copy');
    expect(texts.single.streaming, isFalse);
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a worker message to the owner keeps its images: from history, live, and when its text already streamed', () async {
    final (b, hq) = await up();
    final seven = [for (var i = 1; i <= 7; i++) {'id': 'u-$i', 'name': 'mock-$i.png', 'mime': 'image/png', 'bytes': 10}];
    hq.messages = [{'id': 'm-mock', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'tell', 'body': 'המוקאפ', 'attachments': seven, 'created_at': 2000, 'state': 'delivered'}];
    await b.openConversation('yoav');
    TextMsg item(String id) => b.data!.chats['yoav']!.items.whereType<TextMsg>().singleWhere((t) => t.id == id);
    expect(item('msg:m-mock').attachments.map((a) => a.id), ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6', 'u-7']);

    hq.send({'seq': 0, 'type': 'message.new', 'data': {...msgNew('live', 'yoav', 'owner', 'עוד')['data'] as Map, 'attachments': seven.take(2).toList()}});
    await until(() => ids(b).contains('msg:live'));
    expect(item('msg:live').attachments.length, 2);

    b.showConversation('yoav');
    hq.send({'seq': 300, 'ts': 6000, 'type': 'engine.text', 'identity': 'yoav', 'data': {'shift': 'yoav-4', 'seq': 9, 'ev': {'kind': 'text', 'text': 'הנה', 'messageId': 'msg_img'}}});
    await until(() => ids(b).contains('t:msg_img'));
    hq.send({'seq': 301, 'type': 'message.new', 'data': {'id': 'm-img', 'from_identity': 'yoav', 'to_identity': 'owner', 'kind': 'tell', 'body': 'הנה', 'text_ref': 'msg_img', 'attachments': seven, 'created_at': 6001, 'state': 'delivered'}});
    await until(() => item('t:msg_img').attachments.isNotEmpty);
    expect(item('t:msg_img').attachments.length, 7, reason: 'the streamed bubble takes the stored copy\'s images');
    expect(ids(b), isNot(contains('msg:m-img')));
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

  test('a GO is a card in the conversation, headline first, and words typed on it go to its inbox item', () async {
    final (b, hq) = await up();
    b.showConversation('yoav');
    await b.openConversation('yoav');
    hq.inbox = [
      {'id': 2, 'kind': 'go', 'state': 'open', 'blocking': true, 'from_identity': 'yoav', 'title': 'GO: פריסת hq', 'headline': "עדכון לאפליקציה: תמונות בצ'אט",
        'body': 'פריסת hq עם #65\nסיכון: low', 'ref': 'yoav-1:07', 'created_at': 3000},
    ];
    hq.send({'seq': 101, 'type': 'inbox.new', 'data': {}});
    await until(() => b.data!.chats['yoav']!.items.whereType<GoCard>().isNotEmpty);
    final go = b.data!.chats['yoav']!.items.whereType<GoCard>().single;
    expect(go.headline, "עדכון לאפליקציה: תמונות בצ'אט");
    expect(go.question, contains('#65'));
    expect(go.askId, 'inbox:2');
    expect(b.data!.waiting.single.headline, "עדכון לאפליקציה: תמונות בצ'אט");
    final r = await b.freeAnswer('inbox:2', 'לא, בלי הבוטים');
    expect(r.ok, isTrue);
    expect(hq.requests, contains('/api/inbox/2/answer'));
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('answered questions stay in the history, closed with his words; a typed answer is his reply to it', () async {
    final (b, hq) = await up();
    hq.events = [
      {'seq': 5, 'ts': 2000, 'type': 'inbox.new', 'identity': 'yoav',
        'data': {'id': 3, 'kind': 'ask', 'from_identity': 'yoav', 'title': 'יואב שואל/ת', 'headline': 'הבוטים של החנות', 'body': 'להעביר גם את הבוטים?', 'blocking': true, 'ref': 'a9', 'created_at': 2000}},
      {'seq': 6, 'ts': 2000, 'type': 'ask.new', 'identity': 'yoav', 'data': {'id': 'a9', 'options': ['כן', 'לא']}},
      {'seq': 7, 'ts': 2100, 'type': 'inbox.new', 'identity': 'yoav',
        'data': {'id': 4, 'kind': 'go', 'from_identity': 'yoav', 'title': 'GO: x', 'headline': 'עדכון', 'body': 'x', 'blocking': true, 'ref': 'op-4', 'created_at': 2100}},
    ];
    hq.messages = [
      {'id': 'inbox-4-done', 'from_identity': 'owner', 'to_identity': 'yoav', 'kind': 'answer', 'ref': 'op-4', 'body': 'רן סיים: GO: x\nGO', 'created_at': 2300, 'state': 'handled'},
      {'id': 'a9-answer', 'from_identity': 'owner', 'to_identity': 'yoav', 'kind': 'answer', 'ref': 'a9', 'body': 'תשובה לשאלה a9: לא, בלי הבוטים', 'created_at': 2200, 'state': 'handled'},
    ];
    b.showConversation('yoav');
    await b.openConversation('yoav');
    final items = b.data!.chats['yoav']!.items;
    final ask = items.whereType<AskCard>().firstWhere((c) => c is! GoCard);
    expect(ask.headline, 'הבוטים של החנות');
    expect([for (final o in ask.options) o.label], ['כן', 'לא']);
    expect(ask.state, AskState.answered);
    expect(ask.answer, 'לא, בלי הבוטים');
    final reply = items.whereType<UserMsg>().single;
    expect(reply.text, 'לא, בלי הבוטים', reason: 'without the envelope hq adds for the worker');
    expect(reply.replyTo?.askId, 'a9');
    final go = items.whereType<GoCard>().single;
    expect(go.state, AskState.answered);
    expect(go.answer, 'GO', reason: 'a tapped GO is the card line only, no bubble');
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('reopening keeps one bubble for an answer typed here; a declined GO is the card line only', () async {
    final (b, hq) = await up();
    hq.events = [
      {'seq': 5, 'ts': 2000, 'type': 'inbox.new', 'identity': 'yoav',
        'data': {'id': 3, 'kind': 'ask', 'from_identity': 'yoav', 'title': 'q', 'headline': 'הבוטים', 'body': 'להעביר?', 'blocking': true, 'ref': 'a9', 'created_at': 2000}},
      {'seq': 7, 'ts': 2100, 'type': 'inbox.new', 'identity': 'yoav',
        'data': {'id': 4, 'kind': 'go', 'from_identity': 'yoav', 'title': 'GO: x', 'headline': 'עדכון', 'body': 'x', 'blocking': true, 'ref': 'op-4', 'created_at': 2100}},
    ];
    hq.messages = [
      {'id': 'inbox-4-declined', 'from_identity': 'owner', 'to_identity': 'yoav', 'kind': 'answer', 'ref': 'op-4', 'body': 'רן דחה: GO: x', 'created_at': 2300, 'state': 'handled'},
      {'id': 'a9-answer', 'from_identity': 'owner', 'to_identity': 'yoav', 'kind': 'answer', 'ref': 'a9', 'body': 'תשובה לשאלה a9: לא, בלי הבוטים', 'created_at': 2200, 'state': 'handled'},
    ];
    b.showConversation('yoav');
    await b.openConversation('yoav');
    // As if typed on this device: the local bubble, a reply to the question.
    final chat = b.data!.chats['yoav']!;
    chat.items.removeWhere((i) => i is UserMsg);
    chat.items.add(UserMsg(id: 'm-local', ts: DateTime.fromMillisecondsSinceEpoch(2200), text: 'לא, בלי הבוטים', delivery: Delivery.delivered,
        replyTo: const Quote(author: 'יואב', text: 'הבוטים', askId: 'a9')));
    await b.openConversation('yoav');
    final items = b.data!.chats['yoav']!.items;
    expect(items.whereType<UserMsg>().map((m) => m.id), ['m-local'], reason: 'not shown twice after reopening');
    final go = items.whereType<GoCard>().single;
    expect(go.answer, 'נסגר');
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('an answer whose card is gone from the chat is his words alone, without hq\'s question id', () async {
    final (b, hq) = await up();
    hq.messages = [
      {'id': 'a7-answer', 'from_identity': 'owner', 'to_identity': 'yoav', 'kind': 'answer', 'ref': 'noa-1:mviisehy-02b744b9ed', 'body': 'תשובה לשאלה noa-1:mviisehy-02b744b9ed: מאשר', 'created_at': 2200, 'state': 'handled'},
    ];
    b.showConversation('yoav');
    await b.openConversation('yoav');
    final mine = b.data!.chats['yoav']!.items.whereType<UserMsg>().single;
    expect(mine.text, 'מאשר');
  }, timeout: const Timeout(Duration(seconds: 20)));
}
