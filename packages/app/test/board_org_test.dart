// The board and the org tab read hq's tasks and org.yaml's projects (t19): every open task shows with
// its worker, state and project; closed task teams are gone from org; project teams list their workers.
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

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
    expect(ac.line, 'עדי · 5 משימות פתוחות');
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
}
