// #53: the layout (chats · status · projects · settings) on the real hq of 20/10/2026 19:59
// (test/fixtures/hq-1957, captured from /api/board, /api/inbox, /api/asks, /api/toggles,
// /api/messages?identity=owner and /api/accounts; no token inside, message bodies cut to one line), with
// the names this PR gives in org.yaml (project agent-company is "החברה"; titles without project ids).
// The approved mockup is docs/app/mockups/t53/; these goldens are the same screens as built.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:agent_company/ui/projects/projects_screen.dart';
import 'package:agent_company/ui/settings/settings_screen.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

const _dir = 'test/fixtures/hq-1957';
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

CompanyData _data({bool earlierWaiting = false}) {
  final board = _json('board');
  final d = mapSnapshot(
    board: (board['identities'] as List).cast<Map<String, dynamic>>(),
    inbox: earlierWaiting ? _list('inbox-earlier', 'items') : _list('inbox', 'items'),
    asks: _list('asks', 'asks'),
    toggles: _list('toggles', 'toggles'),
    tasks: (board['tasks'] as List).cast<Map<String, dynamic>>(),
    projects: (board['projects'] as List).cast<Map<String, dynamic>>(),
    now: _at,
  );
  _lastLines(d);
  return d;
}

Future<BuildContext> _pump(WidgetTester tester, {Size size = kPhone, bool earlierWaiting = false}) async {
  await loadFonts();
  Motion.frozen = true;
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  StatusScreen.clock = () => _at;
  addTearDown(() => StatusScreen.clock = DateTime.now);
  addTearDown(tester.view.reset);
  final store = AppStore(_Snapshot(_data(earlierWaiting: earlierWaiting)));
  await store.start();
  // His last visit to the status screen, for the mockup: 18:00 today.
  store.statusSeenAt = DateTime(2026, 10, 20, 18, 0);
  await tester.pumpWidget(CompanyApp(store: store, themeMode: ThemeMode.light));
  await tester.pump();
  return tester.element(find.byType(Scaffold).first);
}

Future<void> _shot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/layout/$name.png'));
}

const _tall = Size(342, 1500);

Iterable<String> _rows(WidgetTester tester) => [
      for (final w in tester.widgetList(find.byWidgetPredicate((w) => w is ConversationRow || w is WorkingRow)))
        w is ConversationRow ? w.c.identityId : (w as WorkingRow).c.identityId,
    ];

void main() {
  testWidgets('chats: Yoav pinned, who is at work (leads with their team\'s tasks), then the rest by latest', (tester) async {
    await _pump(tester, size: _tall);
    final rows = _rows(tester).toList();
    expect(rows.first, 'yoav');
    expect(find.text('מחכה לך (0)'), findsNothing, reason: 'nothing waits: no bar');
    // At work: Keren on her own task, Adi with the two tasks her team runs (Shani, Omer).
    final working = [for (final w in tester.widgetList<WorkingRow>(find.byType(WorkingRow))) w.c.identityId];
    expect(working, ['keren', 'adi']);
    expect(findShown('שני: לא נקרא, התראות על הודעות'), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is Ic && w.name == 'play_arrow'), findsNWidgets(3));
    // The rest, by latest, each once; task workers without an unread message are not here.
    expect(rows.sublist(3, 6), ['shachar', 'boaz', 'inbal']);
    expect(rows.toSet().length, rows.length);
    expect(rows.where((id) => id.startsWith('agent-company-t')), isEmpty);
    // Two lines a row: "פנוי" / "נח" under a name says nothing and is gone.
    expect(find.text('פנוי'), findsNothing);
    await _shot(tester, '01-chats');
  });

  testWidgets('chats: "מחכה לך (2)" on top; a tap shows only those conversations', (tester) async {
    await _pump(tester, earlierWaiting: true);
    expect(find.text('מחכה לך (2)'), findsOneWidget);
    expect(find.text('עדי, בועז'), findsOneWidget);
    await _shot(tester, '02-chats-waiting');
    await tester.tap(find.text('מחכה לך (2)'));
    await tester.pump();
    expect(_rows(tester).toList(), ['adi', 'boaz']);
    await tester.tap(find.text('כל השיחות'));
    await tester.pump();
    expect(_rows(tester).first, 'yoav');
  });

  testWidgets('status: what waits, what finished since the last visit, a line per project', (tester) async {
    final ctx = await _pump(tester, size: _tall, earlierWaiting: true);
    NavScope.read(ctx).go(AppTab.status);
    await tester.pump();
    expect(find.text('מ-18:00'), findsOneWidget);
    // Since 18:00: 14 finished with a worker on them (the one closed into another task has none, and is left out).
    expect(findShown('עוד 8 · בפרויקטים'), findsOneWidget);
    expect(findShown('עובדת קבועה חדשה, מיכל, תפעול עסקי'), findsOneWidget, reason: 'the title without "לומו בוט: "');
    expect(findShown('החברה · תומר · 19:56'), findsOneWidget, reason: 'the project by its name, never agent-company');
    expect(findShown('שקט, אין משימה שרצה'), findsNWidgets(3));
    expect(findShown('קרן: שעת איסוף'), findsOneWidget);
    await _shot(tester, '03-status');
  });

  testWidgets('status: a task\'s summary is its line, in his words', (tester) async {
    final ctx = await _pump(tester);
    final d = StoreScope.read(ctx).data!;
    final i = d.tickets.indexWhere((t) => t.number == 't51');
    final t = d.tickets[i];
    d.tickets[i] = Ticket(number: t.number, title: t.title, project: t.project, projectName: t.projectName, group: t.group, assignee: t.assignee,
        status: t.status, assigneeId: t.assigneeId, doneAt: t.doneAt, summary: 'מיכל בצוות של לומו בוט');
    StoreScope.read(ctx).touch();
    NavScope.read(ctx).go(AppTab.status);
    await tester.pump();
    expect(findShown('מיכל בצוות של לומו בוט'), findsOneWidget);
    expect(findShown('עובדת קבועה חדשה'), findsNothing);
  });

  testWidgets('projects: by his names, each with its lead and open tasks; then the standing teams', (tester) async {
    final ctx = await _pump(tester, size: _tall);
    NavScope.read(ctx).go(AppTab.projects);
    await tester.pump();
    for (final name in ['החברה', 'האפליקציה לומו', 'לומו בוט', 'טיקי בוט', 'הבוט הקולי', 'צוותים קבועים']) {
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
    Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => const ProjectScreen(projectId: 'voice-bot')));
    await _shot(tester, '06-project-voice-bot');
    expect(findShown('שעת איסוף "לא ידוע" לא נאמרת ללקוח'), findsNWidgets(2), reason: 'under Keren, and as the open task');
  });

  testWidgets('settings: automations, accounts, devices', (tester) async {
    final ctx = await _pump(tester, size: const Size(342, 900));
    NavScope.read(ctx).go(AppTab.settings);
    await tester.pumpAndSettle();
    expect(findShown('9 פועלות · מתוך 18'), findsOneWidget);
    expect(find.text('החשבון הראשי'), findsOneWidget);
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
    d.tickets.add(Ticket(number: 't99', title: 'עוזר: השוואת ביטוחים', project: '', projectName: '', group: TicketGroup.working, assignee: d.who('agent-company-t14').name,
        status: WorkerStatus.working, assigneeId: 'agent-company-t14', openedBy: 'eli'));
    store.touch();
    await tester.pump();
    expect([for (final w in tester.widgetList<WorkingRow>(find.byType(WorkingRow))) w.c.identityId], contains('eli'));
    expect(findShown('${d.who('agent-company-t14').name}: השוואת ביטוחים'), findsOneWidget);
  });
}
