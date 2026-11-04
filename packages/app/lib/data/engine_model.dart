import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// hq event log -> chat items. A Dart port of spikes/bet7-chat/model.ts, adapted to the
// EngineEvent kinds hq persists (packages/shared/src/shift-protocol.ts) instead of raw stream-json:
//   engine.text, engine.tool_use, engine.tool_result, engine.result, engine.user_echo,
//   engine.delta (live only, seq 0), shift.state.
// Pure: no IO. Feeding the same event twice is a no-op (dedupe by seq), so replay after a
// reconnect (`/ws?after=<seq>`) never duplicates a line (chat.md §7).
// The conversation model (chat.md §2.3א): a turn that reached the owner through `tell`/`ask`/`request_go`
// shows that item, not its own narration of it: the text written after that call is dropped when the turn ends.
// Text he saw before the call stays (hq stores it as the reply and the stored message replaces those bubbles).
import '../model/company_time.dart';
import '../model/models.dart';

class EngineModel {
  EngineModel({required this.items, required this.gender, this.onLive});
  final List<ChatItem> items;
  final Gender gender;
  final void Function(LiveState)? onLive;

  int lastSeq = 0;
  final _streams = <String, TextMsg>{};
  ToolGroup? _group;
  // toolUseId -> its group and index there. The group, not the open one: a result can come after text closed it
  // (Codex runs tools side by side), and an index into the next group threw RangeError or marked the wrong row.
  final _groupTools = <String, (ToolGroup, int)>{};
  final _hiddenTools = <String>{}; // toolUseIds with no row (hiddenTool)
  final _askCards = <String, HandoffCard>{}; // toolUseId -> its card (browser_ask_user)
  final _toolNames = <String, List<String>>{}; // group id -> tool names in order
  final _toolStarted = <String, DateTime>{};
  String? _why; // the worker's last text in this turn: "למה" on the details of the tool it calls next
  int? _shiftNo;
  String? _runShift; // the shift of the last engine event that names one (deltas, live-only, don't)
  final _turnTexts = <TextMsg>[];
  int? _toldAt; // how many of [_turnTexts] existed when the turn first reached the owner through a tool

  /// Applies one hq event `{seq, ts, type, identity, data}`.
  void apply(Map<String, dynamic> e) {
    final seq = (e['seq'] as num?)?.toInt() ?? 0;
    if (seq != 0 && seq <= lastSeq) return; // already applied (replay overlap)
    if (seq != 0) lastSeq = seq;
    final ts = DateTime.fromMillisecondsSinceEpoch((e['ts'] as num?)?.toInt() ?? CompanyTime.now().millisecondsSinceEpoch);
    final type = e['type'] as String? ?? '';
    final data = (e['data'] as Map?)?.cast<String, dynamic>() ?? const {};

    if (type == 'shift.state') {
      final id = data['id'] as String? ?? data['shift'] as String? ?? '';
      // A run that ended, or a new one starting, means the last turn is over even if it never sent `result`:
      // nothing carries into the next one, and a tool it was running stops spinning ("נקטע"). The `live` of
      // the run whose events we are showing is not that (its first frames can come before it).
      if (data['state'] != 'live' || id != _runShift) {
        _turnTexts.clear();
        _toldAt = null;
        for (final s in _streams.values) {
          s.streaming = false;
        }
        _streams.clear();
        _hiddenTools.clear();
        _groupTools.clear();
        for (final c in _askCards.values) {
          c.ended = true;
        }
        _askCards.clear();
        _why = null;
        _closeGroup(Outcome.interrupted);
        onLive?.call(const LiveState());
      }
      final n = int.tryParse(id.split('-').last);
      if (n != null && data['state'] == 'live' && _shiftNo != n) {
        if (_shiftNo != null) items.add(ShiftMarker(id: 'shift:$id', ts: ts, shift: n, from: _shiftNo!, seq: seq));
        _shiftNo = n;
      }
      return;
    }
    if (!type.startsWith('engine.')) return;
    if (data['shift'] is String) _runShift = data['shift'] as String;
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
        if (text.trim().isNotEmpty) _why = text;
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
        if (reachesOwner(name, ev['input'])) _toldAt ??= _turnTexts.length;
        final id = ev['toolUseId'] as String? ?? '$seq';
        final input = (ev['input'] as Map?)?.cast<String, dynamic>() ?? const {};
        // A message to the owner, a question or a GO request shows as its own item, and tool
        // housekeeping means nothing to him: no tool row for those (it read "השתמש בכלים" between
        // every two messages), and no row that appears and then vanishes.
        // A request for him in the server's browser is a card he acts on, not a tool row ("השתמש בכלי", 31/10).
        if (name == askUserTool) {
          _closeGroup(Outcome.ok);
          final card = HandoffCard(id: 'ask:$id', ts: ts, what: (input['what'] ?? '').toString().trim(), seq: seq);
          items.add(card);
          _askCards[id] = card;
          onLive?.call(LiveState(phase: LivePhase.tool, label: liveLabel(name, input, gender), labelBuilder: () => liveLabel(name, input, gender)));
          return;
        }
        if (hiddenTool(name, input)) {
          _hiddenTools.add(id);
          onLive?.call(LiveState(phase: LivePhase.tool, label: liveLabel(name, input, gender), labelBuilder: () => liveLabel(name, input, gender)));
          return;
        }
        final g = _group ??= _newGroup(ts, seq);
        _groupTools[id] = (g, g.tools.length);
        _toolStarted[id] = ts;
        (_toolNames[g.id] ??= []).add(name);
        g.tools.add(ToolLine(icon: toolIcon(name), label: toolDetail(name, input), labelBuilder: () => toolDetail(name, input), name: name, outcome: Outcome.running,
            call: ToolCall(name: name, input: input, started: ts, why: _why)));
        g.outcome = Outcome.running;
        g.liveLabelBuilder = () => liveLabel(name, input, gender);
        g.summaryBuilder = () => summarizeTools(_toolNames[g.id]!.sublist(0, _toolNames[g.id]!.length - 1), gender, files: _files(g));
        onLive?.call(LiveState(phase: LivePhase.tool, label: g.liveLabel, labelBuilder: () => g.liveLabel, runningCommand: name == 'Bash' ? (input['command'] as String?) : null));
      case 'tool_result':
        final id = ev['toolUseId'] as String? ?? '';
        if (_hiddenTools.remove(id)) {
          onLive?.call(const LiveState(phase: LivePhase.thinking));
          return;
        }
        final card = _askCards.remove(id);
        if (card != null) {
          card.ended = true;
          // browser-memory says "NOT asked" / "NOT notified" when he never got it (askUser.ts, marked there as read
          // by the app); a cancelled call is not that.
          card.failed = ev['isError'] == true && RegExp(r'NOT (asked|notified)').hasMatch(ev['preview'] as String? ?? '');
          onLive?.call(const LiveState(phase: LivePhase.thinking));
          return;
        }
        final at = _groupTools.remove(id);
        if (at == null) return;
        final (g, i) = at;
        final old = g.tools[i];
        final err = ev['isError'] == true;
        g.tools[i] = ToolLine(icon: old.icon, label: old.label, labelBuilder: old.labelBuilder, name: old.name, trail: old.trail, outcome: err ? Outcome.error : Outcome.ok,
            call: old.call?.done(at: ts, preview: ev['preview'] as String?, isError: err));
        if (err) g.outcome = Outcome.error;
        final started = g.ts;
        final secs = ts.difference(started).inSeconds;
        g.summaryBuilder = () => summarizeTools(_toolNames[g.id]!, gender, files: _files(g), seconds: secs, failed: g.tools.any((t) => t.outcome == Outcome.error));
        g.liveLabel = null;
      case 'result':
        for (final s in _streams.values) {
          s.streaming = false;
        }
        _streams.clear();
        _why = null;
        // A turn the host cut on purpose (his message at `now`, a stop) ended `interrupted`: no error, nothing to show.
        final cut = ev['interrupted'] == true;
        final failed = ev['isError'] == true && !cut;
        _closeGroup(cut ? Outcome.interrupted : failed ? Outcome.error : Outcome.ok);
        _groupTools.clear(); // a row the turn ended on stays stopped
        final toldAt = _toldAt;
        if (toldAt != null) {
          final drop = _turnTexts.skip(toldAt).toSet();
          items.removeWhere(drop.contains);
        }
        _turnTexts.clear();
        _toldAt = null;
        if (failed) {
          items.add(ErrorLine(id: 'r:$seq', ts: ts, text: UiCopy.text(800, [gender == Gender.f ? UiCopy.text(798) : UiCopy.text(799)]), textBuilder: () => UiCopy.text(800, [gender == Gender.f ? UiCopy.text(798) : UiCopy.text(799)]), seq: seq));
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
      if (t.outcome == Outcome.running) g.tools[i] = ToolLine(icon: t.icon, label: t.label, labelBuilder: t.labelBuilder, name: t.name, trail: t.trail, outcome: Outcome.interrupted, call: t.call);
    }
    g.liveLabel = null;
    _group = null;
  }
}

/// No tool row for these: the owner sees their result as its own item, or they are bookkeeping.
/// browser-memory's hand-over to him (B.9): a [HandoffCard] in the conversation.
const askUserTool = 'mcp__browser__browser_ask_user';

bool hiddenTool(String name, Object? input) => reachesOwner(name, input) || const {'ToolSearch', 'TodoWrite', 'ExitPlanMode'}.contains(name);

/// A company tool whose result the owner sees as its own item (a message, an ask card, a GO card).
bool reachesOwner(String name, Object? input) =>
    name == 'mcp__company__ask' ||
    name == 'mcp__company__request_go' ||
    (name == 'mcp__company__tell' && input is Map && {'owner', companyNames.owner, companyNames.ownerId}.contains(input['to']));

String toolIcon(String name) => switch (name) {
      'Read' => 'description',
      'Grep' || 'Glob' || 'WebSearch' => 'search',
      'WebFetch' => 'open_in_new',
      'Edit' || 'Write' || 'MultiEdit' || 'NotebookEdit' => 'edit',
      'Bash' => 'terminal',
      'Task' || 'Agent' => 'person',
      'mcp__company__remember' => 'bookmark_add',
      'mcp__company__recall' => 'manage_search',
      'mcp__company__tell' => 'chat',
      'mcp__company__ask' => 'help',
      'mcp__company__open_team' => 'group_add',
      'mcp__company__close_team' => 'task_alt',
      'mcp__company__request_go' => 'front_hand',
      'mcp__company__status' => 'flag',
      'mcp__company__compose_home' => 'home',
      _ => 'build',
    };

/// What a tool row says in Hebrew, past tense (נועה, 22/10): never the tool's internal name. A tool not on
/// this list is "השתמש בכלי", and its name shows only on the details screen.
String toolLabel(String name, Gender g) {
  final f = g == Gender.f;
  return switch (name) {
    'mcp__company__remember' => f ? UiCopy.text(801) : UiCopy.text(802),
    'mcp__company__recall' => f ? UiCopy.text(803) : UiCopy.text(804),
    'mcp__company__tell' => f ? UiCopy.text(805) : UiCopy.text(806),
    'mcp__company__ask' => f ? UiCopy.text(807) : UiCopy.text(808),
    'mcp__company__open_team' => f ? UiCopy.text(809) : UiCopy.text(810),
    'mcp__company__close_team' => f ? UiCopy.text(811) : UiCopy.text(812),
    'mcp__company__request_go' => f ? UiCopy.text(813) : UiCopy.text(814),
    'mcp__company__status' => f ? UiCopy.text(815) : UiCopy.text(816),
    'mcp__company__compose_home' => f ? UiCopy.text(817) : UiCopy.text(818),
    'Bash' => f ? UiCopy.text(819) : UiCopy.text(820),
    'Read' => f ? UiCopy.text(821) : UiCopy.text(822),
    'Edit' || 'Write' || 'MultiEdit' || 'NotebookEdit' => f ? UiCopy.text(823) : UiCopy.text(824),
    'Grep' || 'Glob' => f ? UiCopy.text(825) : UiCopy.text(826),
    'WebSearch' || 'WebFetch' => f ? UiCopy.text(827) : UiCopy.text(828),
    'Task' || 'Agent' => UiCopy.text(829),
    _ => f ? UiCopy.text(830) : UiCopy.text(831),
  };
}

/// Tools with no LTR detail of their own (company tools, unknown ones): the row is the Hebrew label alone.
bool toolKnown(String name) => const {
  'mcp__company__remember', 'mcp__company__recall', 'mcp__company__tell', 'mcp__company__ask',
  'mcp__company__open_team', 'mcp__company__close_team', 'mcp__company__request_go',
  'mcp__company__status', 'mcp__company__compose_home', 'Bash', 'Read', 'Edit', 'Write',
  'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Task', 'Agent',
}.contains(name);

bool toolHasAgentDescription(ToolLine tool) => (tool.name == 'Task' || tool.name == 'Agent') &&
    hebrewOrEmpty((tool.call?.input['description'] ?? '').toString()).isNotEmpty;

bool toolHasDetail(String name) => const {'Read', 'Edit', 'Write', 'MultiEdit', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'}.contains(name);

/// The LTR detail line of one tool (chat.md §2.4 table, open state).
String toolDetail(String name, Map<String, dynamic> input) {
  String s(String k) => (input[k] ?? '').toString();
  return switch (name) {
    'Read' || 'Edit' || 'Write' || 'MultiEdit' => s('file_path'),
    'Grep' => '"${s('pattern')}"${input['path'] != null ? ' in ${s('path')}' : ''}',
    'Glob' => s('pattern'),
    'Bash' => s('command'),
    'Task' || 'Agent' => hebrewOrEmpty(s('description')).isNotEmpty ? s('description') : UiCopy.text(829),
    'WebFetch' => s('url'),
    'WebSearch' => s('query'),
    _ => name,
  };
}

/// A tool's own description is shown only when it has Hebrew (dir-0002); otherwise the caller falls back to a generic Hebrew line.
String hebrewOrEmpty(String d) => (!UiCopy.legacy && UiCopy.copy.localeName == 'en' && RegExp(r'[A-Za-z]').hasMatch(d)) ? d : RegExp(InputCopy.v5).hasMatch(d) ? d : '';

/// What the live tool row says while it runs: "מריץ בדיקות".
String liveLabel(String name, Map<String, dynamic> input, Gender g) {
  final f = g == Gender.f;
  if (name == 'Bash') {
    final cmd = (input['command'] ?? '').toString();
    if (_isTest(cmd)) return f ? UiCopy.text(832) : UiCopy.text(833);
    final d = hebrewOrEmpty((input['description'] ?? '').toString());
    return d.isNotEmpty ? d : (f ? UiCopy.text(834) : UiCopy.text(835));
  }
  return switch (name) {
    'Read' => f ? UiCopy.text(836) : UiCopy.text(837),
    'Grep' || 'Glob' => f ? UiCopy.text(838) : UiCopy.text(839),
    'Edit' || 'Write' || 'MultiEdit' => f ? UiCopy.text(840) : UiCopy.text(841),
    'Task' || 'Agent' => f ? UiCopy.text(842) : UiCopy.text(843),
    'mcp__company__tell' => f ? UiCopy.text(844) : UiCopy.text(845),
    'mcp__company__ask' => f ? UiCopy.text(846) : UiCopy.text(847),
    'mcp__company__remember' => f ? UiCopy.text(848) : UiCopy.text(849),
    'mcp__company__open_team' => f ? UiCopy.text(850) : UiCopy.text(851),
    askUserTool => UiCopy.text(852),
    _ => f ? UiCopy.text(85) : UiCopy.text(86),
  };
}

bool _isTest(String cmd) => RegExp(r'\b(go test|flutter test|pytest|npm (run )?test|node --test|jest|vitest)\b').hasMatch(cmd);

String _times(int n, bool f) => switch (n) { 1 => UiCopy.text(853), 2 => UiCopy.text(854), _ => UiCopy.text(855, [n]) };

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
  if (reads > 0) parts.add('${f ? UiCopy.text(856) : UiCopy.text(857)} ${reads == 1 ? UiCopy.text(858) : UiCopy.text(267, [reads])}');
  if (searches > 0) parts.add('${f ? UiCopy.text(859) : UiCopy.text(860)} ${_times(searches, f)}');
  if (edits.length == 1) parts.add('${f ? UiCopy.text(861) : UiCopy.text(862)} `${edits.first}`');
  if (edits.length > 1) parts.add(UiCopy.text(863, [f ? UiCopy.text(861) : UiCopy.text(862), edits.length]));
  if (bash > 0) parts.add('${f ? UiCopy.text(864) : UiCopy.text(865)} ${bash == 1 ? UiCopy.text(366) : UiCopy.text(866, [bash])}${failed ? UiCopy.text(867) : ''}');
  if (agents > 0) parts.add(f ? UiCopy.text(868) : UiCopy.text(869));
  if (web > 0) parts.add(f ? UiCopy.text(870) : UiCopy.text(871));
  if (tells > 0) parts.add('${f ? UiCopy.text(872) : UiCopy.text(873)} ${tells == 1 ? UiCopy.text(874) : UiCopy.text(24, [tells])}');
  if (memory > 0) parts.add(f ? UiCopy.text(801) : UiCopy.text(802));
  if (teams > 0) parts.add(f ? UiCopy.text(875) : UiCopy.text(876));
  final other = names.length - reads - searches - count((n) => n == 'Edit' || n == 'Write' || n == 'MultiEdit') - bash - agents - web - tells - memory - teams;
  if (other > 0) parts.add(f ? UiCopy.text(877) : UiCopy.text(878));
  if (seconds != null && seconds > 0) parts.add(UiCopy.text(272, [seconds]));
  return parts.join(' · ');
}
