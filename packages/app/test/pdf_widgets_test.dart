import 'dart:io';

import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/media/viewer.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pdfrx/pdfrx.dart';

import 'product_test.dart' show productApp;

Future<void> ready(WidgetTester tester) async {
  for (var i = 0; i < 150; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
    final viewers = find.byType(PdfViewer);
    if (viewers.evaluate().isNotEmpty && tester.widget<PdfViewer>(viewers.first).controller!.isReady) {
      for (var frame = 0; frame < 15; frame++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump(const Duration(milliseconds: 20));
      }
      return;
    }
  }
  fail('PDF viewer did not become ready');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    if (Platform.isLinux) Pdfrx.pdfiumModulePath = File('build/native_assets/linux/libpdfium.so').absolute.path;
    await pdfrxInitialize();
  });
  for (final language in ['en', 'he']) {
    for (final dark in [false, true]) {
      testWidgets('PDF viewer $language dark=$dark renders a real document with persistent chrome', (tester) async {
        final bytes = File('test/fixtures/media/search-12.pdf').readAsBytesSync();
        final a = Attachment(name: 'Service contract.pdf', id: 'pdf-fixture', mime: 'application/pdf', bytes: bytes.length, data: bytes);
        await productApp(
          tester,
          language: language,
          dark: dark,
          settle: false,
          home: FileViewer(attachment: a),
        );
        addTearDown(() async {
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pump(const Duration(seconds: 1));
        });
        await ready(tester);
        expect(find.byType(PdfViewer), findsOneWidget);
        await tester.enterText(find.byType(TextField), 'בלי רשת');
        final count = language == 'he' ? '1 מתוך 12' : '1 of 12';
        for (var i = 0; i < 150 && find.text(count).evaluate().isEmpty; i++) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
          await tester.pump(const Duration(milliseconds: 20));
        }
        expect(find.text(count), findsOneWidget);
        for (var i = 0; i < 15; i++) {
          await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
          await tester.pump(const Duration(milliseconds: 20));
        }

        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/pdf-$language-${dark ? 'dark' : 'light'}.png'));
      });
    }
  }
  testWidgets('search finds Hebrew matches in the real document', (tester) async {
    final bytes = File('test/fixtures/media/search-12.pdf').readAsBytesSync();
    await productApp(
      tester,
      settle: false,
      home: FileViewer(
        attachment: Attachment(name: 'Hebrew.pdf', id: 'hebrew', mime: 'application/pdf', bytes: bytes.length, data: bytes),
      ),
    );
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(seconds: 1));
    });
    await ready(tester);
    await tester.enterText(find.byType(TextField), 'בלי רשת');
    for (var i = 0; i < 150 && find.text('1 of 12').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(find.text('1 of 12'), findsOneWidget);
  });
}
