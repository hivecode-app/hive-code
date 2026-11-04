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
  int starts = 0, reveals = 0;
  Completer<CommandResult>? startReply;
  List<Map<String, dynamic>> eventLog = [];
  bool accepted = false;
  List<TaskProgress> get tasks => [
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
    if (failedTree) throw StateError('unavailable');
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

void main() {
  testWidgets(
    'Tasks destination opens the task, back preserves project and selection; report is not Released',
    (tester) async {
      final store = await productApp(tester, backend: TaskBackend());
      await tester.tap(find.text('Tasks'));
      await tester.pumpAndSettle();
      expect(find.byType(ProductTasks), findsOneWidget);
      await tester.tap(find.byKey(const Key('task-1')));
      await tester.pumpAndSettle();
      expect(find.byType(ProductTaskScreen), findsOneWidget);
      expect(find.text('Fix search'), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(store.selectedTask, 1);
      expect(
        tester.widget<ListTile>(find.byKey(const Key('task-1'))).selected,
        true,
      );
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
      );
      final semantics = tester.ensureSemantics();

      expect(
        tester.getSemantics(find.byKey(const Key('task-1'))).label,
        contains('Fix search'),
      );
      var reached = false;
      for (var i = 0; i < 30; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.tab);
        await tester.pump();
        final tile = FocusManager.instance.primaryFocus?.context
            ?.findAncestorWidgetOfExactType<ListTile>();
        if (tile?.key == const ValueKey('task-1')) {
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
      store.taskProject = 'voice';
      store.touch();
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(store.taskProject, 'voice');
      expect(store.selectedTask, 1);
      expect(find.byKey(const Key('task-3')), findsOneWidget);
      expect(find.byKey(const Key('task-1')), findsNothing);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    },
  );

  testWidgets('an unverified task remains visible without inventing a stage', (
    tester,
  ) async {
    await productApp(
      tester,
      backend: TaskBackend()..unknown = true,
      home: const Scaffold(body: ProductTasks()),
    );
    expect(find.byKey(const Key('task-3')), findsOneWidget);
    expect(find.text('Progress is being verified'), findsOneWidget);
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
      final proposal = tester.widget<ListTile>(find.byKey(const Key('task-1')));
      expect((proposal.leading as Ic).name, 'lightbulb');
      expect(
        find.descendant(
          of: find.byKey(const Key('task-4')),
          matching: find.text('Work completed'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('task-5')),
          matching: find.text('Work completed'),
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
    }
  }
}
