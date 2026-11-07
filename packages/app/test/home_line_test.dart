import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/l10n/app_localizations.dart';
import 'package:agent_company/model/company_time.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/model/task_progress.dart';
import 'package:agent_company/ui/product/chats.dart';
import 'package:agent_company/ui/product/settings.dart';
import 'package:agent_company/ui/product/shell.dart';
import 'package:agent_company/ui/product/team.dart' show shownStatus;
import 'package:agent_company/ui/system_bar.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart' show kDemoNow;
import 'product_test.dart' show productApp, OfflineBackend;

/// Tasks with real stages, as hq's /api/tasks gives them.
class _StagedBackend extends FakeBackend {
  _StagedBackend(this.stages, {this.extra = const []}) : super(simulate: false, now: kDemoNow);
  final Map<String, TaskStage> stages;
  final List<TaskProgress> extra;
  int reads = 0;
  @override
  Future<List<TaskProgress>> taskProgress() async {
    reads++;
    return [
      for (final (i, e) in stages.entries.indexed) TaskProgress(id: 900 + i, title: 'אפליקציה: משימה של ${e.key}', worker: e.key, stage: e.value, state: 'running'),
      ...extra,
    ];
  }
}

WaitItem _ask(String id, String from, WaitKind kind) => WaitItem(id: id, kind: kind, from: from, time: '10:00', kicker: 'k', body: 'b');

void main() {
  AppLocalizations l(WidgetTester tester) => AppLocalizations.of(tester.element(find.byType(ProductShell)));
  (String, String, bool)? line(WidgetTester tester, String id) {
    final context = tester.element(find.byType(ProductChats));
    final store = StoreScope.read(context);
    return chatLine(context, store.data!, store, id);
  }

  testWidgets('"מחכה לך" is one source: the chip counts it, filters to who asks, and an answer leaves both', (tester) async {
    final store = await productApp(tester, language: 'he');
    final d = store.data!;
    final asking = {for (final w in d.needsYou) w.from};
    expect(asking, isNotEmpty, reason: 'the demo asks him something');
    expect(find.text(l(tester).needsYouCount(d.waitingCount)), findsOneWidget);
    await tester.tap(find.text(l(tester).needsYouCount(d.waitingCount)));
    await tester.pumpAndSettle();
    final rows = tester.widgetList<ProductChatRow>(find.byType(ProductChatRow, skipOffstage: false)).map((r) => r.conversation.identityId).toSet();
    expect(rows, asking);
    for (final id in asking) {
      expect(line(tester, id)?.$1, anyOf('front_hand', 'contact_support'));
    }
    // Every ask answered: the chip and the filter go, the card says nothing waits, and every chat is back.
    d.waiting.clear();
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text(l(tester).needsYouCount(0)), findsNothing);
    expect(find.textContaining(l(tester).noRequests), findsOneWidget);
    expect(find.text(l(tester).all), findsOneWidget, reason: 'the project chips stay; only "מחכה לך" goes');
    final all = find.byType(ProductChatRow, skipOffstage: false).evaluate().length;
    expect(all, greaterThan(rows.length));
    // A new ask does not bring the filter back by itself.
    d.waiting.add(_ask('new', asking.first, WaitKind.go));
    store.touch();
    await tester.pumpAndSettle();
    expect(find.byType(ProductChatRow, skipOffstage: false).evaluate().length, all);
  });

  testWidgets('one he put off says "לא עכשיו", never "מחכה לך" beside a card that says nothing waits; waiting with nothing open is blocked', (tester) async {
    final store = await productApp(tester, language: 'he');
    final d = store.data!;
    d.waiting.clear();
    d.presence['ido'] = const Presence(status: WorkerStatus.waiting);
    d.presence['dana'] = const Presence(status: WorkerStatus.waiting);
    d.presence['itai'] = const Presence(status: WorkerStatus.stuck);
    d.waiting.add(_ask('later', 'ido', WaitKind.go)..state = WaitState.notNow);
    d.waiting.add(_ask('later2', 'itai', WaitKind.go)..state = WaitState.notNow);
    store.touch();
    await tester.pumpAndSettle();
    final t = l(tester);
    expect(find.textContaining(t.noRequests), findsOneWidget);
    expect(line(tester, 'ido'), ('front_hand', t.notNow, false));
    expect(shownStatus(d, 'ido'), WorkerStatus.blocked, reason: 'the team says "מחכה לך" only where the chip does');
    expect(line(tester, 'itai')?.$1, 'warning', reason: 'stuck says so first');
    expect(line(tester, 'dana')?.$1, 'block');
    expect(shownStatus(d, 'dana'), WorkerStatus.blocked);
  });

  testWidgets('the line names the task it is on: running first, never queued or cancelled', (tester) async {
    final store = await productApp(
      tester,
      language: 'he',
      backend: _StagedBackend(const {}, extra: [
        TaskProgress(id: 1, title: 'בתור', worker: 'ido', stage: TaskStage.development, state: 'queued', updatedAt: DateTime(2030)),
        TaskProgress(id: 2, title: 'בוטלה', worker: 'ido', stage: TaskStage.review, state: 'closed', outcome: 'cancelled', updatedAt: DateTime(2030)),
        TaskProgress(id: 3, title: 'במנוחה', worker: 'ido', stage: TaskStage.review, state: 'resting', updatedAt: DateTime(2029)),
        TaskProgress(id: 4, title: 'רצה', worker: 'ido', stage: TaskStage.review, state: 'running', updatedAt: DateTime(2020)),
      ]),
    );
    expect(store.taskOf('ido')?.title, 'רצה');
  });

  testWidgets('the stages are read at most once a minute, and an update inside the minute is read at its end', (tester) async {
    AppStore.readPipelineLater = true;
    addTearDown(() => AppStore.readPipelineLater = false);
    final backend = _StagedBackend(const {'ido': TaskStage.development});
    final store = await productApp(tester, language: 'he', backend: backend);
    final first = backend.reads;
    expect(first, greaterThan(0));
    await store.refreshPipeline();
    await store.refreshPipeline();
    expect(backend.reads, first, reason: 'inside the minute');
    await tester.pump(const Duration(minutes: 1));
    await tester.pump();
    expect(backend.reads, first + 1, reason: 'one read at the end of the minute');
  });

  testWidgets('the third line: a GO, a question, stuck, the stage of its task, what it works on', (tester) async {
    final store = await productApp(
      tester,
      language: 'he',
      backend: _StagedBackend({'dana': TaskStage.review, 'ido': TaskStage.development}),
    );
    final d = store.data!;
    d.waiting.clear();
    for (final id in ['dana', 'ido', 'stuck-one', 'free-one']) {
      d.presence[id] = const Presence(status: WorkerStatus.working, activity: 'כותבת');
    }
    d.presence['stuck-one'] = const Presence(status: WorkerStatus.stuck);
    d.presence['free-one'] = const Presence(status: WorkerStatus.free, activity: 'כותבת');
    store.touch();
    await tester.pumpAndSettle();
    final t = l(tester);
    expect(store.taskOf('dana'), isNotNull);
    expect(line(tester, 'dana'), ('rate_review', t.stageTask(t.progressReview, 'משימה של dana'), false));
    expect(line(tester, 'ido'), ('play_arrow', 'משימה של ido', false));
    expect(line(tester, 'stuck-one'), ('warning', t.stuck, false));
    expect(line(tester, 'free-one'), isNull);
    d.waiting.add(_ask('q1', 'ido', WaitKind.blockingAsk));
    expect(line(tester, 'ido'), ('contact_support', t.questionForYou, false));
    d.waiting.add(_ask('g1', 'ido', WaitKind.go));
    expect(line(tester, 'ido'), ('front_hand', t.needsYou, true));
  });

  testWidgets('stuck says for how long when hq sends since when, in the worker\'s gender (mockup "תקועה 40 דקות")', (tester) async {
    final store = await productApp(tester, language: 'he', backend: _StagedBackend({'dana': TaskStage.development}));
    final d = store.data!;
    d.waiting.clear();
    final now = CompanyTime.now();
    d.presence['dana'] = Presence(status: WorkerStatus.stuck, stuckSince: now.subtract(const Duration(minutes: 40)));
    d.presence['ido'] = Presence(status: WorkerStatus.stuck, stuckSince: now.subtract(const Duration(minutes: 130)));
    store.touch();
    await tester.pumpAndSettle();
    expect(line(tester, 'dana'), ('warning', 'תקועה 40 דקות · משימה של dana', false));
    expect(line(tester, 'ido')!.$2, startsWith('תקוע שעתיים'));
  });

  testWidgets('approval waits on someone: an hourglass, not a check mark', (tester) async {
    final store = await productApp(tester, language: 'he', backend: _StagedBackend({'dana': TaskStage.approval}));
    store.data!
      ..waiting.clear()
      ..presence['dana'] = const Presence(status: WorkerStatus.working);
    store.touch();
    await tester.pumpAndSettle();
    expect(line(tester, 'dana')?.$1, 'hourglass_top');
  });

  testWidgets('the stages read after the end of the minute do not schedule another read', (tester) async {
    AppStore.readPipelineLater = true;
    addTearDown(() => AppStore.readPipelineLater = false);
    final backend = _StagedBackend(const {'ido': TaskStage.development});
    final store = await productApp(tester, language: 'he', backend: backend);
    await store.refreshPipeline();
    await tester.pump(const Duration(minutes: 1));
    await tester.pump();
    final after = backend.reads;
    // hq answers that read with tasks.progress: it must not start the minute again.
    await store.refreshPipeline();
    await tester.pump(const Duration(minutes: 2));
    await tester.pump();
    expect(backend.reads, after);
  });

  testWidgets('offline: a framed card with since when, and troubleshooting opens settings', (tester) async {
    await productApp(tester, language: 'he', backend: OfflineBackend());
    expect(find.byType(OfflineCard), findsOneWidget);
    expect(find.text(l(tester).offlineBody), findsOneWidget);
    final semantics = tester.ensureSemantics();
    expect(tester.getSemantics(find.text(l(tester).troubleshoot)).getSemanticsData().flagsCollection.isButton, isTrue);
    semantics.dispose();
    await tester.tap(find.text(l(tester).troubleshoot));
    await tester.pumpAndSettle();
    expect(find.byType(ProductSettings), findsOneWidget);
  });

  testWidgets('the tab is "צ\'אטים", as in the mockup', (tester) async {
    await productApp(tester, language: 'he');
    expect(l(tester).chats, "צ'אטים");
  });
}
