import 'dart:convert';
import 'dart:io';

import 'package:analyzer/dart/analysis/utilities.dart';
import 'package:analyzer/dart/ast/ast.dart';
import 'package:analyzer/dart/ast/visitor.dart';
import 'package:flutter_test/flutter_test.dart';

final forbidden = RegExp(r'משמרת|\bhq\b|\blease\b|\bGO\b|hq-host|!|—|את/ה');
List<String> copyViolations(Map<String, dynamic> catalogue) => [
  for (final entry in catalogue.entries)
    if (!entry.key.startsWith('@') && entry.value is String && forbidden.hasMatch(entry.value as String)) entry.key,
];

class _LiteralVisitor extends RecursiveAstVisitor<void> {
  final violations = <String>[];
  final hebrew = RegExp(r'[\u0590-\u05ff]');
  @override
  void visitSimpleStringLiteral(SimpleStringLiteral node) {
    if (hebrew.hasMatch(node.value)) violations.add(node.toSource());
  }

  @override
  void visitStringInterpolation(StringInterpolation node) {
    for (final piece in node.elements.whereType<InterpolationString>()) {
      if (hebrew.hasMatch(piece.value)) violations.add(piece.value);
    }
    super.visitStringInterpolation(node);
  }
}

void main() {
  test('both catalogues have the same keys, parameters and professional copy', () {
    final en = jsonDecode(File('lib/l10n/app_en.arb').readAsStringSync()) as Map<String, dynamic>;
    final he = jsonDecode(File('lib/l10n/app_he.arb').readAsStringSync()) as Map<String, dynamic>;
    Set<String> keys(Map<String, dynamic> m) => m.keys.where((k) => !k.startsWith('@')).toSet();
    expect(keys(en), keys(he));
    expect(copyViolations(en), isEmpty);
    expect(copyViolations(he), isEmpty);
    final args = RegExp(r'\{(\w+)\}');
    for (final k in keys(en)) {
      expect(args.allMatches(en[k] as String).map((m) => m[1]).toSet(), args.allMatches(he[k] as String).map((m) => m[1]).toSet(), reason: k);
    }
  });
  test('copy guard rejects each planted prohibited term', () {
    for (final term in ['משמרת', 'hq', 'lease', 'GO', 'hq-host', '!', '—', 'את/ה']) {
      expect(copyViolations({'label': 'bad $term copy'}), ['label']);
    }
  });
  test('application literals live in ARB across every application layer', () {
    for (final file in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart') && !f.path.startsWith('lib/l10n/') && !f.path.endsWith('fake_backend.dart') && !f.path.endsWith('demo_map.dart'))) {
      final visitor = _LiteralVisitor();
      parseString(content: file.readAsStringSync()).unit.accept(visitor);
      expect(visitor.violations, isEmpty, reason: file.path);
    }
  });
  test('every approved now row in the copy table is present in both ARBs', () {
    final en = jsonDecode(File('lib/l10n/app_en.arb').readAsStringSync()) as Map<String, dynamic>;
    final he = jsonDecode(File('lib/l10n/app_he.arb').readAsStringSync()) as Map<String, dynamic>;
    final lines = File('../../docs/product/copy-table.md').readAsLinesSync();
    String plain(String s) => s.replaceAll('**', '').replaceAll('\u2060', '');
    for (final line in lines.where((l) => l.startsWith('| '))) {
      final cells = line.split('|').sublist(1, line.split('|').length - 1).map((s) => s.trim()).toList();
      if (cells.length != 5 || cells[0].startsWith('עברית:')) continue;
      final h = cells[1] == '(ללא שינוי)' ? cells[0] : cells[1];
      final e = cells[3] == '(ללא שינוי)' ? cells[2] : cells[3];
      if (h == 'אין' || e == 'אין') continue;
      expect(he.values.whereType<String>().map(plain), contains(plain(h)));
      expect(en.values.whereType<String>().map(plain), contains(plain(e)));
    }
  });
}
