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

  testWidgets('a browser request is a card with what is needed, the tab and "סיימתי"; pressing it closes the card', (tester) async {
    await pumpApp(tester, size: const Size(342, 900), home: const ChatScreen(identityId: 'amit'));
    expect(find.textContaining('בקשה בדפדפן', findRichText: true), findsOneWidget);
    expect(find.textContaining('נדרש קוד אימות כדי להוריד', findRichText: true), findsOneWidget);
    expect(find.text('פתיחה'), findsOneWidget);
    await tester.tap(find.text('סיימתי'));
    await tester.pumpAndSettle();
    expect(find.text('סיימתי'), findsNothing);
    expect(find.textContaining('בוצע', findRichText: true), findsOneWidget);
  });

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

  testWidgets('a plain tap while busy sends now: no "בתור" on the bubble', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    final chat = store.data!.chats['dana']!;
    // With her GO open the text would answer it (the next test): close it first, as after a GO.
    for (final c in chat.items.whereType<AskCard>()) {
      c.state = AskState.answered;
    }
    store.touch();
    await tester.pump();
    // The mockup already has one message queued after the step.
    expect(find.text('בתור · אחרי הצעד הנוכחי · '), findsOneWidget);
    expect(find.text('ושגם ה-web יקבל את התיקון'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    final sent = chat.items.whereType<UserMsg>().last;
    expect(sent.text, 'ושגם ה-web יקבל את התיקון');
    expect(sent.priority, Priority.now);
    expect(sent.delivery, Delivery.delivered);
    expect(chat.live.label, 'נעצרה וקוראת');
    expect(find.text('בתור · אחרי הצעד הנוכחי · '), findsOneWidget);
    // The second until hq hands it to her CLI: still no "בתור" line under it.
    sent.delivery = Delivery.queued;
    store.touch();
    await tester.pump();
    expect(find.textContaining('בתור'), findsOneWidget);
  });

  testWidgets('after the current step stays a choice on long press: queued, then retracted to the composer', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    final chat = store.data!.chats['dana']!;
    for (final c in chat.items.whereType<AskCard>()) {
      c.state = AskState.answered;
    }
    store.touch();
    await tester.pump();
    await tester.longPress(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    await tester.tap(find.text('אחרי הצעד הנוכחי'));
    await tester.pump();
    final sent = chat.items.whereType<UserMsg>().last;
    expect(sent.text, 'ושגם ה-web יקבל את התיקון');
    expect(sent.priority, Priority.next);
    expect(sent.delivery, Delivery.queued);
    expect(find.text('בתור · אחרי הצעד הנוכחי · '), findsNWidgets(2));
    await tester.tap(find.text('משיכה חזרה').first);
    await tester.pump();
    expect(chat.items.contains(sent), isFalse);
    expect(find.text('ושגם ה-web יקבל את התיקון'), findsOneWidget);
  });

  testWidgets('his message waiting on a tool says on what, never "בתור"; after 3 minutes, how long and "עצירה עכשיו"', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'noa'));
    final chat = store.data!.chats['noa']!;
    final msg = UserMsg(id: 'w1', ts: kDemoNow, text: 'תעצרי רגע', priority: Priority.now, delivery: Delivery.delivered,
        waitingOn: WaitingOn(tool: 'Bash', command: 'cd packages/app && npm run build', since: kDemoNow.subtract(const Duration(minutes: 1))));
    chat.items.add(msg);
    store.touch();
    await tester.pump();
    expect(find.textContaining('נכנסת כשהפקודה', findRichText: true), findsOneWidget);
    expect(find.textContaining('npm run build', findRichText: true), findsOneWidget);
    expect(find.textContaining('בתור', findRichText: true), findsNothing);
    expect(find.text('עצירה עכשיו'), findsNothing);

    // Long on one tool: how long it has run, and the chat's stop (with its confirm mid-command).
    chat.live = const LiveState(phase: LivePhase.tool, label: 'מריצה פריסה', runningCommand: 'bash deploy/hq.sh');
    msg.waitingOn = WaitingOn(tool: 'Bash', command: 'bash deploy/hq.sh', since: kDemoNow.subtract(const Duration(minutes: 4)));
    store.touch();
    await tester.pump();
    expect(find.textContaining('נכנסת כשהפריסה תסתיים · כבר 4 דק׳', findRichText: true), findsOneWidget);
    expect(find.textContaining('כבר 4 דק׳ ·', findRichText: true), findsNothing, reason: 'no dot left hanging before the link');
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_noa_waiting.png'));
    await tester.tap(find.text('עצירה עכשיו'));
    await tester.pump();
    expect(find.textContaining('לעצור באמצע', findRichText: true), findsOneWidget);
    await tester.tap(find.text('המשך'));
    await tester.pump();

    // Read: the line goes.
    msg.delivery = Delivery.read;
    store.touch();
    await tester.pump();
    expect(find.textContaining('נכנסת כש', findRichText: true), findsNothing);
  });

  testWidgets('the waiting line at text scale 1.3 with a long command still fits the phone', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 900), textScale: 1.3, home: const ChatScreen(identityId: 'noa'));
    final chat = store.data!.chats['noa']!;
    chat.live = const LiveState(phase: LivePhase.tool, label: 'מריצה מיגרציה', runningCommand: 'node scripts/migrate-attachments-to-uploads.mjs --all');
    chat.items.add(UserMsg(id: 'w2', ts: kDemoNow, text: 'תעצרי רגע', priority: Priority.now, delivery: Delivery.delivered,
        waitingOn: WaitingOn(tool: 'Bash', command: 'node scripts/migrate-attachments-to-uploads.mjs --all', since: kDemoNow.subtract(const Duration(minutes: 5)))));
    store.touch();
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.text('עצירה עכשיו'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_noa_waiting_long.png'));
  });

  testWidgets('a tool that ran past a minute shows m:ss, not 0:240', (tester) async {
    final store = await pumpApp(tester, home: const ChatScreen(identityId: 'noa'));
    store.data!.chats['noa']!.live = const LiveState(phase: LivePhase.tool, label: 'מריצה בדיקות', seconds: 240);
    store.touch();
    await tester.pump();
    expect(find.textContaining('מריצה בדיקות · 4:00', findRichText: true), findsOneWidget);
  });

  test('what a message waits for, in his words', () {
    WaitingOn w(String tool, [String? cmd]) => WaitingOn(tool: tool, command: cmd, since: kDemoNow);
    expect(waitingWhat(w('Bash', 'npm test 2>&1 | tail')), ('הפקודה `npm test`', true));
    expect(waitingWhat(w('Bash', 'kubectl apply -f x.yaml')), ('הפריסה', true));
    expect(waitingWhat(w('Bash', 'git push origin HEAD --force-with-lease --no-verify')).$1, 'הפקודה `git push origin HEAD --…`');
    expect(waitingWhat(w('Edit')), ('העריכה', true));
    expect(waitingWhat(w('Agent')), ('העוזר', false));
    expect(waitingWhat(w('mcp__company__tell')), ('הכלי `tell`', false));
  });

  test('waiting_on from hq', () {
    final p = WaitingOn.parse({'tool': 'Bash', 'command': 'npm test', 'since': '2026-10-21T06:00:00.000Z'})!;
    expect((p.tool, p.command, p.since.toUtc().hour), ('Bash', 'npm test', 6));
    expect(WaitingOn.parse(null), isNull);
    expect(WaitingOn.parse({'tool': 'Bash'}), isNull);
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

  testWidgets('answering in the chat: the card folds at once with "ביטול" for 5s, and the pin goes', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 2300), home: const ChatScreen(identityId: 'ido'));
    expect(find.text('לשאלה'), findsOneWidget);
    await tester.tap(find.text('ביטול המנוי מיד'));
    await tester.pump();
    expect(findShown('ענית: ביטול המנוי מיד · 14:06'), findsOneWidget);
    expect(find.text('לשאלה'), findsNothing);
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    expect(findShown('ענית ב-14:06: ביטול המנוי מיד'), findsOneWidget);
    expect(find.text('לשאלה'), findsNothing);
    expect(store.data!.waiting.firstWhere((w) => w.from == 'ido').state, WaitState.answered);
  });

  testWidgets('an open GO: the headline first, details folded, buttons in it; typing is a message, not an answer (#258)', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
    final chat = store.data!.chats['dana']!;
    final go = chat.items.whereType<GoCard>().single;
    expect(find.text('עדכון ללומו: הטקסט בטלפון מתוקן'), findsWidgets);
    expect(find.text('אישור'), findsOneWidget);
    expect(find.text('לא עכשיו'), findsOneWidget);
    // Details are folded until asked for; a tap on the card opens them.
    expect(find.textContaining('deploy.sh rollback'), findsNothing);
    await tester.tap(find.text('עדכון ללומו: הטקסט בטלפון מתוקן').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('deploy.sh rollback'), findsOneWidget);
    // Nothing tags what he writes as an answer to it.
    expect(find.text('תשובה לבקשת GO של דנה'), findsNothing);
    expect(find.descendant(of: find.byType(Composer), matching: find.byType(QuoteStrip)), findsNothing);
    await tester.tap(find.bySemanticsLabel('שליחה'));
    await tester.pump();
    final sent = chat.items.whereType<UserMsg>().last;
    expect(sent.text, 'ושגם ה-web יקבל את התיקון');
    expect(sent.replyTo, isNull);
    expect(go.state, AskState.open);
    expect(find.text('אישור'), findsOneWidget);
  });

  testWidgets('his button answer is "מאשר" under a small quote of the question, no internal id', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 600), home: const ChatScreen(identityId: 'dana'));
    store.data!.chats['dana']!.items.add(UserMsg(id: 'm-answer', ts: kDemoNow, text: 'מאשר', delivery: Delivery.delivered,
        replyTo: const Quote(author: 'דנה', text: 'להעביר גם את הבוטים?', askId: 'a1')));
    store.touch();
    await tester.pump();
    expect(find.textContaining('תשובה לשאלה noa', findRichText: true), findsNothing);
    expect(find.textContaining('מאשר', findRichText: true), findsWidgets);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/chat_answer_quote.png'));
  });
}
