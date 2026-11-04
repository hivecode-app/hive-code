import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    // flutter_tester runs from the SDK directory; point its background worker at
    // the native asset Flutter just built for this app rather than at the SDK.
    if (Platform.isLinux) Pdfrx.pdfiumModulePath = File('build/native_assets/linux/libpdfium.so').absolute.path;
    await pdfrxInitialize();
  });
  test('real 12-page PDF has searchable Hebrew text on every page', () async {
    final document = await PdfDocument.openData(await File('test/fixtures/media/search-12.pdf').readAsBytes(), useProgressiveLoading: false);
    try {
      expect(document.pages.length, 12);
      for (final page in document.pages) {
        expect((await page.loadText())!.fullText, contains('בלי רשת'));
      }
    } finally {
      await document.dispose();
    }
  });
  test('300-page local fixture opens and renders its first page within two seconds after engine initialization', () async {
    final bytes = await File('test/fixtures/media/search-300.pdf').readAsBytes();
    final watch = Stopwatch()..start();
    final document = await PdfDocument.openData(bytes, useProgressiveLoading: false);
    try {
      expect(document.pages.length, 300);
      final image = await document.pages.first.render(fullWidth: 390, fullHeight: 552);
      expect(image, isNotNull);
      image?.dispose();
      watch.stop();
      // This is a deterministic server baseline; device/network timing is a separate release check.
      expect(watch.elapsed, lessThan(const Duration(seconds: 2)));
    } finally {
      await document.dispose();
    }
  });
}
