// #53: the layout (chats · status · projects · settings) on a sample hq at 20/10/2026 19:59
// (test/fixtures/samples/hq_evening: /api/board, /api/inbox, /api/asks, /api/toggles,
// /api/messages?identity=owner and /api/accounts, in the shape of a real day of hq, with invented
// projects, titles and messages), with the project names of org.yaml (agent-company is "החברה").
// These goldens are the screens of the approved mockup (#53), as built.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/icons.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:agent_company/ui/projects/projects_screen.dart';
import 'package:agent_company/ui/settings/settings_screen.dart';
import 'package:agent_company/ui/entity_link.dart';
import 'package:agent_company/ui/projects/project_screen.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

const _dir = 'test/fixtures/samples/hq_evening';
final _at = DateTime(2026, 10, 20, 19, 59);

Map<String, dynamic> _json(String name) => jsonDecode(File('$_dir/$name.json').readAsStringSync()) as Map<String, dynamic>;
List<Map<String, dynamic>> _list(String name, String key) => (_json(name)[key] as List).cast<Map<String, dynamic>>();

class _Snapshot extends FakeBackend {
  _Snapshot(this.snapshot) : super(simulate: false);
  final CompanyData snapshot;
  @override
  CompanyData? get data => snapshot;
  @override
  SystemStatus get status => const SystemStatus(LinkState.online);
  @override
  Future<void> start() async => notifyListeners();
  @override
  String get label => 'app.hq.example.com';
  @override
  Future<AccountsView?> accounts() async {
    final j = _json('accounts');
    return AccountsView(pinned: j['pinned'] as String?, active: j['active'] as String?, accounts: [
      for (final a in (j['accounts'] as List).cast<Map<String, dynamic>>())
        AccountInfo(name: a['name'] as String, label: a['label'] as String, usable: a['usable'] == true, blocked: a['blocked_until'] != null, room: a['room'] as num?),
    ]);
  }
}

/// Last line, time and unread count per conversation, the way the app sets them from /api/messages.
/// The live hq has no /api/conversations yet (#50 is not deployed), so the count here is what came in
/// after his last word and is not handled.
void _lastLines(CompanyData d) {
  final msgs = _list('messages', 'messages');
  String other(Map<String, dynamic> m) => (m['from_identity'] == 'owner' ? m['to_identity'] : m['from_identity']) as String;
  final unread = <String, int>{};
  final closed = <String>{};
  for (final m in msgs) {
    final o = other(m);
    if (closed.contains(o)) continue;
    if (m['from_identity'] == 'owner') {
      closed.add(o);
    } else if (m['state'] != 'handled') {
      unread[o] = (unread[o] ?? 0) + 1;
    }
  }
  final seen = <String>{};
  for (final m in msgs) {
    final o = other(m);
    if (o == 'hq' || !seen.add(o)) continue;
    final t = DateTime.fromMillisecondsSinceEpoch(m['created_at'] as int);
    final c = ConversationSummary(
      identityId: o,
      lastLine: (m['from_identity'] == 'owner' ? 'את/ה: ' : '') + lastLineOf(m),
      time: t.day == _at.day ? hm(t) : 'אתמול',
      lastIsMine: m['from_identity'] != 'owner',
      unread: unread[o] ?? 0,
      pinned: o == 'yoav',
    );
    final i = d.conversations.indexWhere((x) => x.identityId == o);
    if (i >= 0) {
      d.conversations[i] = c;
    } else {
      d.conversations.add(c);
    }
  }
  final order = [for (final m in msgs) other(m)];
  int rank(ConversationSummary c) {
    final r = order.indexOf(c.identityId);
    return r < 0 ? 1 << 20 : r;
  }

  d.conversations.sort((a, b) => rank(a).compareTo(rank(b)));
}

// The summaries hq had not written yet at 19:59 (no task had one): one line in his words per finished task,
// for the head's "מאז שהיית פה". Everything else is the snapshot as it was.
const _summaries = {
  51: 'מיכל התחילה לעבוד בבוט ההזמנות',
  47: 'מעל 7 פריטים: המוקד הקולי מפנה לשליח',
  49: 'שרת 2.6.10 מוכן לפריסה',
  48: 'בלשונית "ארגון" רואים את העובדים הקבועים',
  46: 'שרת 2.6.7 יציב אחרי 24 שעות',
};

// Something burning, for the head's "everything" state (nothing burned at 19:59): an incident from monitoring.
final _incident = <String, dynamic>{
  'id': 90,
  'kind': 'incident',
  'title': 'האתר של החנות לא עונה',
  'body': 'shop.example.com/healthz מחזיר 502 כבר 4 דקות.',
  'from_identity': 'rotem',
  'urgency': 'urgent',
  'blocking': true,
  'ref': 'rotem-1:mock',
  'state': 'open',
  'created_at': DateTime(2026, 10, 20, 19, 55).millisecondsSinceEpoch,
  'link': null,
  'headline': 'האתר של החנות לא עונה',
  'snoozed_at': null,
};

CompanyData _data({bool earlierWaiting = false, bool burning = false, bool summaries = false}) {
  final board = _json('board');
  final d = mapSnapshot(manager: 'yoav', 
    board: (board['identities'] as List).cast<Map<String, dynamic>>(),
    inbox: [if (burning) _incident, ...(earlierWaiting ? _list('inbox-earlier', 'items') : _list('inbox', 'items'))],
    asks: _list('asks', 'asks'),
    toggles: _list('toggles', 'toggles'),
    tasks: [
      for (final t in (board['tasks'] as List).cast<Map<String, dynamic>>()) {...t, if (summaries && _summaries.containsKey(t['id'])) 'summary': _summaries[t['id']]},
    ],
    projects: (board['projects'] as List).cast<Map<String, dynamic>>(),
    now: _at,
  );
  _lastLines(d);
  return d;
}

Future<BuildContext> _pump(WidgetTester tester,
    {Size size = kPhone, bool earlierWaiting = false, bool burning = false, bool summaries = false, DateTime? chatsSeen, bool dark = false, double textScale = 1, bool head = false}) async {
  await loadFonts();
  Motion.frozen = true;
  SharedPreferences.setMockInitialValues({'language': 'he', 'new_interface': false});
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  pinClock(_at);
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final store = AppStore(_Snapshot(_data(earlierWaiting: earlierWaiting, burning: burning, summaries: summaries)));
  await store.start();
  // His last visit to the status screen, for the mockup: 18:00 today. To the chats screen: just now,
  // unless the test says otherwise.
  store.statusSeenAt = DateTime(2026, 10, 20, 18, 0);
  store.markChatsSeen(chatsSeen ?? _at);
  // [head]: the home alone (homeAlone), unfolded.
  await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: head ? homeAlone() : null));
  await tester.pump();
  return tester.element(find.byType(Scaffold).first);
}

Future<void> _shot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sample_layout/$name.png'));
}

const _tall = Size(342, 1500);

void main() {
  testWidgets('status: what waits, what finished since the last visit, a line per project', (tester) async {
    final ctx = await _pump(tester, size: _tall, earlierWaiting: true);
    NavScope.read(ctx).go(AppTab.status);
    await tester.pump();
    expect(find.text('מ-18:00'), findsOneWidget);
    // Since 18:00: 14 finished with a worker on them (the one closed into another task has none, and is left out).
    expect(findShown('עוד 8 · בפרויקטים'), findsOneWidget);
    expect(findShown('עובדת קבועה חדשה, מיכל, תפעול עסקי'), findsOneWidget, reason: 'the title without "בוט ההזמנות: "');
    expect(findShown('החברה · תומר · 19:56'), findsOneWidget, reason: 'the project by its name, never agent-company');
    expect(findShown('שקט, אין משימה שרצה'), findsNWidgets(3));
    expect(findShown('קרן: שעת משלוח'), findsOneWidget);
    await _shot(tester, '03-status');
  });

  testWidgets('status: a task\'s summary is its line, in his words', (tester) async {
    final ctx = await _pump(tester);
    final d = StoreScope.read(ctx).data!;
    final i = d.tickets.indexWhere((t) => t.number == 't51');
    final t = d.tickets[i];
    d.tickets[i] = Ticket(number: t.number, title: t.title, project: t.project, projectName: t.projectName, group: t.group, assignee: t.assignee,
        status: t.status, assigneeId: t.assigneeId, doneAt: t.doneAt, summary: 'מיכל בצוות של בוט ההזמנות');
    StoreScope.read(ctx).touch();
    NavScope.read(ctx).go(AppTab.status);
    await tester.pump();
    expect(findShown('מיכל בצוות של בוט ההזמנות'), findsOneWidget);
    expect(findShown('עובדת קבועה חדשה'), findsNothing);
  });

  testWidgets('a tap on who did it (docs/app/links.md): "מאז הביקור הקודם", a task worker under a lead, a running line on status', (tester) async {
    final ctx = await _pump(tester, size: _tall);
    final d = StoreScope.read(ctx).data!;
    String? open() => find.byType(ChatScreen).evaluate().isEmpty ? null : tester.widget<ChatScreen>(find.byType(ChatScreen).last).identityId;
    Future<void> back() async {
      Navigator.of(tester.element(find.byType(ChatScreen).last)).pop();
      await tester.pumpAndSettle();
    }

    // On status: a finished task of a task worker opens who opened it, not the project.
    NavScope.read(ctx).go(AppTab.status);
    await tester.pumpAndSettle();
    final since = DateTime(2026, 10, 20, 18, 0);
    final done = [for (final t in d.tickets) if (t.doneAt != null && t.assigneeId != null && t.doneAt!.isAfter(since)) t]..sort((a, b) => b.doneAt!.compareTo(a.doneAt!));
    final shown = done.take(StatusScreen.kDoneShown).toList();
    final byTemp = shown.firstWhere((t) => d.who(t.assigneeId!).temp && t.openedBy != null && d.identities.containsKey(t.openedBy));
    expect(chatTargetOfTicket(d, byTemp), byTemp.openedBy);
    await tester.tap(findShown(byTemp.doneLine));
    await tester.pumpAndSettle();
    expect(open(), byTemp.openedBy);
    expect(find.byType(ProjectScreen), findsNothing);
    await back();

    // "קרן: שעת משלוח" in "בפרויקטים עכשיו" opens Keren.
    await tester.tap(findShown('קרן: שעת משלוח'));
    await tester.pumpAndSettle();
    expect(open(), 'keren');
  });

  testWidgets('projects: by his names, each with its lead and open tasks; then the standing teams', (tester) async {
    final ctx = await _pump(tester, size: _tall);
    NavScope.read(ctx).go(AppTab.projects);
    await tester.pump();
    for (final name in ['החברה', 'החנות', 'בוט ההזמנות', 'בוט התמיכה', 'המוקד הקולי', 'צוותים קבועים']) {
      expect(findShown(name), findsWidgets, reason: name);
    }
    expect(find.text('agent-company'), findsNothing);
    expect(find.text('2 משימות פתוחות'), findsOneWidget);
    expect(find.text('משימה פתוחה אחת'), findsOneWidget);
    await _shot(tester, '04-projects');
  });

  testWidgets('project: the team, the open tasks and what finished today, task workers too', (tester) async {
    final ctx = await _pump(tester, size: _tall);
    NavScope.read(ctx).go(AppTab.projects);
    await tester.pump();
    Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => const ProjectScreen(projectId: 'agent-company')));
    await tester.pumpAndSettle();
    expect(findShown('שני (זמני) · עובד מ-19:40'), findsOneWidget);
    expect(find.text('עוד 29'), findsOneWidget);
    await _shot(tester, '05-project-agent-company');
    await tester.tap(find.text('עוד 29'));
    await tester.pump();
    expect(find.text('עוד 29'), findsNothing);
  });

  testWidgets('project: a standing worker\'s task shows under the team', (tester) async {
    final ctx = await _pump(tester);
    Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => const ProjectScreen(projectId: 'voice')));
    await _shot(tester, '06-project-voice');
    expect(findShown('שעת משלוח "לא ידוע" לא נאמרת ללקוח'), findsNWidgets(2), reason: 'under Keren, and as the open task');
  });

  testWidgets('settings: automations, accounts, devices', (tester) async {
    final ctx = await _pump(tester, size: const Size(342, 900));
    NavScope.read(ctx).go(AppTab.settings);
    await tester.pumpAndSettle();
    expect(findShown('9 פועלות · מתוך 18'), findsOneWidget);
    expect(find.text('חשבון שני'), findsOneWidget);
    await _shot(tester, '07-settings');
    await tester.tap(findShown('9 פועלות'));
    await tester.pumpAndSettle();
    expect(find.byType(AutomationsScreen), findsOneWidget);
    expect(find.text('נגה · ראש מחלקת השיפור'), findsOneWidget, reason: 'grouped by who runs them');
  });

  testWidgets('automations', (tester) async {
    final ctx = await _pump(tester, size: _tall);
    Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => const AutomationsScreen()));
    await _shot(tester, '08-automations');
  });

  testWidgets('leaving the status tab is the visit: what finished before it is no longer "since"', (tester) async {
    final ctx = await _pump(tester);
    final store = StoreScope.read(ctx);
    store.statusSeenAt = null;
    NavScope.read(ctx).go(AppTab.status);
    await tester.pump();
    // Android back, not a tab: still the visit.
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(NavScope.read(ctx).tab, AppTab.chats);
    expect(store.statusSeenAt, isNotNull);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt(AppStore.kStatusSeenKey), store.statusSeenAt!.millisecondsSinceEpoch, reason: 'kept on the device');
  });

  testWidgets('a task worker\'s errand without a project shows under whoever opened it', (tester) async {
    final ctx = await _pump(tester);
    final store = StoreScope.read(ctx);
    final d = store.data!;
    d.tickets.add(Ticket(number: 't99', title: 'עוזר: השוואת מחירים', project: '', projectName: '', group: TicketGroup.working, assignee: d.who('agent-company-t14').name,
        status: WorkerStatus.working, assigneeId: 'agent-company-t14', openedBy: 'eli'));
    store.touch();
    await tester.pump();
    // The line under Eli's row (the desktop's list; the phone's rows have no such line since task 205).
    final tasks = openedTasks(d)['eli']!;
    expect(openTasksLine(tasks), 'רצה: השוואת מחירים');
    expect(tasks.single.worker, 'agent-company-t14');
  });

  // ── the home alone: what needs him, the blocks and the lanes ───────────────

  Future<void> headShot(WidgetTester tester, String name) async {
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sample_head/$name.png'));
  }

  final at19 = DateTime(2026, 10, 20, 19, 0);

  testWidgets('head: a stuck worker burns, with the task he is stuck on', (tester) async {
    final ctx = await _pump(tester, head: true);
    final store = StoreScope.read(ctx);
    final keren = store.data!.presence['keren']!;
    store.data!.presence['keren'] = Presence(status: WorkerStatus.stuck, currentTask: keren.currentTask, activity: keren.activity);
    store.touch();
    await tester.pumpAndSettle();
    expect(findShown('תקוע · קרן'), findsOneWidget);
    expect(findShown('שעת משלוח "לא ידוע" לא נאמרת ללקוח'), findsWidgets);
  });

  testWidgets('leaving the chats tab, or the app, is the visit: "since" starts there, kept for every device', (tester) async {
    final ctx = await _pump(tester, summaries: true, chatsSeen: at19);
    final store = StoreScope.read(ctx);
    NavScope.read(ctx).go(AppTab.status);
    await tester.pump();
    expect(store.chatsSeenAt!.isAfter(at19), isTrue);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getInt(AppStore.kChatsSeenKey), store.chatsSeenAt!.millisecondsSinceEpoch);
  });

  test('head data: the summary in his words, else the title without its area; newest first', () {
    final d = _data(summaries: true);
    final h = HeadData.of(d, since: DateTime(2026, 10, 20, 19, 0));
    expect(h.done.first.text, _summaries[51]);
    final d2 = _data();
    final h2 = HeadData.of(d2, since: DateTime(2026, 10, 20, 19, 0));
    expect(h2.done.map((x) => x.text), contains('עובדת קבועה חדשה, מיכל, תפעול עסקי'));
    expect([for (final x in h2.done) x.at], [for (final x in h2.done) x.at]..sort((a, b) => b.compareTo(a)));
    expect(sinceLabel(DateTime(2026, 10, 19, 22, 10), _at), 'מאז אתמול 22:10');
    expect(sinceLabel(DateTime(2026, 10, 17, 9, 0), _at), 'מאז 17/10');
  });

  // ── the home blocks (lib/ui/blocks), on the sample day ──────────────────

  Future<BuildContext> blocks(WidgetTester tester, {bool dark = false, double textScale = 1, Size size = const Size(342, 1700)}) async {
    final ctx = await _pump(tester, earlierWaiting: true, burning: true, summaries: true, size: size, dark: dark, textScale: textScale, chatsSeen: DateTime(2026, 10, 20, 19, 0));
    final d = StoreScope.read(ctx).data!;
    final projects = projectsByActivity(d);
    Navigator.of(ctx).push(MaterialPageRoute(
      builder: (context) => Scaffold(
        backgroundColor: context.p.surface,
        body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
          BlockCard(
            label: 'מה צריך ממך',
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                AlertBlock(items: [for (final w in d.waiting) if (HeadData.hot(w)) w], now: _at),
                const BlockHairline(),
                WaitingBlock(items: [for (final w in d.waiting) if (!HeadData.hot(w)) w], now: _at),
              ]),
            ),
          ),
          BlockCard(label: 'פסי היום', child: LanesBlock(data: LanesData.of(d, now: _at))),
          BlockCard(
            label: 'הפרויקטים',
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                for (final (i, pr) in projects.indexed) ...[
                  if (i > 0) const BlockHairline(),
                  ProjectBlock(
                    data: i == 1
                        ? ProjectLine.fromJson({...ProjectLine.of(d, pr.id).toJson(), 'note': 'קרן מחכה לתשובה מהלקוח על שעת המשלוח'})
                        : ProjectLine.of(d, pr.id),
                    now: _at,
                  ),
                ],
              ]),
            ),
          ),
          BlockCard(label: 'מי עובד עכשיו', child: PeopleBlock(data: PeopleData.of(d))),
          const BlockCard(child: NoteBlock(data: NoteData(text: 'היום נסגרו 30 משימות בחברה, רובן באפליקציה. בוט ההזמנות מחכה ל-GO שלך מ-19:57.', from: 'adi'))),
          BlockCard(label: 'מאז שהיית פה', child: SinceBlock(data: SinceData.of(d, since: DateTime(2026, 10, 20, 19, 0)), now: _at, max: 3)),
        ]),
      ),
    ));
    await tester.pumpAndSettle();
    return ctx;
  }

  testWidgets('blocks: lanes, projects, people, a note and "since", on the day of 20/10', (tester) async {
    final ctx = await blocks(tester);
    final d = StoreScope.read(ctx).data!;
    final lanes = LanesData.of(d, now: _at);
    expect(lanes.from, DateTime(2026, 10, 20, 5), reason: 'the day started at 05:45: from that hour, nothing cut and nothing empty');
    expect(lanes.lanes.first.id, 'agent-company', reason: 'open ones first');
    expect(lanes.lanes.first.running.length, 2);
    expect(lanes.lanes.firstWhere((l) => l.id == 'shop-bot').waiting, 1, reason: 'Boaz\'s GO');
    expect(find.text('עכשיו'), findsOneWidget);
    expect(findShown('עכשיו: שעת משלוח "לא ידוע" לא נאמרת ללקוח · קרן'), findsOneWidget);
    expect(findShown('שקט · אחרון: שרת 2.6.10 מוכן לפריסה'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^החברה, 2 רצות, \d+ הסתיימו היום, דבר אחד מחכה לך')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^\d+ הסתיימו, \d\d:\d\d עד \d\d:\d\d\. ')), findsWidgets, reason: 'dots on the same pixels are one, with a count');
    await headShot(tester, 'blocks');
    // A mark tells its story under the axis; a merged one, each of its sentences and its span of time.
    await tester.tap(find.bySemanticsLabel(RegExp(r'^\d+ הסתיימו, ')).first);
    await tester.pumpAndSettle();
    expect(find.byWidgetPredicate((w) => w is RichText && RegExp(r'^\d+ הסתיימו · מ-\d\d:\d\d עד \d\d:\d\d$').hasMatch(stripBidi(w.text.toPlainText()).trim())), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sample_head/blocks-bubble.png'));
  });

  testWidgets('blocks: dark and text at 130%', (tester) async {
    await blocks(tester, dark: true);
    await headShot(tester, 'blocks-dark');
    await tester.pumpWidget(const SizedBox());
    await blocks(tester, textScale: 1.3, size: const Size(342, 2000));
    await headShot(tester, 'blocks-text-130');
  });

  test('blocks: data goes through JSON and back the same', () {
    final d = _data(earlierWaiting: true, summaries: true);
    final lanes = LanesData.of(d, now: _at);
    expect(jsonEncode(LanesData.fromJson(jsonDecode(jsonEncode(lanes.toJson())) as Map<String, dynamic>).toJson()), jsonEncode(lanes.toJson()));
    final pl = ProjectLine.of(d, 'voice');
    expect(pl.now, 'שעת משלוח "לא ידוע" לא נאמרת ללקוח');
    expect(ProjectLine.fromJson(pl.toJson()).toJson(), pl.toJson());
    final since = SinceData.of(d, since: DateTime(2026, 10, 20, 19, 0));
    expect(since.items.first.text, _summaries[51]);
    expect(SinceData.fromJson(since.toJson()).toJson(), since.toJson());
    final people = PeopleData.of(d);
    expect(people.people.map((x) => x.id), containsAll(['keren', 'agent-company-t53', 'agent-company-t50']));
    expect(PeopleData.fromJson(people.toJson()).toJson(), people.toJson());
  });

  testWidgets('lanes: alone, and with a running bar picked', (tester) async {
    final ctx = await _pump(tester, earlierWaiting: true, summaries: true, size: const Size(342, 420));
    final d = StoreScope.read(ctx).data!;
    Navigator.of(ctx).push(MaterialPageRoute(
      builder: (context) => Scaffold(
        backgroundColor: context.p.surface,
        body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [BlockCard(label: 'פסי היום', child: LanesBlock(data: LanesData.of(d, now: _at)))]),
      ),
    ));
    await tester.pumpAndSettle();
    await headShot(tester, 'lanes');
    await tester.tap(find.bySemanticsLabel(RegExp(r'^קרן עובד על זה מ-19:46\. ')));
    await tester.pumpAndSettle();
    expect(findShown('קרן · מ-19:46'), findsOneWidget);
    await headShot(tester, 'lanes-picked');
    await tester.tap(find.byIcon(kIcons['close']!));
    await tester.pumpAndSettle();
    expect(find.text('מחכה לך'), findsOneWidget, reason: 'the legend is back');
  });

  test('project: each worker once in who', () {
    final d = _data();
    final pl = ProjectLine.of(d, 'support');
    expect(ProjectLine.fromJson({...pl.toJson(), 'who': ['keren', 'keren']}).who.length, 2, reason: 'JSON is taken as given');
    expect(ProjectLine.of(d, 'agent-company').who.toSet().length, ProjectLine.of(d, 'agent-company').who.length, reason: 'each worker once');
  });

  testWidgets('project: a last one from days ago shows its date, not "אתמול"', (tester) async {
    final ctx = await _pump(tester);
    Navigator.of(ctx).push(MaterialPageRoute(
      builder: (context) => Scaffold(
        body: Column(children: [
          ProjectBlock(data: ProjectLine(id: 'x', name: 'פרויקט', last: 'משהו ישן', lastAt: DateTime(2026, 10, 13, 9)), now: _at),
          ProjectBlock(data: ProjectLine(id: 'y', name: 'עוד', last: 'משהו מאתמול', lastAt: DateTime(2026, 10, 19, 9)), now: _at),
        ]),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('13/10'), findsOneWidget);
    expect(find.text('אתמול'), findsOneWidget);
  });
}
