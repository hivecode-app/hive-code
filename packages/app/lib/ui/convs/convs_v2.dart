import 'package:agent_company/l10n/ui_copy.dart';
// What is left of the old phone list (task 205): its time, word search and word fit, used by the product's lists.
import 'package:flutter/material.dart';

import '../common.dart';

/// "14:02" today, "אתמול", else "20/10", as in WhatsApp.
String whenV2(DateTime t, DateTime now) => switch (daysAgo(t, now)) { 0 => hm(t), 1 => UiCopy.copy.yesterday2, _ => dm(t) };

final _letter = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Where [q] first starts a word of [s] (case aside), or -1: "דנה" finds "דנה ביקשה" and "(דנה)", not "עדנה".
/// Only the start of a word (נועה, 21/10): a match inside a word is noise in a list of names.
int wordStart(String s, String q) {
  if (q.isEmpty) return -1;
  final hay = s.toLowerCase(), needle = q.toLowerCase();
  for (var i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (i == 0 || !_letter.hasMatch(hay[i - 1])) return i;
  }
  return -1;
}

/// [lead] then [text] in [maxLines] lines at most, cut only between words with "…" (T2): Flutter's own
/// ellipsis cuts inside a word ([fitWords]). With [mark], the first match is bold, and a match too far in starts the
/// text a few words before it, after "…". The text is isolated in its own direction ([paragraphDirection]), so a Latin line keeps its order.
class WordFit extends StatelessWidget {
  const WordFit({super.key, required this.text, required this.style, this.lead, this.leadStyle, this.mark, this.markStyle, this.maxLines = 1});
  final String text;
  final TextStyle style;
  final String? lead;
  final TextStyle? leadStyle;
  final String? mark;
  final TextStyle? markStyle;
  final int maxLines;

  TextSpan _span(String t) {
    final m = mark == null ? -1 : wordStart(t, mark!);
    return TextSpan(children: [
      if (lead != null) TextSpan(text: lead, style: leadStyle),
      // The direction of the whole text, not of its first letter: "GO לפרודקשן" is Hebrew.
      TextSpan(text: paragraphDirection(text) == TextDirection.rtl ? kRLI : kLRI),
      if (m < 0)
        TextSpan(text: t)
      else ...[
        TextSpan(text: t.substring(0, m)),
        TextSpan(text: t.substring(m, m + mark!.length), style: markStyle),
        TextSpan(text: t.substring(m + mark!.length)),
      ],
      const TextSpan(text: kPDI),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final full = DefaultTextStyle.of(context).style.merge(style);
    final dir = Directionality.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(builder: (context, box) {
      bool fits(String t) {
        final tp = TextPainter(text: TextSpan(style: full, children: [_span(t)]), textDirection: dir, textScaler: scaler, maxLines: maxLines)..layout(maxWidth: box.maxWidth);
        final over = tp.didExceedMaxLines || (maxLines == 1 && tp.width > box.maxWidth);
        tp.dispose();
        return !over;
      }

      var words = text.split(' ');
      var head = '';
      // A match past the first line or so: start a few words before it.
      if (mark != null && mark!.isNotEmpty) {
        final at = words.indexWhere((w) => wordStart(w, mark!) >= 0);
        if (at > 4 && !fits(words.take(at + 1).join(' '))) {
          words = words.sublist(at - 3);
          head = '…';
        }
      }
      final shown = fitWords(words.join(' '), fits, head: head);
      return Text.rich(_span(shown), maxLines: maxLines, softWrap: maxLines > 1, overflow: TextOverflow.clip, style: style);
    });
  }
}
