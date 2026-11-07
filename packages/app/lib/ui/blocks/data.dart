// The data each home block shows. Every block takes only its own object: built from what the app already has
// ([of]), or handed over by the recipe hq composes ([fromJson]; times are epoch milliseconds).
import '../../data/backend.dart';
import '../../model/company_time.dart';
import '../../model/models.dart';

DateTime _ms(Object? v) => DateTime.fromMillisecondsSinceEpoch((v as num).toInt());
DateTime? _msOrNull(Object? v) => v is num ? _ms(v) : null;
List<Map<String, dynamic>> _maps(Object? v) => v is List ? v.whereType<Map>().map((m) => m.cast<String, dynamic>()).toList() : const [];

/// The project a worker belongs to now: the project of the open task he is on, else his team's project.
String? projectOf(CompanyData d, String identityId) {
  for (final t in d.tickets) {
    if (t.doneAt == null && t.assigneeId == identityId && t.project.isNotEmpty) return t.project;
  }
  final team = d.identities[identityId]?.teamId;
  if (team == null) return null;
  for (final p in _projects(d)) {
    if (p.teamId == team || p.id == team) return p.id;
  }
  return null;
}

/// org.yaml's projects; from the tickets when hq gave none.
List<ProjectInfo> _projects(CompanyData d) {
  if (d.projects.isNotEmpty) return d.projects;
  final seen = <String>{};
  return [
    for (final t in d.tickets)
      if (t.project.isNotEmpty && seen.add(t.project)) ProjectInfo(id: t.project, name: t.projectName, active: true),
  ];
}

String _symbolOf(CompanyData d, ProjectInfo p) => d.teams[p.teamId ?? p.id]?.symbol ?? 'folder';

bool _open(WaitItem w) => w.state == WaitState.open || w.state == WaitState.pending;

/// Open projects first (something running or queued), then by their latest activity.
List<ProjectInfo> projectsByActivity(CompanyData d) {
  DateTime last(String id) {
    var at = DateTime(0);
    for (final t in d.tickets) {
      if (t.project != id) continue;
      for (final x in [t.doneAt, t.startedAt]) {
        if (x != null && x.isAfter(at)) at = x;
      }
    }
    return at;
  }

  bool open(String id) => d.tickets.any((t) => t.project == id && t.doneAt == null);
  final list = [..._projects(d)];
  list.sort((a, b) {
    final o = (open(b.id) ? 1 : 0) - (open(a.id) ? 1 : 0);
    return o != 0 ? o : last(b.id).compareTo(last(a.id));
  });
  return list;
}

// ───────────────────────── lanes ─────────────────────────

/// A task that finished: a filled mark at [at].
class LaneDone {
  const LaneDone({required this.at, required this.text, this.who, this.opener});
  final DateTime at;
  final String text;
  final String? who;

  /// Who opened the task: where it leads once a task worker finished it.
  final String? opener;
  factory LaneDone.fromJson(Map<String, dynamic> j) =>
      LaneDone(at: _ms(j['at']), text: j['text'] as String? ?? '', who: j['who'] as String?, opener: j['opener'] as String?);
  Map<String, dynamic> toJson() => {'at': at.millisecondsSinceEpoch, 'text': text, 'who': who, 'opener': opener};
}

/// A task running now: a bar from [from] to now, the face of [who] at its end.
class LaneRun {
  const LaneRun({required this.from, required this.text, this.who});
  final DateTime from;
  final String text;
  final String? who;
  factory LaneRun.fromJson(Map<String, dynamic> j) => LaneRun(from: _ms(j['from']), text: j['text'] as String? ?? '', who: j['who'] as String?);
  Map<String, dynamic> toJson() => {'from': from.millisecondsSinceEpoch, 'text': text, 'who': who};
}

/// A production failure: `warning` at [at].
class LaneAlert {
  const LaneAlert({required this.at, required this.text});
  final DateTime at;
  final String text;
  factory LaneAlert.fromJson(Map<String, dynamic> j) => LaneAlert(at: _ms(j['at']), text: j['text'] as String? ?? '');
  Map<String, dynamic> toJson() => {'at': at.millisecondsSinceEpoch, 'text': text};
}

/// One project's lane of the day.
class Lane {
  const Lane({required this.id, required this.name, this.symbol = 'folder', this.done = const [], this.running = const [], this.waiting = 0, this.queued = const [], this.alerts = const []});
  final String id;
  final String name;
  final String symbol;
  final List<LaneDone> done;
  final List<LaneRun> running;

  /// How many things in it wait for him: a hollow `front_hand` mark at now.
  final int waiting;

  /// The tasks waiting their turn, in queue order (#128): a hollow `schedule` mark at now, on a track of its own.
  final List<String> queued;
  final List<LaneAlert> alerts;

  factory Lane.fromJson(Map<String, dynamic> j) => Lane(
        id: j['id'] as String,
        name: j['name'] as String? ?? j['id'] as String,
        symbol: j['symbol'] as String? ?? 'folder',
        done: [for (final x in _maps(j['done'])) LaneDone.fromJson(x)],
        running: [for (final x in _maps(j['running'])) LaneRun.fromJson(x)],
        waiting: (j['waiting'] as num?)?.toInt() ?? 0,
        queued: (j['queued'] as List?)?.whereType<String>().toList() ?? const [],
        alerts: [for (final x in _maps(j['alerts'])) LaneAlert.fromJson(x)],
      );
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'symbol': symbol,
        'done': [for (final x in done) x.toJson()],
        'running': [for (final x in running) x.toJson()],
        'waiting': waiting,
        'queued': queued,
        'alerts': [for (final x in alerts) x.toJson()],
      };
}

/// "פסי היום": a lane per project on one time axis, [from] to [now].
class LanesData {
  const LanesData({required this.from, required this.now, required this.lanes});
  final DateTime from;
  final DateTime now;
  final List<Lane> lanes;

  /// Today, from the hour of its first activity to [now], for [projects] or all of them.
  factory LanesData.of(CompanyData d, {required DateTime now, List<String>? projects, DateTime? from}) {
    final list = [for (final p in projectsByActivity(d)) if (projects == null || projects.contains(p.id)) p];
    // From the hour of the day's first activity, so nothing is cut and nothing is empty; at most 16 hours
    // back, at least two (an early morning still reads as a day). No activity today: from 08:00.
    final day = dayStart(now);
    DateTime? first;
    for (final t in d.tickets) {
      if (projects != null && !projects.contains(t.project)) continue;
      for (final at in [t.doneAt, t.doneAt == null ? t.startedAt : null]) {
        if (at != null && !at.isBefore(day) && (first == null || at.isBefore(first))) first = at;
      }
    }
    var start = from ?? (first == null ? day.add(const Duration(hours: 8)) : hourStart(first));
    if (from == null) {
      final longest = now.subtract(const Duration(hours: 16)), shortest = now.subtract(const Duration(hours: 2));
      if (start.isBefore(longest)) start = longest;
      if (start.isAfter(shortest)) start = shortest;
    }
    final lanes = <Lane>[];
    for (final p in list) {
      final ts = [for (final t in d.tickets) if (t.project == p.id) t];
      lanes.add(Lane(
        id: p.id,
        name: p.name,
        symbol: _symbolOf(d, p),
        done: [
          for (final t in ts)
            if (t.doneAt != null && !t.doneAt!.isBefore(start) && !t.doneAt!.isAfter(now)) LaneDone(at: t.doneAt!, text: t.doneLine, who: t.assigneeId, opener: t.openedBy),
        ],
        running: [
          for (final t in ts)
            if (t.doneAt == null && t.group != TicketGroup.queued)
              LaneRun(from: t.startedAt == null || t.startedAt!.isBefore(start) ? start : t.startedAt!, text: plainTitle(t.title), who: t.assigneeId),
        ],
        waiting: d.waiting.where((w) => _open(w) && w.kind != WaitKind.urgentProd && w.kind != WaitKind.failure && projectOf(d, w.from) == p.id).length,
        queued: [for (final t in d.openTasks) if (t.project == p.id && t.state == OpenTaskState.queued) t.title],
        alerts: [
          for (final w in d.waiting)
            if (_open(w) && (w.kind == WaitKind.urgentProd || w.kind == WaitKind.failure) && projectOf(d, w.from) == p.id)
              LaneAlert(at: w.createdAt ?? now, text: (w.headline ?? w.body).split('\n').first),
        ],
      ));
    }
    return LanesData(from: start, now: now, lanes: lanes);
  }

  factory LanesData.fromJson(Map<String, dynamic> j) =>
      LanesData(from: _ms(j['from']), now: _ms(j['now']), lanes: [for (final x in _maps(j['lanes'])) Lane.fromJson(x)]);
  Map<String, dynamic> toJson() => {'from': from.millisecondsSinceEpoch, 'now': now.millisecondsSinceEpoch, 'lanes': [for (final l in lanes) l.toJson()]};
}

// ───────────────────────── project ─────────────────────────

/// A project in two lines: what runs now and who, or "שקט" and the last thing that finished.
class ProjectLine {
  const ProjectLine({required this.id, required this.name, this.symbol = 'folder', this.now, this.who = const [], this.queued = 0, this.waiting = 0, this.last, this.lastAt, this.lastWho, this.lastOpener, this.note});
  final String id;
  final String name;
  final String symbol;

  /// A line from whoever composes the home, under the two ("השחרור מחכה לאישור שלך").
  final String? note;

  /// The task running now (the newest, when more than one); null when nothing runs.
  final String? now;

  /// Who runs its open tasks, the one on [now] first.
  final List<String> who;
  final int queued;
  final int waiting;

  /// The last task that finished: its summary in his words, else its title.
  final String? last;
  final DateTime? lastAt;

  /// Who did [last], and who opened it: where its line leads.
  final String? lastWho;
  final String? lastOpener;

  factory ProjectLine.of(CompanyData d, String id) {
    final p = _projects(d).where((p) => p.id == id).firstOrNull ?? ProjectInfo(id: id, active: true);
    final ts = [for (final t in d.tickets) if (t.project == id) t];
    final running = [for (final t in ts) if (t.doneAt == null && t.group != TicketGroup.queued) t]
      ..sort((a, b) => (b.startedAt ?? DateTime(0)).compareTo(a.startedAt ?? DateTime(0)));
    final done = [for (final t in ts) if (t.doneAt != null) t]..sort((a, b) => b.doneAt!.compareTo(a.doneAt!));
    return ProjectLine(
      id: id,
      name: p.name,
      symbol: _symbolOf(d, p),
      now: running.isEmpty ? null : plainTitle(running.first.title),
      who: [...{for (final t in running) if (t.assigneeId != null) t.assigneeId!}],
      queued: ts.where((t) => t.doneAt == null && t.group == TicketGroup.queued).length,
      waiting: d.waiting.where((w) => _open(w) && projectOf(d, w.from) == id).length,
      last: done.isEmpty ? null : done.first.doneLine,
      lastAt: done.isEmpty ? null : done.first.doneAt,
      lastWho: done.firstOrNull?.assigneeId,
      lastOpener: done.firstOrNull?.openedBy,
    );
  }

  factory ProjectLine.fromJson(Map<String, dynamic> j) => ProjectLine(
        id: j['id'] as String,
        name: j['name'] as String? ?? j['id'] as String,
        symbol: j['symbol'] as String? ?? 'folder',
        now: j['now'] as String?,
        who: (j['who'] as List?)?.whereType<String>().toList() ?? const [],
        queued: (j['queued'] as num?)?.toInt() ?? 0,
        waiting: (j['waiting'] as num?)?.toInt() ?? 0,
        last: j['last'] as String?,
        lastAt: _msOrNull(j['last_at']),
        lastWho: j['last_who'] as String?,
        lastOpener: j['last_opener'] as String?,
        note: j['note'] as String?,
      );
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'symbol': symbol,
        'now': now,
        'who': who,
        'queued': queued,
        'waiting': waiting,
        'last': last,
        'last_at': lastAt?.millisecondsSinceEpoch,
        'last_who': lastWho,
        'last_opener': lastOpener,
        'note': note,
      };
}

// ───────────────────────── since ─────────────────────────

/// A task that finished after his last visit: its summary in his words, who did it, when, who opened it.
class SinceItem {
  const SinceItem({required this.key, required this.text, required this.at, this.who, this.opener, this.task});
  final String key;
  final String text;
  final DateTime at;
  final String? who;

  /// Who opened the task (`opened-by`): where the line leads once a task worker finished it.
  final String? opener;

  /// hq's task id, from a composer's `{text, task}`: who and opener come from the board.
  final int? task;
  factory SinceItem.fromJson(Map<String, dynamic> j) => SinceItem(
      key: j['key'] as String? ?? '${j['at']}',
      text: j['text'] as String? ?? '',
      at: _ms(j['at']),
      who: j['who'] as String?,
      opener: j['opener'] as String?,
      task: (j['task'] as num?)?.toInt());
  Map<String, dynamic> toJson() => {'key': key, 'text': text, 'at': at.millisecondsSinceEpoch, 'who': who, 'opener': opener, 'task': task};
}

/// "מאז שהיית פה": what finished after [since], newest first.
class SinceData {
  const SinceData({required this.since, required this.items});
  final DateTime since;
  final List<SinceItem> items;

  factory SinceData.of(CompanyData d, {required DateTime since}) => SinceData(
        since: since,
        items: [
          for (final t in d.tickets)
            if (t.doneAt != null && t.doneAt!.isAfter(since)) SinceItem(key: 'done:${t.number}:${t.title}', text: t.doneLine, at: t.doneAt!, who: t.assigneeId, opener: t.openedBy),
        ]..sort((a, b) => b.at.compareTo(a.at)),
      );

  factory SinceData.fromJson(Map<String, dynamic> j) => SinceData(since: _ms(j['since']), items: [for (final x in _maps(j['items'])) SinceItem.fromJson(x)]);
  Map<String, dynamic> toJson() => {'since': since.millisecondsSinceEpoch, 'items': [for (final x in items) x.toJson()]};
}

// ───────────────────────── people ─────────────────────────

/// Someone at work now: who, on what, since when.
class PersonNow {
  const PersonNow({required this.id, required this.text, this.since, this.status = WorkerStatus.working});
  final String id;
  final String text;
  final DateTime? since;
  final WorkerStatus status;
  factory PersonNow.fromJson(Map<String, dynamic> j) => PersonNow(
        id: j['id'] as String,
        text: j['text'] as String? ?? '',
        since: _msOrNull(j['since']),
        status: WorkerStatus.values.asNameMap()[j['status']] ?? WorkerStatus.working,
      );
  Map<String, dynamic> toJson() => {'id': id, 'text': text, 'since': since?.millisecondsSinceEpoch, 'status': status.name};
}

/// "מי עובד עכשיו": every worker on a task now, the one who started last first.
class PeopleData {
  const PeopleData({required this.people});
  final List<PersonNow> people;

  factory PeopleData.of(CompanyData d) {
    final out = <PersonNow>[];
    final seen = <String>{};
    final running = [for (final t in d.tickets) if (t.doneAt == null && t.group != TicketGroup.queued && t.assigneeId != null) t]
      ..sort((a, b) => (b.startedAt ?? DateTime(0)).compareTo(a.startedAt ?? DateTime(0)));
    for (final t in running) {
      if (seen.add(t.assigneeId!)) out.add(PersonNow(id: t.assigneeId!, text: plainTitle(t.title), since: t.startedAt, status: t.status));
    }
    return PeopleData(people: out);
  }

  factory PeopleData.fromJson(Map<String, dynamic> j) => PeopleData(people: [for (final x in _maps(j['people'])) PersonNow.fromJson(x)]);
  Map<String, dynamic> toJson() => {'people': [for (final x in people) x.toJson()]};
}

// ───────────────────────── note ─────────────────────────

/// A line in her own words from whoever composes the home ("שמתי לב ש…"), with an optional symbol.
class NoteData {
  const NoteData({required this.text, this.icon, this.from});
  final String text;

  /// A Material Symbols name; `lightbulb` when none.
  final String? icon;

  /// Who wrote it (an identity): her face and name under it.
  final String? from;
  factory NoteData.fromJson(Map<String, dynamic> j) => NoteData(text: j['text'] as String? ?? '', icon: j['icon'] as String?, from: j['from'] as String?);
  Map<String, dynamic> toJson() => {'text': text, 'icon': icon, 'from': from};
}
