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
          items.add(ErrorLine(id: 'r:$seq', ts: ts, text: UiCopy.copy.workEndedError(gender == Gender.f ? UiCopy.copy.theyWillTry : UiCopy.copy.theyWillTry2), textBuilder: () => UiCopy.copy.workEndedError(gender == Gender.f ? UiCopy.copy.theyWillTry : UiCopy.copy.theyWillTry2), seq: seq));
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
    'mcp__company__remember' => f ? UiCopy.copy.savedMemory : UiCopy.copy.savedMemory2,
    'mcp__company__recall' => f ? UiCopy.copy.searchedMemory : UiCopy.copy.searchedMemory2,
    'mcp__company__tell' => f ? UiCopy.copy.sentMessage : UiCopy.copy.sentMessage2,
    'mcp__company__ask' => f ? UiCopy.copy.askedYouQuestion : UiCopy.copy.askedYouQuestion2,
    'mcp__company__open_team' => f ? UiCopy.copy.openedTask : UiCopy.copy.openedTask2,
    'mcp__company__close_team' => f ? UiCopy.copy.closedTask : UiCopy.copy.closedTask2,
    'mcp__company__request_go' => f ? UiCopy.copy.requestedApproval : UiCopy.copy.requestedApproval2,
    'mcp__company__status' => f ? UiCopy.copy.updatedStatus : UiCopy.copy.updatedStatus2,
    'mcp__company__compose_home' => f ? UiCopy.copy.updatedHome : UiCopy.copy.updatedHome2,
    'Bash' => f ? UiCopy.copy.ranCommand : UiCopy.copy.ranCommand2,
    'Read' => f ? UiCopy.copy.readFile : UiCopy.copy.readFile2,
    'Edit' || 'Write' || 'MultiEdit' || 'NotebookEdit' => f ? UiCopy.copy.editedFile : UiCopy.copy.editedFile2,
    'Grep' || 'Glob' => f ? UiCopy.copy.searchedCode : UiCopy.copy.searchedCode2,
    'WebSearch' || 'WebFetch' => f ? UiCopy.copy.searchedWeb : UiCopy.copy.searchedWeb2,
    'Task' || 'Agent' => UiCopy.copy.assistant2,
    _ => f ? UiCopy.copy.usedTool : UiCopy.copy.usedTool2,
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
    'Task' || 'Agent' => hebrewOrEmpty(s('description')).isNotEmpty ? s('description') : UiCopy.copy.assistant2,
    'WebFetch' => s('url'),
    'WebSearch' => s('query'),
    _ => name,
  };
}

/// A tool's own description is shown only when it has Hebrew (dir-0002); otherwise the caller falls back to a generic Hebrew line.
String hebrewOrEmpty(String d) => (UiCopy.copy.localeName == 'en' && RegExp(r'[A-Za-z]').hasMatch(d)) ? d : RegExp(InputCopy.v5).hasMatch(d) ? d : '';

/// What the live tool row says while it runs: "מריץ בדיקות".
String liveLabel(String name, Map<String, dynamic> input, Gender g) {
  final f = g == Gender.f;
  if (name == 'Bash') {
    final cmd = (input['command'] ?? '').toString();
    if (_isTest(cmd)) return f ? UiCopy.copy.runningTests : UiCopy.copy.runningTests2;
    final d = hebrewOrEmpty((input['description'] ?? '').toString());
    return d.isNotEmpty ? d : (f ? UiCopy.copy.runningCommand : UiCopy.copy.runningCommand2);
  }
  return switch (name) {
    'Read' => f ? UiCopy.copy.reading : UiCopy.copy.reading2,
    'Grep' || 'Glob' => f ? UiCopy.copy.searching : UiCopy.copy.searching2,
    'Edit' || 'Write' || 'MultiEdit' => f ? UiCopy.copy.editing : UiCopy.copy.editing2,
    'Task' || 'Agent' => f ? UiCopy.copy.startingAssistant : UiCopy.copy.startingAssistant2,
    'mcp__company__tell' => f ? UiCopy.copy.writing : UiCopy.copy.writing2,
    'mcp__company__ask' => f ? UiCopy.copy.asking : UiCopy.copy.asking2,
    'mcp__company__remember' => f ? UiCopy.copy.savingMemory : UiCopy.copy.savingMemory2,
    'mcp__company__open_team' => f ? UiCopy.copy.openingTeam : UiCopy.copy.openingTeam2,
    askUserTool => UiCopy.copy.waitingYouBrowser,
    _ => f ? UiCopy.copy.working2 : UiCopy.copy.working3,
  };
}

bool _isTest(String cmd) => RegExp(r'\b(go test|flutter test|pytest|npm (run )?test|node --test|jest|vitest)\b').hasMatch(cmd);

String _times(int n, bool f) => switch (n) { 1 => UiCopy.copy.once, 2 => UiCopy.copy.twice, _ => UiCopy.copy.times(n) };

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
  if (reads > 0) parts.add('${f ? UiCopy.copy.read2 : UiCopy.copy.read3} ${reads == 1 ? UiCopy.copy.file2 : UiCopy.copy.files(reads)}');
  if (searches > 0) parts.add('${f ? UiCopy.copy.searched : UiCopy.copy.searched2} ${_times(searches, f)}');
  if (edits.length == 1) parts.add('${f ? UiCopy.copy.edited : UiCopy.copy.edited2} `${edits.first}`');
  if (edits.length > 1) parts.add(UiCopy.copy.files3(f ? UiCopy.copy.edited : UiCopy.copy.edited2, edits.length));
  if (bash > 0) parts.add('${f ? UiCopy.copy.ran : UiCopy.copy.ran2} ${bash == 1 ? UiCopy.copy.command3 : UiCopy.copy.commands2(bash)}${failed ? UiCopy.copy.failed4 : ''}');
  if (agents > 0) parts.add(f ? UiCopy.copy.startedAssistant : UiCopy.copy.startedAssistant2);
  if (web > 0) parts.add(f ? UiCopy.copy.readOnline : UiCopy.copy.readOnline2);
  if (tells > 0) parts.add('${f ? UiCopy.copy.sent2 : UiCopy.copy.sent3} ${tells == 1 ? UiCopy.copy.message3 : UiCopy.copy.messages2(tells)}');
  if (memory > 0) parts.add(f ? UiCopy.copy.savedMemory : UiCopy.copy.savedMemory2);
  if (teams > 0) parts.add(f ? UiCopy.copy.openedTeam : UiCopy.copy.openedTeam2);
  final other = names.length - reads - searches - count((n) => n == 'Edit' || n == 'Write' || n == 'MultiEdit') - bash - agents - web - tells - memory - teams;
  if (other > 0) parts.add(f ? UiCopy.copy.usedTools : UiCopy.copy.usedTools2);
  if (seconds != null && seconds > 0) parts.add(UiCopy.copy.s(seconds));
  return parts.join(' · ');
}
