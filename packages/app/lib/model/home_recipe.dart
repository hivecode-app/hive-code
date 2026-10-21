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

class HomeRecipe {
  const HomeRecipe({required this.version, required this.composedBy, required this.composedAt, required this.blocks, this.source = 'agent', this.fallback, this.reason});
  final int version;

  /// The identity that composed it, or `hq` for the default.
  final String composedBy;
  final DateTime composedAt;
  final List<HomeBlock> blocks;

  /// `agent` or `default`; [fallback] says why the default (none | stale | invalid | off).
  final String source;
  final String? fallback;
  final String? reason;

  bool get byAgent => source == 'agent';

  factory HomeRecipe.fromJson(Map<String, dynamic> j) => HomeRecipe(
        version: (j['version'] as num?)?.toInt() ?? 0,
        composedBy: j['composed_by'] as String? ?? 'hq',
        composedAt: DateTime.fromMillisecondsSinceEpoch((j['composed_at'] as num?)?.toInt() ?? 0),
        source: j['source'] as String? ?? 'agent',
        fallback: j['fallback'] as String?,
        reason: j['reason'] as String?,
        blocks: [
          for (final b in (j['blocks'] as List? ?? const []).whereType<Map>())
            ?HomeBlock.fromJson(b.cast<String, dynamic>()),
        ],
      );

  Map<String, dynamic> toJson() => {
        'version': version,
        'composed_by': composedBy,
        'composed_at': composedAt.millisecondsSinceEpoch,
        'source': source,
        if (fallback != null) 'fallback': fallback,
        if (reason != null) 'reason': reason,
        'blocks': [for (final b in blocks) b.toJson()],
      };
}
