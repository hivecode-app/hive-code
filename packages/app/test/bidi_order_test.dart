// Measures, not eyeballs: in every line of the bidi corpus, each English token (path, id, version,
// time, URL, word) must come out on screen left to right, as one piece. Lays each line out on one
// unbroken line with the real fonts and checks the x position of every character of every token.
// Prints the count for main's rendering (first strong letter, no isolates) next to ours.

import 'package:agent_company/ui/chat/markdown.dart';
import 'package:agent_company/ui/common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures/bidi/corpus.dart';
import 'helpers.dart';

// A token: non-space run with a Latin letter or digit, without leading/trailing punctuation.
final _token = RegExp(r'[A-Za-z0-9~/$#][^\s()\[\]«»"“”,;]*[A-Za-z0-9/]|[A-Za-z0-9]');
final _controls = RegExp('[\u2060\u2066-\u2069\u200E\u200F\u202F]');

/// Tokens of [plain] whose characters are not laid out left to right.
List<String> misordered(String plain, TextDirection dir) {
  final tp = TextPainter(text: TextSpan(text: plain, style: const TextStyle(fontFamily: 'Heebo', fontSize: 16)), textDirection: dir)..layout();
  final bad = <String>[];
  final visible = plain.replaceAll(_controls, '\u0000');
  for (final m in _token.allMatches(visible)) {
    final tok = m[0]!;
    if (!RegExp('[A-Za-z]').hasMatch(tok) && !tok.contains(RegExp(r'[:/.]'))) continue; // plain numbers are fine either way
    double? last;
    for (var i = m.start; i < m.end; i++) {
      if (visible[i] == '\u0000') continue;
      final boxes = tp.getBoxesForSelection(TextSelection(baseOffset: i, extentOffset: i + 1));
      if (boxes.isEmpty) continue;
      final x = boxes.first.left;
      if (last != null && x < last - 0.5) {
        bad.add(tok.replaceAll('\u0000', ''));
        break;
      }
      last = x;
    }
  }
  tp.dispose();
  return bad;
}

/// Main's rendering, for the before/after number: first strong letter, code as LRI, nothing else.
TextDirection _mainDir(String s) {
  for (final r in s.runes) {
    if (isHebrewRune(r)) return TextDirection.rtl;
    if (isLatinRune(r)) return TextDirection.ltr;
  }
  return TextDirection.rtl;
}

String _mainPlain(String line) => line
    .replaceAllMapped(RegExp(r'`([^`]+)`'), (m) => '\u2066${m[1]}\u2069')
    .replaceAll('**', '');

void main() {
  const corpus = kBidiCorpus;

  testWidgets('every English token in the corpus reads left to right', (tester) async {
    await pumpApp(tester, home: const SizedBox());
    final context = tester.element(find.byType(SizedBox).first);
    var lines = 0, before = 0, after = 0;
    final left = <String>[];
    for (final m in corpus) {
      for (final b in parseMarkdown(m['text'] as String)) {
        final texts = switch (b) {
          MdPara(:final text) => text.split('\n'),
          MdHeading(:final text) => [text],
          MdList(:final items) => [for (final i in items) i.text],
          MdQuote(:final text) => text.split('\n'),
          MdTable(:final header, :final rows) => [...header, for (final r in rows) ...r],
          MdCode() => <String>[],
        };
        for (final line in texts.where((l) => l.trim().isNotEmpty)) {
          lines++;
          before += misordered(_mainPlain(line), _mainDir(line)).length;
          final dir = paragraphDirection(line);
          final span = TextSpan(children: Rich.spans(context, line, const TextStyle(), codeBox: true, isolate: dir == TextDirection.rtl));
          final bad = misordered(span.toPlainText(includeSemanticsLabels: false), dir);
          after += bad.length;
          for (final t in bad) {
            left.add('${m['id']}: $t  ‹$line›');
          }
        }
      }
    }
    // ignore: avoid_print
    print('bidi order: $lines lines · tokens out of order: main $before → now $after');
    for (final l in left) {
      // ignore: avoid_print
      print('  $l');
    }
    expect(left, isEmpty);
  });
}
