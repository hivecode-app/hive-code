// "בעבודה ובתור" (#128): Yoav opened an urgent task, it waited in the queue, and he saw it nowhere. Every open task
// is now under whoever opened it in the conversations, at the top of "סטטוס", in the home block `tasks`, and a
// queued one in its project's lane (the hq side is packages/hq/test/open-tasks.test.ts).
import 'dart:convert';

import 'package:agent_company/data/hq_backend.dart' show mapSnapshot;
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

final _at = DateTime(2026, 10, 20, 13, 30).millisecondsSinceEpoch;

Map<String, dynamic> _open(int id, String state, {String? worker, int? position, String? reason, String opener = 'yoav', String title = 'משימה'}) => {
      'id': id, 'ref': null, 'project': 'shop', 'title': title, 'opened_by': opener, 'worker': worker, 'state': state,
      'position': position, 'reason': reason, 'since': _at,
    };

final _hq = [
  _open(81, 'running', worker: 'noa', title: 'שגיאת המפתח בקבלות'),
  _open(82, 'waiting_for_you', worker: 'ido', title: 'תשלומים כפולים'),
  _open(83, 'queued', position: 1, reason: 'מחכה למשבצת', title: 'hq: דוח שבועי (#12)'),
  _open(84, 'later', title: 'מצב שהאפליקציה לא מכירה'),
  _open(85, 'blocked', reason: 'מחכה להחלטה', opener: 'dana', title: 'החלטה על מחירים'),
];

List<OpenTask> _tasks() => mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], openTasks: _hq).openTasks;

void main() {
  test('open_tasks: parsed in order, the title in his words, a state this app does not know is left out', () {
    final t = _tasks();
    expect(t.map((x) => x.id), [81, 82, 83, 85]);
    expect(t[2].title, 'דוח שבועי');
    expect([t[2].state, t[2].position, t[2].reason, t[2].worker], [OpenTaskState.queued, 1, 'מחכה למשבצת', null]);
    expect([t[1].state, t[1].worker], [OpenTaskState.waitingForYou, 'ido']);
    expect(t[0].since, DateTime.fromMillisecondsSinceEpoch(_at));
  });

  test('an hq from before open_tasks: the list from the tasks, queued ones in order, under the opener or the project lead', () {
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], tasks: [
      {'id': 1, 'title': 'רצה', 'project': 'p', 'state': 'running', 'identity': 'p-t1', 'labels': '["opened-by:yoav"]', 'started_at': _at, 'updated_at': _at},
      {'id': 2, 'title': 'אפליקציה: בתור', 'project': 'p', 'state': 'queued', 'labels': '[]', 'updated_at': _at},
      {'id': 3, 'title': 'עוד בתור', 'project': 'p', 'state': 'queued', 'labels': '[]', 'updated_at': _at},
      {'id': 4, 'title': 'נגמרה', 'project': 'p', 'state': 'done', 'labels': '[]', 'updated_at': _at},
    ]);
    final t = d.openTasks;
    expect(t.map((x) => [x.id, x.state, x.position, x.title, x.openedBy]), [
      [1, OpenTaskState.running, null, 'רצה', 'yoav'],
      [2, OpenTaskState.queued, 1, 'בתור', null],
      [3, OpenTaskState.queued, 2, 'עוד בתור', null],
    ]);
  });

  test('the line under a conversation: counts, and one task says itself', () {
    final t = _tasks();
    expect(openTasksLine(t), '4 משימות · אחת רצה · אחת מחכה לך · 1 בתור · אחת חסומה');
    expect(openTasksLine([t[0], t[0], t[2]]), '3 משימות · 2 רצות · 1 בתור');
    expect(openTasksLine([t[2]]), 'בתור, מקום 1: דוח שבועי');
    expect(openTasksIcon(t), 'front_hand', reason: 'what needs him first');
    expect(openTasksIcon([t[2]]), 'schedule');
  });

  test('home block tasks: "open" or ids, JSON and back; one that finished leaves, "open" stays while anything is open', () {
    final all = HomeBlock.fromJson({'type': 'tasks', 'tasks': 'open'})!;
    final some = HomeBlock.fromJson({'type': 'tasks', 'tasks': [83, 99], 'emphasis': 'strong'})!;
    expect([all.allOpen, all.tasks], [true, <int>[]]);
    expect(jsonEncode(all.toJson()), jsonEncode({'type': 'tasks', 'tasks': 'open'}));
    expect(jsonEncode(some.toJson()), jsonEncode({'type': 'tasks', 'emphasis': 'strong', 'tasks': [83, 99]}));
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], openTasks: _hq);
    final r = HomeRecipe(version: 1, composedBy: 'adi', composedAt: DateTime(2026), blocks: [all, some]);
    final live = liveBlocks(r, d);
    expect(live.map((b) => b.tasks), [<int>[], [83]]);
    d.openTasks = [];
    expect(liveBlocks(r, d), isEmpty);
  });

  test('lanes: the queue of a project, in its order', () {
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], openTasks: _hq,
        projects: [{'id': 'shop', 'name': 'החנות', 'status': 'active'}]);
    final lane = LanesData.of(d, now: DateTime(2026, 10, 20, 14)).lanes.single;
    expect(lane.queued, ['דוח שבועי']);
    expect(Lane.fromJson(jsonDecode(jsonEncode(lane.toJson())) as Map<String, dynamic>).queued, ['דוח שבועי']);
  });

  // The phone's rows have no such line since task 205 (נועה, 21/10); the wide screen's list keeps it.
  testWidgets('wide screen: the line under Yoav opens what he opened; a tap on a running one opens its worker', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsScreen(compact: true)), size: const Size(342, 1100));
    store.data!.openTasks = _tasks();
    store.touch();
    await tester.pumpAndSettle();
    final lines = {for (final w in tester.widgetList<OpenTasksLine>(find.byType(OpenTasksLine))) w.identityId: openTasksLine(w.tasks)};
    expect(lines, {'yoav': '3 משימות · אחת רצה · אחת מחכה לך · 1 בתור', 'dana': 'חסומה: החלטה על מחירים'});
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/open-tasks-chats.png'));

    await tester.tap(find.byWidgetPredicate((w) => w is OpenTasksLine && w.identityId == 'yoav'));
    await tester.pumpAndSettle();
    expect(find.text('מה פתוח אצל יואב'), findsOneWidget);
    expect(find.text('בתור, מקום 1 · מחכה למשבצת · מ-13:30'), findsOneWidget);
    expect(find.text('רצה · נועה · מ-13:30'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/open-tasks-sheet.png'));

    // Running: its worker (queued: nobody on it yet, so whoever opened it, as everywhere).
    await tester.tap(find.text('רצה · נועה · מ-13:30'));
    await tester.pumpAndSettle();
    expect(find.text('מה פתוח אצל יואב'), findsNothing);
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).identityId, 'noa');
  });

  testWidgets('wide screen: the compact list has the line too', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsScreen(compact: true)), size: const Size(342, 1100));
    store.data!.openTasks = _tasks();
    store.touch();
    await tester.pumpAndSettle();
    expect({for (final w in tester.widgetList<OpenTasksLine>(find.byType(OpenTasksLine))) w.identityId}, containsAll(['yoav', 'dana']));
  });

  testWidgets('a task a task worker opened (open_team) goes under the one who opened that worker\'s task', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsScreen(compact: true)), size: const Size(342, 1100));
    final d = store.data!;
    final temp = d.identities.values.firstWhere((i) => i.temp).id;
    d.openTasks = [
      OpenTask(id: 1, title: 'משימה של העובד הזמני', state: OpenTaskState.running, worker: temp, openedBy: 'yoav'),
      OpenTask(id: 2, title: 'עזרה שהוא ביקש', state: OpenTaskState.queued, position: 1, openedBy: temp),
    ];
    store.touch();
    await tester.pumpAndSettle();
    final lines = {for (final w in tester.widgetList<OpenTasksLine>(find.byType(OpenTasksLine))) w.identityId: w.tasks.map((t) => t.id).toList()};
    expect(lines, {'yoav': [1, 2]});
  });

  testWidgets('"סטטוס": "בעבודה ובתור" at the top, every open task with who opened it', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: StatusScreen()), size: const Size(342, 1400));
    store.data!.openTasks = _tasks();
    store.touch();
    await tester.pumpAndSettle();
    final top = tester.getTopLeft(find.text('בעבודה ובתור')).dy;
    expect(top, lessThan(tester.getTopLeft(find.text('מחכה לך').first).dy));
    expect(find.byType(OpenTaskRow), findsNWidgets(4));
    expect(find.text('בתור, מקום 1 · מחכה למשבצת · פתח יואב · מ-13:30'), findsOneWidget);
    expect(find.text('חסומה · מחכה להחלטה · פתחה דנה · מ-13:30'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/open-tasks-status.png'));

    // Nobody on it yet: whoever opened it.
    await tester.tap(find.text('בתור, מקום 1 · מחכה למשבצת · פתח יואב · מ-13:30'));
    await tester.pumpAndSettle();
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).identityId, 'yoav');
    Navigator.of(tester.element(find.byType(ChatScreen))).pop();
    await tester.pumpAndSettle();

    store.data!.openTasks = [];
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text('אין משימות פתוחות'), findsOneWidget);
  });

  testWidgets('the home block: the recipe\'s task, drawn from the live list', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 400));
    store.data!.openTasks = _tasks();
    final ctx = tester.element(find.byType(Scaffold).first);
    Navigator.of(ctx).push(MaterialPageRoute(
      builder: (context) => Scaffold(
        body: ListView(children: [
          HomeBlocks(
            recipe: HomeRecipe(version: 1, composedBy: 'adi', composedAt: kDemoNow, blocks: [HomeBlock.fromJson({'type': 'tasks', 'tasks': [83]})!]),
            data: StoreScope.of(context).data!,
            now: kDemoNow,
            since: kDemoNow,
          ),
        ]),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.byType(OpenTaskRow), findsOneWidget);
    expect(findShown('דוח שבועי'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/open-tasks-block.png'));
  });
}
