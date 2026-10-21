// A message sent while hq restarts (21/10, 23:55: the text stayed "לא נמסר" for good): what did not
// reach hq waits in the outbox and goes again by itself, with the same id, so hq takes it once.
import 'dart:async';
import 'dart:convert';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// FakeBackend whose sends answer from a script: each try takes the next result, then ok.
class Flaky extends FakeBackend {
  Flaky(this.results) : super(simulate: false, now: DateTime(2026, 10, 21, 23, 55));
  final List<CommandResult> results;
  final ids = <String>[];

  @override
  SystemStatus get status => const SystemStatus(LinkState.online);

  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    ids.add(msg.id);
    if (results.isNotEmpty) {
      final r = results.removeAt(0);
      if (!r.ok) {
        msg.delivery = r.transient ? Delivery.pendingConnection : Delivery.failed;
        if (!data!.chats[identityId]!.items.contains(msg)) data!.chats[identityId]!.items.add(msg);
        return r;
      }
    }
    return super.send(identityId, msg);
  }
}

const down = CommandResult.fail('אין חיבור לשרת, ולכן הפעולה לא נשלחה. אפשר לנסות שוב.', transient: true);

List<Map<String, dynamic>> savedOutbox(SharedPreferences p) => (jsonDecode(p.getString('outbox') ?? '[]') as List).cast<Map<String, dynamic>>();

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a send that does not reach hq waits, is kept on the device, and goes again with the same id', (tester) async {
    final prefs = await SharedPreferences.getInstance();
    final b = Flaky([down, down]);
    final store = AppStore(b, prefs: prefs);
    await store.start();
    final m = await store.send('yoav', 'למה יש שגיאה', Priority.next);
    expect(m.delivery, Delivery.pendingConnection, reason: 'not "לא נמסר": it is not final');
    expect(store.error, isNull);
    expect(savedOutbox(prefs).map((e) => e['id']), [m.id]);

    await tester.pump(const Duration(seconds: 2)); // first retry: still down
    expect(b.ids, [m.id, m.id]);
    expect(m.delivery, Delivery.pendingConnection);

    await tester.pump(const Duration(seconds: 4)); // second retry: hq is back
    expect(b.ids, [m.id, m.id, m.id]);
    expect(m.delivery, Delivery.delivered);
    expect(savedOutbox(prefs), isEmpty);
    expect(store.data!.chats['yoav']!.items.where((i) => i.id == m.id), hasLength(1), reason: 'one bubble, not one per try');
    store.dispose();
  });

  testWidgets('a refusal from hq is final: "לא נמסר" with why, and no retry', (tester) async {
    final b = Flaky([const CommandResult.fail('השרת לא קיבל את הפעולה. אפשר לנסות שוב.')]);
    final store = AppStore(b);
    await store.start();
    final m = await store.send('yoav', 'x', Priority.next);
    expect(m.delivery, Delivery.failed);
    expect(store.error, 'השרת לא קיבל את הפעולה. אפשר לנסות שוב.');
    await tester.pump(const Duration(minutes: 2));
    expect(b.ids, [m.id]);

    // "ניסיון נוסף" is the same message, not a new one.
    await store.resend('yoav', m);
    expect(b.ids, [m.id, m.id]);
    expect(m.delivery, Delivery.delivered);
    expect(store.data!.chats['yoav']!.items.where((i) => i.id == m.id), hasLength(1));
    store.dispose();
  });

  testWidgets('order holds: behind one that waits, the next waits too', (tester) async {
    final b = Flaky([down, down]);
    final store = AppStore(b);
    await store.start();
    final a = await store.send('yoav', 'ראשונה', Priority.next);
    // Not sent ahead of the first: it waits behind it, and the first is tried again now (down).
    final c = await store.send('yoav', 'שנייה', Priority.next);
    await tester.pump();
    expect([a.delivery, c.delivery], [Delivery.pendingConnection, Delivery.pendingConnection]);
    expect(b.ids, [a.id, a.id]);
    await tester.pump(const Duration(seconds: 2));
    expect(b.ids, [a.id, a.id, a.id, c.id]);
    expect([a.delivery, c.delivery], [Delivery.delivered, Delivery.delivered]);
    store.dispose();
  });

  testWidgets('"משיכה חזרה" on a waiting message takes it off the device, and it never goes', (tester) async {
    final prefs = await SharedPreferences.getInstance();
    final b = Flaky([down]);
    final store = AppStore(b, prefs: prefs);
    await store.start();
    final m = await store.send('yoav', 'בעצם לא', Priority.next);
    expect(await store.retract('yoav', m), 'בעצם לא');
    expect(savedOutbox(prefs), isEmpty);
    expect(store.data!.chats['yoav']!.items.contains(m), isFalse);
    await tester.pump(const Duration(minutes: 2));
    expect(b.ids, [m.id]);
    store.dispose();
  });

  test('an image that is already up waits in the saved outbox with its id, and comes back after a restart', () async {
    final prefs = await SharedPreferences.getInstance();
    final b = Flaky([down]);
    final store = AppStore(b, prefs: prefs);
    await store.start();
    const img = Attachment(name: 'a.png', bytes: 10, mime: 'image/png', id: 'up-1');
    final m = await store.send('yoav', '', Priority.next, attachments: [img]);
    expect(m.delivery, Delivery.pendingConnection);
    expect(savedOutbox(prefs).single['attachments'], [
      {'id': 'up-1', 'name': 'a.png', 'bytes': 10, 'mime': 'image/png'},
    ]);
    store.dispose();

    final again = AppStore(Recordless(), prefs: prefs);
    await again.start();
    final back = again.data!.chats['yoav']!.items.whereType<UserMsg>().firstWhere((u) => u.id == m.id);
    expect(back.attachments.single.id, 'up-1');
    again.dispose();
  });

  testWidgets('order holds behind a message that is still on its way, not only one that waits', (tester) async {
    final b = Slow();
    final store = AppStore(b);
    await store.start();
    final first = store.send('yoav', 'ראשונה', Priority.next); // on its way, no answer yet
    await tester.pump();
    final c = await store.send('yoav', 'שנייה', Priority.next);
    await tester.pump();
    expect(c.delivery, Delivery.pendingConnection, reason: 'it waits behind the first, not sent alongside it');
    expect(b.ids, hasLength(1));
    b.calls.last.complete(down); // the first did not get there
    final a = await first;
    await tester.pump(const Duration(seconds: 2));
    b.calls.last.complete(const CommandResult.ok());
    await tester.pump();
    b.calls.last.complete(const CommandResult.ok());
    await tester.pump();
    expect(b.ids, [a.id, a.id, c.id]);
    expect([a.delivery, c.delivery], [Delivery.delivered, Delivery.delivered]);
    store.dispose();
  });

  testWidgets('pulled back while the outbox goes: it does not go', (tester) async {
    final b = Slow();
    final store = AppStore(b);
    await store.start();
    final first = store.send('yoav', 'ראשונה', Priority.next);
    await tester.pump();
    b.calls.last.complete(down);
    final a = await first; // waits now
    final c = await store.send('yoav', 'שנייה', Priority.next); // waits behind it; the outbox goes: the first is on its way
    await tester.pump();
    expect(b.ids, [a.id, a.id]);
    expect(await store.retract('yoav', a), isNull, reason: 'on its way: hq may already have it');
    expect(store.error, 'ההודעה כבר בדרך לשרת, ולכן אי אפשר למשוך אותה.');
    expect(await store.retract('yoav', c), 'שנייה');
    b.calls.last.complete(const CommandResult.ok());
    await tester.pump();
    expect(b.ids, [a.id, a.id], reason: 'the pulled-back one never went');
    expect(a.delivery, Delivery.delivered);
    expect(store.data!.chats['yoav']!.items.contains(c), isFalse);
    store.dispose();
  });

  testWidgets('"ניסיון נוסף" on an answer to a question is one bubble', (tester) async {
    final b = Flaky([]);
    final store = AppStore(b);
    await store.start();
    final m = UserMsg(id: 'm-a', ts: DateTime(2026, 10, 21), text: 'כן', priority: Priority.next, delivery: Delivery.failed,
        replyTo: const Quote(author: 'יואב', text: 'q', askId: 'ask-1'));
    store.data!.chats['yoav']!.items.add(m);
    await store.resend('yoav', m);
    expect(store.data!.chats['yoav']!.items.where((i) => identical(i, m)), hasLength(1));
    store.dispose();
  });

  group('HqBackend tells a dropped link from a refusal', () {
    Future<CommandResult> tellWith(MockClient client) async {
      final hq = HqBackend(baseUrl: 'http://hq', token: 't', client: client);
      return hq.send('yoav', UserMsg(id: 'm-1', ts: DateTime(2026, 10, 21), text: 'x', priority: Priority.next));
    }

    test('no answer at all (hq down): transient', () async {
      final r = await tellWith(MockClient((_) async => throw http.ClientException('Connection refused')));
      expect(r.transient, isTrue);
    });

    test('502 from the proxy while hq restarts: transient', () async {
      final r = await tellWith(MockClient((_) async => http.Response('bad gateway', 502)));
      expect(r.transient, isTrue);
    });

    test('400 from hq: final', () async {
      final r = await tellWith(MockClient((_) async => http.Response('{"error":"bad"}', 400)));
      expect(r.ok, isFalse);
      expect(r.transient, isFalse);
    });

    test('the retry carries the same msg_id', () async {
      final ids = <String>[];
      var n = 0;
      final hq = HqBackend(
        baseUrl: 'http://hq',
        token: 't',
        client: MockClient((req) async {
          ids.add((jsonDecode(req.body) as Map)['msg_id'] as String);
          return n++ == 0 ? http.Response('', 502) : http.Response('{}', 200);
        }),
      );
      final msg = UserMsg(id: 'm-1', ts: DateTime(2026, 10, 21), text: 'x', priority: Priority.next);
      expect((await hq.send('yoav', msg)).transient, isTrue);
      expect(msg.delivery, Delivery.pendingConnection);
      expect((await hq.send('yoav', msg)).ok, isTrue);
      expect(ids, ['m-1', 'm-1']);
    });
  });
}

/// A plain fake on the same device, for "after a restart".
class Recordless extends FakeBackend {
  Recordless() : super(simulate: false, now: DateTime(2026, 10, 21, 23, 56));
  @override
  SystemStatus get status => const SystemStatus(LinkState.offline);
}

/// Every send waits until the test completes its entry in [calls].
class Slow extends FakeBackend {
  Slow() : super(simulate: false, now: DateTime(2026, 10, 21, 23, 55));
  final calls = <Completer<CommandResult>>[];
  final ids = <String>[];

  @override
  SystemStatus get status => const SystemStatus(LinkState.online);

  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    ids.add(msg.id);
    final items = data!.chats[identityId]!.items;
    if (!items.contains(msg)) items.add(msg);
    final c = Completer<CommandResult>();
    calls.add(c);
    final r = await c.future;
    if (!r.ok) return r;
    return super.send(identityId, msg);
  }
}
