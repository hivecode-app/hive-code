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
import 'package:agent_company/ui/home/wait_item_screen.dart';
import 'package:agent_company/ui/product/approval.dart';
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
  await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: home));
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
      // At 130% the two folded lines are above the screen, not built.
      if (scale == 1) {
        expect(findShown('אישרת ב-11:58'), findsOneWidget);
        expect(findShown('הוחלפה בבקשה חדשה'), findsOneWidget);
      }
      expect(find.text('אישור'), findsOneWidget, reason: 'only the newest GO asks');
      await _shot(tester, 'a-open-$look');
    });
  }

  // The GO's button opens the approval (product/approval.dart): its facts, and there one tap decides with
  // "ביטול" for 5 seconds; the card in the chat agrees.
  Future<void> openApproval(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(FilledButton, 'אישור'));
    await tester.pumpAndSettle();
    expect(find.byType(ApprovalSheet), findsOneWidget);
  }

  Finder inSheet(Finder f) => find.descendant(of: find.byType(ApprovalSheet), matching: f);

  testWidgets('the moment after "אישור", with "ביטול"; the card in the chat agrees', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await openApproval(tester);
    await tester.tap(inSheet(find.widgetWithText(FilledButton, 'אישור')));
    await tester.pump();
    expect(inSheet(findShown('אישרת · 14:06')), findsOneWidget);
    expect(inSheet(find.text('ביטול')), findsOneWidget);
    Navigator.of(tester.element(find.byType(ApprovalSheet))).pop();
    await tester.pumpAndSettle();
    expect(findShown('אישרת · 14:06'), findsOneWidget);
    expect(find.text('ביטול'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'אישור'), findsNothing);
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('the GO\'s details are in the approval, and opening it never starts an answer', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    // The card shows hq's text (the wait item's body), not the chat item's (#1499).
    expect(find.textContaining('deploy.sh rollback', findRichText: true), findsNothing);
    expect(find.textContaining('חזרה לגרסה הקודמת', findRichText: true), findsWidgets);
    await openApproval(tester);
    // The facts are hq's (the wait item's body), not the card's text.
    expect(inSheet(find.textContaining('חזרה לגרסה הקודמת לוקחת כדקה', findRichText: true)), findsWidgets);
    Navigator.of(tester.element(find.byType(ApprovalSheet))).pop();
    await tester.pumpAndSettle();
    expect(findShown('תשובה ל'), findsNothing, reason: 'no answer strip over the composer');
  });

  testWidgets('"ביטול" within 5 seconds takes the GO back; after them it is sent', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _danaWithHistory(store);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await openApproval(tester);
    await tester.tap(inSheet(find.widgetWithText(FilledButton, 'אישור')));
    await tester.pump(const Duration(seconds: 4));
    await tester.tap(inSheet(find.text('ביטול')));
    await tester.pump();
    expect(inSheet(find.text('ביטול')), findsNothing);
    await tester.tap(inSheet(find.widgetWithText(FilledButton, 'אישור')));
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    final card = store.data!.chats['dana']!.items.whereType<GoCard>().last;
    expect(card.state, AskState.answered);
    if (find.byType(ApprovalSheet).evaluate().isNotEmpty) {
      Navigator.of(tester.element(find.byType(ApprovalSheet))).pop();
      await tester.pumpAndSettle();
    }
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
    // Open in hq too: the banner counts what hq has open (task 1014).
    store.data!.waiting.add(WaitItem(id: 'w-dq', kind: WaitKind.softAsk, from: 'dana', time: '13:45', kicker: 'שאלה', body: 'q', askId: 'ask-dq', inboxId: 45, createdAt: _at(13, 45)));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.text('2 החלטות פתוחות'), findsOneWidget);
    expect(find.text('אישור'), findsNothing);
    await tester.tap(find.text('לראשונה'));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    // The first is a GO: it opens whole, over its card, which is now on screen (#1499).
    expect(find.byType(ApprovalSheet), findsOneWidget);
    Navigator.of(tester.element(find.byType(ApprovalSheet))).pop();
    await tester.pumpAndSettle();
    expect(find.text('אישור'), findsOneWidget, reason: 'the open GO is on screen');
  });

  // #1499: Dana's GO of 08/11, as hq sent it. Its sections are her own ("מה השתנה מהתוכנית הקודמת",
  // "הסדר", "הסיכון", "איך חוזרים"): every one of them is reachable, in the card and in the approval.
  const realGo = '**מה השתנה מהתוכנית הקודמת:** מהתקלה של הערב למדנו שהמכונה אצל ספק השרתים נחסמת כשמעתיקים אליה הרבה.\n\n'
      '**הסדר:**\n1. **בלי ניתוק:** הוצאת העותק של ה-DB מהמכונה אצל ספק השרתים.\n2. **ניתוק 1, ‏20–45 שניות:** שרת הצ\'אט עובר מהמכונה של dev.\n'
      '3. **ה-promote.**\n   - **ניתוק 2,** כ-10 שניות בכל מכונה.\n\n'
      '**הסיכון:** שלושה ניתוקים קצרים. הודעות מחכות בטלפון ויוצאות לבד.\n\n'
      '**איך חוזרים:** לכל שלב יש דרך חזרה כתובה.\n\n'
      '**איפה אני חולקת:** אפשר גם לוותר הלילה על העותק השלישי של תור הבוטים.\n'
      'PR: https://github.com/hive-owner/lumo-app/pull/4378\nסיכון: medium';
  const realHeadline = 'להחליט אם להמשיך הלילה את הפריסה שנעצרה, בתוכנית מתוקנת בלי סיכון מספק השרתים';

  void danaRealGo(AppStore store) {
    final d = store.data!;
    d.chats['dana'] = Conversation(identityId: 'dana', items: [
      GoCard(id: 'rg', ts: _at(13, 41), askId: 'inbox:1279', from: 'dana', headline: realHeadline, details: realGo),
    ]);
    d.waiting.removeWhere((w) => w.from == 'dana');
    d.waiting.insert(0, WaitItem(id: 'w-rg', kind: WaitKind.go, from: 'dana', time: '13:41', kicker: 'GO לפרודקשן', headline: realHeadline, body: realGo, options: const [AskOption(id: 'go', label: 'GO', primary: true)],
        links: const [WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo-app/pull/4378')], askId: 'inbox:1279', inboxId: 1279, createdAt: _at(13, 41)));
  }

  testWidgets('a GO\'s whole body: folded with "עוד" in the card, whole in the approval, with its PR', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    danaRealGo(store);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    // The headline is a sentence of hers: shown as written, not wrapped in "לאשר את …?".
    expect(find.text(realHeadline), findsOneWidget);
    expect(find.textContaining('לאשר את', findRichText: true), findsNothing);
    expect(find.textContaining('מהתקלה של הערב', findRichText: true), findsWidgets);
    expect(find.text('עוד'), findsOneWidget, reason: 'a long body folds');
    await _shot(tester, 'real-go-card-folded');
    await tester.tap(find.text('עוד'));
    await tester.pumpAndSettle();
    await _shot(tester, 'real-go-card-open');
    expect(find.textContaining('לוותר הלילה על העותק השלישי', findRichText: true), findsWidgets);
    expect(find.text('השינוי בקוד'), findsOneWidget);
    expect(find.textContaining('סיכון: medium', findRichText: true), findsNothing, reason: 'the trailer is a level, not text');

    await openApproval(tester);
    for (final words in ['מהתקלה של הערב', 'הוצאת העותק של', 'שלושה ניתוקים קצרים', 'לכל שלב יש דרך חזרה כתובה', 'לוותר הלילה על העותק השלישי']) {
      expect(inSheet(find.textContaining(words, findRichText: true)), findsWidgets, reason: words);
    }
    expect(inSheet(find.text('סיכון בינוני')), findsOneWidget);
    expect(inSheet(find.text('השינוי בקוד')), findsOneWidget);
    expect(inSheet(find.text('לא צוין')), findsNothing, reason: 'no guessed section left empty');
    await _shot(tester, 'real-go-approval');
    await tester.drag(inSheet(find.byType(SingleChildScrollView)).first, const Offset(0, -600));
    await tester.pumpAndSettle();
    await _shot(tester, 'real-go-approval-end');
  });

  testWidgets('a long question folds with "עוד" under its headline, and opens whole', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    store.data!.chats['dana'] = Conversation(identityId: 'dana', items: [
      AskCard(id: 'lq', ts: _at(13, 45), askId: 'ask-lq', from: 'dana', headline: 'להעביר את הבוטים לתור החדש הלילה?', question: realGo.split('\nPR:').first,
          options: const [AskOption(id: 'y', label: 'כן'), AskOption(id: 'n', label: 'לא')]),
    ]);
    store.data!.waiting.removeWhere((w) => w.from == 'dana');
    store.data!.waiting.add(WaitItem(id: 'w-lq', kind: WaitKind.softAsk, from: 'dana', time: '13:45', kicker: 'שאלה', body: 'q', askId: 'ask-lq', inboxId: 46, createdAt: _at(13, 45)));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.textContaining('מהתקלה של הערב', findRichText: true), findsWidgets);
    expect(find.text('עוד'), findsOneWidget);
    await _shot(tester, 'real-ask-folded');
    await tester.tap(find.text('עוד'));
    await tester.pumpAndSettle();
    expect(find.textContaining('לוותר הלילה על העותק השלישי', findRichText: true), findsWidgets);
    expect(find.text('פחות'), findsOneWidget);
  });

  testWidgets('a question\'s whole text shows in the card, and "לשאלה" opens its details', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    final chat = Conversation(identityId: 'dana', items: [
      AskCard(id: 'dq', ts: _at(13, 45), askId: 'ask-dq', from: 'dana', headline: 'לשלוח למשה את רשימת השינויים?',
          question: 'הרשימה ארוכה: **14 שינויים** מאז הגרסה הקודמת, כולל התיקון לתמונות.', options: const [AskOption(id: 'y', label: 'כן'), AskOption(id: 'n', label: 'לא')]),
      for (var i = 0; i < 40; i++) TextMsg(id: 'pad$i', ts: _at(14, 0), text: 'שורה $i'),
    ]);
    store.data!.chats['dana'] = chat;
    store.data!.waiting.removeWhere((w) => w.from == 'dana');
    store.data!.waiting.add(WaitItem(id: 'w-dq', kind: WaitKind.softAsk, from: 'dana', time: '13:45', kicker: 'שאלה', body: 'q', askId: 'ask-dq', inboxId: 45, createdAt: _at(13, 45)));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await tester.tap(find.text('לשאלה'));
    for (var i = 0; i < 30; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    await tester.pumpAndSettle();
    expect(find.textContaining('14 שינויים', findRichText: true), findsWidgets);
  });

  testWidgets('"מחכה לך": the pile\'s card and a decision\'s page show the GO\'s whole text as markdown (#1499)', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 900), home: const SizedBox());
    danaRealGo(store);
    decisionQueue
      ..order.clear()
      ..done.clear()
      ..current = null
      ..focus('w-rg');
    await pumpScreen(tester, store, const DecisionStack());
    expect(find.textContaining('מהתקלה של הערב', findRichText: true), findsWidgets);
    expect(find.textContaining('**', findRichText: true), findsNothing, reason: 'markdown, not its marks');
    // A decision with no headline: its page shows the body as markdown too.
    final bare = WaitItem(id: 'w-bare', kind: WaitKind.go, from: 'dana', time: '13:41', kicker: 'GO', body: realGo, options: const [AskOption(id: 'go', label: 'GO', primary: true)], askId: 'inbox:1280', inboxId: 1280);
    await pumpScreen(tester, store, WaitItemScreen(item: bare));
    expect(find.textContaining('לוותר הלילה על העותק השלישי', findRichText: true), findsWidgets);
    expect(find.textContaining('**', findRichText: true), findsNothing);
  });

  testWidgets('a headline that is the worker\'s sentence is not wrapped; a short name is, and is not said twice (#1499)', (tester) async {
    late BuildContext ctx;
    await pumpApp(tester, home: Builder(builder: (c) {
      ctx = c;
      return const SizedBox();
    }));
    WaitItem go(String? headline, {String body = ''}) => WaitItem(id: 'g', kind: WaitKind.go, from: 'dana', time: '', kicker: '', headline: headline, body: body);
    expect(approvalTitle(ctx, go(realHeadline)), realHeadline);
    expect(approvalTitle(ctx, go('לשלוח את הגרסה?')), 'לשלוח את הגרסה?');
    expect(approvalTitle(ctx, go('התיקון למפה')), 'לאשר את התיקון למפה?');
    expect(approvalParts(go('התיקון למפה', body: 'התיקון למפה\nשלב אחד')).text, 'שלב אחד');
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
