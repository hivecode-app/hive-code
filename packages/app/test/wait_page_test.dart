// A tap on an item in "מחכה לך" opens the item's own page, not the conversation: the question in front of
// him, "פרטים" open, the same decision buttons as the card, and "לשיחה עם …" at the bottom.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:agent_company/ui/home/wait_item_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

DateTime _at(int h, int m) => DateTime(2026, 10, 20, h, m);

WaitItem _ask() => WaitItem(
      id: 'w-ido-new',
      kind: WaitKind.blockingAsk,
      from: 'ido',
      time: '13:50',
      kicker: 'שאלה · חוסמת',
      headline: 'מה עושים עם המנוי של לומו?',
      body: 'המנוי פג אתמול. אפשר לחדש עכשיו או לבטל.\nהחידוש עולה 40 ש"ח לחודש.',
      options: const [AskOption(id: 'a', label: 'ביטול המנוי מיד', primary: true), AskOption(id: 'b', label: 'חידוש לחודש')],
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

Future<AppStore> _open(WidgetTester tester, WaitItem item, {bool dark = false}) async {
  final store = await pumpApp(tester, dark: dark, size: const Size(390, 800), home: const SizedBox());
  store.data!.waiting.removeWhere((w) => w.kind != WaitKind.awaiting && w.kind != WaitKind.go && w.kind != WaitKind.blockingAsk);
  store.data!.waiting.insert(0, item);
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: WaitItemScreen(item: item)));
  await tester.pumpAndSettle();
  return store;
}

void main() {
  testWidgets('a tap on a question in "מחכה לך" opens its page, not the conversation', (tester) async {
    final store = await pumpApp(tester, size: const Size(390, 900), home: const SizedBox());
    store.data!.waiting.insert(0, _ask());
    store.touch();
    await tester.pumpWidget(CompanyApp(store: store, home: const Scaffold(body: ConversationsScreen())));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('מה עושים עם המנוי', findRichText: true).first);
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

  for (final dark in [false, true]) {
    final look = dark ? 'dark' : 'light';
    testWidgets('page of a question with options ($look)', (tester) async {
      await _open(tester, _ask(), dark: dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/wait_page/ask-$look.png'));
    });
    testWidgets('page of a GO ($look)', (tester) async {
      await _open(tester, _go(), dark: dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/wait_page/go-$look.png'));
    });
  }
}
