import '../model/task_progress.dart';
import 'backend.dart';

class SearchHit {
  const SearchHit({
    required this.kind,
    required this.id,
    required this.title,
    this.subtitle = '',
    this.identity,
    this.project,
    this.reportsTo,
    this.body = '',
    this.state,
    this.projectName,
    this.stage,
    this.outcome,
    this.waiting = false,
    this.role,
    this.leadName,
    this.leads = false,
    this.status,
    this.nowTask,
    this.openTasks,
    this.taskTitle,
  });
  final String kind, id, title, subtitle, body;
  final String? state;
  final String? identity, project, reportsTo;

  /// The project as he calls it; null when the hit has no project.
  final String? projectName;

  /// task: the stage hq knows now (null = unknown), `completed`/`cancelled`, and whether it waits on him.
  final TaskStage? stage;
  final String? outcome;
  final bool waiting;

  /// person: the role alone, the lead's name, hq's derived status and the task in hand.
  final String? role, leadName, status;

  /// person: others report to them, so "in X's team" would be wrong: they report to X.
  final bool leads;
  final ({int id, String title, TaskStage? stage})? nowTask;

  /// project: how many tasks are open.
  final int? openTasks;

  /// message: the task it belongs to.
  final String? taskTitle;

  static TaskStage? _stage(Object? s) => TaskStage.values.where((v) => v.name == s).firstOrNull;

  factory SearchHit.fromJson(Map<String, dynamic> j) {
    final now = j['now_task'] as Map<String, dynamic>?;
    return SearchHit(
      kind: j['kind'] as String,
      id: j['id'] as String,
      title: j['title'] as String,
      subtitle: j['subtitle'] as String? ?? '',
      identity: j['identity'] as String?,
      project: j['project'] as String?,
      reportsTo: j['reports_to'] as String?,
      body: j['body'] as String? ?? '',
      state: j['state'] as String?,
      projectName: j['project_name'] as String?,
      stage: _stage(j['stage']),
      outcome: j['outcome'] as String?,
      waiting: j['waiting'] == true,
      role: j['role'] as String?,
      leadName: j['lead_name'] as String?,
      leads: j['leads'] == true,
      status: j['status'] as String?,
      nowTask: now == null ? null : (id: (now['id'] as num).toInt(), title: now['title'] as String, stage: _stage(now['stage'])),
      openTasks: (j['open_tasks'] as num?)?.toInt(),
      taskTitle: j['task_title'] as String?,
    );
  }
}

List<SearchHit> searchLocal(CompanyData? d, String query) {
  if (d == null || query.trim().isEmpty) return [];
  final q = query.trim().toLowerCase();
  bool matches(String s) => s.toLowerCase().contains(q);
  String? projectName(String? team) => team == null ? null : d.teams[team]?.name;
  return [
    for (final who in d.identities.values)
      if (d.canChat(who.id) && matches('${who.name} ${d.roleLine(who.id)}'))
        SearchHit(
          kind: 'person',
          id: who.id,
          identity: who.id,
          title: who.name,
          subtitle: d.roleLine(who.id),
          role: who.title,
          projectName: d.teamOf(who.id)?.permanent == false ? null : d.teamOf(who.id)?.name,
          reportsTo: d.teamOf(who.id)?.leadId == who.id ? d.managerId : d.teamOf(who.id)?.leadId,
        ),
    for (final team in d.teams.values)
      if (matches(team.name)) SearchHit(kind: 'project', id: team.id, project: team.id, title: team.name, projectName: team.name),
    for (final t in d.openTasks)
      if (matches(t.title))
        SearchHit(kind: 'task', id: '${t.id}', title: t.title, identity: t.worker ?? t.openedBy, project: t.project, projectName: projectName(t.project), state: t.state.name),
    for (final m in d.recent)
      if (matches(m.text)) SearchHit(kind: 'message', id: m.id, title: m.text, identity: m.id),
  ];
}
