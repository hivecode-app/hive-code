import 'package:agent_company/l10n/ui_copy.dart';
// Small, safe markdown for worker text (chat.md §2.3, §2.11, §5):
// paragraphs, headings, bullet/numbered lists, > quotes, ``` code blocks ```, and inline markup
// (`code`, **bold**, #123). Each block gets its own direction from its first strong character.
// An unfinished code fence while streaming renders as if closed, so nothing jumps when it closes.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/tokens.dart';
import '../common.dart';
import '../selection.dart';

sealed class MdBlock {}

class MdPara extends MdBlock {
  MdPara(this.text);
  final String text;
}

class MdHeading extends MdBlock {
  MdHeading(this.text, this.level);
  final String text;
  final int level;
}

class MdItem {
  MdItem(this.text, this.marker, this.depth);
  final String text;

  /// "•" or the source's own number ("3."), so a list that starts at 3 says 3.
  final String marker;

  /// Nesting from the source indentation (2 spaces or a tab per level).
  final int depth;
}

class MdList extends MdBlock {
  MdList(this.items);
  final List<MdItem> items;
}

class MdQuote extends MdBlock {
  MdQuote(this.text);
  final String text;
}

/// `| a | b |` rows with a `|---|---|` line under the header (GitHub style).
class MdTable extends MdBlock {
  MdTable(this.header, this.rows);
  final List<String> header;
  final List<List<String>> rows;
}

class MdCode extends MdBlock {
  MdCode(this.code, this.lang);
  final String code;
  final String lang;
}

final _fenceRe = RegExp(r'^\s*```(\S*)');
final _fenceEnd = RegExp(r'^\s*```');
final _headRe = RegExp(r'^(#{1,4})\s+(.*)');
final _itemRe = RegExp(r'^([ \t]*)([-*•]|\d+[.)])\s+(.*)');
final _tableSep = RegExp(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$');

/// Cells of a `| a | b |` row. A `|` inside backticks or escaped as `\|` is text, not a border.
List<String> _cells(String l) {
  var t = l.trim();
  if (t.startsWith('|')) t = t.substring(1);
  if (t.endsWith('|') && !t.endsWith(r'\|')) t = t.substring(0, t.length - 1);
  final out = <String>[];
  final cell = StringBuffer();
  var code = false;
  for (var i = 0; i < t.length; i++) {
    final c = t[i];
    if (c == '`') code = !code;
    if (c == '\\' && i + 1 < t.length && t[i + 1] == '|') {
      cell.write('|');
      i++;
      continue;
    }
    if (c == '|' && !code) {
      out.add(cell.toString().trim());
      cell.clear();
      continue;
    }
    cell.write(c);
  }
  out.add(cell.toString().trim());
  return out;
}

/// A header row followed by a separator with a `|` and the same number of columns.
bool _isTableStart(String head, String sep) =>
    head.trimLeft().startsWith('|') && sep.contains('|') && _tableSep.hasMatch(sep) && _cells(sep).length == _cells(head).length;

// Parsing runs for every bubble on every rebuild (and per token while streaming), so the result
// is kept for recent texts. Blocks are immutable.
final _parsed = <String, List<MdBlock>>{};

List<MdBlock> parseMarkdown(String src) {
  final hit = _parsed.remove(src);
  if (hit != null) return _parsed[src] = hit;
  final blocks = _parse(src);
  _parsed[src] = blocks;
  if (_parsed.length > 400) _parsed.remove(_parsed.keys.first);
  return blocks;
}

List<MdBlock> _parse(String src) {
  final lines = src.replaceAll('\r\n', '\n').split('\n');
  final out = <MdBlock>[];
  final para = <String>[];
  void flush() {
    if (para.isNotEmpty) out.add(MdPara(para.join('\n')));
    para.clear();
  }

  // Nesting by the list's own indent steps, so 2-space and 4-space lists nest the same way.
  (String, String, int) item(RegExpMatch m) {
    final mk = m.group(2)!;
    return (m.group(3)!, RegExp(r'\d').hasMatch(mk) ? '${mk.substring(0, mk.length - 1)}.' : '•', m.group(1)!.replaceAll('\t', '    ').length);
  }

  MdList list(List<(String, String, int)> raw) {
    final steps = {for (final r in raw) r.$3}.toList()..sort();
    return MdList([for (final (text, marker, indent) in raw) MdItem(text, marker, steps.indexOf(indent).clamp(0, 3))]);
  }

  for (var i = 0; i < lines.length; i++) {
    final l = lines[i];
    final fence = _fenceRe.firstMatch(l);
    if (fence != null) {
      flush();
      final code = <String>[];
      i++;
      while (i < lines.length && !_fenceEnd.hasMatch(lines[i])) {
        code.add(lines[i]);
        i++;
      }
      out.add(MdCode(code.join('\n'), fence.group(1) ?? ''));
      continue;
    }
    if (l.trim().isEmpty) {
      flush();
      continue;
    }
    if (i + 1 < lines.length && _isTableStart(l, lines[i + 1])) {
      flush();
      final header = _cells(l);
      final rows = <List<String>>[];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trimLeft().startsWith('|')) {
        rows.add(_cells(lines[++i]));
      }
      // A row with more cells than the header widens the table instead of losing them.
      final cols = [header.length, for (final r in rows) r.length].reduce((a, b) => a > b ? a : b);
      String at(List<String> r, int k) => k < r.length ? r[k] : '';
      out.add(MdTable([for (var k = 0; k < cols; k++) at(header, k)], [for (final r in rows) [for (var k = 0; k < cols; k++) at(r, k)]]));
      continue;
    }
    final h = _headRe.firstMatch(l);
    if (h != null) {
      flush();
      out.add(MdHeading(h.group(2)!, h.group(1)!.length));
      continue;
    }
    final li = _itemRe.firstMatch(l);
    if (li != null) {
      flush();
      final items = [item(li)];
      while (i + 1 < lines.length) {
        final n = _itemRe.firstMatch(lines[i + 1]);
        if (n == null) break;
        items.add(item(n));
        i++;
      }
      out.add(list(items));
      continue;
    }
    if (l.startsWith('>')) {
      flush();
      final q = [l.replaceFirst(RegExp(r'^>\s?'), '')];
      while (i + 1 < lines.length && lines[i + 1].startsWith('>')) {
        q.add(lines[++i].replaceFirst(RegExp(r'^>\s?'), ''));
      }
      out.add(MdQuote(q.join('\n')));
      continue;
    }
    para.add(l);
  }
  flush();
  return out;
}

/// Where the bubble's time goes: the end of the last line's own direction. A Hebrew last line
/// ends on the left, an English one on the right; after code the time takes its own line on the
/// ambient (RTL) end.
TextDirection markdownEndDirection(String src, {TextDirection fallback = TextDirection.rtl}) {
  final blocks = parseMarkdown(src);
  if (blocks.isEmpty) return fallback;
  return switch (blocks.last) {
    MdPara(:final text) => lastLineDirection(text),
    MdHeading(:final text) => paragraphDirection(text),
    MdList(:final items) => paragraphDirection(items.last.text),
    MdQuote(:final text) => lastLineDirection(text),
    MdTable() || MdCode() => fallback,
  };
}

/// Renders markdown blocks. [trailer] (the bubble's time) is reserved at the end of the last line.
/// Every line, list item, heading and quote takes its own direction (bidi.dart): an English line
/// inside a Hebrew message is LTR and left-aligned, and its bullet sits on its left.
class Markdown extends StatelessWidget {
  const Markdown(this.src, {super.key, this.trailerWidth = 0, this.caret = false, this.maxBlocks});
  final String src;
  final double trailerWidth;
  final bool caret;
  final int? maxBlocks;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final base = T.body.copyWith(color: p.text);
    var blocks = parseMarkdown(src);
    if (maxBlocks != null && blocks.length > maxBlocks!) blocks = blocks.sublist(0, maxBlocks);
    final children = <Widget>[];
    for (var i = 0; i < blocks.length; i++) {
      final last = i == blocks.length - 1;
      final b = blocks[i];
      final gap = last ? 0.0 : 4.0;
      switch (b) {
        case MdPara():
          final lines = b.text.split('\n');
          for (var j = 0; j < lines.length; j++) {
            final lastLine = j == lines.length - 1;
            children.add(Padding(padding: EdgeInsets.only(bottom: lastLine ? gap : 0), child: _inline(context, lines[j], base, last && lastLine)));
          }
        case MdHeading():
          children.add(Padding(
              padding: EdgeInsets.only(bottom: gap, top: 2),
              child: _inline(context, b.text, base.copyWith(fontWeight: FontWeight.w700, fontSize: b.level <= 2 ? 17 : 15.5), last)));
        case MdList():
          final markerWidth = 8.0 + 8.5 * b.items.map((i) => i.marker.length).reduce((a, c) => a > c ? a : c);
          for (var j = 0; j < b.items.length; j++) {
            final it = b.items[j];
            final dir = paragraphDirection(it.text);
            final lastItem = last && j == b.items.length - 1;
            children.add(Padding(
              padding: EdgeInsetsDirectional.only(bottom: j == b.items.length - 1 ? gap : 2),
              child: Directionality(
                textDirection: dir,
                child: Padding(
                  padding: EdgeInsetsDirectional.only(start: 16.0 * it.depth),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    // Wide enough for "10." so the text column lines up across items.
                    // The bullet is not copied with the text.
                    SizedBox(
                      width: it.marker == '•' ? 16 : markerWidth,
                      child: SelectionContainer.disabled(child: Text(it.depth > 0 && it.marker == '•' ? '◦' : it.marker,
                          textDirection: dir, style: base.copyWith(color: p.text2))),
                    ),
                    Expanded(child: _inline(context, it.text, base, lastItem)),
                  ]),
                ),
              ),
            ));
          }
        case MdQuote():
          final dir = paragraphDirection(b.text);
          final qLines = b.text.split('\n');
          children.add(Padding(
            padding: EdgeInsets.only(bottom: gap),
            child: Directionality(
              textDirection: dir,
              child: Container(
                padding: const EdgeInsetsDirectional.only(start: 8),
                decoration: BoxDecoration(border: BorderDirectional(start: BorderSide(color: p.text3, width: 3))),
                child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  for (final (k, l) in qLines.indexed) _inline(context, l, base.copyWith(color: p.text2), last && k == qLines.length - 1),
                ]),
              ),
            ),
          ));
        case MdTable():
          children.add(Padding(padding: EdgeInsets.only(bottom: gap, top: 2), child: _table(context, b, base)));
          if (last && trailerWidth > 0) children.add(SizedBox(height: 16, width: trailerWidth));
        case MdCode():
          children.add(Padding(padding: EdgeInsets.only(bottom: gap, top: 2), child: CodeBlock(code: b.code, lang: b.lang)));
          if (last && trailerWidth > 0) children.add(SizedBox(height: 16, width: trailerWidth));
      }
    }
    return SelectionLines(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: children));
  }

  /// A table in the direction of its header, columns as wide as their content, scrolling sideways
  /// inside the bubble when it is wider than the bubble.
  Widget _table(BuildContext context, MdTable t, TextStyle base) {
    final p = context.p;
    final dir = paragraphDirection(t.header.join(' '));
    final small = base.copyWith(fontSize: 14, height: 1.4);
    Widget cell(String c, {bool head = false}) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
          child: Text.rich(TextSpan(children: Rich.spans(context, c, head ? small.copyWith(fontWeight: FontWeight.w700) : small)),
              style: head ? small.copyWith(fontWeight: FontWeight.w700) : small, textDirection: paragraphDirection(c.isEmpty ? t.header.first : c)),
        );
    return Directionality(
      textDirection: dir,
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Table(
            defaultColumnWidth: const IntrinsicColumnWidth(),
            border: TableBorder(horizontalInside: BorderSide(color: p.line)),
            children: [
              TableRow(decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.text3))), children: [for (final h in t.header) cell(h, head: true)]),
              for (final r in t.rows) TableRow(children: [for (final c in r) cell(c)]),
            ],
          ),
        ),
      ),
    );
  }

  Widget _inline(BuildContext context, String text, TextStyle style, bool last) {
    final dir = paragraphDirection(text);
    final spans = Rich.spans(context, text, style, codeBox: true, isolate: dir == TextDirection.rtl);
    if (last && caret) spans.add(const WidgetSpan(alignment: PlaceholderAlignment.middle, child: Caret()));
    // Room for the bubble's time so it sits on the last line like WhatsApp's. Kept as one bidi run
    // with the caret (the caret is the spacer's first child) so the caret hugs the text.
    if (last && trailerWidth > 0) {
      if (last && caret) spans.removeLast();
      spans.add(WidgetSpan(
        alignment: PlaceholderAlignment.middle,
        child: SizedBox(
          width: trailerWidth + (caret ? 3 : 0),
          height: 16,
          child: caret ? Directionality(textDirection: dir, child: const Align(alignment: AlignmentDirectional.centerStart, child: Caret())) : null,
        ),
      ));
    }
    return Text.rich(TextSpan(children: spans), style: style, textDirection: dir, textAlign: TextAlign.start);
  }
}

/// Thin streaming caret (`.caret`), still when motion is reduced.
class Caret extends StatefulWidget {
  const Caret({super.key});
  @override
  State<Caret> createState() => _CaretState();
}

class _CaretState extends State<Caret> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 1));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if ((MediaQuery.maybeDisableAnimationsOf(context) ?? false) || Motion.frozen) {
      _c.value = 0;
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return AnimatedBuilder(animation: _c, builder: (_, _) => Opacity(opacity: _c.value < 0.5 ? 1 : 0, child: Container(width: 2, height: 16, margin: const EdgeInsetsDirectional.only(start: 1), color: context.p.text))); }
}

/// Code block (chat.md §2.11): always LTR, mono on a secondary surface, language + copy in a thin
/// header, horizontal scroll inside the block, folded above 20 lines.
class CodeBlock extends StatefulWidget {
  const CodeBlock({super.key, required this.code, this.lang = ''});
  final String code;
  final String lang;
  @override
  State<CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<CodeBlock> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final lines = widget.code.split('\n');
    final folded = lines.length > 20 && !open;
    final shown = folded ? lines.take(20).join('\n') : widget.code;
    return Container(
      decoration: BoxDecoration(color: p.codeBg, borderRadius: BorderRadius.circular(6), border: Border.all(color: p.line)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SelectionContainer.disabled(child: Container(
            height: 28,
            padding: const EdgeInsets.only(left: 10, right: 2),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
            child: Row(children: [
              Expanded(child: Text(widget.lang, style: T.mono(11.5).copyWith(color: p.text2))),
              _CopyButton(text: widget.code),
            ]),
          )),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            child: Text(shown, style: T.mono(12.5, lh: 19).copyWith(color: p.text)),
          ),
          if (lines.length > 20)
            SelectionContainer.disabled(child: InkWell(
              onTap: () => setState(() => open = !open),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                child: Directionality(
                  textDirection: Directionality.of(context),
                  child: Text(open ? UiCopy.text(125) : UiCopy.text(311, [lines.length - 20]),
                      style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                ),
              ),
            )),
        ]),
      ),
    );
  }
}

class _CopyButton extends StatefulWidget {
  const _CopyButton({required this.text});
  final String text;
  @override
  State<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<_CopyButton> {
  bool done = false;
  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return IconButton(tooltip: done ? UiCopy.text(312) : UiCopy.text(183), visualDensity: VisualDensity.compact, iconSize: 16, onPressed: () async {await Clipboard.setData(ClipboardData(text: widget.text)); if (mounted) setState(() => done = true);}, icon: Ic(done ? 'check' : 'content_copy', size: 16, color: context.p.text2)); }
}
