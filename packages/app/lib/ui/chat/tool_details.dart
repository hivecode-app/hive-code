import 'package:agent_company/l10n/ui_copy.dart';
// What a worker did with one tool, in plain Hebrew (נועה, 22/10): a tap on a tool row in the chat opens it.
// A full-height sheet on the phone, the side panel on a wide desktop. Above: the icon, the Hebrew label, who
// and when. Below, by kind: what went into memory and where, the message and whom it answered, how a command
// ended, the file and its diff, and for the rest labelled fields with the raw JSON folded under them.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/engine_model.dart';
import '../../data/hq_backend.dart' show withoutIds;
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'items.dart' show DiffBody;
import 'markdown.dart';

/// The desktop's side panel for tool details. Null selection: the column shows what it showed before.
class ToolPanel extends ChangeNotifier {
  ({String identityId, ToolCall call, String chat})? shown;

  /// [chat]: the conversation it was opened from, which the column belongs to while it is open (a message between
  /// workers is opened from either one's, and its sender is not always that one).
  void show(String identityId, ToolCall call, {String? chat}) {
    shown = (identityId: identityId, call: call, chat: chat ?? identityId);
    notifyListeners();
  }

  void close() {
    if (shown == null) return;
    shown = null;
    notifyListeners();
  }
}

/// Put by the desktop frame when it has a side column to show details in.
class ToolPanelScope extends InheritedNotifier<ToolPanel> {
  const ToolPanelScope({super.key, required ToolPanel panel, required super.child}) : super(notifier: panel);
  static ToolPanel? maybeOf(BuildContext context) => context.dependOnInheritedWidgetOfExactType<ToolPanelScope>()?.notifier;
}

void openToolDetails(BuildContext context, String identityId, ToolCall call, {String? chat}) {
  final panel = context.getInheritedWidgetOfExactType<ToolPanelScope>()?.notifier;
  if (panel != null) return panel.show(identityId, call, chat: chat);
  final p = context.p;
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: p.surface,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
    builder: (ctx) => SizedBox(
      height: MediaQuery.sizeOf(ctx).height,
      child: ToolDetails(identityId: identityId, call: call, onClose: () => Navigator.of(ctx).pop()),
    ),
  );
}

/// A message between two workers opens the same screen as the "שלח הודעה" it came from: the text whole, from and to, and
/// what it answers.
void openInternalMessage(BuildContext context, InternalMsg m) {
  final call = ToolCall(
    name: 'mcp__company__tell',
    input: {'to': m.to, 'body': m.body, if (m.ref != null) 'ref': m.ref, 'messageId': m.messageId},
    started: m.ts,
    ended: m.ts,
  );
  openToolDetails(context, m.from, call, chat: StoreScope.read(context).selectedConversation);
}

/// A conversation, with the message in it brought into view and lit for a moment. From the details this closes
/// them first (the sheet on the phone, the side panel on a desktop).
void _openChat(BuildContext context, String worker, {String? id, String? text}) {
  // The side panel closes; without one the details are a sheet over the screen, which closes first.
  final panel = ToolPanelScope.maybeOf(context);
  panel?.close();
  Nav.chat(context, worker, closeSheet: panel == null, message: (id: id, text: text));
}

class ToolDetails extends StatelessWidget {
  const ToolDetails({super.key, required this.identityId, required this.call, required this.onClose});
  final String identityId;
  final ToolCall call;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data;
    if (d == null) return const SizedBox.shrink();
    final who = d.who(identityId);
    final c = call;
    final label = toolLabel(c.name, who.gender);
    final sections = switch (c.name) {
      'mcp__company__remember' => _remember(context, d, c),
      'mcp__company__tell' => _tell(context, d, c),
      'Bash' => _bash(context, c),
      'Read' || 'Edit' || 'Write' || 'MultiEdit' => _file(context, c),
      _ => _other(context, c),
    };
    final why = _lastSentence(c.why);
    return Material(
      color: p.surface,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(20, 14, 8, 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Padding(padding: const EdgeInsets.only(top: 2), child: Ic(toolIcon(c.name), size: 24, color: p.text)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(label, style: T.bar.copyWith(color: p.text)),
                const SizedBox(height: 4),
                Row(children: [
                  Monogram.of(d, identityId, size: AvSize.xs),
                  const SizedBox(width: 8),
                  Flexible(child: Text('${who.name} · ${_when(c.started)}', style: T.small.copyWith(color: p.text2))),
                ]),
              ]),
            ),
            IconButton(onPressed: onClose, tooltip: UiCopy.copy.close2, icon: Ic('close', size: 22, color: p.text2)),
          ]),
        ),
        Divider(height: 1, color: p.line),
        Expanded(
          child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
            ...sections,
            if (why != null) _Section(UiCopy.copy.why2, child: Rich(why, style: T.row2.copyWith(color: p.text))),
          ]),
        ),
      ]),
    );
  }

  // ── רשם לזיכרון ──

  List<Widget> _remember(BuildContext context, CompanyData d, ToolCall c) {
    final p = context.p;
    final i = c.input;
    final text = (i['text'] ?? i['content'] ?? '').toString();
    final file = i['file'] as String?;
    final quote = i['quote'] as String?;
    final kind = _kinds[i['kind']];
    final where = memoryWhere(d, i);
    return [
      if (c.isError) _failed(context, c),
      _Section(UiCopy.copy.recorded, child: _Box(child: Markdown(text))),
      _Section(UiCopy.copy.where, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(where, style: T.row2.copyWith(color: p.text)),
        if (file != null) Padding(padding: const EdgeInsets.only(top: 2), child: _Ltr(file, color: p.text2, size: 12)),
      ])),
      if (kind != null) _Section(UiCopy.copy.type2, child: Text(kind, style: T.row2.copyWith(color: p.text))),
      if (quote != null && quote.trim().isNotEmpty)
        _Section(UiCopy.copy.quote, child: _Quoted(child: Text('«${quote.trim()}»', style: T.row2.copyWith(color: p.text)))),
    ];
  }

  // ── שלח הודעה ──

  List<Widget> _tell(BuildContext context, CompanyData d, ToolCall c) {
    final p = context.p;
    final to = (c.input['to'] ?? '').toString();
    final body = (c.input['body'] ?? c.input['text'] ?? '').toString();
    final refId = c.input['ref'] as String?;
    final ref = refId == null ? null : _findRef(d, refId);
    final messageId = c.input['messageId'] as String?;
    final toId = to == 'owner' ? companyNames.ownerId : to;
    // The message in the conversation it went to: by its id when it is known, else by the start of its text.
    void open(String worker) => _openChat(context, worker, id: messageId, text: withoutIds(body));
    final refChat = ref == null ? null : (ref.from == 'owner' ? identityId : ref.from);
    return [
      if (c.isError) _failed(context, c),
      _Section(UiCopy.copy.from, child: _Person(id: identityId, onTap: d.canChat(identityId) ? () => open(identityId) : null)),
      _Section(UiCopy.copy.to3, child: _Person(id: toId, name: to, onTap: d.identities.containsKey(toId) && d.canChat(toId) ? () => open(toId) : null)),
      _Section(UiCopy.copy.message2, child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(12)),
          child: Markdown(body),
        ),
      )),
      if (ref != null)
        _Section(UiCopy.copy.reply, child: _Quoted(
          onTap: refChat != null && d.canChat(refChat) ? () => _openChat(context, refChat, id: refId, text: withoutIds(ref.body)) : null,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${d.who(ref.from).name} · ${_when(ref.ts)}', style: T.small.copyWith(color: p.text2, fontWeight: FontWeight.w700)),
            const SizedBox(height: 2),
            _Folding(text: ref.body, lines: 4),
          ]),
        )),
      if (d.identities.containsKey(toId) && d.canChat(toId))
        Padding(
          padding: const EdgeInsets.only(top: 24),
          child: OutlinedButton.icon(
            style: OutlinedButton.styleFrom(minimumSize: const Size(0, 48), side: BorderSide(color: p.line), foregroundColor: p.text),
            onPressed: () => open(toId),
            icon: Ic('chat', size: 20, color: p.text),
            label: Text(UiCopy.copy.chat(d.who(toId).name), style: T.button),
          ),
        ),
    ];
  }

  RefMessage? _findRef(CompanyData d, String id) {
    for (final chat in d.chats.values) {
      final m = chat.refs[id];
      if (m != null) return m;
    }
    return null;
  }

  // ── הריץ פקודה ──

  List<Widget> _bash(BuildContext context, ToolCall c) {
    final p = context.p;
    final title = hebrewOrEmpty((c.input['description'] ?? '').toString());
    final cmd = (c.input['command'] ?? '').toString();
    final out = c.preview ?? '';
    return [
      if (title.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(title, style: T.name.copyWith(color: p.text))),
      _Section(UiCopy.copy.activity, child: _outcome(context, c)),
      _Section(UiCopy.copy.command2, child: _CodeFold(code: cmd, foldedLines: 2, open: UiCopy.copy.showFullCommand)),
      if (out.trim().isNotEmpty) _Section(UiCopy.copy.output, child: _CodeFold(code: out.trimRight(), foldedLines: _short(out) ? 3 : 0, open: _outputLabel(out))),
    ];
  }

  /// Three lines or fewer show as they are; anything longer folds behind "הצגת הפלט".
  bool _short(String out) => !out.endsWith('…') && '\n'.allMatches(out.trimRight()).length < 3;

  String _outputLabel(String out) {
    final cut = out.endsWith('…');
    final n = '\n'.allMatches(out.trimRight()).length + 1;
    // hq keeps the first 400 characters of a result: past that, the real line count is unknown.
    if (cut) return UiCopy.copy.showFirstLines;
    return n == 1 ? UiCopy.copy.showOutputOne : UiCopy.copy.showOutputLines(n);
  }

  Widget _outcome(BuildContext context, ToolCall c) {
    final p = context.p;
    final secs = c.ended?.difference(c.started).inMilliseconds;
    final dur = secs == null ? '' : ' · ${_duration(secs)}';
    if (c.ended == null) return _IconLine(icon: 'progress_activity', text: UiCopy.copy.stillRunning, color: p.text);
    if (!c.isError) return _IconLine(icon: 'check_circle', text: UiCopy.copy.completed(dur), color: p.text);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _IconLine(icon: 'error', text: UiCopy.copy.failed3(dur), color: p.text, bold: true),
      if (_lastLine(c.preview) case final l?)
        Padding(padding: const EdgeInsets.only(top: 6), child: _Box(child: _Ltr(l, color: p.text, size: 12.5, wrap: true))),
    ]);
  }

  Widget _failed(BuildContext context, ToolCall c) => _Section(UiCopy.copy.activity, child: _outcome(context, c));

  // ── קרא קובץ / ערך קובץ ──

  List<Widget> _file(BuildContext context, ToolCall c) {
    final p = context.p;
    final path = (c.input['file_path'] ?? '').toString();
    final i = path.lastIndexOf('/');
    final name = i < 0 ? path : path.substring(i + 1);
    final from = (c.input['offset'] as num?)?.toInt();
    final limit = (c.input['limit'] as num?)?.toInt();
    return [
      if (c.isError) _failed(context, c),
      _Section(UiCopy.copy.file, child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _Ltr(name, color: p.text, size: 15, bold: true),
        Padding(padding: const EdgeInsets.only(top: 2), child: _Ltr(i < 0 ? path : path.substring(0, i + 1), color: p.text2, size: 12, wrap: true)),
        if (c.name == 'Read' && (from != null || limit != null))
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(UiCopy.copy.lines(from ?? 1, (from ?? 1) + (limit ?? 2000) - 1), style: T.small.copyWith(color: p.text2)),
          ),
      ])),
      if (c.name != 'Read') ...[
        if (_diff(c) case final f?)
          _Section(_diffTitle(f), child: ClipRRect(borderRadius: BorderRadius.circular(8), child: DiffBody(file: f))),
      ],
    ];
  }

  String _diffTitle(DiffFile f) {
    String n(int k, String one, String many) => k == 1 ? one : '$k $many';
    final parts = [if (f.add > 0) n(f.add, UiCopy.copy.oneLineAdded, UiCopy.copy.linesAdded), if (f.del > 0) n(f.del, UiCopy.copy.oneLineDeleted, UiCopy.copy.linesDeleted)];
    return parts.isEmpty ? UiCopy.copy.change2 : parts.join(' · ');
  }

  /// A small diff from the edit itself: the old lines out, the new ones in (no line numbers: the tool has none).
  DiffFile? _diff(ToolCall c) {
    final path = (c.input['file_path'] ?? '').toString();
    final edits = c.name == 'MultiEdit'
        ? [for (final e in (c.input['edits'] as List? ?? const [])) if (e is Map) (e['old_string']?.toString() ?? '', e['new_string']?.toString() ?? '')]
        : c.name == 'Write'
            ? [('', (c.input['content'] ?? '').toString())]
            : [((c.input['old_string'] ?? '').toString(), (c.input['new_string'] ?? '').toString())];
    var add = 0, del = 0;
    final hunks = <DiffHunk>[];
    for (final (o, n) in edits) {
      final ol = o.isEmpty ? <String>[] : o.split('\n');
      final nl = n.isEmpty ? <String>[] : n.split('\n');
      // Lines both sides share at the edges are context, not change.
      var head = 0;
      while (head < ol.length && head < nl.length && ol[head] == nl[head]) {
        head++;
      }
      var tail = 0;
      while (tail < ol.length - head && tail < nl.length - head && ol[ol.length - 1 - tail] == nl[nl.length - 1 - tail]) {
        tail++;
      }
      final lines = <DiffLine>[
        for (var k = 0; k < head; k++) DiffLine(DiffLineKind.ctx, k + 1, ol[k]),
        for (var k = head; k < ol.length - tail; k++) DiffLine(DiffLineKind.del, k + 1, ol[k]),
        for (var k = head; k < nl.length - tail; k++) DiffLine(DiffLineKind.add, k + 1, nl[k]),
        for (var k = ol.length - tail; k < ol.length; k++) DiffLine(DiffLineKind.ctx, k + 1, ol[k]),
      ];
      add += nl.length - head - tail;
      del += ol.length - head - tail;
      // A whole new file shows its first 30 lines.
      hunks.add(DiffHunk(edits.length > 1 ? UiCopy.copy.change3(hunks.length + 1) : '', lines.length > 30 ? lines.sublist(0, 30) : lines));
    }
    if (hunks.isEmpty) return null;
    return DiffFile(path: path, add: add, del: del, hunks: [for (final h in hunks) DiffHunk(h.header, h.lines)]);
  }

  // ── כל השאר ──

  List<Widget> _other(BuildContext context, ToolCall c) {
    final p = context.p;
    final known = toolKnown(c.name);
    // An unknown tool's name shows here only, as code (נועה, 22/10).
    final fields = [
      for (final e in c.input.entries)
        if (_fieldNames[e.key] != null && e.value != null && e.value.toString().trim().isNotEmpty) (_fieldNames[e.key]!, e.value),
    ];
    final out = c.preview ?? '';
    final json = RegExp(r'^\s*[\[{]').hasMatch(out);
    return [
      if (!known) Padding(padding: const EdgeInsets.only(top: 12), child: Align(alignment: AlignmentDirectional.centerStart, child: _Chip(c.name))),
      _Section(UiCopy.copy.activity, child: _outcome(context, c)),
      for (final (k, v) in fields)
          _Section(k, child: v is String ? _Folding(text: v, lines: 6) : _Ltr(v is List ? v.join(', ') : jsonEncode(v), color: p.text, size: 12.5, wrap: true)),
      // A reply in words is worth showing; a JSON reply is a technical detail like the input.
      if (out.trim().isNotEmpty && !json) _Section(UiCopy.copy.result, child: _CodeFold(code: out, foldedLines: 3, open: UiCopy.copy.showAll)),
      _Section(UiCopy.copy.technicalDetails, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _CodeFold(code: const JsonEncoder.withIndent('  ').convert(c.input), foldedLines: 0, open: UiCopy.copy.showToolInput),
        if (json) _CodeFold(code: out, foldedLines: 0, open: UiCopy.copy.showToolResult),
      ])),
    ];
  }
}

/// Where a `remember` landed, in words: "זיכרון החברה · ספר העיצוב", "לומו · החלטות".
String memoryWhere(CompanyData d, Map<String, dynamic> i) {
  final file = i['file'] as String?;
  final scope = i['scope'] as String?;
  String projectName(String id) => d.projects.where((p) => p.id == id).map((p) => p.name).firstOrNull ?? id;
  if (file != null) {
    final parts = file.split('/');
    final base = parts.last.replaceAll(RegExp(r'\.md$'), '');
    final open = RegExp(r'^open-(.+)$').firstMatch(base);
    final what = open != null
        ? UiCopy.copy.openWork2(d.identities[open.group(1)]?.name ?? open.group(1)!)
        : _files[base] ?? (base.endsWith('-actions') ? UiCopy.copy.actions : base);
    if (parts.length >= 3 && parts[1] == 'projects') return '${projectName(parts[2])} · $what';
    if (parts.length >= 4 && parts[1] == 'company') return '${_teams[parts[2]] ?? UiCopy.copy.companyMemory} · $what';
    return UiCopy.copy.companyMemory2(what);
  }
  final kind = _kindsPlural[i['kind']] ?? UiCopy.copy.records;
  return switch (scope) {
    'project' => '${i['project'] is String ? projectName(i['project'] as String) : UiCopy.copy.projectMemory} · $kind',
    'personal' => UiCopy.copy.yourMemory(kind),
    'identity' => UiCopy.copy.workerMemory(kind),
    _ => UiCopy.copy.companyMemory2(kind),
  };
}

final _files = {
  'design-taste': UiCopy.copy.designGuide,
  'decisions': UiCopy.copy.decisions,
  'lessons': UiCopy.copy.lessons,
  'customers': UiCopy.copy.customers,
  'conventions': UiCopy.copy.procedures,
  'time-estimates': UiCopy.copy.timeEstimates,
  'repos': UiCopy.copy.repositories,
  'INDEX': UiCopy.copy.contents,
};
final _teams = {'design': UiCopy.copy.designTeam, 'monitoring': UiCopy.copy.monitoringTeam, 'improvement': UiCopy.copy.improvementTeam};
final _kinds = {'decision': UiCopy.copy.decision, 'lesson': UiCopy.copy.lesson, 'fact': UiCopy.copy.fact, 'directive': UiCopy.copy.instruction, 'trap': UiCopy.copy.pitfall, 'command': UiCopy.copy.command3};
final _kindsPlural = {'decision': UiCopy.copy.decisions, 'lesson': UiCopy.copy.lessons, 'fact': UiCopy.copy.facts, 'directive': UiCopy.copy.instructions, 'trap': UiCopy.copy.pitfalls, 'command': UiCopy.copy.commands};

/// Input fields worth a Hebrew label on the generic details; the rest stay in "פרטים טכניים".
final _fieldNames = {
  'query': UiCopy.copy.search2,
  'pattern': UiCopy.copy.search2,
  'path': UiCopy.copy.where,
  'url': UiCopy.copy.address,
  'prompt': UiCopy.copy.request3,
  'description': UiCopy.copy.description,
  'title': UiCopy.copy.title,
  'brief': UiCopy.copy.brief,
  'headline': UiCopy.copy.summary,
  'question': UiCopy.copy.question3,
  'options': UiCopy.copy.options,
  'summary': UiCopy.copy.summary2,
  'state': UiCopy.copy.state,
  'project': UiCopy.copy.project,
  'priority': UiCopy.copy.priority,
  'reason': UiCopy.copy.reason,
  'risk': UiCopy.copy.risk2,
  'rollback': UiCopy.copy.rollback2,
  'what': UiCopy.copy.what,
  'scope': UiCopy.copy.scope,
  'need': UiCopy.copy.needed,
};

String _when(DateTime t) {
  final now = CompanyTime.now();
  final today = dayStart(now);
  final day = dayStart(t);
  if (day == today) return UiCopy.copy.today3(hm(t));
  if (today.difference(day).inDays == 1) return UiCopy.copy.yesterday4(hm(t));
  return '${dm(t)} ${hm(t)}';
}

String _duration(int ms) {
  if (ms < 1000) return UiCopy.copy.lessThanSecond;
  if (ms < 10000) return UiCopy.copy.s((ms / 1000).toStringAsFixed(1));
  final s = ms ~/ 1000;
  if (s < 60) return UiCopy.copy.s(s);
  return UiCopy.copy.min2(s ~/ 60, (s % 60).toString().padLeft(2, '0'));
}

/// The last non-empty line of an error, without the "…" hq adds when it cuts.
String? _lastLine(String? out) {
  if (out == null) return null;
  final cut = out.endsWith('…');
  final all = out.split('\n');
  // A cut preview ends mid-line: the last whole line says more than half of one.
  if (cut && all.length > 1) all.removeLast();
  final lines = all.map((l) => l.trim()).where((l) => l.isNotEmpty && l != '---' && !RegExp(r'^Exit code \d+$').hasMatch(l)).toList();
  return lines.isEmpty ? null : lines.last.replaceAll(RegExp(r'…$'), '');
}

/// "למה": the last sentence the worker wrote before the call.
String? _lastSentence(String? text) {
  if (text == null) return null;
  final paras = text.trim().split(RegExp(r'\n\s*\n')).where((s) => s.trim().isNotEmpty).toList();
  if (paras.isEmpty) return null;
  final last = paras.last.trim();
  if (last.length <= 240) return last;
  final sentences = last.split(RegExp(r'(?<=[.!?:])\s+')).where((s) => s.trim().isNotEmpty).toList();
  return sentences.isEmpty ? last : sentences.last.trim();
}

class _Section extends StatelessWidget {
  const _Section(this.title, {required this.child});
  final String title;
  final Widget child;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.only(top: 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(title, style: T.section.copyWith(color: p.text2)),
        const SizedBox(height: 6),
        child,
      ]),
    );
  }
}

/// A quote: a bar on the start side, the text beside it, on surface2.
class _Quoted extends StatelessWidget {
  const _Quoted({required this.child, this.onTap});
  final Widget child;

  /// A quote that leads somewhere (the message it quotes) shows a chevron at its end.
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final box = ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: Container(
        color: p.surface2,
        child: IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(width: 3, color: p.text3),
            Expanded(child: Padding(padding: const EdgeInsetsDirectional.fromSTEB(10, 6, 12, 8), child: child)),
            if (onTap != null) Padding(padding: const EdgeInsetsDirectional.only(end: 10), child: Center(child: Ic(chevronIcon(context), size: 20, color: p.text2))),
          ]),
        ),
      ),
    );
    if (onTap == null) return box;
    return Semantics(button: true, hint: UiCopy.copy.goMessage, child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTap, child: box));
  }
}

/// Who sent or got a message: the face and the name. With [onTap] it leads to their conversation.
class _Person extends StatelessWidget {
  const _Person({required this.id, this.name, this.onTap});
  final String id;

  /// What to say when the id is not one of the company's (a name the worker typed).
  final String? name;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final known = d.identities.containsKey(id);
    final row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 48),
      child: Row(children: [
        if (known) ...[Monogram.of(d, id, size: AvSize.sm), const SizedBox(width: 10)],
        Expanded(
          child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(known ? d.who(id).name : (name ?? id), style: T.name.copyWith(color: p.text)),
            if (known && d.who(id).title.isNotEmpty) Text(d.who(id).title, style: T.small.copyWith(color: p.text2)),
          ]),
        ),
        if (onTap != null) Ic(chevronIcon(context), size: 20, color: p.text2),
      ]),
    );
    if (onTap == null) return row;
    return Semantics(button: true, hint: known ? UiCopy.copy.chat2(d.who(id).name) : null, child: InkWell(onTap: onTap, child: row));
  }
}

class _Box extends StatelessWidget {
  const _Box({required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return Container(padding: const EdgeInsets.fromLTRB(12, 10, 12, 10), decoration: BoxDecoration(color: context.p.surface2, borderRadius: BorderRadius.circular(8)), child: child); }
}

class _IconLine extends StatelessWidget {
  const _IconLine({required this.icon, required this.text, required this.color, this.bold = false});
  final String icon;
  final String text;
  final Color color;
  final bool bold;
  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Padding(padding: const EdgeInsets.only(top: 1), child: Ic(icon, size: 20, color: color, fill: icon == 'error')), const SizedBox(width: 8), Expanded(child: Text(text, style: T.row2.copyWith(color: color, fontWeight: bold ? FontWeight.w700 : null)))]); }
}

/// Latin text set left to right: a path, a command line, an error.
class _Ltr extends StatelessWidget {
  const _Ltr(this.text, {required this.color, this.size = 12.5, this.bold = false, this.wrap = false});
  final String text;
  final Color color;
  final double size;
  final bool bold;
  final bool wrap;
  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return SizedBox(width: double.infinity, child: Text(text, textDirection: TextDirection.ltr, textAlign: TextAlign.left, maxLines: wrap ? null : 1, overflow: wrap ? null : TextOverflow.ellipsis, style: T.mono(size, lh: size * 1.5, w: bold ? FontWeight.w700 : FontWeight.w400).copyWith(color: color))); }
}

class _Chip extends StatelessWidget {
  const _Chip(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: p.codeBg, borderRadius: BorderRadius.circular(6), border: Border.all(color: p.line)),
      child: Text(text, textDirection: TextDirection.ltr, style: T.mono(12, lh: 18).copyWith(color: p.text)),
    );
  }
}

/// Hebrew text folded after [lines] lines, with "עוד" that opens it in place.
class _Folding extends StatefulWidget {
  const _Folding({required this.text, required this.lines});
  final String text;
  final int lines;
  @override
  State<_Folding> createState() => _FoldingState();
}

class _FoldingState extends State<_Folding> {
  bool open = false;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final long = '\n'.allMatches(widget.text).length + 1 > widget.lines || widget.text.length > widget.lines * 60;
    if (open || !long) return Markdown(widget.text);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Rich(widget.text.split('\n').take(widget.lines).join('\n'), style: T.row2.copyWith(color: p.text), maxLines: widget.lines, overflow: TextOverflow.fade),
      TextButton(
        style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 36), tapTargetSize: MaterialTapTargetSize.shrinkWrap),
        onPressed: () => setState(() => open = true),
        child: Text(UiCopy.copy.more4, style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
      ),
    ]);
  }
}

/// Code folded to [foldedLines] lines (0: only the button), with a copy button when open.
class _CodeFold extends StatefulWidget {
  const _CodeFold({required this.code, required this.foldedLines, required this.open});
  final String code;
  final int foldedLines;
  final String open;
  @override
  State<_CodeFold> createState() => _CodeFoldState();
}

class _CodeFoldState extends State<_CodeFold> {
  bool open = false;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final lines = widget.code.split('\n');
    final fits = widget.foldedLines > 0 && lines.length <= widget.foldedLines && widget.code.length < widget.foldedLines * 70;
    final shown = open || fits;
    final text = shown ? widget.code : lines.take(widget.foldedLines).join('\n');
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (shown || widget.foldedLines > 0)
        Container(
          padding: EdgeInsets.fromLTRB(12, 10, shown ? 34 : 12, 10),
          decoration: BoxDecoration(color: p.codeBg, borderRadius: BorderRadius.circular(8), border: Border.all(color: p.line)),
          child: Stack(clipBehavior: Clip.none, children: [
            Text(text,
                textDirection: TextDirection.ltr,
                textAlign: TextAlign.left,
                maxLines: shown ? null : widget.foldedLines,
                overflow: shown ? null : TextOverflow.ellipsis,
                style: T.mono(12, lh: 18).copyWith(color: p.text)),
            if (shown)
              Positioned(
                top: -12,
                right: -34,
                child: IconButton(
                  tooltip: UiCopy.copy.copy,
                  onPressed: () => Clipboard.setData(ClipboardData(text: widget.code)),
                  icon: Ic('content_copy', size: 18, color: p.text2),
                ),
              ),
          ]),
        ),
      if (!fits)
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4), minimumSize: const Size(0, 40)),
            onPressed: () => setState(() => open = !open),
            icon: AnimatedRotation(turns: open ? 0.5 : 0, duration: const Duration(milliseconds: 200), child: Ic('expand_more', size: 18, color: p.accent)),
            label: Text(open ? UiCopy.copy.hide2 : widget.open, style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
          ),
        ),
    ]);
  }
}
