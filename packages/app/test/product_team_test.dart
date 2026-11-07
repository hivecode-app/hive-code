// The team tab (app-gap §2, mockup a-he-team): only who is in the team now, the lead first, a summary line, and
// who finished today folded at the end. On the real board 16 done task workers of "החברה" filled the tab.
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/l10n/app_localizations_he.dart';
import 'package:agent_company/ui/product/team.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _id(String id, String name, String team, String kind, String lifecycle, String status, {String? project, String? reportsTo, String title = ''}) =>
    {'id': id, 'name': name, 'title': title, 'symbol': '', 'team': team, 'team_kind': kind, 'project': project, 'lifecycle': lifecycle, 'status': status, 'shift': null, 'reports_to': reportsTo, 'tone': null};

void main() {
  final now = DateTime(2026, 11, 7, 12);
  final board = [
    _id('yoav', 'יואב', 'management', 'permanent', 'resident', 'free'),
    _id('eli', 'אלי', 'personal', 'permanent', 'lead', 'resting'),
    _id('personal-t9', 'נועם', 'personal-t9', 'task', 'ephemeral', 'working', reportsTo: 'eli'),
    _id('adi', 'עדי', 'agent-company', 'project', 'lead', 'resting', project: 'agent-company', title: 'מנכ"לית'),
    for (var i = 1; i <= 16; i++) _id('agent-company-t$i', 'עובד $i', 'agent-company-t$i', 'task', 'ephemeral', i == 1 ? 'working' : 'done', project: 'agent-company'),
    _id('agent-company-t20', 'מאיה', 'agent-company-t20', 'task', 'ephemeral', 'waiting_for_you', project: 'agent-company'),
    _id('dana', 'דנה', 'lumo', 'project', 'lead', 'working', project: 'lumo'),
    // Resting after its task closed: gone. Resting while its task is still open (waits for a reply): in the team.
    _id('lumo-t30', 'רון', 'lumo-t30', 'task', 'ephemeral', 'resting', project: 'lumo'),
    _id('lumo-t31', 'טל', 'lumo-t31', 'task', 'ephemeral', 'resting', project: 'lumo'),
  ];
  final projects = [
    {'id': 'agent-company', 'name': 'החברה', 'status': 'active', 'team': 'agent-company'},
    {'id': 'lumo', 'name': 'האפליקציה לומו', 'status': 'active', 'team': 'lumo'},
  ];
  final tasks = [
    {'id': 2, 'title': 'p1: תיקון הסרגל', 'state': 'done', 'identity': 'agent-company-t2', 'project': 'agent-company', 'updated_at': DateTime(2026, 11, 7, 10).millisecondsSinceEpoch},
    {'id': 3, 'title': 'ישנה', 'state': 'done', 'identity': 'agent-company-t3', 'project': 'agent-company', 'updated_at': DateTime(2026, 11, 5, 10).millisecondsSinceEpoch},
    {'id': 31, 'title': 'מסך התשלום', 'state': 'resting', 'identity': 'lumo-t31', 'project': 'lumo', 'updated_at': DateTime(2026, 11, 7, 11).millisecondsSinceEpoch},
  ];
  final d = mapSnapshot(board: board, inbox: const [], asks: const [], toggles: const [], tasks: tasks, projects: projects, now: now);

  test('only who is in the team now: a task worker whose task is done is gone', () {
    final groups = ProductTeam.groups(d);
    final ids = [for (final g in groups) for (final who in g.$2) who.id];
    expect(ids, isNot(contains('agent-company-t2')));
    expect(ids, containsAll(['adi', 'agent-company-t1', 'agent-company-t20', 'dana', 'yoav', 'eli', 'personal-t9']));
    expect([for (final g in groups) g.$1].take(2), ['החברה', 'האפליקציה לומו']);
  });

  test('the lead first, then who waits on him, then who works', () {
    final company = ProductTeam.groups(d).first.$2.map((who) => who.id).toList();
    expect(company, ['adi', 'agent-company-t20', 'agent-company-t1']);
  });

  test('the summary counts only the states someone is in', () {
    final shown = [for (final g in ProductTeam.groups(d)) ...g.$2];
    expect(ProductTeam.summary(AppLocalizationsHe(), d, shown), '1 מחכה לך · 3 בעבודה · 1 פנוי · 3 במנוחה');
  });

  test('who finished today is folded with the task it finished; earlier days are not', () {
    final finished = ProductTeam.finishedToday(d, now);
    expect(finished.keys, ['agent-company-t2']);
    expect(finished['agent-company-t2']!.title, 'p1: תיקון הסרגל');
  });

  test('a task worker is in the team while its task is open, not after', () {
    final ids = [for (final g in ProductTeam.groups(d)) for (final who in g.$2) who.id];
    expect(ids, contains('lumo-t31'));
    expect(ids, isNot(contains('lumo-t30')));
  });

  test('the summary counts in the plural', () {
    final many = mapSnapshot(
      board: [
        _id('yoav', 'יואב', 'management', 'permanent', 'resident', 'free'),
        _id('eli', 'אלי', 'personal', 'permanent', 'lead', 'free'),
        _id('adi', 'עדי', 'agent-company', 'project', 'lead', 'waiting_for_you', project: 'agent-company'),
        _id('dana', 'דנה', 'lumo', 'project', 'lead', 'waiting_for_you', project: 'lumo'),
      ],
      inbox: const [], asks: const [], toggles: const [], tasks: const [], projects: projects, now: now,
    );
    final shown = [for (final g in ProductTeam.groups(many)) ...g.$2];
    expect(ProductTeam.summary(AppLocalizationsHe(), many, shown), '2 מחכים לך · 2 פנויים');
  });
}
