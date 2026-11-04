import 'package:agent_company/ui/chat/composer_field.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/native/native_bridge.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker_platform_interface/image_picker_platform_interface.dart';

import 'product_test.dart' show productApp;

class Picker extends ImagePickerPlatform {
  final requests = <MultiImagePickerOptions>[];
  bool denied = false;
  @override
  Future<XFile?> getImageFromSource({required ImageSource source, ImagePickerOptions options = const ImagePickerOptions()}) async =>
      throw PlatformException(code: 'camera_access_denied');
  @override
  Future<List<XFile>> getMultiImageWithOptions({MultiImagePickerOptions options = const MultiImagePickerOptions()}) async {
    requests.add(options);
    if (denied) throw PlatformException(code: 'photo_access_denied');
    return [];
  }
}

void main() {
  for (final language in ['en', 'he']) {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 2.0]) {
        testWidgets('media source sheet $language dark=$dark scale=$scale', (tester) async {
          NativeBridge.debugSupportedOverride = true;
          NativeComposerField.debugNative = false;
          addTearDown(() {
            NativeBridge.debugSupportedOverride = null;
            NativeComposerField.debugNative = null;
          });
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeBridge.channel, (call) async {
            if (call.method != 'recentScreenshot') return null;
            expect((call.arguments as Map)['requestPermission'], isFalse);
            return {'path': '/cache/screenshot.png', 'name': 'Screenshot.png', 'mime': 'image/png', 'bytes': 100};
          });
          addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeBridge.channel, null));
          await productApp(
            tester,
            language: language,
            dark: dark,
            scale: scale,
            home: const ChatScreen(identityId: 'dana'),
          );
          await tester.tap(find.byTooltip(language == 'he' ? 'צירוף' : 'Attach'));
          await tester.pumpAndSettle();
          expect(find.text(language == 'he' ? 'צילום המסך האחרון' : 'Latest screenshot'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/sources-$language-${dark ? 'dark' : 'light'}-${(scale * 100).round()}.png'));
        });
      }
    }
  }
  for (final language in ['en', 'he']) {
    for (final dark in [false, true]) {
      testWidgets('photo permission is requested only by its explicit source action $language dark=$dark', (tester) async {
        NativeBridge.debugSupportedOverride = true;
        NativeComposerField.debugNative = false;
        addTearDown(() {
          NativeBridge.debugSupportedOverride = null;
          NativeComposerField.debugNative = null;
        });
        final requests = <bool>[];
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeBridge.channel, (call) async {
          if (call.method == 'imageAccessGranted') return false;
          if (call.method == 'recentScreenshot') {
            requests.add((call.arguments as Map)['requestPermission'] == true);
            return null;
          }
          return null;
        });
        addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeBridge.channel, null));
        final store = await productApp(
          tester,
          language: language,
          dark: dark,
          home: const ChatScreen(identityId: 'dana'),
          prepare: (s) => s.setDraft('dana', 'Keep this draft'),
        );
        await tester.tap(find.byTooltip(language == 'he' ? 'צירוף' : 'Attach'));
        await tester.pumpAndSettle();
        expect(requests, [false]);
        expect(find.text(language == 'he' ? 'צילום המסך האחרון' : 'Latest screenshot'), findsNothing);
        final action = find.text(language == 'he' ? 'לאפשר גישה לתמונות' : 'Allow photo access');
        expect(action, findsOneWidget);
        await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/media/source-access-$language-${dark ? 'dark' : 'light'}.png'));
        await tester.tap(action);
        await tester.pumpAndSettle();
        expect(requests, [false, true]);
        expect(store.data!.chats['dana']!.draft, 'Keep this draft');
      });
    }
  }
  testWidgets('camera refusal names the camera and preserves the draft', (tester) async {
    NativeBridge.debugSupportedOverride = false;
    addTearDown(() => NativeBridge.debugSupportedOverride = null);
    final old = ImagePickerPlatform.instance;
    ImagePickerPlatform.instance = Picker();
    addTearDown(() => ImagePickerPlatform.instance = old);
    final store = await productApp(tester, home: const ChatScreen(identityId: 'dana'));
    await tester.enterText(find.byType(TextField), 'Keep this draft');
    await tester.pump();
    await tester.tap(find.byTooltip('Camera'));
    await tester.pumpAndSettle();
    expect(store.error, contains('Camera'));
    expect(store.error, contains('device settings'));
    expect(store.error, isNot(contains('Gallery')));
    expect(store.data!.chats['dana']!.draft, 'Keep this draft');
  });
  testWidgets('gallery is reduced by default; Original changes the actual picker options; cancel and refusal preserve the draft', (tester) async {
    NativeBridge.debugSupportedOverride = false;
    addTearDown(() => NativeBridge.debugSupportedOverride = null);
    final previous = ImagePickerPlatform.instance, picker = Picker();
    ImagePickerPlatform.instance = picker;
    addTearDown(() => ImagePickerPlatform.instance = previous);
    final store = await productApp(tester, home: const ChatScreen(identityId: 'dana'));
    await tester.enterText(find.byType(TextField), 'keep this draft');
    Future<void> sheet() async {
      await tester.tap(find.byTooltip('Attach'));
      await tester.pumpAndSettle();
    }

    await sheet();
    await tester.tap(find.text('Gallery'));
    await tester.pumpAndSettle();
    expect(picker.requests.last.imageOptions.maxWidth, 2048);
    expect(picker.requests.last.imageOptions.maxHeight, 2048);
    expect(picker.requests.last.imageOptions.imageQuality, 85);
    expect(picker.requests.last.limit, 20);
    expect(store.data!.chats['dana']!.draft, 'keep this draft');
    await sheet();
    await tester.tap(find.text('Original'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Gallery'));
    await tester.pumpAndSettle();
    expect(picker.requests.last.imageOptions.maxWidth, isNull);
    expect(picker.requests.last.imageOptions.maxHeight, isNull);
    expect(picker.requests.last.imageOptions.imageQuality, isNull);
    picker.denied = true;
    await sheet();
    await tester.tap(find.text('Gallery'));
    await tester.pumpAndSettle();
    expect(store.data!.chats['dana']!.draft, 'keep this draft');
    expect(store.images('dana'), isEmpty);
  });
}
