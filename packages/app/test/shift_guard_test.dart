// On the web `<<` is 32-bit: `1 << 31` and up are not what they are on the phone (`1 << 52` is 0, #148).
// Large bounds are written as literals (9007199254740991) or with math.max, not as shifts.
// A basic guard: it catches a shift by a decimal literal, not by a variable (`1 << n`) or a hex one.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('no shift by 31 or more in lib/', () {
    final shift = RegExp(r'<<\s*(3[1-9]|[4-9]\d|\d{3,})\b');
    final bad = <String>[];
    for (final f
        in Directory('lib')
            .listSync(recursive: true)
            .whereType<File>()
            .where((f) => f.path.endsWith('.dart'))) {
      final lines = f.readAsLinesSync();
      for (final (i, l) in lines.indexed) {
        final code = l.split('//').first;
        if (shift.hasMatch(code)) bad.add('${f.path}:${i + 1}: ${l.trim()}');
      }
    }
    expect(bad, isEmpty);
  });
}
