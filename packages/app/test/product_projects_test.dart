// The projects he goes in by (app-gap §1, §9): on the real board every task worker has a team of its own named
// after its host ("החברה" sixteen times). The directory, the chips and the faces read org.yaml's projects instead.
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/l10n/app_localizations_he.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/product/shell.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> _id(String id, String name, String team, String kind, String lifecycle, String status, {String? project, String? reportsTo, String? tone}) =>
    {'id': id, 'name': name, 'title': '', 'symbol': '', 'team': team, 'team_kind': kind, 'project': project, 'lifecycle': lifecycle, 'status': status, 'shift': null, 'reports_to': reportsTo, 'tone': tone};

void main() {
  final board = [
    _id('yoav', 'יואב', 'management', 'permanent', 'resident', 'free'),
    _id('eli', 'אלי', 'personal', 'permanent', 'lead', 'resting'),
    _id('adi', 'עדי', 'agent-company', 'project', 'lead', 'resting', project: 'agent-company'),
    _id('dana', 'דנה', 'lumo', 'project', 'lead', 'working', project: 'lumo'),
    for (var i = 1; i <= 16; i++) _id('agent-company-t$i', 'עובד $i', 'agent-company-t$i', 'task', 'ephemeral', i == 1 ? 'working' : 'done', project: 'agent-company'),
    _id('lumo-t40', 'קרן', 'lumo-t40', 'task', 'ephemeral', 'working', project: 'lumo'),
    // An errand with no project, opened by a task worker of lumo: it works for lumo.
    _id('lumo-t41', 'גל', 'lumo-t41', 'task', 'ephemeral', 'working', reportsTo: 'lumo-t40'),
    // An errand of the personal team: no project.
    _id('personal-t9', 'נועם', 'personal-t9', 'task', 'ephemeral', 'working', reportsTo: 'eli'),
    // A worker of a dormant project: in no active project and in no standing team.
    _id('rates-bot', 'רז', 'rates-bot', 'project', 'lead', 'resting', project: 'rates-bot'),
  ];
  final projects = [
    {'id': 'agent-company', 'name': 'החברה', 'status': 'active', 'team': 'agent-company'},
    {'id': 'lumo', 'name': 'האפליקציה לומו', 'status': 'active', 'team': 'lumo'},
    {'id': 'voice-bot', 'name': 'הבוט הקולי', 'status': 'active', 'team': 'voice-bot'},
    {'id': 'rates-bot', 'name': 'בוט המחירים', 'status': 'dormant', 'team': null},
  ];
  final d = mapSnapshot(board: board, inbox: const [], asks: const [], toggles: const [], tasks: const [], projects: projects, now: DateTime(2026, 11, 7, 12));

  test('the projects are org.yaml\'s active ones, once each, by his names', () {
    expect([for (final p in d.activeProjects) p.name], ['החברה', 'האפליקציה לומו', 'הבוט הקולי']);
    expect(d.teams.length, greaterThan(16), reason: 'the task teams are still there; the directory does not read them');
  });

  test('every worker belongs to its project; a standing team to none', () {
    expect(d.projectOf('agent-company-t7'), 'agent-company');
    expect(d.projectOf('adi'), 'agent-company');
    expect(d.projectOf('lumo-t40'), 'lumo');
    expect(d.projectOf('lumo-t41'), 'lumo', reason: 'an errand takes its host\'s project');
    expect(d.projectOf('yoav'), isNull);
    expect(d.projectOf('personal-t9'), isNull);
  });

  test('each project has its own hue on its workers\' faces; neighbours never share one', () {
    expect(d.toneOf('agent-company-t3'), d.projectTone('agent-company'));
    expect(d.projectTone('agent-company'), isNot(d.projectTone('lumo')));
    expect(d.projectTone('lumo'), isNot(d.projectTone('voice-bot')));
    expect(d.toneOf('yoav'), isNull, reason: 'a standing team without a tone stays slate');
  });

  test('projectName reads his name for an id', () {
    expect(d.projectName('lumo'), 'האפליקציה לומו');
    expect(d.projectName('nope'), 'nope');
  });

  test('the team tab has everyone, once: an errand under the team it came from, a dormant project by its own name', () {
    final groups = ProductDirectory.teamGroups(d, standingTeams(d));
    final everyone = [for (final g in groups) for (final who in g.$2) who.id];
    final chattable = [for (final who in d.identities.values) if (d.canChat(who.id)) who.id];
    expect(everyone.toSet(), chattable.toSet());
    expect(everyone.length, everyone.toSet().length, reason: 'nobody twice');
    final personal = groups.firstWhere((g) => g.$2.any((who) => who.id == 'eli'));
    expect([for (final who in personal.$2) who.id], contains('personal-t9'));
    expect(groups.firstWhere((g) => g.$2.any((who) => who.id == 'rates-bot')).$1, 'בוט המחירים');
  });

  test('under a project in the sidebar: its lead first, then who is busy', () {
    expect(projectPeople(d, 'lumo', max: 4), ['dana', 'lumo-t40', 'lumo-t41']);
    expect(projectPeople(d, 'agent-company', max: 4), ['adi', 'agent-company-t1'], reason: 'the done task workers are not listed');
  });

  test('nine project tones, all different, in org.yaml order', () {
    expect(CompanyData.kProjectTones.toSet().length, 9);
    expect([for (final p in d.activeProjects) d.projectTone(p.id)], ['teal', 'blue', 'clay']);
  });

  test('a lead is named in its own gender, as in the mockup ("מירה, ראשת צוות")', () {
    final he = AppLocalizationsHe();
    expect(he.teamLead('f'), 'ראשת צוות');
    expect(he.teamLead('m'), 'ראש צוות');
    expect(he.projectLead('f', 'דנה'), 'ראשת צוות: דנה');
  });

  test('with no gender on the board, the title tells it', () {
    expect(titleGender('ראשת צוות פינטו'), Gender.f);
    expect(titleGender('מנכ"לית החברה'), Gender.f);
    expect(titleGender('מפתחת'), Gender.f);
    expect(titleGender('ראש צוות הניטור'), Gender.m);
    expect(titleGender('מפתח'), Gender.m);
    expect(titleGender('מנהל החברה'), Gender.m);
    expect(titleGender(''), Gender.m);
  });
}
