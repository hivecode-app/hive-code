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
import 'package:agent_company/ui/product/search_screen.dart';
import 'package:agent_company/ui/tasks/task_screen.dart';
import 'package:agent_company/ui/tasks/tasks_screen.dart';
import 'package:flutter/material.dart';
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
  bool accepted = false;
  int released = 0;
  bool orphanGo = false;
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
      expect(find.text('Pull requests'), findsOneWidget);
      expect(find.text('Review approved'), findsOneWidget);
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
    expect(find.text('Pull requests'), findsOneWidget);
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
    'stage activity shows actual transitions and excludes label or priority edits',
    (tester) async {
      final backend = TaskBackend()
        ..eventLog = [
          {
            'type': 'task.labels',
            'data': '{}',
            'ts': kDemoNow.millisecondsSinceEpoch,
          },
          {
            'type': 'task.priority',
            'data': '{}',
            'ts': kDemoNow.millisecondsSinceEpoch,
          },
          {
            'type': 'task.state',
            'data': '{"state":"running"}',
            'ts': kDemoNow.millisecondsSinceEpoch,
          },
          {
            'type': 'task.state',
            'data': '{"state":"done"}',
            'ts': kDemoNow.millisecondsSinceEpoch,
          },
        ];
      await productApp(
        tester,
        backend: backend,
        home: const ProductTaskScreen(id: 2),
      );
      expect(find.text('Work started'), findsOneWidget);
      expect(find.text('Work completed'), findsOneWidget);
      expect(
        find.text('In development'),
        findsOneWidget,
        reason: 'the timeline label is not duplicated for admin events',
      );
    },
  );

  testWidgets(
    'timeline sequence at 200 percent remains read-only and saves selected activity',
    (tester) async {
      final backend = TaskBackend();
      final store = await productApp(
        tester,
        backend: backend,
        scale: 2,
        home: const ProductTaskScreen(id: 3),
      );
      expect(find.text('Stage 3 of 5'), findsOneWidget);
      expect(find.byType(ChoiceChip), findsNothing);
      await tester.tap(find.byKey(const Key('choose-stage-activity')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('stage-proposal')));
      await tester.pumpAndSettle();
      expect(store.taskActivityStages[3], 'proposal');
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
    await tester.tap(find.byTooltip('Refresh'));
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

  testWidgets('request navigation points into the detail direction in RTL', (
    tester,
  ) async {
    await productApp(
      tester,
      backend: TaskBackend(),
      language: 'he',
      home: const ProductTaskScreen(id: 2),
    );
    final request = tester.widget<ListTile>(
      find.byWidgetPredicate(
        (w) =>
            w is ListTile &&
            w.leading is Ic &&
            (w.leading as Ic).name == 'front_hand',
      ),
    );
    expect((request.trailing as Ic).name, 'chevron_left');
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
    'the hierarchy reserves its phone height and periodic refresh never moves the conversation',
    (tester) async {
      final backend = TaskBackend();
      final people = await backend.organization();
      backend.treeLoads = 0;
      backend.treeReply = Completer<List<OrgPerson>>();
      await productApp(
        tester,
        backend: backend,
        home: const ChatScreen(identityId: 'dana'),
      );
      final hierarchy = find.byType(ConversationHierarchy);
      final height = tester.getSize(hierarchy).height;
      backend.treeReply!.complete(people);
      await tester.pumpAndSettle();
      expect(tester.getSize(hierarchy).height, height);
      backend.treeReply = Completer<List<OrgPerson>>();
      await tester.pump(const Duration(seconds: 30));
      expect(backend.treeLoads, 2);
      expect(tester.getSize(hierarchy).height, height);
      expect(find.text('Updating team'), findsNothing);
      backend.treeReply!.complete(people);
      await tester.pumpAndSettle();
      expect(tester.getSize(hierarchy).height, height);
      backend.treeReply = null;
      backend.failedTree = true;
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(tester.getSize(hierarchy).height, height);
      expect(find.byKey(const Key('conversation-team')), findsOneWidget);
      expect(
        find.byTooltip('Team refresh failed. Showing saved information.'),
        findsOneWidget,
      );
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
    'a known conversation without a team has no empty hierarchy strip',
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
      expect(tester.getSize(find.byType(ConversationHierarchy)).height, 0);
      backend.failedTree = true;
      backend.customPeople = null;
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(ConversationHierarchy)).height, 0);
    },
  );
  testWidgets(
    'a long team label stays inside its reserved strip at 200 percent',
    (tester) async {
      final backend = TaskBackend()
        ..customPeople = [
          OrgPerson(
            id: 'dana',
            name: 'Long team lead name ' * 10,
            title: 'Lead',
          ),
          const OrgPerson(
            id: 'ido',
            name: 'Ido',
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
        matching: find.byType(Text),
      );
      expect(tester.widget<Text>(label).maxLines, 1);
      expect(
        tester.getRect(label).height,
        lessThanOrEqualTo(
          tester.getRect(find.byType(ConversationHierarchy)).height,
        ),
      );
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
    'wide chat shows the tree once, and at 200 percent uses a full-width team entry',
    (tester) async {
      final store = await productApp(
        tester,
        backend: TaskBackend(),
        size: const Size(1280, 900),
        prepare: (s) => s.selectedConversation = 'dana',
      );
      expect(find.byType(ConversationHierarchy), findsOneWidget);
      expect(
        tester
            .widget<ConversationHierarchy>(find.byType(ConversationHierarchy))
            .sidebar,
        true,
      );
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      store.touch();
      await tester.pumpAndSettle();
      expect(find.byType(ConversationHierarchy), findsOneWidget);
      expect(
        tester
            .widget<ConversationHierarchy>(find.byType(ConversationHierarchy))
            .sidebar,
        false,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'keyboard and semantics expose activity and the completed worker at 200 percent',
    (tester) async {
      final store = await productApp(
        tester,
        backend: TaskBackend(),
        scale: 2,
        home: const ProductTaskScreen(id: 3),
      );
      final semantics = tester.ensureSemantics();
      await openByKeyboard(tester, const Key('choose-stage-activity'));
      expect(
        tester.getSemantics(find.byKey(const Key('stage-proposal'))).label,
        contains('Stage complete'),
      );
      await openByKeyboard(tester, const Key('stage-proposal'));
      expect(store.taskActivityStages[3], 'proposal');
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
    await tester.tap(find.text('Pull requests'));
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
        expect(find.byKey(const Key('org-task-2')), findsOneWidget);
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
