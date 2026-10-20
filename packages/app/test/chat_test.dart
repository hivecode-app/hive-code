import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/composer.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  for (final dark in [false, true]) {
    final t = dark ? 'dark' : 'light';
    testWidgets('conversations golden ($t)', (tester) async {
      await pumpApp(tester, dark: dark, home: const Scaffold(body: ConversationsScreen()));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/convs_$t.png'));
    });
    // Tall frames show every message kind at once (the gallery view of chat.md §2).
    testWidgets('chat with Ido, all kinds ($t)', (tester) async {
      await pumpApp(tester, dark: dark, size: const Size(342, 2300), home: const ChatScreen(identityId: 'ido'));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_ido_$t.png'));
    });
    testWidgets('chat with Dana while she works ($t)', (tester) async {
      await pumpApp(tester, dark: dark, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_dana_$t.png'));
    });
  }

  testWidgets('tool group and diff open on tap', (tester) async {
    await pumpApp(tester, size: const Size(342, 2300), home: const ChatScreen(identityId: 'ido'));
    expect(find.text('internal/billing/stripe.go'), findsNothing);
    await tester.tap(find.textContaining('קרא 4 קבצים'));
    await tester.pumpAndSettle();
    expect(find.text('internal/billing/stripe.go'), findsOneWidget);
    await tester.tap(find.text('השינויים'));
    await tester.pumpAndSettle();
    expect(find.textContaining('ErrNeedsOwnerDecision'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_ido_open.png'));
  });

  testWidgets('send while busy: queued after the current step, then retracted to the composer', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    final chat = store.data!.chats['dana']!;
    // With her GO open the text would answer it (the next test): close it first, as after a GO.
    for (final c in chat.items.whereType<AskCard>()) {
      c.state = AskState.answered;
    }
    store.touch();
    await tester.pump();
    // The composer already holds the draft from the mockup.
    expect(find.text('ושגם ה-web יקבל את התיקון'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    final sent = chat.items.whereType<UserMsg>().last;
    expect(sent.text, 'ושגם ה-web יקבל את התיקון');
    expect(sent.delivery, Delivery.queued);
    expect(find.text('בתור · אחרי הצעד הנוכחי · '), findsNWidgets(2));
    await tester.tap(find.text('משיכה חזרה').first);
    await tester.pump();
    expect(chat.items.contains(sent), isFalse);
    expect(find.text('ושגם ה-web יקבל את התיקון'), findsOneWidget);
  });

  testWidgets('long press on send offers when to deliver', (tester) async {
    await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    await tester.longPress(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    expect(find.text('דנה באמצע עבודה. מתי למסור?'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_dana_menu.png'));
    await tester.tap(find.text('עכשיו'));
    await tester.pump();
    expect(find.text('דנה באמצע עבודה. מתי למסור?'), findsNothing);
  });

  testWidgets('stop is in the status line and works without a confirm while writing', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    await tester.tap(find.text('עצירה'));
    await tester.pump();
    expect(store.data!.chats['dana']!.live.phase, LivePhase.stopped);
    expect(find.textContaining('נעצרה ·'), findsWidgets);
  });

  testWidgets('stop asks first while a command runs', (tester) async {
    await pumpApp(tester, home: const ChatScreen(identityId: 'noa'));
    await tester.tap(find.text('עצירה'));
    await tester.pumpAndSettle();
    expect(find.textContaining('לעצור באמצע'), findsOneWidget);
    await tester.tap(find.text('המשך'));
    await tester.pumpAndSettle();
  });

  testWidgets('answering in the chat: 3s undo, then the card collapses and the pin goes', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 2300), home: const ChatScreen(identityId: 'ido'));
    expect(find.text('לשאלה'), findsOneWidget);
    await tester.tap(find.text('ביטול המנוי מיד'));
    await tester.pump();
    expect(find.text("יישלח לעידו בעוד 3 שנ'"), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.textContaining('ענית: ביטול המנוי מיד'), findsOneWidget);
    expect(find.text('לשאלה'), findsNothing);
    expect(store.data!.waiting.firstWhere((w) => w.from == 'ido').state, WaitState.answered);
  });

  testWidgets('an open GO: the headline first, details folded, buttons under it, and what he types answers it', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    final chat = store.data!.chats['dana']!;
    final go = chat.items.whereType<GoCard>().single;
    expect(find.text('עדכון ללומו: הטקסט בטלפון מתוקן'), findsWidgets);
    // Details are folded until asked for.
    expect(find.textContaining('deploy.sh rollback'), findsNothing);
    await tester.tap(find.text('פרטים'));
    await tester.pumpAndSettle();
    expect(find.textContaining('deploy.sh rollback'), findsOneWidget);
    // The composer says what the text will do: answer her request.
    expect(find.text('תשובה לבקשת GO של דנה'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    final sent = chat.items.whereType<UserMsg>().last;
    expect(sent.text, 'ושגם ה-web יקבל את התיקון');
    expect(sent.replyTo?.askId, go.askId);
    expect(sent.delivery, Delivery.delivered, reason: 'an answer goes now, never queued behind her work');
    expect(go.state, AskState.answered);
    expect(go.answer, 'ושגם ה-web יקבל את התיקון');
    await tester.pump();
    expect(find.textContaining('ענית:', findRichText: true), findsOneWidget);
    expect(find.text('לא עכשיו'), findsNothing, reason: 'the buttons go with the answer');
    // His message carries the quote of her request; the composer no longer does: the next text is a message.
    expect(find.descendant(of: find.byType(Composer), matching: find.byType(QuoteStrip)), findsNothing);
  });
}
