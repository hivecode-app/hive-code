/// Product progress uses stable keys, independently of translated labels or worker presence.
enum TaskStage { proposal, development, review, approval, released }

List<Map<String, dynamic>> taskRows(dynamic value) => value is List
    ? [for (final x in value) Map<String, dynamic>.from(x as Map)]
    : [];

class TaskRequest {
  const TaskRequest({
    required this.id,
    required this.kind,
    required this.title,
    this.askedBy,
    this.task,
    this.ref,
  });
  final int id;
  final String kind, title;
  final String? askedBy, ref;
  final int? task;
  factory TaskRequest.fromJson(Map<String, dynamic> j) => TaskRequest(
    id: j['id'] as int,
    kind: j['kind'] as String,
    title: j['title'] as String,
    askedBy: j['asked_by'] as String?,
    task: j['task'] as int?,
    ref: j['ref'] as String?,
  );
}

class TaskPr {
  const TaskPr({
    required this.url,
    this.review = 'pending',
    this.ci = 'unknown',
    this.quote,
    this.stale = false,
    this.state = 'OPEN',
    this.merged = false,
  });
  final String url, review, ci, state;
  final String? quote;
  final bool stale, merged;

  /// Still open on GitHub (not merged, not closed). Unread evidence counts as open: nothing is invented.
  bool get open => !merged && (state == 'OPEN' || state.isEmpty);
  String get number => url.split('/').last;
  factory TaskPr.fromJson(Map<String, dynamic> j) => TaskPr(
    url: j['url'] as String,
    review: j['review'] as String? ?? 'pending',
    ci: j['ci'] as String? ?? 'unknown',
    quote: j['quote'] as String?,
    stale: j['error'] == true || j['checked_at'] == 0,
    state: j['state'] as String? ?? '',
    merged: j['merged'] == true,
  );
}

DateTime? _ms(dynamic v) => v is int ? DateTime.fromMillisecondsSinceEpoch(v) : null;

class TaskProgress {
  const TaskProgress({
    required this.id,
    required this.title,
    this.body = '',
    this.project,
    this.worker,
    this.openedBy,
    this.stage,
    this.state = '',
    this.outcome,
    this.summary,
    this.workerStatus,
    this.awaiting,
    this.requests = const [],
    this.prs = const [],
    this.about,
    this.createdAt,
    this.startedAt,
    this.updatedAt,
  });
  final int id;
  final String title, body, state;
  final String? project,
      worker,
      openedBy,
      outcome,
      summary,
      workerStatus,
      awaiting;

  /// What the task changes for him, in his words (open_team `about`); null on tasks opened without one.
  final String? about;
  final DateTime? createdAt, startedAt, updatedAt;
  final TaskStage? stage;
  final List<TaskRequest> requests;
  final List<TaskPr> prs;
  bool get canStart => state == 'proposal';
  factory TaskProgress.fromJson(Map<String, dynamic> j) => TaskProgress(
    id: j['id'] as int,
    title: j['title'] as String,
    body: j['body'] as String? ?? '',
    project: j['project'] as String?,
    worker: j['worker'] as String?,
    openedBy: j['opened_by'] as String?,
    state: j['state'] as String? ?? '',
    stage: TaskStage.values.where((s) => s.name == j['stage']).firstOrNull,
    outcome: j['outcome'] as String?,
    summary: j['summary'] as String?,
    workerStatus: j['worker_status'] as String?,
    awaiting: j['awaiting'] as String?,
    requests: taskRows(j['requests']).map(TaskRequest.fromJson).toList(),
    prs: taskRows(j['prs']).map(TaskPr.fromJson).toList(),
    about: j['about'] as String?,
    createdAt: _ms(j['created_at']),
    startedAt: _ms(j['started_at']),
    updatedAt: _ms(j['updated_at']),
  );
}

class OrgPerson {
  const OrgPerson({
    required this.id,
    required this.name,
    required this.title,
    this.manager,
    this.project,
    this.active = true,
    this.tasks = const [],
  });
  final String id, name, title;
  final String? manager, project;
  final bool active;
  final List<({int id, String title, String state})> tasks;
  factory OrgPerson.fromJson(Map<String, dynamic> j) => OrgPerson(
    id: j['id'] as String,
    name: j['name'] as String,
    title: j['title'] as String,
    manager: j['reports_to'] as String?,
    project: j['project'] as String?,
    active: j['active'] != 0,
    tasks: [
      for (final t in taskRows(j['tasks']))
        (
          id: t['id'] as int,
          title: t['title'] as String,
          state: t['state'] as String,
        ),
    ],
  );
}

class TaskActivity {
  const TaskActivity({
    this.messages = const [],
    this.files = const [],
    this.events = const [],
  });
  final List<Map<String, dynamic>> messages, files, events;
  factory TaskActivity.fromJson(Map<String, dynamic> j) => TaskActivity(
    messages: taskRows(j['messages']),
    files: taskRows(j['files']),
    events: taskRows(j['events']),
  );
}
