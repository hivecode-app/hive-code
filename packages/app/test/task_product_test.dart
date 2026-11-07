import 'package:agent_company/native/native_bridge.dart';
import 'package:agent_company/ui/tasks/organization.dart';
import 'package:agent_company/ui/tasks/task_timeline.dart';
import 'package:agent_company/ui/common.dart';

import 'dart:async';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/search.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/model/task_progress.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/conversation_tasks.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/product/search_screen.dart';
import 'package:agent_company/ui/tasks/task_screen.dart';
import 'package:agent_company/ui/tasks/tasks_screen.dart';
import 'package:flutter/material.dart';
import 'package:agent_company/l10n/app_localizations.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart' show kDemoNow;
import 'product_test.dart' show productApp;

class TaskBackend extends FakeBackend {
  TaskBackend({this.he = false}) : super(simulate: false, now: kDemoNow);
  final bool he;
  bool failedActivity = false,
      failedTree = false,
      failedList = false,
      unknown = false;
  int starts = 0, reveals = 0, treeLoads = 0;
  Completer<List<OrgPerson>>? treeReply;
  List<OrgPerson>? customPeople;
  Completer<CommandResult>? startReply;
  List<Map<String, dynamic>> eventLog = [];
  List<Map<String, dynamic>>? timeline;
  static const pr12 = 'https://github.com/example/project/pull/12';
  List<Map<String, dynamic>> get demoTimeline {
    int at(int minutes) => kDemoNow.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
    return [
      {'kind': 'opened', 'at': at(60), 'by': 'dana', 'worker': 'maya'},
      {'kind': 'pr', 'at': at(40), 'url': pr12, 'number': 12, 'by': 'maya'},
      {'kind': 'checks', 'at': at(30), 'url': pr12, 'ci': 'passed'},
      {'kind': 'review', 'at': at(20), 'url': pr12, 'review': 'approved', 'quote': he ? 'בדקתי ש-`upload.resume() != null` ב-`upload_io.dart` אחרי ניתוק. **אושר.**' : 'Verified `upload.resume() != null` after disconnecting. Approved.'},
    ];
  }
  bool accepted = false;
  int released = 0;
  bool orphanGo = false;
  final sent = <UserMsg>[];
  bool failSend = false;
  @override
  Future<CommandResult> send(String identityId, UserMsg msg) async {
    sent.add(msg);
    if (failSend) return const CommandResult.fail('refused');
    msg.delivery = Delivery.delivered;
    return const CommandResult.ok();
  }

  List<TaskProgress> get tasks => [
    if (orphanGo)
      const TaskProgress(id: 201, title: 'A finished report', project: 'lumo', state: 'done', outcome: 'completed'),
    if (orphanGo)
      TaskProgress(
        id: 200,
        title: 'Waits on a request not in the inbox',
        project: 'lumo',
        state: 'done',
        stage: TaskStage.approval,
        requests: [TaskRequest(id: 999, kind: 'go', title: 'GO', askedBy: 'ido', task: 200)],
      ),
    for (var i = 0; i < released; i++)
      TaskProgress(
        id: 100 + i,
        title: 'Released $i',
        project: 'lumo',
        state: 'done',
        stage: TaskStage.released,
        outcome: 'completed',
        updatedAt: kDemoNow.subtract(Duration(hours: i)),
      ),
    TaskProgress(
      id: 1,
      title: he ? 'תיקון החיפוש' : 'Fix search',
      body: he
          ? 'חיפוש שמות עובדים והערות בשיחה.'
          : 'Find people and notes in conversations.',
      project: 'lumo',
      state: accepted ? 'queued' : 'proposal',
      stage: accepted ? TaskStage.development : TaskStage.proposal,
      openedBy: 'dana',
    ),
    TaskProgress(
      id: 2,
      title: he ? 'שיפור פתיחת המפה' : 'Improve map loading',
      project: 'lumo',
      state: 'running',
      stage: TaskStage.development,
      worker: 'ido',
      workerStatus: 'stuck',
      requests: [
        TaskRequest(
          id: 55,
          kind: 'ask',
          title: he ? 'באיזה מכשיר לבדוק?' : 'Which device should be checked?',
          askedBy: 'ido',
          task: 2,
        ),
      ],
    ),
    TaskProgress(
      id: 3,
      title: he ? 'העלאת קובץ מהטלפון' : 'Upload a file from the phone',
      body: he
          ? 'העלאה ממשיכה אחרי ניתוק.'
          : 'Uploads resume after a disconnect.',
      project: 'voice',
      state: 'running',
      stage: unknown ? null : TaskStage.review,
      worker: 'maya',
      prs: [
        TaskPr(
          url: 'https://github.com/example/project/pull/12',
          review: 'approved',
          ci: 'passed',
          quote: he
              ? 'בדקתי העלאה חוזרת אחרי ניתוק. אושר.'
              : 'Verified that uploads resume after disconnecting. Approved.',
        ),
      ],
    ),
    TaskProgress(
      id: 4,
      title: he ? 'שחרור תיקון ההתחברות' : 'Release the sign-in fix',
      project: 'lumo',
      state: 'done',
      awaiting: 'deploy',
      stage: TaskStage.approval,
      outcome: 'completed',
    ),
    TaskProgress(
      id: 5,
      title: he ? 'תיקון ההתראות שוחרר' : 'Notification fix released',
      project: 'lumo',
      state: 'done',
      stage: TaskStage.released,
      outcome: 'completed',
    ),
    TaskProgress(
      id: 6,
      title: he ? 'דוח ממצאים' : 'Investigation report',
      project: 'lumo',
      state: 'done',
      stage: TaskStage.development,
      outcome: 'completed',
    ),
  ];
  @override
  Future<List<TaskProgress>> taskProgress() async {
    if (failedList) throw StateError('unavailable');
    return tasks;
  }

  @override
  Future<TaskProgress?> taskDetail(int id) async =>
      tasks.where((t) => t.id == id).firstOrNull;
  @override
  Future<CommandResult> startTask(int id) async {
    starts++;
    final result =
        await (startReply?.future ?? Future.value(const CommandResult.ok()));
    if (result.ok) accepted = true;
    return result;
  }

  @override
  Future<TaskActivity> taskActivity(int id) async {
    if (failedActivity) throw StateError('unavailable');
    return TaskActivity(
      messages: [
        if (id == 3)
          {
            'id': 'old-source',
            'identity': 'maya',
            'body': he ? 'פרטי בדיקת העלאה' : 'Upload verification details',
            'created_at': 1,
          },
      ],
      files: const [],
      events: eventLog,
      timeline: [
        for (final e in timeline ?? (id == 3 ? demoTimeline : <Map<String, dynamic>>[])) ?TaskEvent.fromJson(e),
      ],
    );
  }

  @override
  Future<List<OrgPerson>> organization() async {
    treeLoads++;
    if (treeReply != null) return treeReply!.future;
    if (failedTree) throw StateError('unavailable');
    if (customPeople != null) return customPeople!;
    return [
      const OrgPerson(
        id: 'dana',
        name: 'Dana',
        title: 'Team lead',
        manager: 'yoav',
      ),
      const OrgPerson(
        id: 'ido',
        name: 'Ido',
        title: 'Developer',
        manager: 'dana',
        tasks: [(id: 2, title: 'Improve map loading', state: 'running')],
      ),
      const OrgPerson(
        id: 'shira',
        name: 'Shira',
        title: 'Reviewer',
        manager: 'dana',
        active: false,
        tasks: [(id: 6, title: 'Investigation report', state: 'done')],
      ),
      for (var i = 0; i < 35; i++)
        OrgPerson(
          id: 'member-$i',
          name: 'Member $i',
          title: 'Developer',
          manager: 'dana',
        ),
    ];
  }

  @override
  Future<List<SearchHit>> search(String q) async => [
    SearchHit(
      kind: 'message',
      id: 'old-source',
      title: 'Upload verification details',
      identity: 'maya',
      subtitle: 'Maya',
    ),
  ];
  @override
  Future<bool> revealMessage(String identity, String message) async {
    reveals++;
    final chat = data!.chats.putIfAbsent(
      identity,
      () => Conversation(identityId: identity, items: []),
    );
    chat.items.insert(
      0,
      TextMsg(
        id: 'msg:$message',
        ts: kDemoNow.subtract(const Duration(days: 5)),
        text: 'Upload verification details',
      ),
    );
    notifyListeners();
    return true;
  }
}

class MissingTaskDetails extends TaskBackend {
  @override
  Future<TaskProgress?> taskDetail(int id) async =>
      throw StateError('unavailable');
  @override
  Future<List<SearchHit>> search(String q) async => [
    const SearchHit(
      kind: 'task',
      id: '3',
      title: 'Running task',
      identity: 'maya',
      project: 'voice',
    ),
  ];
}

class RacingTaskDetails extends TaskBackend {
  final replies = <Completer<TaskProgress?>>[];
  @override
  Future<TaskProgress?> taskDetail(int id) {
    final c = Completer<TaskProgress?>();
    replies.add(c);
    return c.future;
  }
}

Future<void> openByKeyboard(WidgetTester tester, Key key) async {
  for (var i = 0; i < 100; i++) {
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    final context = FocusManager.instance.primaryFocus?.context;
    var reached = context?.widget.key == key;
    context?.visitAncestorElements((element) {
      if (element.widget.key == key) reached = true;
      return !reached;
    });
    if (reached) {
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      return;
    }
  }
  fail('Keyboard focus did not reach $key');
}

Future<void> showTask(WidgetTester tester, int id) => tester.scrollUntilVisible(
  find.byKey(Key('task-$id')),
  200,
  scrollable: find
      .descendant(
        of: find.byKey(const PageStorageKey('task-list')),
        matching: find.byType(Scrollable),
      )
      .first,
);

void main() {
  test('a turn\'s open_team puts its task under the message after it; a queued call is found by its id', () {
    final at = kDemoNow;
    ToolGroup opened(String id, String preview) => ToolGroup(id: id, ts: at, summary: '', tools: [
      ToolLine(icon: 'group_add', label: '', name: 'mcp__company__open_team', call: ToolCall(name: 'mcp__company__open_team', started: at, preview: preview)),
    ]);
    final items = <ChatItem>[
      opened('g1', '{"ok":true,"id":"dana-1:aa","ref":"task-7","result":{"task":7,"state":"queued"}}'),
      TextMsg(id: 'm1', ts: at, text: 'Opened a task for Ido.'),
      opened('g2', '{"queued":true,"id":"dana-1:bb"}'),
      UserMsg(id: 'u1', ts: at, text: 'ok'),
      opened('g3', '`open_team` נדחה ב-hq: no'),
    ];
    final cards = taskCardsByItem(items);
    expect(cards, {'m1': [7], 'g2': ['dana-1:bb']});
    const tasks = [TaskProgress(id: 7, title: 'Seven'), TaskProgress(id: 8, title: 'Eight', op: 'dana-1:bb')];
    expect(resolveTaskRef(tasks, 7)!.id, 7);
    expect(resolveTaskRef(tasks, 'dana-1:bb')!.id, 8);
    expect(resolveTaskRef(tasks, 9), isNull);
  });

  test('the team counts who is at work now, not everyone who ever worked for the lead', () {
    OrgPerson worker(String id, List<String> states) => OrgPerson(id: id, name: id, title: 'מפתח', manager: 'dana', tasks: [for (final (i, s) in states.indexed) (id: i, title: 't', state: s)]);
    final org = [
      const OrgPerson(id: 'dana', name: 'דנה', title: 'מנכ"לית'),
      worker('a', ['done', 'running']),
      worker('b', ['done', 'done']),
      worker('c', ['closed']),
      worker('d', ['resting']),
    ];
    final team = conversationTeam(org, 'dana');
    expect([for (final p in team.people) if (p.atWork) p.id], ['a', 'd']);
    expect(team.people.map((p) => p.id), ['a', 'd', 'b', 'c'], reason: 'the ones at work first');
    expect(const OrgPerson(id: 'yoav', name: 'יואב', title: 'מנהל').atWork, isTrue, reason: 'a permanent worker with no task');
  });

  test('the conversation\'s tasks: what waits for him first, cancelled and finished out, three released last', () {
    const tasks = [
      TaskProgress(id: 1, title: 'dev', stage: TaskStage.development, openedBy: 'dana'),
      TaskProgress(id: 2, title: 'approval', stage: TaskStage.approval, worker: 'dana'),
      TaskProgress(id: 3, title: 'cancelled', stage: TaskStage.development, openedBy: 'dana', outcome: 'cancelled'),
      TaskProgress(id: 4, title: 'released', stage: TaskStage.released, openedBy: 'dana', outcome: 'completed'),
      TaskProgress(id: 5, title: 'finished', stage: TaskStage.development, openedBy: 'dana', outcome: 'completed'),
      TaskProgress(id: 6, title: 'deploy', stage: TaskStage.approval, openedBy: 'dana', outcome: 'completed', awaiting: 'deploy'),
      TaskProgress(id: 7, title: 'other', stage: TaskStage.approval, openedBy: 'yoav'),
      TaskProgress(id: 8, title: 'review', stage: TaskStage.review, openedBy: 'dana'),
    ];
    expect([for (final t in conversationTasks(tasks, 'dana')) t.id], [2, 6, 8, 1, 4]);
    expect(conversationTasks(tasks, 'dana').where(isOpenTask).length, 4);
  });

  test('a task with no stage: a finished report is "completed", an open one is "being checked", as on the board', () async {
    final l = await AppLocalizations.delegate.load(const Locale('he'));
    const report = TaskProgress(id: 1, title: 'report', state: 'done', outcome: 'completed');
    const open = TaskProgress(id: 2, title: 'open', state: 'working');
    const dev = TaskProgress(id: 3, title: 'dev', stage: TaskStage.development);
    expect(taskStageLook(l, report), ('check_circle', l.progressCompleted));
    expect(taskStageLook(l, open), ('progress_activity', l.progressUnknown));
    final groups = taskStageGroups(l, const [report, open, dev]);
    expect([for (final g in groups) g.$2], [l.progressDevelopment, l.progressUnknown, l.progressCompleted]);
    expect([for (final g in groups) g.$4.single.id], [3, 2, 1]);
  });

  testWidgets('a task opened in the conversation is a card in the message, and a tap opens its page', (tester) async {
    final backend = TaskBackend();
    final store = await productApp(tester, backend: backend, home: const ChatScreen(identityId: 'dana'));
    final chat = store.data!.chats['dana']!;
    chat.items.addAll([
      ToolGroup(id: 'g-open', ts: kDemoNow, summary: '', tools: [
        ToolLine(icon: 'group_add', label: '', name: 'mcp__company__open_team',
          call: ToolCall(name: 'mcp__company__open_team', started: kDemoNow, preview: '{"ok":true,"id":"dana-1:aa","ref":"task-2","result":{"task":2}}')),
      ]),
      TextMsg(id: 't-open', ts: kDemoNow, text: 'Opened a task for Ido.'),
    ]);
    store.touch();
    await tester.pumpAndSettle();
    final card = find.byKey(const ValueKey('task-card-2'));
    expect(find.descendant(of: find.byType(TextBubble), matching: card), findsOneWidget);
    expect(find.descendant(of: card, matching: find.text('Improve map loading')), findsOneWidget);
    await tester.tap(card);
    await tester.pumpAndSettle();
    expect(find.byType(ProductTaskScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the phone title has the project, the team and the open tasks as chips', (tester) async {
    await productApp(tester, backend: TaskBackend(), home: const ChatScreen(identityId: 'dana'));
    expect(find.byKey(const Key('conversation-team')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('chat-chip-tasks')), matching: find.text('1 open task')), findsOneWidget);
    await tester.tap(find.byKey(const Key('chat-chip-tasks')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('chat-task-1')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Tasks destination opens the task, back preserves project and selection; report is not Released',
    (tester) async {
      final store = await productApp(tester, backend: TaskBackend());
      await tester.tap(find.text('Tasks'));
      await tester.pumpAndSettle();
      expect(find.byType(ProductTasks), findsOneWidget);
      await showTask(tester, 1);
      await tester.tap(find.byKey(const Key('task-1')));
      await tester.pumpAndSettle();
      expect(find.byType(ProductTaskScreen), findsOneWidget);
      expect(find.text('Fix search'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(store.selectedTask, 1);
      await showTask(tester, 1);
      expect(find.byKey(const Key('task-1')), findsOneWidget);
      expect(find.text('Investigation report'), findsNothing);
    },
  );

  testWidgets(
    'Start coalesces clicks and failure preserves proposal and description',
    (tester) async {
      final backend = TaskBackend()..startReply = Completer<CommandResult>();
      await productApp(
        tester,
        backend: backend,
        home: const ProductTaskScreen(id: 1),
      );
      await tester.tap(find.byKey(const Key('start-task')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('start-task')));
      await tester.pump();
      expect(backend.starts, 1);
      backend.startReply!.complete(const CommandResult.fail(null));
      await tester.pumpAndSettle();
      expect(find.text('Fix search'), findsOneWidget);
      expect(find.textContaining('Its description is saved'), findsOneWidget);
      expect(backend.accepted, false);
      await tester.tap(find.byKey(const Key('stage-review')));
      await tester.pumpAndSettle();
      expect(
        backend.starts,
        1,
        reason: 'timeline selection never mutates task state',
      );
    },
  );

  testWidgets(
    'activity failure leaves task and PR accessible; retry recovers',
    (tester) async {
      final backend = TaskBackend()..failedActivity = true;
      await productApp(
        tester,
        backend: backend,
        home: const ProductTaskScreen(id: 3),
      );
      expect(find.text('Upload a file from the phone'), findsOneWidget);
      expect(find.text('PR #12'), findsOneWidget, reason: 'the code link comes with the task, not its activity');
      backend.failedActivity = false;
      await tester.ensureVisible(find.byKey(const Key('retry-task-activity')));
      await tester.tap(find.byKey(const Key('retry-task-activity')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('retry-task-activity')), findsNothing);
    },
  );

  testWidgets(
    'new task chooses project then opens an editable draft with its lead',
    (tester) async {
      final store = await productApp(
        tester,
        backend: TaskBackend(),
        home: const Scaffold(body: ProductTasks()),
      );
      await tester.tap(find.byKey(const Key('task-options')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('new-task')));
      await tester.pumpAndSettle();
      expect(find.text('Choose a project'), findsOneWidget);
      await tester.tap(find.widgetWithText(SimpleDialogOption, 'לומו'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(store.data!.chats['dana']!.draft, endsWith('Task description: '));
      expect(store.data!.chats['dana']!.draft, contains('ושגם'));
    },
  );

  testWidgets(
    'search loads and highlights a source outside history; back restores search and query',
    (tester) async {
      final backend = TaskBackend();
      await productApp(tester, backend: backend);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('global-search')), 'Upload');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Upload verification details'));
      await tester.pumpAndSettle();
      expect(backend.reveals, 1);
      expect(
        find.textContaining('Upload verification details', findRichText: true),
        findsWidgets,
      );
      await tester.pump(const Duration(milliseconds: 1300));
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byType(ProductSearch), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('global-search')))
            .controller!
            .text,
        'Upload',
      );
    },
  );

  testWidgets(
    'keyboard opens a task at 200 percent and filtering survives background refresh',
    (tester) async {
      final backend = TaskBackend();
      final store = await productApp(
        tester,
        backend: backend,
        scale: 2,
        home: const Scaffold(body: ProductTasks()),
        prepare: (s) => s.taskProject = 'voice',
      );
      final semantics = tester.ensureSemantics();

      expect(
        tester.getSemantics(find.byKey(const Key('task-3'))).label,
        contains('Upload a file from the phone'),
      );
      var reached = false;
      for (var i = 0; i < 30; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        final tile = FocusManager.instance.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<InkWell>();
        if (tile?.key == const ValueKey('task-3')) {
          reached = true;
          break;
        }
      }
      expect(
        reached,
        true,
        reason: 'task row participates in keyboard traversal',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.byType(ProductTaskScreen), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(store.taskProject, 'voice');
      expect(store.selectedTask, 3);
      expect(find.byKey(const Key('task-3')), findsOneWidget);
      expect(find.byKey(const Key('task-1')), findsNothing);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets('the released column shows the latest five and the rest on request', (tester) async {
    await productApp(
      tester,
      backend: TaskBackend()..released = 8,
      size: const Size(1440, 900),
      home: const Scaffold(body: ProductTasks()),
      prepare: (s) => s.taskBoard = true,
    );
    expect(find.text('Released 4'), findsOneWidget);
    expect(find.text('Released 5'), findsNothing);
    await tester.tap(find.byKey(const Key('more-released')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('more-released')), findsNothing);
    expect(find.text('Released 7', skipOffstage: false), findsOneWidget);
  });

  testWidgets('a task waiting on him stays in the list when its request is not among his', (tester) async {
    await productApp(tester, backend: TaskBackend()..orphanGo = true, home: const Scaffold(body: ProductTasks()));
    expect(find.byKey(const ValueKey('task-200')), findsOneWidget);
  });

  testWidgets('a finished task that shipped nothing is not "in development", even with finished ones shown', (tester) async {
    await productApp(
      tester,
      backend: TaskBackend()..orphanGo = true,
      home: const Scaffold(body: ProductTasks()),
      prepare: (s) => s.taskIncludeCompleted = true,
    );
    expect(find.byKey(const ValueKey('task-201'), skipOffstage: false), findsNothing);
  });

  testWidgets('an empty board column says so', (tester) async {
    await productApp(
      tester,
      backend: TaskBackend(),
      size: const Size(1440, 900),
      home: const Scaffold(body: ProductTasks()),
      prepare: (s) => s.taskBoard = true,
    );
    expect(find.text('Nothing released this week'), findsOneWidget);
  });

  testWidgets('an unverified task remains visible without inventing a stage', (
    tester,
  ) async {
    await productApp(
      tester,
      backend: TaskBackend()..unknown = true,
      home: const Scaffold(body: ProductTasks()),
    );
    expect(find.byKey(const Key('task-3')), findsOneWidget);
    expect(
      find.textContaining('Progress is being verified', findRichText: true),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('task-3')));
    await tester.pumpAndSettle();
    expect(find.text('Progress is being verified'), findsOneWidget);
    expect(find.byKey(const ValueKey('task-pr-${TaskBackend.pr12}')), findsOneWidget);
  });

  testWidgets(
    'an unverified search result never offers Start when detail loading fails',
    (tester) async {
      await productApp(tester, backend: MissingTaskDetails());
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('global-search')), 'Running');
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Running task'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('start-task')), findsNothing);
      expect(find.text('Progress is being verified'), findsOneWidget);
      expect(find.text('Running task'), findsOneWidget);
    },
  );

  testWidgets(
    'the activity says what happened, in order, and leaves out what it does not know',
    (tester) async {
      int at(int m) => kDemoNow.subtract(Duration(minutes: m)).millisecondsSinceEpoch;
      final backend = TaskBackend()
        ..timeline = [
          {'kind': 'opened', 'at': at(90), 'by': 'owner', 'worker': 'ido'},
          {'kind': 'started', 'at': at(80), 'worker': 'ido'},
          {'kind': 'pr', 'at': at(60), 'url': TaskBackend.pr12, 'number': 12},
          {'kind': 'checks', 'at': at(50), 'url': TaskBackend.pr12, 'ci': 'failed'},
          {'kind': 'review', 'at': at(40), 'url': TaskBackend.pr12, 'review': 'changes', 'quote': 'The retry loses the file name.'},
          {'kind': 'merged', 'at': at(20), 'url': TaskBackend.pr12, 'number': 12},
          {'kind': 'a-newer-kind', 'at': at(10)},
          {'kind': 'deployed', 'at': at(5)},
        ];
      await productApp(
        tester,
        backend: backend,
        home: const ProductTaskScreen(id: 2),
      );
      final lines = [
        'You opened the task, assigned to $kFSIעידו$kPDI',
        'Work started',
        'PR opened',
        'Automated checks failed',
        'Review asked for fixes. "${kFSI}The retry loses the file name.$kPDI"',
        'Merged',
        'Released',
      ];
      for (final line in lines) {
        expect(find.text(line, skipOffstage: false), findsWidgets, reason: line);
      }
      // "Released" is also the stages' last word: the activity's is the last one on the page.
      final ys = [for (final line in lines) tester.getTopLeft(find.text(line, skipOffstage: false).last).dy];
      expect(ys, [...ys]..sort(), reason: 'oldest first');
      expect(find.text('PR #12', skipOffstage: false), findsNWidgets(2), reason: 'the PR and the merge');
    },
  );

  testWidgets(
    'the stages at 200 percent are the current one and its place, read-only',
    (tester) async {
      final backend = TaskBackend();
      await productApp(
        tester,
        backend: backend,
        scale: 2,
        home: const ProductTaskScreen(id: 3),
      );
      expect(find.text('Stage 3 of 5'), findsOneWidget);
      expect(find.byType(ChoiceChip), findsNothing);
      expect(find.byKey(const Key('stage-proposal')), findsNothing);
      expect(
        tester.widget<TaskTimeline>(find.byType(TaskTimeline)).current,
        TaskStage.review,
      );
      expect(backend.starts, 0);
    },
  );

  testWidgets(
    'unassigned proposals use their own symbol and completion metadata does not label a release twice',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(),
        home: const Scaffold(body: ProductTasks()),
      );
      final proposal = tester.widget<Ic>(
        find.descendant(
          of: find.byKey(const Key('task-1')),
          matching: find.byKey(const Key('task-row-icon')),
        ),
      );
      expect(proposal.name, 'lightbulb');
      expect(
        find.descendant(
          of: find.byKey(const Key('task-4')),
          matching: find.textContaining(
            'Merged, waiting for release',
            findRichText: true,
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('task-5')),
          matching: find.textContaining(
            'Merged, waiting for release',
            findRichText: true,
          ),
        ),
        findsNothing,
      );
    },
  );

  testWidgets('a slow detail response cannot overwrite a newer refresh', (
    tester,
  ) async {
    final backend = RacingTaskDetails();
    await productApp(
      tester,
      backend: backend,
      home: ProductTaskScreen(id: 3, initial: backend.tasks[2]),
    );
    await tester.tap(find.byKey(const Key('task-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Refresh'));
    await tester.pump();
    expect(backend.replies.length, 2);
    backend.replies[1].complete(
      const TaskProgress(
        id: 3,
        title: 'Newer details',
        stage: TaskStage.approval,
      ),
    );
    await tester.pumpAndSettle();
    backend.replies[0].complete(
      const TaskProgress(
        id: 3,
        title: 'Stale details',
        stage: TaskStage.development,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Newer details'), findsOneWidget);
    expect(find.text('Stale details'), findsNothing);
  });

  testWidgets('a request on the task is a card with its own action, its kind in its symbol', (
    tester,
  ) async {
    await productApp(
      tester,
      backend: TaskBackend(),
      language: 'he',
      home: const ProductTaskScreen(id: 2),
    );
    final card = find.ancestor(of: find.byKey(const ValueKey('task-request-55')), matching: find.byType(Row)).first;
    expect(find.descendant(of: card, matching: find.byWidgetPredicate((w) => w is Ic && w.name == 'help')), findsOneWidget);
    expect(find.descendant(of: card, matching: find.text('צפייה')), findsOneWidget);
  });

  testWidgets(
    'long team and completed worker are reachable in two taps; back restores the team anchor',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(),
        home: const ChatScreen(identityId: 'dana'),
      );
      await tester.tap(find.byKey(const Key('conversation-team')));
      await tester.pumpAndSettle();
      final member = find.byKey(const ValueKey('org-person-member-34'));
      await tester.scrollUntilVisible(
        member,
        600,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      await tester.tap(member);
      await tester.pumpAndSettle();
      expect(
        tester.widget<ChatScreen>(find.byType(ChatScreen).last).identityId,
        'member-34',
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(member.hitTestable(), findsOneWidget);
    },
  );

  testWidgets(
    'a completed worker opens in two taps and a failed tree leaves the conversation usable',
    (tester) async {
      final backend = TaskBackend();
      await productApp(
        tester,
        backend: backend,
        home: const ChatScreen(identityId: 'dana'),
      );
      await tester.tap(find.byKey(const Key('conversation-team')));
      await tester.pumpAndSettle();
      final finished = find.byKey(const ValueKey('org-person-shira'));
      await tester.ensureVisible(finished);
      await tester.tap(finished);
      await tester.pumpAndSettle();
      expect(
        tester.widget<ChatScreen>(find.byType(ChatScreen).last).identityId,
        'shira',
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(finished.hitTestable(), findsOneWidget);
    },
  );

  testWidgets(
    'a phone worker opens the manager tree with siblings in one tap',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(),
        home: const ChatScreen(identityId: 'ido'),
      );
      await tester.tap(find.byKey(const Key('conversation-team')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('org-person-dana')), findsOneWidget);
      expect(find.byKey(const Key('org-person-shira')), findsOneWidget);
      await tester.tap(find.byKey(const Key('org-person-shira')));
      await tester.pumpAndSettle();
      expect(
        tester.widget<ChatScreen>(find.byType(ChatScreen).last).identityId,
        'shira',
      );
    },
  );

  testWidgets(
    'the team chip stays put while the tree refreshes, and a failed refresh keeps what was shown',
    (tester) async {
      final backend = TaskBackend();
      await productApp(
        tester,
        backend: backend,
        home: const ChatScreen(identityId: 'dana'),
      );
      final chip = find.byKey(const Key('conversation-team'));
      expect(chip, findsOneWidget);
      final rect = tester.getRect(chip);
      final loads = backend.treeLoads;
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(backend.treeLoads, greaterThan(loads));
      expect(tester.getRect(chip), rect);
      backend.failedTree = true;
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(tester.getRect(chip), rect);
      // What is shown is saved, and says so, with a retry.
      expect(find.byTooltip('Team refresh failed. Showing saved information.'), findsOneWidget);
      backend.failedTree = false;
      await tester.ensureVisible(find.byKey(const Key('chat-chip-stale')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('chat-chip-stale')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('chat-chip-stale')), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('an unknown sidebar never shows unrelated top-level managers', (
    tester,
  ) async {
    final backend = TaskBackend()
      ..customPeople = [
        const OrgPerson(id: 'other', name: 'Other manager', title: 'Lead'),
      ];
    await productApp(
      tester,
      backend: backend,
      home: const Scaffold(
        body: ConversationHierarchy(identity: 'missing', sidebar: true),
      ),
    );
    expect(find.byKey(const Key('org-person-other')), findsNothing);
    expect(find.text('No team members to show.'), findsOneWidget);
  });
  testWidgets(
    'a known conversation without a team has no team chip',
    (tester) async {
      final backend = TaskBackend()
        ..customPeople = [
          const OrgPerson(id: 'ido', name: 'Ido', title: 'Developer'),
        ];
      await productApp(
        tester,
        backend: backend,
        home: const ChatScreen(identityId: 'ido'),
      );
      expect(find.byKey(const Key('conversation-team')), findsNothing);
    },
  );
  testWidgets(
    'a long team label stays on one line at 200 percent',
    (tester) async {
      final backend = TaskBackend()
        ..customPeople = [
          const OrgPerson(id: 'dana', name: 'Dana', title: 'Lead'),
          OrgPerson(
            id: 'ido',
            name: 'Long worker name ' * 10,
            title: 'Developer',
            manager: 'dana',
          ),
        ];
      await productApp(
        tester,
        backend: backend,
        scale: 2,
        home: const ChatScreen(identityId: 'dana'),
      );
      final label = find.descendant(
        of: find.byKey(const Key('conversation-team')),
        matching: find.textContaining('Long worker name'),
      );
      expect(tester.widget<Text>(label).maxLines, 1);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a failed hierarchy does not block a chat; retry recovers', (
    tester,
  ) async {
    final backend = TaskBackend()..failedTree = true;
    await productApp(
      tester,
      backend: backend,
      home: const ChatScreen(identityId: 'dana'),
    );
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(find.byType(TextField), findsWidgets);
    final error = find.byTooltip(
      'The team could not be loaded. The conversation is still available.',
    );
    expect(error, findsOneWidget);
    backend.failedTree = false;
    await tester.tap(error);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('conversation-team')), findsOneWidget);
  });

  testWidgets(
    'a chat beside the list has its task column, info its panel, and at 200 percent the phone chips',
    (tester) async {
      final store = await productApp(
        tester,
        backend: TaskBackend(),
        size: const Size(1440, 900),
        prepare: (s) => s.selectedConversation = 'dana',
      );
      // Beside the list (a-he-home-desktop): the task column, 280.
      expect(find.byType(ConversationTaskColumn), findsOneWidget);
      expect(tester.getSize(find.byType(ConversationTaskColumn)).width, 280);
      expect(find.byKey(const ValueKey('chat-task-1')), findsOneWidget);
      // `info` puts the conversation's panel there: four of the team in lines, "משימות" in view without scrolling.
      await tester.tap(find.byKey(const Key('chat-info')));
      await tester.pumpAndSettle();
      expect(find.byType(ConversationTasksPanel), findsOneWidget);
      expect(find.byType(ConversationTaskColumn), findsNothing);
      expect(find.byType(PersonRow), findsNWidgets(4));
      expect(find.byKey(const ValueKey('chat-person-ido')), findsOneWidget);
      expect(find.byKey(const Key('conversation-team')), findsOneWidget);
      final heading = find.descendant(of: find.byType(ConversationTasksPanel), matching: find.text('Tasks'));
      expect(heading.hitTestable(), findsOneWidget);
      expect(tester.getBottomLeft(heading).dy, lessThan(900 * 0.6), reason: 'the tasks start high on the screen, not at its bottom');
      expect(find.byKey(const ValueKey('chat-task-1')).hitTestable(), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/tasks/chat-info-panel.png'));
      await tester.tap(find.byKey(const Key('chat-info')));
      await tester.pumpAndSettle();
      expect(find.byType(ConversationTaskColumn), findsOneWidget);
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      store.touch();
      await tester.pumpAndSettle();
      expect(find.byType(ConversationTasksPanel), findsNothing);
      expect(find.byType(ConversationChips), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a chat with the whole width has its tabs and the full panel', (tester) async {
    await productApp(tester, backend: TaskBackend(), size: const Size(1440, 900), home: const ChatScreen(identityId: 'dana'));
    expect(find.byKey(const ValueKey('chat-tab-1')), findsOneWidget);
    expect(find.byType(ConversationTasksPanel), findsOneWidget);
    expect(tester.getSize(find.byType(ConversationTasksPanel)).width, 320);
    expect(find.byType(ConversationTaskColumn), findsNothing);
    await tester.tap(find.byKey(const ValueKey('chat-tab-1')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationTaskList), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a chat on its own, not beside the list, has no task column', (tester) async {
    await productApp(tester, backend: TaskBackend(), size: const Size(800, 900), home: const ChatScreen(identityId: 'dana'));
    expect(find.byType(ConversationTaskColumn), findsNothing);
    expect(find.byType(ConversationChips), findsOneWidget);
  });

  testWidgets('the team link has no count: the tree it opens has everyone who ever worked there', (tester) async {
    await productApp(tester, backend: TaskBackend(), size: const Size(1440, 900), home: const ChatScreen(identityId: 'dana'));
    expect(find.text('Dana’s team'), findsOneWidget);
  });

  testWidgets('the team chip: a face for one at work, the group icon for more', (tester) async {
    await productApp(tester, backend: TaskBackend(), home: const ChatScreen(identityId: 'dana'));
    final chip = find.byKey(const Key('conversation-team'));
    expect(find.descendant(of: chip, matching: find.byWidgetPredicate((w) => w is Ic && w.name == 'group')), findsOneWidget);
  });

  testWidgets('a message from the task page is about the task, stays as a draft, and says when it did not get there', (tester) async {
    final backend = TaskBackend();
    await productApp(
      tester,
      backend: backend,
      home: Builder(
        builder: (context) => Scaffold(
          body: TextButton(
            key: const Key('open'),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ProductTaskScreen(id: 3))),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('open')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('task-message')), 'half written');
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open')));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(find.byKey(const Key('task-message'))).controller!.text, 'half written');
    await tester.tap(find.byKey(const Key('task-send')));
    await tester.pumpAndSettle();
    expect(backend.sent.last.text, 'half written');
    expect(backend.sent.last.ref, 'task-3', reason: 'it belongs to this task, not to whatever the worker does now');
    expect(find.byKey(const Key('task-message-failed')), findsNothing);
    backend.failSend = true;
    await tester.enterText(find.byKey(const Key('task-message')), 'again');
    await tester.pump();
    expect(tester.widget<IconButton>(find.byKey(const Key('task-send'))).onPressed, isNotNull);
    await tester.tap(find.byKey(const Key('task-send')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('task-message-failed')), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('task-message'))).controller!.text, '');
  });

  testWidgets('the keyboard lifts the message line with the page instead of covering it', (tester) async {
    await productApp(tester, backend: TaskBackend(), home: const ProductTaskScreen(id: 3));
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    addTearDown(tester.view.resetViewInsets);
    await tester.pumpAndSettle();
    expect(tester.getBottomLeft(find.byKey(const Key('task-send'))).dy, lessThanOrEqualTo(844 - 300));
  });

  testWidgets('on a computer the facts are a side panel and the message opens the chat', (tester) async {
    await productApp(tester, backend: TaskBackend(), size: const Size(1440, 900), home: const ProductTaskScreen(id: 3));
    expect(find.byKey(const Key('task-message')), findsNothing);
    for (final label in ['Stage', 'Owner', 'Checks', 'Next']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(tester.getTopLeft(find.text('Next')).dx, greaterThan(1440 - 340), reason: 'in the side panel, not under the activity');
    await tester.tap(find.byKey(const Key('task-message-wide')));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('in English, Hebrew names and code in a quote keep their own direction inside the line', (tester) async {
    await productApp(tester, backend: TaskBackend(he: true), home: const ProductTaskScreen(id: 3));
    final lines = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? '').toList();
    final opened = lines.firstWhere((l) => l.contains('assigned to'));
    expect(opened, contains(kFSI), reason: 'a name is isolated, so the line does not turn around');
    final review = lines.firstWhere((l) => l.contains('upload.resume()'));
    expect(review, contains('${kLRI}upload.resume()\u00A0!=\u00A0null$kPDI'), reason: 'code keeps left-to-right inside a Hebrew quote, in one piece');
    expect(review, isNot(contains('`')));
    expect(review, contains('upload_io.dart'), reason: 'emphasis marks go, a name in code keeps its underscore');
    expect(review, isNot(contains('**')));
  });

  testWidgets(
    'semantics say each stage and where the task is in it',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(),
        home: const ProductTaskScreen(id: 3),
      );
      final semantics = tester.ensureSemantics();
      final proposal = tester.getSemantics(find.byKey(const Key('stage-proposal')));
      expect(proposal.label, 'Proposal');
      expect(proposal.value, 'Stage complete');
      expect(tester.getSemantics(find.byKey(const Key('stage-review'))).value, 'Current stage');
      final link = find.byKey(const ValueKey('task-pr-${TaskBackend.pr12}'));
      expect(tester.getSemantics(find.ancestor(of: link, matching: find.byType(Semantics)).first).flagsCollection.isLink, isTrue);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets(
    'keyboard reaches a completed colleague and back restores the team at 200 percent',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(),
        scale: 2,
        home: const ChatScreen(identityId: 'dana'),
      );
      final semantics = tester.ensureSemantics();
      await openByKeyboard(tester, const Key('conversation-team'));
      final worker = find.byKey(const Key('org-person-shira'));
      await tester.ensureVisible(worker);
      expect(tester.getSemantics(worker).label, contains('Shira'));
      expect(tester.getSemantics(worker).label, contains('Completed'));
      await openByKeyboard(tester, const Key('org-person-shira'));
      expect(
        tester.widget<ChatScreen>(find.byType(ChatScreen).last).identityId,
        'shira',
      );
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(worker.hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets(
    'hierarchy indents each generation and aligns opposite-language rows to the interface',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(he: true),
        language: 'he',
        home: const ChatScreen(identityId: 'dana'),
      );
      await tester.tap(find.byKey(const Key('conversation-team')));
      await tester.pumpAndSettle();
      final parent = find.byKey(const Key('org-person-dana'));
      final worker = find.byKey(const Key('org-person-ido'));
      final task = find.byKey(const Key('org-task-2'));
      expect(parent, findsOneWidget);
      expect(
        tester.getRect(worker).right,
        lessThan(tester.getRect(parent).right),
      );
      expect(
        tester.getRect(task).right,
        lessThan(tester.getRect(worker).right),
      );
      final title = tester
          .widgetList<Text>(
            find.descendant(of: worker, matching: find.byType(Text)),
          )
          .firstWhere((w) => w.data?.contains('Ido') == true);
      expect(title.textDirection, TextDirection.ltr);
      expect(title.textAlign, TextAlign.right);
      final completed = find.byKey(const Key('org-person-shira'));
      expect(
        find.descendant(
          of: completed,
          matching: find.byWidgetPredicate(
            (w) => w is StatusWord && w.icon == 'check_circle',
          ),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the PR action opens the exact recorded URL', (tester) async {
    NativeBridge.debugSupportedOverride = true;
    String? opened;
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(NativeBridge.channel, (call) async {
      if (call.method == 'openUrl') {
        opened = (call.arguments as Map)['url'] as String;
        return true;
      }
      return null;
    });
    addTearDown(() {
      NativeBridge.debugSupportedOverride = null;
      messenger.setMockMethodCallHandler(NativeBridge.channel, null);
    });
    await productApp(
      tester,
      backend: TaskBackend(),
      home: const ProductTaskScreen(id: 3),
    );
    await tester.tap(find.byKey(const ValueKey('task-pr-${TaskBackend.pr12}')));
    await tester.pumpAndSettle();
    expect(opened, 'https://github.com/example/project/pull/12');
  });

  testWidgets(
    'past stages have a visible non-color mark and an explicit screen-reader status',
    (tester) async {
      await productApp(
        tester,
        backend: TaskBackend(),
        home: const ProductTaskScreen(id: 3),
      );
      final semantics = tester.ensureSemantics();
      final proposal = find.byKey(const Key('stage-proposal'));
      expect(tester.getSemantics(proposal).value, 'Stage complete');
      expect(
        find.descendant(
          of: proposal,
          matching: find.byWidgetPredicate((w) => w is Ic && w.name == 'check'),
        ),
        findsOneWidget,
      );
      semantics.dispose();
    },
  );

  testWidgets(
    'a failed team refresh keeps saved people visible and marks the information as stale',
    (tester) async {
      final backend = TaskBackend();
      await productApp(
        tester,
        backend: backend,
        home: const Scaffold(
          body: ConversationHierarchy(identity: 'dana', sidebar: true),
        ),
      );
      expect(find.byKey(const Key('org-person-ido')), findsOneWidget);
      backend.failedTree = true;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(
        find.text('Team refresh failed. Showing saved information.'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('org-person-ido')), findsOneWidget);
    },
  );

  for (final language in ['he', 'en']) {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 1.3, 2.0]) {
        for (final screen in ['list', 'detail']) {
          testWidgets('task golden $screen $language $dark $scale', (
            tester,
          ) async {
            await productApp(
              tester,
              backend: TaskBackend(he: language == 'he'),
              language: language,
              dark: dark,
              scale: scale,
              home: screen == 'list'
                  ? const Scaffold(body: ProductTasks())
                  : const ProductTaskScreen(id: 3),
            );
            expect(tester.takeException(), isNull);
            await expectLater(
              find.byType(MaterialApp),
              matchesGoldenFile(
                'golden/tasks/$screen-$language-$dark-$scale.png',
              ),
            );
          });
        }
      }
      testWidgets('task board golden $language $dark', (tester) async {
        // Its empty columns say so: no proposals accepted yet is in the list golden; nothing released this week is here.
        await productApp(
          tester,
          backend: TaskBackend(he: language == 'he'),
          language: language,
          dark: dark,
          size: const Size(1440, 900),
          home: const Scaffold(body: ProductTasks()),
          prepare: (s) => s.taskBoard = true,
        );
        expect(find.byType(SegmentedButton<bool>), findsOneWidget);
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile('golden/tasks/board-$language-$dark.png'),
        );
      });
      testWidgets('hierarchy desktop with tasks $language $dark', (
        tester,
      ) async {
        await productApp(
          tester,
          backend: TaskBackend(he: language == 'he'),
          language: language,
          dark: dark,
          size: const Size(1280, 900),
          home: const ChatScreen(identityId: 'dana'),
        );
        expect(find.byKey(const ValueKey('chat-task-1')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile(
            'golden/tasks/hierarchy-desktop-$language-$dark.png',
          ),
        );
      });
      testWidgets('hierarchy golden $language $dark', (tester) async {
        await productApp(
          tester,
          backend: TaskBackend(he: language == 'he'),
          language: language,
          dark: dark,
          home: const Scaffold(
            body: ConversationHierarchy(identity: 'dana', sidebar: true),
          ),
        );
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile('golden/tasks/hierarchy-$language-$dark.png'),
        );
      });
      testWidgets('the finished one in the chat stays out of the fold $language $dark', (tester) async {
        final backend = TaskBackend(he: language == 'he')
          ..customPeople = [
            const OrgPerson(id: 'dana', name: 'Dana', title: 'Team lead', manager: 'yoav'),
            for (var i = 0; i < 7; i++)
              OrgPerson(id: 'done-$i', name: 'Done $i', title: 'Developer', manager: 'dana', tasks: [(id: 10 + i, title: 'Finished task $i', state: 'done')]),
          ];
        await productApp(
          tester,
          backend: backend,
          language: language,
          dark: dark,
          home: const Scaffold(
            body: ConversationHierarchy(identity: 'done-3', sidebar: true),
          ),
        );
        expect(find.byKey(const ValueKey('org-person-done-3')), findsOneWidget);
        expect(find.byKey(const ValueKey('org-person-done-0')), findsNothing);
        expect(find.byKey(const PageStorageKey('org-finished-dana')), findsOneWidget);
      });
      testWidgets('hierarchy folds more than five finished $language $dark', (tester) async {
        final backend = TaskBackend(he: language == 'he')
          ..customPeople = [
            const OrgPerson(id: 'dana', name: 'Dana', title: 'Team lead', manager: 'yoav'),
            const OrgPerson(id: 'ido', name: 'Ido', title: 'Developer', manager: 'dana', tasks: [(id: 2, title: 'Improve map loading', state: 'running')]),
            for (var i = 0; i < 7; i++)
              OrgPerson(id: 'done-$i', name: 'Done $i', title: 'Developer', manager: 'dana', tasks: [(id: 10 + i, title: 'Finished task $i', state: 'done')]),
          ];
        await productApp(
          tester,
          backend: backend,
          language: language,
          dark: dark,
          home: const Scaffold(
            body: ConversationHierarchy(identity: 'dana', sidebar: true),
          ),
        );
        expect(find.byKey(const ValueKey('org-person-done-0')), findsNothing);
        expect(find.byKey(const ValueKey('org-person-ido')), findsOneWidget);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile('golden/tasks/hierarchy-folded-$language-$dark.png'),
        );
        await tester.tap(find.byKey(const PageStorageKey('org-finished-dana')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('org-person-done-0')));
        await tester.pumpAndSettle();
        expect(tester.widget<ChatScreen>(find.byType(ChatScreen).last).identityId, 'done-0');
        expect(tester.takeException(), isNull);
      });
      testWidgets('hierarchy large golden $language $dark', (tester) async {
        await productApp(
          tester,
          backend: TaskBackend(he: language == 'he'),
          language: language,
          dark: dark,
          scale: 2,
          home: const Scaffold(
            body: ConversationHierarchy(identity: 'dana', sidebar: true),
          ),
        );
        expect(tester.takeException(), isNull);
        await expectLater(
          find.byType(MaterialApp),
          matchesGoldenFile('golden/tasks/hierarchy-$language-$dark-2.0.png'),
        );
      });
    }
  }
}
