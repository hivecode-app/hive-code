// hq event log -> chat items. A Dart port of spikes/bet7-chat/model.ts, adapted to the
// EngineEvent kinds hq persists (packages/shared/src/shift-protocol.ts) instead of raw stream-json:
//   engine.text, engine.tool_use, engine.tool_result, engine.result, engine.user_echo,
//   engine.delta (live only, seq 0), shift.state.
// Pure: no IO. Feeding the same event twice is a no-op (dedupe by seq), so replay after a
// reconnect (`/ws?after=<seq>`) never duplicates a line (chat.md §7).
// The conversation model (chat.md §2.3א): a turn that reached the owner through `tell`/`ask`/`request_go`
// shows that item, not its own text: the text of such a turn is dropped when the turn ends.
import '../model/models.dart';

class EngineModel {
  EngineModel({required this.items, required this.gender, this.onLive});
  final List<ChatItem> items;
  final Gender gender;
  final void Function(LiveState)? onLive;

  int lastSeq = 0;
  final _streams = <String, TextMsg>{};
  ToolGroup? _group;
  final _groupTools = <String, int>{}; // toolUseId -> index in group.tools
  final _hiddenTools = <String>{}; // toolUseIds with no row (hiddenTool)
  final _toolNames = <String, List<String>>{}; // group id -> tool names in order
  final _toolStarted = <String, DateTime>{};
  int? _shiftNo;
  final _turnTexts = <TextMsg>[];
  bool _turnToldOwner = false;

  /// Applies one hq event `{seq, ts, type, identity, data}`.
  void apply(Map<String, dynamic> e) {
    final seq = (e['seq'] as num?)?.toInt() ?? 0;
    if (seq != 0 && seq <= lastSeq) return; // already applied (replay overlap)
    if (seq != 0) lastSeq = seq;
    final ts = DateTime.fromMillisecondsSinceEpoch((e['ts'] as num?)?.toInt() ?? DateTime.now().millisecondsSinceEpoch);
    final type = e['type'] as String? ?? '';
    final data = (e['data'] as Map?)?.cast<String, dynamic>() ?? const {};

    if (type == 'shift.state') {
      // A run that died mid-turn never sent `result`: its turn is over, nothing carries into the next one.
      _turnTexts.clear();
      _turnToldOwner = false;
      final id = data['id'] as String? ?? data['shift'] as String? ?? '';
      final n = int.tryParse(id.split('-').last);
      if (n != null && data['state'] == 'live' && _shiftNo != n) {
        if (_shiftNo != null) items.add(ShiftMarker(id: 'shift:$id', ts: ts, shift: n, from: _shiftNo!, seq: seq));
        _shiftNo = n;
      }
      return;
    }
    if (!type.startsWith('engine.')) return;
    final ev = (data['ev'] as Map?)?.cast<String, dynamic>() ?? data;
    final kind = ev['kind'] as String? ?? type.substring(7);

    switch (kind) {
      case 'text_delta':
        final mid = ev['messageId'] as String? ?? 'live';
        final t = _streams.putIfAbsent(mid, () {
          _closeGroup(Outcome.ok);
          final m = TextMsg(id: 't:$mid', ts: ts, text: '', streaming: true);
          items.add(m);
          _turnTexts.add(m);
          return m;
        });
        t.text += ev['text'] as String? ?? '';
        onLive?.call(const LiveState(phase: LivePhase.writing));
      case 'thinking_delta':
        onLive?.call(const LiveState(phase: LivePhase.thinking));
      case 'text':
        final mid = ev['messageId'] as String?;
        final text = ev['text'] as String? ?? '';
        final live = mid == null ? null : _streams.remove(mid);
        if (live != null) {
          live
            ..text = text
            ..streaming = false
            ..seq = seq;
        } else if (text.trim().isNotEmpty) {
          _closeGroup(Outcome.ok);
          final m = TextMsg(id: 't:${mid ?? seq}', ts: ts, text: text, seq: seq);
          items.add(m);
          _turnTexts.add(m);
        }
      case 'tool_use':
        if (ev['parentToolUseId'] != null) return; // subagent internals: only the Task line shows
        final name = ev['name'] as String? ?? '?';
        if (reachesOwner(name, ev['input'])) _turnToldOwner = true;
        final id = ev['toolUseId'] as String? ?? '$seq';
        final input = (ev['input'] as Map?)?.cast<String, dynamic>() ?? const {};
        // A message to the owner, a question or a GO request shows as its own item, and tool
        // housekeeping means nothing to him: no tool row for those (it read "השתמש בכלים" between
        // every two messages), and no row that appears and then vanishes.
        if (hiddenTool(name, input)) {
          _hiddenTools.add(id);
          onLive?.call(LiveState(phase: LivePhase.tool, label: liveLabel(name, input, gender)));
          return;
        }
        final g = _group ??= _newGroup(ts, seq);
        _groupTools[id] = g.tools.length;
        _toolStarted[id] = ts;
        (_toolNames[g.id] ??= []).add(name);
        g.tools.add(ToolLine(icon: toolIcon(name), label: toolDetail(name, input), name: name, outcome: Outcome.running));
        g.outcome = Outcome.running;
        g.liveLabel = liveLabel(name, input, gender);
        g.summary = summarizeTools(_toolNames[g.id]!.sublist(0, _toolNames[g.id]!.length - 1), gender, files: _files(g));
        onLive?.call(LiveState(phase: LivePhase.tool, label: g.liveLabel, runningCommand: name == 'Bash' ? (input['command'] as String?) : null));
      case 'tool_result':
        final id = ev['toolUseId'] as String? ?? '';
        if (_hiddenTools.remove(id)) {
          onLive?.call(const LiveState(phase: LivePhase.thinking));
          return;
        }
        final g = _group;
        final i = _groupTools[id];
        if (g == null || i == null) return;
        final old = g.tools[i];
        final err = ev['isError'] == true;
        g.tools[i] = ToolLine(icon: old.icon, label: old.label, name: old.name, trail: old.trail, outcome: err ? Outcome.error : Outcome.ok);
        if (err) g.outcome = Outcome.error;
        final started = g.ts;
        final secs = ts.difference(started).inSeconds;
        g.summary = summarizeTools(_toolNames[g.id]!, gender, files: _files(g), seconds: secs, failed: g.tools.any((t) => t.outcome == Outcome.error));
        g.liveLabel = null;
      case 'result':
        for (final s in _streams.values) {
          s.streaming = false;
        }
        _streams.clear();
        _closeGroup(ev['isError'] == true ? Outcome.error : Outcome.ok);
        if (_turnToldOwner) {
          final drop = _turnTexts.toSet();
          items.removeWhere(drop.contains);
        }
        _turnTexts.clear();
        _turnToldOwner = false;
        if (ev['isError'] == true) {
          items.add(ErrorLine(id: 'r:$seq', ts: ts, text: 'הסבב נגמר בשגיאה. ${gender == Gender.f ? 'היא תנסה' : 'הוא ינסה'} שוב בהודעה הבאה.', seq: seq));
        }
        onLive?.call(const LiveState());
      case 'user_echo':
        // Delivery acks arrive as message.state; the echo itself is not a chat line.
        break;
      default:
        break;
    }
  }

  ToolGroup _newGroup(DateTime ts, int seq) {
    final g = ToolGroup(id: 'g:$seq', ts: ts, summary: '', tools: [], outcome: Outcome.running, seq: seq);
    items.add(g);
    return g;
  }

  List<String> _files(ToolGroup g) => [for (final t in g.tools) if (t.name == 'Edit' || t.name == 'Write' || t.name == 'MultiEdit') t.label.split('/').last];

  void _closeGroup(Outcome o) {
    final g = _group;
    if (g == null) return;
    if (g.outcome == Outcome.running) g.outcome = o;
    for (var i = 0; i < g.tools.length; i++) {
      final t = g.tools[i];
      if (t.outcome == Outcome.running) g.tools[i] = ToolLine(icon: t.icon, label: t.label, name: t.name, trail: t.trail, outcome: Outcome.interrupted);
    }
    g.liveLabel = null;
    _group = null;
  }
}

/// No tool row for these: the owner sees their result as its own item, or they are bookkeeping.
bool hiddenTool(String name, Object? input) => reachesOwner(name, input) || const {'ToolSearch', 'TodoWrite', 'ExitPlanMode'}.contains(name);

/// A company tool whose result the owner sees as its own item (a message, an ask card, a GO card).
bool reachesOwner(String name, Object? input) =>
    name == 'mcp__company__ask' ||
    name == 'mcp__company__request_go' ||
    (name == 'mcp__company__tell' && input is Map && const {'owner', 'רן', 'ran'}.contains(input['to']));

String toolIcon(String name) => switch (name) {
      'Read' => 'description',
      'Grep' || 'Glob' || 'WebSearch' => 'search',
      'Edit' || 'Write' || 'MultiEdit' => 'edit',
      'Bash' => 'terminal',
      'Task' || 'Agent' => 'person',
      'WebFetch' => 'open_in_new',
      _ => 'build',
    };

/// The LTR detail line of one tool (chat.md §2.4 table, open state).
String toolDetail(String name, Map<String, dynamic> input) {
  String s(String k) => (input[k] ?? '').toString();
  return switch (name) {
    'Read' || 'Edit' || 'Write' || 'MultiEdit' => s('file_path'),
    'Grep' => '"${s('pattern')}"${input['path'] != null ? ' in ${s('path')}' : ''}',
    'Glob' => s('pattern'),
    'Bash' => s('command'),
    'Task' || 'Agent' => s('description'),
    'WebFetch' => s('url'),
    'WebSearch' => s('query'),
    _ => name,
  };
}

/// What the live tool row says while it runs: "מריץ בדיקות".
String liveLabel(String name, Map<String, dynamic> input, Gender g) {
  final f = g == Gender.f;
  if (name == 'Bash') {
    final cmd = (input['command'] ?? '').toString();
    if (_isTest(cmd)) return f ? 'מריצה בדיקות' : 'מריץ בדיקות';
    final d = (input['description'] ?? '').toString();
    return d.isNotEmpty ? d : (f ? 'מריצה פקודה' : 'מריץ פקודה');
  }
  return switch (name) {
    'Read' => f ? 'קוראת' : 'קורא',
    'Grep' || 'Glob' => f ? 'מחפשת' : 'מחפש',
    'Edit' || 'Write' || 'MultiEdit' => f ? 'עורכת' : 'עורך',
    'Task' || 'Agent' => f ? 'שולחת עוזר' : 'שולח עוזר',
    'mcp__company__tell' => f ? 'כותבת' : 'כותב',
    'mcp__company__ask' => f ? 'שואלת' : 'שואל',
    'mcp__company__remember' => f ? 'רושמת לזיכרון' : 'רושם לזיכרון',
    'mcp__company__open_team' => f ? 'פותחת צוות' : 'פותח צוות',
    _ => f ? 'עובדת' : 'עובד',
  };
}

bool _isTest(String cmd) => RegExp(r'\b(go test|flutter test|pytest|npm (run )?test|node --test|jest|vitest)\b').hasMatch(cmd);

String _times(int n, bool f) => switch (n) { 1 => 'פעם אחת', 2 => 'פעמיים', _ => '$n פעמים' };

/// One Hebrew sentence for a run of tools (chat.md §2.4): "קרא 4 קבצים · חיפש פעמיים · ערך `renew.go`".
/// hq will own this (summarizeTools); the client keeps the same rules until it does.
String summarizeTools(List<String> names, Gender g, {List<String> files = const [], int? seconds, bool failed = false}) {
  final f = g == Gender.f;
  final parts = <String>[];
  int count(bool Function(String) p) => names.where(p).length;
  final reads = count((n) => n == 'Read');
  final searches = count((n) => n == 'Grep' || n == 'Glob');
  final edits = files.toSet().toList();
  final bash = count((n) => n == 'Bash');
  final agents = count((n) => n == 'Task' || n == 'Agent');
  final web = count((n) => n == 'WebFetch' || n == 'WebSearch');
  // (Owner-facing company tools and housekeeping never get here: hiddenTool keeps them out.)
  final tells = count((n) => n == 'mcp__company__tell');
  final memory = count((n) => n == 'mcp__company__remember');
  final teams = count((n) => n == 'mcp__company__open_team');
  if (reads > 0) parts.add('${f ? 'קראה' : 'קרא'} ${reads == 1 ? 'קובץ' : '$reads קבצים'}');
  if (searches > 0) parts.add('${f ? 'חיפשה' : 'חיפש'} ${_times(searches, f)}');
  if (edits.length == 1) parts.add('${f ? 'ערכה' : 'ערך'} `${edits.first}`');
  if (edits.length > 1) parts.add('${f ? 'ערכה' : 'ערך'} ${edits.length} קבצים');
  if (bash > 0) parts.add('${f ? 'הריצה' : 'הריץ'} ${bash == 1 ? 'פקודה' : '$bash פקודות'}${failed ? ' · נכשל' : ''}');
  if (agents > 0) parts.add(f ? 'שלחה עוזר' : 'שלח עוזר');
  if (web > 0) parts.add(f ? 'קראה ברשת' : 'קרא ברשת');
  if (tells > 0) parts.add('${f ? 'שלחה' : 'שלח'} ${tells == 1 ? 'הודעה' : '$tells הודעות'}');
  if (memory > 0) parts.add(f ? 'רשמה לזיכרון' : 'רשם לזיכרון');
  if (teams > 0) parts.add(f ? 'פתחה צוות' : 'פתח צוות');
  final other = names.length - reads - searches - count((n) => n == 'Edit' || n == 'Write' || n == 'MultiEdit') - bash - agents - web - tells - memory - teams;
  if (other > 0) parts.add(f ? 'השתמשה בכלים' : 'השתמש בכלים');
  if (seconds != null && seconds > 0) parts.add("$seconds שנ'");
  return parts.join(' · ');
}
