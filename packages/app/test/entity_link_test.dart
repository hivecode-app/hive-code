// What a worker did or does leads to a conversation (docs/app/links.md): the rule, and the taps that follow it.
import 'package:agent_company/data/hq_backend.dart' show mapSnapshot;
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/entity_link.dart';
import 'package:agent_company/ui/projects/project_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// [child] on a screen of its own over the demo, as a block sits on the home.
Future<AppStore> _on(WidgetTester tester, Widget Function(BuildContext) child) async {
  final store = await pumpApp(tester);
  final ctx = tester.element(find.byType(Scaffold).first);
  Navigator.of(ctx).push(MaterialPageRoute(
    builder: (context) => Scaffold(backgroundColor: context.p.surface, body: ListView(children: [BlockCard(child: child(context))])),
  ));
  await tester.pumpAndSettle();
  return store;
}

String? _openChat(WidgetTester tester) {
  final chats = find.byType(ChatScreen);
  return chats.evaluate().isEmpty ? null : tester.widget<ChatScreen>(chats.last).identityId;
}

Ticket _ticket(String number, {String? worker, String? openedBy, DateTime? doneAt}) => Ticket(
    number: number, title: 'אפליקציה: משימה', project: 'lumo', projectName: 'לומו', group: doneAt == null ? TicketGroup.working : TicketGroup.doneToday,
    assignee: '', status: WorkerStatus.working, assigneeId: worker, openedBy: openedBy, doneAt: doneAt);

void main() {
  testWidgets('the rule: the worker on it; a task worker who finished hands it to who opened it; nobody on it, who opened it', (tester) async {
    final store = await pumpApp(tester);
    final d = store.data!;
    expect(d.who('ido').temp, isTrue);
    expect(d.who('dana').temp, isFalse);
    expect(chatTargetOf(d, worker: 'ido', openedBy: 'dana'), 'ido', reason: 'still working: the worker');
    expect(chatTargetOf(d, worker: 'ido', openedBy: 'dana', done: true), 'dana', reason: 'a task worker finished: who opened it');
    expect(chatTargetOf(d, worker: 'dana', openedBy: 'yoav', done: true), 'dana', reason: 'a standing worker keeps it');
    expect(chatTargetOf(d, openedBy: 'dana'), 'dana', reason: 'queued: who opened it');
    expect(chatTargetOf(d, worker: 'ido', done: true), 'ido', reason: 'nobody opened it: still the worker');
    expect(chatTargetOf(d, worker: 'ghost', openedBy: 'ghost2'), isNull, reason: 'no one known: not a link');
    expect(chatTargetOfTicket(d, _ticket('t1', worker: 'ido', openedBy: 'dana', doneAt: kDemoNow)), 'dana');
  });

  testWidgets('"מאז שהיית פה": every line opens who did it, or who opened it once a task worker is done', (tester) async {
    await _on(tester, (context) => SinceBlock(
          now: kDemoNow,
          open: true,
          onToggle: () {},
          data: SinceData(since: kDemoNow.subtract(const Duration(hours: 3)), items: [
            SinceItem(key: 'a', text: 'התמונות עולות גם מהטלפון', at: kDemoNow.subtract(const Duration(minutes: 5)), who: 'ido', opener: 'dana'),
            SinceItem(key: 'b', text: 'הבית מסודר מחדש', at: kDemoNow.subtract(const Duration(minutes: 9)), who: 'yoav'),
          ]),
        ));
    expect(find.bySemanticsLabel(RegExp('^התמונות עולות')), findsOneWidget);
    await tester.tap(findShown('התמונות עולות גם מהטלפון'));
    await tester.pumpAndSettle();
    expect(_openChat(tester), 'dana');
    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();
    await tester.tap(findShown('הבית מסודר מחדש'));
    await tester.pumpAndSettle();
    expect(_openChat(tester), 'yoav');
  });

  test('a composer\'s "since" names its task: the line leads where the task does', () {
    final d = mapSnapshot(
      board: [
        {'id': 'noa', 'name': 'נועה', 'title': 'מפתחת', 'team': 'lumo', 'lifecycle': 'ephemeral'},
        {'id': 'dana', 'name': 'דנה', 'title': 'מנכ"לית', 'team': 'lumo', 'lifecycle': 'always-on'},
      ],
      inbox: const [], asks: const [], toggles: const [],
      tasks: [
        {'id': 77, 'title': 'הודעות קוליות', 'state': 'done', 'identity': 'noa', 'project': 'lumo', 'updated_at': kDemoNow.millisecondsSinceEpoch, 'labels': '["opened-by:dana"]'},
      ],
      now: kDemoNow,
    );
    final b = HomeBlock.fromJson({'type': 'since', 'items': ['שורה בלי משימה', {'text': 'ההודעות הקוליות מתנגנות', 'task': 77}]})!;
    expect(b.items.map((x) => (x.text, x.task)), [('שורה בלי משימה', null), ('ההודעות הקוליות מתנגנות', 77)]);
    expect(b.toJson()['items'], ['שורה בלי משימה', {'text': 'ההודעות הקוליות מתנגנות', 'task': 77}]);
    expect(ticketOf(d, 77)?.assigneeId, 'noa');
    expect(sinceTarget(d, SinceItem(key: 'x', text: 'x', at: kDemoNow, task: 77)), 'dana', reason: 'noa is a task worker and it is done');
    expect(sinceTarget(d, SinceItem(key: 'y', text: 'y', at: kDemoNow)), isNull, reason: 'no task, no worker: just a sentence');
  });

  test('"מה לבדוק" follows the same rule: the task worker finished, so who opened it', () {
    final d = mapSnapshot(
      board: [
        {'id': 'noa', 'name': 'נועה', 'title': 'מפתחת', 'team': 'lumo', 'lifecycle': 'ephemeral'},
        {'id': 'dana', 'name': 'דנה', 'title': 'מנכ"לית', 'team': 'lumo', 'lifecycle': 'always-on'},
      ],
      inbox: const [], asks: const [], toggles: const [],
      tasks: [
        {'id': 78, 'title': 'תמונות', 'state': 'done', 'identity': 'noa', 'project': 'lumo', 'updated_at': kDemoNow.millisecondsSinceEpoch, 'labels': '["opened-by:dana"]'},
      ],
      awaiting: [
        {'id': 78, 'title': 'תמונות', 'project': 'lumo', 'identity': 'noa', 'awaiting': 'check', 'awaiting_at': 0},
        {'id': 79, 'title': 'אחר', 'project': 'lumo', 'identity': 'noa', 'awaiting': 'deploy', 'awaiting_at': 0},
      ],
      now: kDemoNow,
    );
    final items = AwaitingData.of(d).items;
    expect(awaitingTarget(d, items.firstWhere((x) => x.id == 78)), 'dana');
    expect(awaitingTarget(d, items.firstWhere((x) => x.id == 79)), 'noa', reason: 'not on the board: nobody known who opened it, so the worker');
  });

  testWidgets('a project\'s card: "עכשיו" opens the worker on it, the rest of the card opens the project', (tester) async {
    await _on(tester, (context) => ProjectBlock(now: kDemoNow, data: const ProjectLine(id: 'lumo', name: 'לומו', now: 'הודעות קוליות ב-web', who: ['noa'])));
    expect(find.bySemanticsLabel(RegExp('^עכשיו הודעות קוליות')), findsOneWidget);
    await tester.tap(findShown('הודעות קוליות ב-web'));
    await tester.pumpAndSettle();
    expect(_openChat(tester), 'noa');
    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();
    await tester.tap(find.text('לומו'));
    await tester.pumpAndSettle();
    expect(find.byType(ProjectScreen), findsOneWidget);
    expect(_openChat(tester), isNull);
  });

  testWidgets('a quiet project\'s last line opens who did it', (tester) async {
    await _on(tester, (context) => ProjectBlock(
        now: kDemoNow, data: ProjectLine(id: 'lumo', name: 'לומו', last: 'הטקסט בטלפון תקין', lastAt: kDemoNow, lastWho: 'shira', lastOpener: 'dana')));
    await tester.tap(findShown('הטקסט בטלפון תקין'));
    await tester.pumpAndSettle();
    expect(_openChat(tester), 'dana', reason: 'shira is a task worker who finished');
  });
}
