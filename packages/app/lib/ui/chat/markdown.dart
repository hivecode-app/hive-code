// Small, safe markdown for worker text (chat.md §2.3, §2.11, §5):
// paragraphs, headings, bullet/numbered lists, > quotes, ``` code blocks ```, and inline markup
// (`code`, **bold**, #123). Each block gets its own direction from its first strong character.
// An unfinished code fence while streaming renders as if closed, so nothing jumps when it closes.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/tokens.dart';
import '../common.dart';

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

class MdList extends MdBlock {
  MdList(this.items, this.ordered);
  final List<String> items;
  final bool ordered;
}

class MdQuote extends MdBlock {
  MdQuote(this.text);
  final String text;
}

class MdCode extends MdBlock {
  MdCode(this.code, this.lang);
  final String code;
  final String lang;
}

List<MdBlock> parseMarkdown(String src) {
  final lines = src.replaceAll('\r\n', '\n').split('\n');
  final out = <MdBlock>[];
  final para = <String>[];
  void flush() {
    if (para.isNotEmpty) out.add(MdPara(para.join('\n')));
    para.clear();
  }

  for (var i = 0; i < lines.length; i++) {
    final l = lines[i];
    final fence = RegExp(r'^\s*```(\S*)').firstMatch(l);
    if (fence != null) {
      flush();
      final code = <String>[];
      i++;
      while (i < lines.length && !RegExp(r'^\s*```').hasMatch(lines[i])) {
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
    final h = RegExp(r'^(#{1,4})\s+(.*)').firstMatch(l);
    if (h != null) {
      flush();
      out.add(MdHeading(h.group(2)!, h.group(1)!.length));
      continue;
    }
    final li = RegExp(r'^\s*([-*•]|\d+[.)])\s+(.*)').firstMatch(l);
    if (li != null) {
      flush();
      final ordered = RegExp(r'\d').hasMatch(li.group(1)!);
      final items = [li.group(2)!];
      while (i + 1 < lines.length) {
        final n = RegExp(r'^\s*([-*•]|\d+[.)])\s+(.*)').firstMatch(lines[i + 1]);
        if (n == null) break;
        items.add(n.group(2)!);
        i++;
      }
      out.add(MdList(items, ordered));
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

/// Renders markdown blocks. [trailer] (the bubble's time) is reserved at the end of the last line.
class Markdown extends StatelessWidget {
  const Markdown(this.src, {super.key, this.trailerWidth = 0, this.caret = false, this.maxBlocks});
  final String src;
  final double trailerWidth;
  final bool caret;
  final int? maxBlocks;

  @override
  Widget build(BuildContext context) {
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
          children.add(Padding(padding: EdgeInsets.only(bottom: gap), child: _inline(context, b.text, base, last)));
        case MdHeading():
          children.add(Padding(
              padding: EdgeInsets.only(bottom: gap, top: 2),
              child: _inline(context, b.text, base.copyWith(fontWeight: FontWeight.w700, fontSize: b.level <= 2 ? 17 : 15.5), last)));
        case MdList():
          for (var j = 0; j < b.items.length; j++) {
            final it = b.items[j];
            children.add(Padding(
              padding: EdgeInsets.only(bottom: j == b.items.length - 1 ? gap : 2),
              child: Directionality(
                textDirection: firstStrongDirection(it),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 18, child: Text(b.ordered ? '${j + 1}.' : '•', style: base.copyWith(color: p.text2))),
                  Expanded(child: _inline(context, it, base, last && j == b.items.length - 1)),
                ]),
              ),
            ));
          }
        case MdQuote():
          children.add(Padding(
            padding: EdgeInsets.only(bottom: gap),
            child: Container(
              padding: const EdgeInsetsDirectional.only(start: 8),
              decoration: BoxDecoration(border: BorderDirectional(start: BorderSide(color: p.text3, width: 3))),
              child: _inline(context, b.text, base.copyWith(color: p.text2), last),
            ),
          ));
        case MdCode():
          children.add(Padding(padding: EdgeInsets.only(bottom: gap, top: 2), child: CodeBlock(code: b.code, lang: b.lang)));
          if (last && trailerWidth > 0) children.add(SizedBox(height: 16, width: trailerWidth));
      }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: children);
  }

  Widget _inline(BuildContext context, String text, TextStyle style, bool last) {
    final spans = Rich.spans(context, text, style, codeBox: true);
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
          child: caret ? const Align(alignment: AlignmentDirectional.centerStart, child: Caret()) : null,
        ),
      ));
    }
    return Text.rich(TextSpan(children: spans), style: style, textDirection: firstStrongDirection(text));
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
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (_, _) => Opacity(
          opacity: _c.value < 0.5 ? 1 : 0,
          child: Container(width: 2, height: 16, margin: const EdgeInsetsDirectional.only(start: 1), color: context.p.text),
        ),
      );
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
    final p = context.p;
    final lines = widget.code.split('\n');
    final folded = lines.length > 20 && !open;
    final shown = folded ? lines.take(20).join('\n') : widget.code;
    return Container(
      decoration: BoxDecoration(color: p.codeBg, borderRadius: BorderRadius.circular(6), border: Border.all(color: p.line)),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            height: 28,
            padding: const EdgeInsets.only(left: 10, right: 2),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
            child: Row(children: [
              Expanded(child: Text(widget.lang, style: T.mono(11.5).copyWith(color: p.text2))),
              _CopyButton(text: widget.code),
            ]),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
            child: Text(shown, style: T.mono(12.5, lh: 19).copyWith(color: p.text)),
          ),
          if (lines.length > 20)
            InkWell(
              onTap: () => setState(() => open = !open),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                child: Directionality(
                  textDirection: TextDirection.rtl,
                  child: Text(open ? 'קיפול' : 'עוד ${lines.length - 20} שורות',
                      style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                ),
              ),
            ),
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
  Widget build(BuildContext context) => IconButton(
        tooltip: done ? 'הועתק' : 'העתקה',
        visualDensity: VisualDensity.compact,
        iconSize: 16,
        onPressed: () async {
          await Clipboard.setData(ClipboardData(text: widget.text));
          if (mounted) setState(() => done = true);
        },
        icon: Ic(done ? 'check' : 'content_copy', size: 16, color: context.p.text2),
      );
}
