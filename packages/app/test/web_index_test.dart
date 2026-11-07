import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  // Flutter web places each `flt-semantics` box with a transform and no `left`, which only lands where the widget is
  // painted in an LTR page. `dir="rtl"` on <html> shifted every box (#466): a screen reader's focus went off-screen,
  // and with semantics on a desktop click hit the wrong control. The app sets its own direction; only the boot text is RTL.
  test('the page itself is LTR, so the semantics boxes sit where the widgets are painted', () {
    final html = File('web/index.html').readAsStringSync();
    final root = RegExp(r'<html[^>]*>').firstMatch(html)![0]!;
    expect(root, isNot(contains('dir=')), reason: root);
    expect(html, contains('<div id="boot" dir="rtl">'));
  });
}
