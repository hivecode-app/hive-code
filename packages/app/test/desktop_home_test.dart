// The desktop opens on the home (HomeV2Page in the main column), the same home as the phone's, with its row at
// the top of the chats list. Light and dark, with something waiting and with nothing (goldens/desktop_home/).
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/chat/items.dart' show shortcutAsk;
import 'package:agent_company/ui/common.dart' show Ic;
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

const _desktop = Size(1440, 860);

/// Nothing waits and nobody is stuck or waiting on him: the sentence says so, and "מחכה לך" is not on the screen. hq's default
/// recipe (#164): a line for the busiest project, the rest folded into "שקט גם ב:".
void _quiet(AppStore store) {
  final d = store.data!;
  final active = [for (final x in projectsByActivity(d)) if (x.active) x.id];
  d.openTasks = [for (final t in d.openTasks) if (t.project == active.first) t];
  d.home = HomeRecipe(version: 0, composedBy: 'hq', composedAt: kDemoNow, source: 'default', blocks: [
    HomeBlock(type: 'project', projects: [active.first]),
    HomeBlock(type: 'quiet', projects: active.skip(1).toList()),
  ]);
  for (final w in d.waiting) {
    w.state = WaitState.answered;
  }
  for (final e in [...d.presence.entries]) {
    if (const [WorkerStatus.stuck, WorkerStatus.waiting, WorkerStatus.blocked].contains(e.value.status)) d.presence[e.key] = Presence(status: WorkerStatus.working, currentTask: e.value.currentTask, activity: e.value.activity);
  }
  store.touch();
}

/// What he wrote last, with each delivery state the row has a tick for: sent, delivered, read (the demo's rows carry none).
void _mine(AppStore store) {
  const ticks = {'rotem': Delivery.queued, 'amit': Delivery.delivered, 'ido': Delivery.read};
  final d = store.data!;
  final next = [
    for (final c in d.conversations)
      ticks.containsKey(c.identityId)
          ? ConversationSummary(identityId: c.identityId, lastLine: c.lastLine, text: c.lastLine, time: c.time, lastIsMine: true, unread: c.unread, delivery: ticks[c.identityId])
          : c,
  ];
  d.conversations
    ..clear()
    ..addAll(next);
  store.touch();
}

void main() {
  for (final dark in [false, true]) {
    final t = dark ? 'dark' : 'light';
    testWidgets('desktop: the app opens on the home, something waits ($t)', (tester) async {
      final store = await pumpApp(tester, dark: dark, size: _desktop);
      _mine(store);
      await tester.pumpAndSettle();
      expect(store.homeOpen, isTrue);
      expect(find.byType(HomeV2Page), findsOneWidget);
      expect(find.byType(HomeEntryRow), findsOneWidget);
      expect(find.byType(WaitingBlock), findsNothing, reason: 'what waits is the "החלטות" tab\'s');
      expect(find.text(decisionsLead(store.data!.waitingCount)!), findsOneWidget, reason: 'the sentence leads with the live count');
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/desktop_home/waiting-$t.png'));
    });

    testWidgets('desktop: the home when nothing waits, with "שקט גם ב:" ($t)', (tester) async {
      final store = await pumpApp(tester, dark: dark, size: _desktop);
      _mine(store);
      _quiet(store);
      await tester.pumpAndSettle();
      expect(find.byType(WaitingBlock), findsNothing);
      expect(find.byType(AlertBlock), findsNothing);
      expect(findShown('שום דבר לא מחכה לך'), findsWidgets);
      expect(find.byType(QuietBlock), findsOneWidget);
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/desktop_home/quiet-$t.png'));
    });
  }

  testWidgets('desktop: the list is 360 wide and its rows are the phone\'s (his own last line with the ticks, "· team")', (tester) async {
    final store = await pumpApp(tester, size: _desktop);
    await tester.pumpAndSettle();
    _mine(store);
    await tester.pumpAndSettle();
    final row = find.byWidgetPredicate((w) => w is ConversationRowV2 && w.c.identityId == 'amit');
    expect(row, findsOneWidget);
    expect(tester.getSize(find.ancestor(of: row, matching: find.byType(ListView)).first).width, closeTo(360, 1), reason: '360 with its 1px edge');
    expect(find.descendant(of: row, matching: find.textContaining('אתה: ', findRichText: true)), findsOneWidget);
    expect(find.descendant(of: row, matching: find.byWidgetPredicate((w) => w is Ic && const ['schedule', 'done', 'done_all'].contains(w.name))), findsOneWidget);
    expect(find.byType(ConversationRowV2), findsWidgets);
  });

  testWidgets('desktop: a conversation closes the home, and its row opens it again', (tester) async {
    final store = await pumpApp(tester, size: _desktop);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(ConversationRowV2).first);
    await tester.pumpAndSettle();
    expect(store.homeOpen, isFalse);
    expect(find.byType(HomeV2Page), findsNothing);
    await tester.tap(find.byType(HomeEntryRow));
    await tester.pumpAndSettle();
    expect(store.homeOpen, isTrue);
    expect(find.byType(HomeV2Page), findsOneWidget);
  });

  testWidgets('desktop: with the home open, 1-4 and Ctrl+. do not act on a conversation that is not on the screen', (tester) async {
    final store = await pumpApp(tester, size: _desktop);
    await tester.pumpAndSettle();
    final id = store.currentConversation;
    final ask = shortcutAsk(store.data!.chats[id]);
    expect(ask, isNotNull, reason: 'the demo has a question open in the default conversation');
    await tester.sendKeyEvent(LogicalKeyboardKey.digit1, physicalKey: PhysicalKeyboardKey.digit1);
    await tester.pumpAndSettle();
    expect(shortcutAsk(store.data!.chats[id]), same(ask), reason: 'not answered');
    expect(find.text('תשובה לשאלה'), findsNothing);
    expect(find.text('עצירת העובד'), findsNothing);
    // On the conversation, the keys are back.
    store.homeOpen = false;
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text('תשובה לשאלה'), findsOneWidget);
  });
}
