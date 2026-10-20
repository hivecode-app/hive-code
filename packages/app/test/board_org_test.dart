// The board and the org tab read hq's tasks and org.yaml's projects (t19): every open task shows with
// its worker, state and project; closed task teams are gone from org; project teams list their workers.
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/org/org_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'hq_snapshot_test.dart' show SnapshotBackend;
import 'helpers.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/ui/common.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> _id(String id, String name, String team, String kind, String lifecycle, String status, {String? project, String title = ''}) =>
    {'id': id, 'name': name, 'title': title, 'symbol': '', 'team': team, 'team_kind': kind, 'project': project, 'lifecycle': lifecycle, 'status': status, 'shift': null};

void main() {
  final now = DateTime(2026, 10, 20, 15, 0);
  int ms(int h, int m) => DateTime(2026, 10, 20, h, m).millisecondsSinceEpoch;
  final board = [
    _id('yoav', 'יואב', 'management', 'permanent', 'resident', 'free', title: 'מנהל החברה'),
    _id('rotem', 'רותם', 'monitoring', 'permanent', 'lead', 'resting'),
    _id('adi', 'עדי', 'agent-company', 'project', 'lead', 'resting', project: 'agent-company', title: 'מנכ"לית'),
    _id('ac-t1', 'איתי', 'ac-t1', 'task', 'ephemeral', 'done', project: 'agent-company'),
    _id('ac-t16', 'רעות', 'ac-t16', 'task', 'ephemeral', 'working', project: 'agent-company', title: 'מפתחת'),
    _id('ac-t17', 'אלון', 'ac-t17', 'task', 'ephemeral', 'waiting_for_you', project: 'agent-company'),
    _id('ac-t18', 'שקד', 'ac-t18', 'task', 'ephemeral', 'stuck', project: 'agent-company'),
    _id('ac-t23', 'גל', 'ac-t23', 'task', 'ephemeral', 'resting', project: 'agent-company'),
    _id('ac-t24', 'טל', 'ac-t24', 'task', 'ephemeral', 'waiting_for_you', project: 'agent-company'),
  ];
  Map<String, dynamic> task(int id, String title, String state, String? who, int updated, {int? started}) =>
      {'id': id, 'title': title, 'project': 'agent-company', 'state': state, 'identity': who, 'updated_at': updated, 'started_at': started};
  final tasks = [
    task(16, 'העברת לומו לחברה', 'running', 'ac-t16', ms(14, 0), started: ms(11, 54)),
    task(17, 'עובדים של פרויקט אחר', 'running', 'ac-t17', ms(14, 0)),
    task(18, 'צירוף תמונות', 'running', 'ac-t18', ms(14, 0)),
    task(20, 'משימה בתור', 'queued', null, ms(14, 0)),
    task(21, 'issue שחיכה ללילה', 'night_wait', null, ms(14, 0)),
    task(22, 'issue שנסגר ב-GitHub', 'closed', null, ms(14, 0)),
    task(23, 'משימה שנקטעה', 'interrupted', 'ac-t23', ms(14, 0)),
    task(24, 'שאלה פתוחה לרן', 'resting', 'ac-t24', ms(14, 0)),
    task(15, 'הושלמה היום', 'done', 'ac-t1', ms(9, 0)),
    task(1, 'הושלמה אתמול', 'done', 'ac-t1', DateTime(2026, 10, 19, 22).millisecondsSinceEpoch),
  ];
  final projects = [
    {'id': 'agent-company', 'name': null, 'status': 'active', 'team': 'agent-company'},
    {'id': 'lumo', 'status': 'dormant', 'team': null},
  ];
  final d = mapSnapshot(board: board, inbox: const [], asks: const [], toggles: const [], tasks: tasks, projects: projects, now: now);

  test('every open task is a board row with its worker, state and project; done today folds in, older done does not', () {
    final by = {for (final t in d.tickets) t.number: t};
    expect(by.keys.toSet(), {'t16', 't17', 't18', 't20', 't21', 't23', 't24', 't15'});
    expect(by['t16']!.assignee, 'רעות');
    expect(by['t16']!.sub, 'מפתחת');
    expect(by['t16']!.project, 'agent-company');
    expect(by['t16']!.status, WorkerStatus.working);
    expect(by['t16']!.group, TicketGroup.working);
    expect(by['t16']!.endLine, 'התחיל 11:54');
    expect(by['t17']!.group, TicketGroup.waiting);
    // Released by the watchdog while its question to the owner is open: still "מחכה לך", not queued.
    expect(by['t24']!.group, TicketGroup.waiting);
    expect(by['t24']!.status, WorkerStatus.waiting);
    expect(by['t18']!.group, TicketGroup.attention);
    for (final n in ['t20', 't21', 't23']) {
      expect(by[n]!.group, TicketGroup.queued, reason: n);
    }
    expect(by['t15']!.group, TicketGroup.doneToday);
    expect(d.boardSubtitle, 'כל החברה · 7 משימות פתוחות · אחת הושלמה היום');
  });

  test('projects come from hq (org.yaml + charter status), not from the code', () {
    expect([for (final p in d.projects) (p.id, p.active)], [('agent-company', true), ('lumo', false)]);
  });

  test('org: permanent teams, then the project team with its lead and the workers on open tasks; no task teams', () {
    expect([for (final t in d.orgTeams) t.teamId], ['management', 'monitoring', 'agent-company']);
    final ac = d.orgTeams.last;
    // The interrupted task's worker rests, but its task team is still open, so it stays.
    expect([for (final m in ac.members) m.identityId], ['adi', 'ac-t16', 'ac-t17', 'ac-t18', 'ac-t23', 'ac-t24']);
    expect(ac.members[1].line, 'העברת לומו לחברה');
    // Everyone on the team (the lead and 5 workers), and every open task of the project (7, two of them queued).
    expect(ac.line, 'עדי · 6 עובדים · 7 משימות פתוחות');
    // The closed task's worker is not counted: 5 working, waiting or free (yoav, t16, t17, t18, t24), 3 resting.
    expect(d.orgSubtitle, '5 עובדים פעילים · 3 נחים');
  });

  test('a project and its team show the owner\'s name from org.yaml; an older hq without names keeps the ids', () {
    final named = mapSnapshot(
      board: [...board, _id('boaz', 'בועז', 'lumo-bot', 'project', 'lead', 'resting', project: 'lumo-bot')],
      inbox: const [], asks: const [], toggles: const [],
      tasks: [{'id': 30, 'title': 'משימה', 'project': 'lumo-bot', 'state': 'queued', 'identity': null, 'updated_at': ms(14, 0)}],
      projects: [{'id': 'lumo-bot', 'name': 'לומו בוט', 'status': 'active', 'team': 'lumo-bot'}],
      now: now,
    );
    expect(named.projects.single.name, 'לומו בוט');
    expect(named.tickets.single.projectName, 'לומו בוט');
    expect(named.teams['lumo-bot']!.name, 'לומו בוט');
    expect(d.projects.last.name, 'lumo');
    expect(d.teams['agent-company']!.name, 'החברה', reason: 'no name in org.yaml: the built-in one');
  });

  test('#40: every worker shows its team; a task worker shows its project by name, never its task id', () {
    Map<String, dynamic> w(String id, String name, String team, String kind, String life, {String? project, String? opener, String title = ''}) =>
        {..._id(id, name, team, kind, life, 'resting', project: project, title: title), 'reports_to': opener};
    final m = mapSnapshot(
      board: [
        ...board,
        w('eli', 'אלי', 'personal', 'permanent', 'lead', title: 'ראש הצוות האישי'),
        w('inbal', 'ענבל', 'tiki-bot-go', 'project', 'lead', project: 'tiki-bot-go', title: 'ראשת צוות'),
        w('voice-bot-t38', 'אורית', 'voice-bot-t38', 'task', 'ephemeral', project: 'voice-bot', opener: 'shachar', title: 'מפתחת'),
        w('tiki-bot-go-t50', 'ברק', 'tiki-bot-go-t50', 'task', 'ephemeral', project: 'tiki-bot-go', opener: 'inbal', title: 'מפתח'),
        w('company-t60', 'שני', 'company-t60', 'task', 'ephemeral', opener: 'eli', title: 'עוזרת אישית'),
        w('company-t61', 'דביר', 'company-t61', 'task', 'ephemeral', opener: 'company-t60', title: 'עוזר אישי'),
      ],
      inbox: const [], asks: const [], toggles: const [], tasks: tasks,
      projects: [
        ...projects,
        {'id': 'voice-bot', 'name': null, 'status': 'active', 'team': 'voice-bot'},
        {'id': 'tiki-bot-go', 'name': 'טיקי בוט', 'status': 'active', 'team': 'tiki-bot-go'},
      ],
      now: now,
    );
    String plain(String s) => s.replaceAll(RegExp('[\u2066-\u2069]'), '');
    expect(plain(m.roleLine('voice-bot-t38')), 'מפתחת · voice-bot', reason: 'no name in org.yaml: the id');
    expect(m.roleLine('tiki-bot-go-t50'), 'מפתח · טיקי בוט');
    expect(m.roleLine('ac-t16'), 'מפתחת · החברה');
    expect(m.roleLine('company-t60'), 'עוזרת אישית · הצוות האישי', reason: 'an errand shows the team that opened it');
    expect(m.roleLine('company-t61'), 'עוזר אישי · הצוות האישי', reason: 'opened by a task worker: its team, not its task id');
    expect(m.roleLine('yoav'), 'מנהל החברה · הנהלה');
    expect(m.roleLine('inbal'), 'ראשת צוות · טיקי בוט');
    expect(m.teamOf('tiki-bot-go-t50')!.symbol, m.teams['tiki-bot-go']!.symbol, reason: 'the badge is the project team\'s');
    // The org tab, the board and the chips: the owner's name for the project (#77), the id only without one.
    expect(m.teams['tiki-bot-go']!.name, 'טיקי בוט');
    expect(m.projects.firstWhere((p) => p.id == 'tiki-bot-go').name, 'טיקי בוט');
    expect(m.projects.firstWhere((p) => p.id == 'voice-bot').name, 'voice-bot');
  });

  test('an hq without tasks or projects still maps (older hq, older cached snapshot)', () {
    final old = mapSnapshot(board: board, inbox: const [], asks: const [], toggles: const []);
    expect(old.tickets, isEmpty);
    expect(old.projects, isEmpty);
    expect(old.orgTeams.map((t) => t.teamId), isNot(contains('ac-t16')));
  });

  test('a standing worker shows the task it is on and how many wait for it', () {
    final gal = {
      ..._id('ido', 'עידו', 'lumo', 'project', 'dormant', 'working', project: 'lumo', title: 'אחראי שרת'),
      'task': {'id': 30, 'ref': null, 'title': 'משימה ישנה', 'state': 'done'},
      'current_task': {'id': 31, 'ref': null, 'title': 'שדרוג השרת', 'state': 'running'},
      'queued': 2,
    };
    final m = mapSnapshot(board: [...board, gal], inbox: const [], asks: const [], toggles: const []);
    final pr = m.presence['ido']!;
    expect(pr.currentTask, 'שדרוג השרת');
    expect(pr.activity, 'שדרוג השרת', reason: 'the current task, not the last one');
    expect(pr.queued, 2);
    expect(memberLine('אחראי שרת', pr), 'אחראי שרת · משימה: שדרוג השרת');
    final idle = mapSnapshot(board: board, inbox: const [], asks: const [], toggles: const []).presence['adi']!;
    expect(idle.currentTask, isNull);
    expect(idle.queued, 0, reason: 'an older hq without the fields');
    expect(memberLine('מנכ"לית', idle), 'מנכ"לית');
  });

  group('#t48: a project team lists its lead and standing workers, then task workers, under the project\'s name', () {
    Map<String, dynamic> w(String id, String name, String team, String kind, String life, String status, {String title = '', Map<String, dynamic>? current, int queued = 0}) =>
        {..._id(id, name, team, kind, life, status, project: 'voice-bot', title: title), 'reports_to': 'shachar', 'current_task': current, 'queued': queued};
    final voice = mapSnapshot(
      board: [
        ...board,
        w('shachar', 'שחר', 'voice-bot', 'project', 'lead', 'free', title: 'ראש צוות'),
        {...w('keren', 'קרן', 'voice-bot', 'project', 'dormant', 'working', title: 'אחראית קול', current: {'id': 47, 'ref': null, 'title': 'השהיה בשיחה', 'state': 'running'}, queued: 1), 'gender': 'f'},
        w('nir', 'ניר', 'voice-bot', 'project', 'dormant', 'resting', title: 'אחראי בדיקות'),
        w('voice-bot-t50', 'אורית', 'voice-bot-t50', 'task', 'ephemeral', 'working', title: 'מפתחת', current: {'id': 50, 'ref': null, 'title': 'תיקון הקלטה', 'state': 'running'}),
      ],
      inbox: const [], asks: const [], toggles: const [],
      tasks: [
        ...tasks,
        {'id': 47, 'title': 'השהיה בשיחה', 'project': 'voice-bot', 'state': 'running', 'identity': 'keren', 'updated_at': ms(14, 0)},
        {'id': 48, 'title': 'הבא בתור של קרן', 'project': 'voice-bot', 'state': 'queued', 'identity': 'keren', 'updated_at': ms(14, 0)},
        {'id': 50, 'title': 'תיקון הקלטה', 'project': 'voice-bot', 'state': 'running', 'identity': 'voice-bot-t50', 'updated_at': ms(14, 0)},
      ],
      // The project has a name in org.yaml; the team row does not (hq's /api/org gave name: null).
      projects: [...projects, {'id': 'voice-bot', 'name': 'הבוט הקולי', 'status': 'active', 'team': null}],
      now: now,
    );

    test('members, lines and the summary', () {
      final t = voice.orgTeams.firstWhere((t) => t.teamId == 'voice-bot');
      expect(voice.teams['voice-bot']!.name, 'הבוט הקולי', reason: 'the project\'s name, never its id');
      expect([for (final m in t.members) m.identityId], ['shachar', 'keren', 'nir', 'voice-bot-t50']);
      expect([for (final m in t.members) memberLine(m.line, voice.presence[m.identityId]!)],
          ['ראש צוות', 'אחראית קול · משימה: השהיה בשיחה', 'אחראי בדיקות', 'תיקון הקלטה']);
      expect(voice.presence['keren']!.status, WorkerStatus.working);
      expect(voice.presence['keren']!.queued, 1);
      expect(voice.presence['nir']!.status, WorkerStatus.resting);
      expect(t.line, 'שחר · 4 עובדים · 3 משימות פתוחות');
    });

    testWidgets('the org tab shows them with their state in a word', (tester) async {
      await loadFonts();
      Motion.frozen = true;
      SharedPreferences.setMockInitialValues({});
      tester.view.physicalSize = const Size(342, 1400) * 2;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final store = AppStore(SnapshotBackend(voice));
      await store.start();
      await tester.pumpWidget(CompanyApp(store: store, themeMode: ThemeMode.light, home: const Scaffold(body: OrgScreen())));
      await tester.pump();
      expect(find.text('הבוט הקולי'), findsOneWidget);
      expect(find.text('voice-bot'), findsNothing);
      expect(findShown('שחר · 4 עובדים · 3 משימות פתוחות'), findsOneWidget);
      // Someone besides the lead is at work: the team starts open.
      expect(find.text('קרן'), findsOneWidget);
      expect(find.text('ניר'), findsOneWidget);
      expect(find.text('אורית'), findsOneWidget);
      expect(findShown('אחראית קול · משימה: השהיה בשיחה'), findsOneWidget);
      // The state in a word, next to its icon: Keren works with one waiting, Nir rests.
      final states = {for (final w in tester.widgetList<StatusWord>(find.byType(StatusWord))) (w.icon, w.word)};
      expect(states, containsAll([(statusIcon(WorkerStatus.working), '${statusWord(WorkerStatus.working, Gender.f)} · 1 בתור'), (statusIcon(WorkerStatus.resting), statusWord(WorkerStatus.resting, Gender.m))]));
    });
  });
}
