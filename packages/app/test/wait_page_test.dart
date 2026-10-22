// A tap on an item in "מחכה לך" opens the item's own page, not the conversation: the question in front of
// him, "פרטים" open, the same decision buttons as the card, and "לשיחה עם …" at the bottom.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/home/wait_item_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:agent_company/ui/nav.dart';

import 'helpers.dart';

DateTime _at(int h, int m) => DateTime(2026, 10, 20, h, m);

WaitItem _ask({bool marked = false}) => WaitItem(
      id: 'w-ido-new',
      kind: WaitKind.blockingAsk,
      from: 'ido',
      time: '13:50',
      kicker: 'שאלה · חוסמת',
      headline: 'מה עושים עם המנוי של לומו?',
      body: 'המנוי פג אתמול. אפשר לחדש עכשיו או לבטל.\nהחידוש עולה 40 ש"ח לחודש.',
      options: [AskOption(id: 'a', label: 'ביטול המנוי מיד', primary: marked), AskOption(id: 'b', label: 'חידוש לחודש')],
      askId: 'ask-ido-new',
      inboxId: 45,
      createdAt: _at(13, 50),
    );

WaitItem _go() => WaitItem(
      id: 'w-dana-new',
      kind: WaitKind.go,
      from: 'dana',
      time: '13:41',
      kicker: 'GO לפרודקשן',
      headline: 'עדכון ללומו: הטקסט בטלפון מתוקן',
      body: '**מה נכנס:** תיקון הטקסט בטלפון, גרסה 1.1.20\n**סיכון:** נמוך.\n**חזרה:** `deploy.sh rollback 1.1.19`',
      options: const [AskOption(id: 'go', label: 'GO', primary: true)],
      askId: 'inbox:50',
      inboxId: 50,
      createdAt: _at(13, 41),
    );

Future<AppStore> _open(WidgetTester tester, WaitItem item, {bool dark = false, double scale = 1}) async {
  final store = await pumpApp(tester, dark: dark, textScale: scale, size: const Size(390, 800), home: const SizedBox());
  store.data!.waiting.removeWhere((w) => w.kind != WaitKind.awaiting && w.kind != WaitKind.go && w.kind != WaitKind.blockingAsk);
  store.data!.waiting.insert(0, item);
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: WaitItemScreen(item: item)));
  await tester.pumpAndSettle();
  return store;
}

void main() {
  testWidgets('a question\'s page: the details open, and its link goes to the conversation', (tester) async {
    final store = await pumpApp(tester, size: const Size(390, 900), home: const SizedBox());
    final item = _ask();
    store.data!.waiting.insert(0, item);
    store.touch();
    await tester.pumpWidget(CompanyApp(store: store, home: Builder(builder: (c) => Scaffold(body: TextButton(onPressed: () => Nav.waitItem(c, item), child: const Text('פתיחה'))))));
    await tester.tap(find.text('פתיחה'));
    await tester.pumpAndSettle();
    expect(find.byType(WaitItemScreen), findsOneWidget);
    expect(find.byType(ChatScreen), findsNothing);
    expect(find.textContaining('החידוש עולה', findRichText: true), findsOneWidget, reason: 'details open');
    expect(find.text('ביטול המנוי מיד'), findsOneWidget);
    await tester.tap(find.text('לשיחה עם ${store.nameOf('ido')}'));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
  });

  testWidgets('a decision on the page folds with "ביטול"', (tester) async {
    final store = await _open(tester, _ask());
    await tester.tap(find.text('חידוש לחודש'));
    await tester.pump();
    expect(store.decision('ask-ido-new', 'w-ido-new'), isNotNull);
    expect(find.text('ביטול'), findsOneWidget);
    await tester.pump(const Duration(seconds: 6));
  });

  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('page of a question, no answer marked: all the same weight ($look)', (tester) async {
      await _open(tester, _ask(), dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/wait_page/ask-$look.png'));
    });
    testWidgets('page of a question, an answer marked by the worker ($look)', (tester) async {
      await _open(tester, _ask(marked: true), dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/wait_page/ask-marked-$look.png'));
    });
    testWidgets('page of a GO ($look)', (tester) async {
      await _open(tester, _go(), dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/wait_page/go-$look.png'));
    });
  }

  testWidgets('the question is the page\'s title, bigger than the details', (tester) async {
    await _open(tester, _ask());
    double sizeOf(String t) => tester.widget<RichText>(find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains(t)).first).text.style!.fontSize!;
    expect(sizeOf('מה עושים עם המנוי'), 21);
    expect(sizeOf('החידוש עולה'), lessThan(21));
  });
}
