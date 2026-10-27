// The head of the conversations screen as hq keeps it (GET /api/home, packages/hq/src/home.ts): a recipe of
// blocks from a fixed vocabulary, composed by an agent or by hq's own default. The recipe only says what to
// show, in what order and in what words; every block is drawn by its own component, from live data.

enum Emphasis { normal, quiet, strong }

/// One block. [type] is one of [HomeBlock.types]; anything else never reaches the screen.
class HomeBlock {
  const HomeBlock({required this.type, this.emphasis = Emphasis.normal, this.text, this.icon, this.inbox = const [], this.shift, this.tasks = const [], this.allOpen = false, this.messages = const [],
      this.projects = const [], this.identities = const [], this.items = const [], this.note, this.caption});

  static const types = {'headline', 'alert', 'waiting', 'asked', 'awaiting', 'tasks', 'lanes', 'project', 'quiet', 'people', 'since', 'note'};

  final String type;
  final Emphasis emphasis;

  /// headline, note.
  final String? text;

  /// note: a Material Symbols name.
  final String? icon;

  /// alert (one) and waiting: inbox item ids.
  final List<int> inbox;

  /// alert: a shift id (`<identity>-<n>`).
  final String? shift;

  /// awaiting and tasks: task ids.
  final List<int> tasks;

  /// tasks: `"open"`, every open task as the list is now (#128).
  final bool allOpen;

  /// asked: his message ids (hq `asked[].id`).
  final List<String> messages;

  /// lanes and quiet: project ids; project: one.
  final List<String> projects;
  final List<String> identities;

  /// since: up to 3 sentences, each with the task it tells of when the composer named one.
  final List<SinceText> items;

  /// project: a line under the two.
  final String? note;

  /// people: a line over the faces.
  final String? caption;

  /// Stable while the block means the same thing: what a move between recipes animates by.
  String get key => switch (type) {
        'project' => 'project:${projects.firstOrNull}',
        'alert' => 'alert:${inbox.firstOrNull ?? shift}',
        _ => type,
      };

  HomeBlock copyWith({List<int>? inbox, List<int>? tasks, List<String>? messages, List<String>? projects, List<String>? identities}) => HomeBlock(
      type: type, emphasis: emphasis, text: text, icon: icon, inbox: inbox ?? this.inbox, shift: shift, tasks: tasks ?? this.tasks, allOpen: allOpen, messages: messages ?? this.messages,
      projects: projects ?? this.projects, identities: identities ?? this.identities, items: items, note: note, caption: caption);

  static List<T> _list<T>(Object? v) => v is List ? v.whereType<T>().toList() : const [];

  /// Null for a block this version of the app doesn't know: hq may be newer.
  static HomeBlock? fromJson(Map<String, dynamic> j) {
    final type = j['type'];
    if (type is! String || !types.contains(type)) return null;
    final alertInbox = j['inbox'] is int ? [j['inbox'] as int] : _list<int>(j['inbox']);
    return HomeBlock(
      type: type,
      emphasis: Emphasis.values.asNameMap()[j['emphasis']] ?? Emphasis.normal,
      text: j['text'] as String?,
      icon: j['icon'] as String?,
      inbox: alertInbox,
      shift: j['shift'] as String?,
      tasks: _list<int>(j['tasks']),
      allOpen: type == 'tasks' && j['tasks'] == 'open',
      messages: _list<String>(j['messages']),
      projects: type == 'project' && j['project'] is String ? [j['project'] as String] : _list<String>(j['projects']),
      identities: _list<String>(j['identities']),
      items: [
        for (final x in j['items'] is List ? j['items'] as List : const [])
          if (x is String) SinceText(x) else if (x is Map && x['text'] is String) SinceText(x['text'] as String, task: x['task'] is num ? (x['task'] as num).toInt() : null),
      ],
      note: j['note'] as String?,
      caption: j['caption'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'type': type,
        if (emphasis != Emphasis.normal) 'emphasis': emphasis.name,
        if (text != null) 'text': text,
        if (icon != null) 'icon': icon,
        if (type == 'alert' && inbox.isNotEmpty) 'inbox': inbox.first else if (inbox.isNotEmpty) 'inbox': inbox,
        if (shift != null) 'shift': shift,
        if (allOpen) 'tasks': 'open' else if (tasks.isNotEmpty) 'tasks': tasks,
        if (messages.isNotEmpty) 'messages': messages,
        if (type == 'project') 'project': projects.firstOrNull else if (projects.isNotEmpty) 'projects': projects,
        if (identities.isNotEmpty) 'identities': identities,
        if (items.isNotEmpty) 'items': [for (final x in items) x.toJson()],
        if (note != null) 'note': note,
        if (caption != null) 'caption': caption,
      };
}

/// A "since" sentence: plain text from an older composer, `{text, task}` from hq's default and a composer who
/// names the task, so the line leads to the worker who did it.
class SinceText {
  const SinceText(this.text, {this.task});
  final String text;
  final int? task;
  Object toJson() => task == null ? text : {'text': text, 'task': task};
}

/// One Claude account's quota as hq read it (GET /api/home `quota`, accounts.ts): both windows and their resets.
/// The last line may be Codex's week (name `codex`, hq codex-quota.ts): one window, and a [note] when tasks stop going to it.
class QuotaLine {
  const QuotaLine({required this.name, required this.label, this.usable = true, this.full = false, this.reopensAt, this.fiveHour, this.sevenDay, this.fiveHourResets, this.sevenDayResets, this.measuredAt, this.note});
  final String name;
  final String label;

  /// Connected and not a duplicate; a managed account waiting for a login is not.
  final bool usable;

  /// No work runs on it now: a window at 100%, or a rejection; [reopensAt] when it takes work again, if known.
  final bool full;
  final DateTime? reopensAt;
  final num? fiveHour;
  final num? sevenDay;
  final DateTime? fiveHourResets;
  final DateTime? sevenDayResets;
  final DateTime? measuredAt;
  final String? note;

  /// Codex, not a Claude account: whether the company can run is not decided by it.
  bool get isCodex => name == 'codex';

  static DateTime? _t(Object? v) => v is num ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;

  static QuotaLine? fromJson(Map<String, dynamic> j) {
    final name = j['name'];
    if (name is! String) return null;
    return QuotaLine(
      name: name,
      label: j['label'] as String? ?? name,
      usable: j['usable'] != false,
      full: j['full'] == true,
      reopensAt: _t(j['reopens_at']),
      fiveHour: j['five_hour_pct'] as num?,
      sevenDay: j['seven_day_pct'] as num?,
      fiveHourResets: _t(j['five_hour_resets_at']),
      sevenDayResets: _t(j['seven_day_resets_at']),
      measuredAt: _t(j['snapshot_at']),
      note: j['note'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'name': name,
        'label': label,
        'usable': usable,
        'full': full,
        'reopens_at': reopensAt?.millisecondsSinceEpoch,
        'five_hour_pct': fiveHour,
        'seven_day_pct': sevenDay,
        'five_hour_resets_at': fiveHourResets?.millisecondsSinceEpoch,
        'seven_day_resets_at': sevenDayResets?.millisecondsSinceEpoch,
        'snapshot_at': measuredAt?.millisecondsSinceEpoch,
        if (note != null) 'note': note,
      };
}

/// How fast the quota goes and on what (GET /api/home `usage`, hq usage.ts): the last hour and day, by kind and worker.
class UsageData {
  const UsageData({this.hourPct, this.dayPct, this.kinds = const [], this.people = const [], this.parallelNow = 0, this.parallelAvg = 0, this.parallelPeak = 0, this.measuredAt});

  /// % of the weekly quota, all accounts as one (hq averages them); null when hq had no quota read for it.
  final num? hourPct;
  final num? dayPct;

  /// The day's spend by kind (`tasks`, `leads_owner`, `leads_workers`, `leads_hq`, `leads_other`), shares 0..1, largest first.
  final List<(String, num)> kinds;

  /// The top workers of the day's spend: (name, share, a task worker).
  final List<(String, num, bool)> people;
  final int parallelNow;
  final num parallelAvg;
  final num parallelPeak;
  final DateTime? measuredAt;

  bool get isEmpty => hourPct == null && dayPct == null && kinds.isEmpty && people.isEmpty && parallelNow == 0 && parallelAvg == 0 && parallelPeak == 0;

  static UsageData? fromJson(Object? v) {
    if (v is! Map) return null;
    final j = v.cast<String, dynamic>();
    final par = (j['parallel'] as Map?)?.cast<String, dynamic>() ?? const {};
    return UsageData(
      hourPct: j['hour_pct'] as num?,
      dayPct: j['day_pct'] as num?,
      kinds: [
        for (final k in (j['kinds'] as List? ?? const []).whereType<Map>())
          if (k['kind'] is String && k['share'] is num) (k['kind'] as String, k['share'] as num),
      ],
      people: [
        for (final p in (j['people'] as List? ?? const []).whereType<Map>())
          if (p['name'] is String && p['share'] is num) (p['name'] as String, p['share'] as num, p['task'] == true),
      ],
      parallelNow: (par['now'] as num?)?.toInt() ?? 0,
      parallelAvg: par['avg'] as num? ?? 0,
      parallelPeak: par['peak'] as num? ?? 0,
      measuredAt: j['measured_at'] is num ? DateTime.fromMillisecondsSinceEpoch((j['measured_at'] as num).toInt()) : null,
    );
  }

  Map<String, dynamic> toJson() => {
        'hour_pct': hourPct,
        'day_pct': dayPct,
        'kinds': [for (final (k, s) in kinds) {'kind': k, 'share': s}],
        'people': [for (final (n, s, t) in people) {'name': n, 'share': s, 'task': t}],
        'parallel': {'now': parallelNow, 'avg': parallelAvg, 'peak': parallelPeak},
        if (measuredAt != null) 'measured_at': measuredAt!.millisecondsSinceEpoch,
      };
}

class HomeRecipe {
  const HomeRecipe({required this.version, required this.composedBy, required this.composedAt, required this.blocks, this.source = 'agent', this.fallback, this.reason, this.waitingChangedAt, this.quota = const [], this.usage});
  final int version;

  /// The Claude accounts' quota, live from hq; empty from an older hq.
  final List<QuotaLine> quota;

  /// How fast it goes and on what; null from an older hq.
  final UsageData? usage;

  /// When what waits for him last changed in hq (an item came in, was answered or put off); null from an
  /// older hq, or when nothing ever waited. A headline composed before it may no longer be true.
  final DateTime? waitingChangedAt;

  /// The identity that composed it, or `hq` for the default.
  final String composedBy;
  final DateTime composedAt;
  final List<HomeBlock> blocks;

  /// `agent` (composed by hand), `hq` (hq's own with its sentence) or `default`; [fallback] says why not the
  /// hand-composed one (none | stale | invalid).
  final String source;
  final String? fallback;
  final String? reason;

  bool get byAgent => source == 'agent';

  /// hq's own, its sentence written from facts without a model (`home-headline` on).
  bool get byHq => source == 'hq';

  factory HomeRecipe.fromJson(Map<String, dynamic> j) => HomeRecipe(
        version: (j['version'] as num?)?.toInt() ?? 0,
        composedBy: j['composed_by'] as String? ?? 'hq',
        composedAt: DateTime.fromMillisecondsSinceEpoch((j['composed_at'] as num?)?.toInt() ?? 0),
        source: j['source'] as String? ?? 'agent',
        fallback: j['fallback'] as String?,
        reason: j['reason'] as String?,
        waitingChangedAt: j['waiting_changed_at'] is num ? DateTime.fromMillisecondsSinceEpoch((j['waiting_changed_at'] as num).toInt()) : null,
        blocks: [
          for (final b in (j['blocks'] as List? ?? const []).whereType<Map>())
            ?HomeBlock.fromJson(b.cast<String, dynamic>()),
        ],
        quota: [
          for (final q in (j['quota'] as List? ?? const []).whereType<Map>())
            ?QuotaLine.fromJson(q.cast<String, dynamic>()),
        ],
        usage: UsageData.fromJson(j['usage']),
      );

  Map<String, dynamic> toJson() => {
        'version': version,
        'composed_by': composedBy,
        'composed_at': composedAt.millisecondsSinceEpoch,
        'source': source,
        if (fallback != null) 'fallback': fallback,
        if (reason != null) 'reason': reason,
        if (waitingChangedAt != null) 'waiting_changed_at': waitingChangedAt!.millisecondsSinceEpoch,
        'blocks': [for (final b in blocks) b.toJson()],
        if (quota.isNotEmpty) 'quota': [for (final q in quota) q.toJson()],
        if (usage != null) 'usage': usage!.toJson(),
      };
}
