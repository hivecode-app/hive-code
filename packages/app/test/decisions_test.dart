// #258: decisions in one tap. A GO or a question shows its buttons, always; a tap on the card opens its
// details and never starts an answer; one tap decides and folds the card to "אישרת · 14:06" with "ביטול"
// for 5 seconds; older GO requests from the same worker fold to one line; the banner leads to the card;
// and the "החלטות" tab decides with the same buttons.
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/decisions/decisions_screen.dart';
import 'package:agent_company/ui/home/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

DateTime _at(int h, int m) => DateTime(2026, 10, 20, h, m);

/// Dana's conversation for the shots (a fixture): a GO approved this morning, one replaced by a newer
/// request, and the newest, open.
void _danaWithHistory(AppStore store) {
  final d = store.data!;
  d.chats['dana'] = Conversation(identityId: 'dana', items: [
    UserMsg(id: 'du1', ts: _at(11, 20), text: 'שה-APK יתקן את הטקסט בטלפון, ותעדכני מתי זה מוכן', delivery: Delivery.read),
    GoCard(id: 'g-old', ts: _at(11, 30), askId: 'inbox:30', from: 'dana', headline: 'עדכון ללומו: תמונות בצ\'אט', details: 'גרסה 1.1.19', state: AskState.answered, answer: 'GO')
      ..answeredAt = _at(11, 58),
    TextMsg(id: 'dt1', ts: _at(12, 40), text: 'מצאתי עוד שבירה בטקסט בטלפון. מכינה גרסה מתוקנת.'),
    GoCard(id: 'g-mid', ts: _at(12, 50), askId: 'inbox:31', from: 'dana', headline: 'עדכון ללומו: הטקסט בטלפון', details: 'גרסה 1.1.20-rc1'),
    TextMsg(id: 'dt2', ts: _at(13, 24), text: 'מוכן. שירה בדקה על CPH2653, הטקסט תקין בעברית ובאנגלית.'),
    GoCard(
      id: 'dg1',
      ts: _at(13, 41),
      askId: 'ask-dana-go',
      from: 'dana',
      headline: 'עדכון ללומו: הטקסט בטלפון מתוקן',
      details: '**מה נכנס:** תיקון הטקסט בטלפון (#3698), גרסה 1.1.20\n'
          '**סיכון:** נמוך. קובץ אחד באפליקציה. הבדיקות והסקירה עברו.\n'
          '**חזרה:** `deploy.sh rollback 1.1.19`, כדקה',
    ),
  ]);
  d.waiting.insert(0, WaitItem(id: 'w-dana-old', kind: WaitKind.go, from: 'dana', time: '12:50', kicker: 'GO לפרודקשן', body: 'גרסה 1.1.20-rc1', askId: 'inbox:31', inboxId: 31, createdAt: _at(12, 50)));
}

/// Three decisions (a fixture): Dana's GO, Ido's question with options, and Noga's GO.
void _threeDecisions(AppStore store) {
  final d = store.data!;
  d.waiting.removeWhere((w) => w.kind != WaitKind.go && w.kind != WaitKind.blockingAsk);
  d.waiting.add(WaitItem(
    id: 'w-noga',
    kind: WaitKind.go,
    from: 'noga',
    time: '13:58',
    kicker: 'GO לפרודקשן · זיכרון',
    headline: 'איחוד זיכרונות כפולים בשרת',
    body: 'מיזוג 14 זיכרונות כפולים. סיכון נמוך, יש גיבוי.',
    options: const [AskOption(id: 'go', label: 'GO', primary: true)],
    askId: 'inbox:44',
    inboxId: 44,
    createdAt: _at(13, 58),
  ));
  d.presence['itai'] = const Presence(status: WorkerStatus.working);
}

Future<void> pumpScreen(WidgetTester tester, AppStore store, Widget home, {bool dark = false}) async {
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: home));
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

Future<void> _shot(WidgetTester tester, String name) async {
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions/$name.png'));
}

void main() {
  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('(a) an open GO, the two before it folded ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale, home: const SizedBox());
      _danaWithHistory(store);
      await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'), dark: dark);
      expect(findShown('אישרת ב-11:58'), findsOneWidget);
      expect(findShown('הוחלפה בבקשה חדשה'), findsOneWidget);
      expect(find.text('אישור'), findsOneWidget, reason: 'only the newest GO asks');
      await _shot(tester, 'a-open-$look');
    });

    testWidgets('(b) the moment after "אישור", with "ביטול" ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale, home: const SizedBox());
      _danaWithHistory(store);
      await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'), dark: dark);
      await tester.tap(find.text('אישור'));
      await tester.pump();
      expect(findShown('אישרת · 14:06'), findsOneWidget);
      expect(find.text('ביטול'), findsOneWidget);
      expect(find.text('אישור'), findsNothing);
      await _shot(tester, 'b-approved-$look');
      await tester.pump(const Duration(seconds: 6));
    });
  }

  testWidgets('a tap on the card opens its details and never starts an answer', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.textContaining('deploy.sh rollback'), findsNothing);
    await tester.tap(findShown('עדכון ללומו: הטקסט בטלפון מתוקן'));
    await tester.pumpAndSettle();
    expect(find.textContaining('rollback', findRichText: true), findsWidgets);
    expect(find.byIcon(Icons.close), findsNothing);
    expect(findShown('תשובה ל'), findsNothing, reason: 'no answer strip over the composer');
  });

  testWidgets('"ביטול" within 5 seconds takes the GO back; after them it is sent', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await tester.tap(find.text('אישור'));
    await tester.pump(const Duration(seconds: 4));
    await tester.tap(find.text('ביטול'));
    await tester.pump();
    expect(find.text('אישור'), findsOneWidget);
    await tester.tap(find.text('אישור'));
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    final card = store.data!.chats['dana']!.items.whereType<GoCard>().last;
    expect(card.state, AskState.answered);
    expect(findShown('אישרת ב-14:06'), findsOneWidget);
    expect(find.text('ביטול'), findsNothing);
  });

  testWidgets('the banner names the open decisions and brings the first into view', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    final chat = store.data!.chats['dana']!;
    // A question too, and a long talk after both: the cards are far up, not built yet.
    chat.items.add(AskCard(id: 'dq', ts: _at(13, 45), askId: 'ask-dq', from: 'dana', question: 'לשלוח למשה גם את רשימת השינויים?', options: const [AskOption(id: 'y', label: 'כן'), AskOption(id: 'n', label: 'לא')]));
    for (var i = 0; i < 40; i++) {
      chat.items.add(TextMsg(id: 'pad$i', ts: _at(14, 0), text: 'שורה $i'));
    }
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.text('2 החלטות פתוחות'), findsOneWidget);
    expect(find.text('אישור'), findsNothing);
    await tester.tap(find.text('לראשונה'));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    expect(find.text('אישור'), findsOneWidget, reason: 'the open GO is on screen');
  });

  testWidgets('no banner when nothing is open', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    store.data!.chats['dana']!.items.removeWhere((i) => i.id == 'dg1' || i.id == 'g-mid');
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.text('לבקשה'), findsNothing);
    expect(find.text('לשאלה'), findsNothing);
  });

  testWidgets('the stack decides in place: the same folded line, and the card in the chat agrees', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 900), home: const SizedBox());
    _threeDecisions(store);
    decisionQueue
      ..order.clear()
      ..done.clear()
      ..current = null;
    await pumpScreen(tester, store, const DecisionStack());
    await tester.tap(find.text('ביטול המנוי מיד'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400)); // the card flies off first
    expect(findShown('ענית: ביטול המנוי מיד · 14:06'), findsOneWidget);
    expect(store.decision('ask-ido', 'w-ido'), isNotNull);
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    final card = store.data!.chats['ido']!.items.whereType<AskCard>().single;
    expect(card.state, AskState.answered);
    expect(card.answer, 'ביטול המנוי מיד');
  });

  test('an older GO from the same worker is replaced, and leaves the count', () async {
    final store = AppStore(FakeBackend(simulate: false, now: kDemoNow));
    await store.start();
    final d = store.data!;
    final before = d.waitingCount;
    d.waiting.add(WaitItem(id: 'w-dana-new', kind: WaitKind.go, from: 'dana', time: '14:05', kicker: 'GO', body: 'x', askId: 'inbox:99', inboxId: 99, createdAt: _at(14, 5)));
    expect(d.superseded(d.waiting.firstWhere((w) => w.id == 'w-dana')), isTrue);
    expect(d.superseded(d.waiting.last), isFalse);
    expect(d.waitingCount, before);
  });

  testWidgets('the desktop\'s "מחכה לך" leaves out a GO that was replaced', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    store.data!.waiting.add(WaitItem(id: 'w-dana-new', kind: WaitKind.go, from: 'dana', time: '14:05', kicker: 'GO · גרסה חדשה', body: 'x', options: const [AskOption(id: 'go', label: 'GO', primary: true)], askId: 'inbox:99', inboxId: 99, createdAt: _at(14, 5)));
    await pumpScreen(tester, store, const Scaffold(body: WaitingList()));
    expect(find.byKey(const ValueKey('w-dana')), findsNothing);
    expect(find.byKey(const ValueKey('w-dana-new')), findsOneWidget);
    expect(find.text('אישור'), findsOneWidget);
  });

}
