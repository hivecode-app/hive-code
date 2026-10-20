// #55: answering questions (quote-reply, the direct field), the system sender, and an outbox
// that is sent when the link comes back instead of waiting for good.
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/home/home_screen.dart';
import 'package:agent_company/ui/home/wait_item_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

/// FakeBackend that records what was sent where, with a link state the test sets.
class Recording extends FakeBackend {
  Recording() : super(simulate: false, now: DateTime(2026, 10, 20, 14, 6));
  final answers = <(String, String)>[];
  final tells = <(String, String)>[];
  CommandResult answerResult = const CommandResult.ok();
  LinkState link = LinkState.online;

  @override
  SystemStatus get status => SystemStatus(link);

  void setLink(LinkState s) {
    link = s;
    notifyListeners();
  }

  @override
  Future<CommandResult> freeAnswer(String askId, String text, {List<Attachment> attachments = const []}) async {
    answers.add((askId, text));
    if (!answerResult.ok) return answerResult;
    return super.freeAnswer(askId, text, attachments: attachments);
  }

  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    tells.add((identityId, msg.text));
    return super.send(identityId, msg);
  }
}

WaitItem systemAsk() => WaitItem(
      id: 'inbox:7',
      inboxId: 7,
      askId: 'account-login-hive-owner-x',
      kind: WaitKind.softAsk,
      from: kSystemId,
      time: '11:00',
      kicker: 'שאלה',
      body: 'חיבור החשבון hive-owner. פותחים את הקישור ומדביקים את הקוד כאן:\nhttps://claude.com/cai/oauth/authorize?code=true',
    );

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('a reply that quotes a question answers it, and is not a message to the asker', () async {
    final b = Recording();
    final store = AppStore(b);
    await store.start();
    final m = await store.send('yoav', 'הקוד: 12345', Priority.next, quote: const Quote(author: 'יואב', text: 'מה הקוד?', askId: 'ask-1'));
    expect(b.answers, [('ask-1', 'הקוד: 12345')]);
    expect(b.tells, isEmpty);
    expect(m.delivery, Delivery.delivered);
  });

  test('a refused answer is marked failed with the reason, never left waiting', () async {
    final b = Recording()..answerResult = const CommandResult.fail('הפריט כבר טופל, ולכן התשובה לא נשלחה.');
    final store = AppStore(b);
    await store.start();
    final m = await store.send('yoav', 'x', Priority.next, quote: const Quote(author: 'יואב', text: 'q', askId: 'ask-1'));
    expect(m.delivery, Delivery.failed);
    expect(store.error, 'הפריט כבר טופל, ולכן התשובה לא נשלחה.');
  });

  test('what was written offline is sent when the link comes back', () async {
    final b = Recording()..link = LinkState.offline;
    final store = AppStore(b);
    await store.start();
    final m = await store.send('yoav', 'נכתב בלי חיבור', Priority.next);
    expect(m.delivery, Delivery.pendingConnection);
    expect(b.tells, isEmpty);
    b.setLink(LinkState.online);
    await Future<void>.delayed(Duration.zero);
    expect(b.tells, [('yoav', 'נכתב בלי חיבור')]);
    expect(m.delivery, isNot(Delivery.pendingConnection));
  });

  testWidgets('the system sender has a name, a direct answer field, and its own page', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: HomeScreen()));
    store.data!.waiting.insert(0, systemAsk());
    store.touch();
    await tester.pump();
    expect(find.text('המערכת'), findsOneWidget);
    expect(find.text('hq'), findsNothing);
    expect(find.byKey(const Key('answer-field-inbox:7')), findsOneWidget); // no options: the field at once

    await tester.ensureVisible(find.text('המערכת'));
    await tester.pump();
    await tester.tap(find.text('המערכת'));
    await tester.pumpAndSettle();
    expect(find.byType(WaitItemScreen), findsOneWidget);

    await tester.enterText(find.byKey(const Key('answer-field-inbox:7')).last, 'abc#123');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    expect(store.data!.waiting.first.state, WaitState.answered);
  });
}
