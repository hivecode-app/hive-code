// The composer's native field on Android (through a mocked platform view) and copying from the
// chat: whole messages, part of one, and code, always as the source characters.
import 'dart:convert';

import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/bidi.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/composer_field.dart';
import 'package:agent_company/ui/chat/markdown.dart';
import 'package:agent_company/ui/selection.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// Android's side of the field: records what Dart sends and lets the test speak for the EditText.
class FakeEditText {
  FakeEditText(this.tester);
  final WidgetTester tester;
  final calls = <MethodCall>[];
  Map<Object?, Object?>? created;
  int? id;

  void install() {
    final m = tester.binding.defaultBinaryMessenger;
    m.setMockMethodCallHandler(SystemChannels.platform_views, (call) async {
      switch (call.method) {
        case 'create':
          final a = call.arguments as Map;
          id = a['id'] as int;
          created = const StandardMessageCodec().decodeMessage(ByteData.sublistView(a['params'] as Uint8List)) as Map?;
          m.setMockMethodCallHandler(MethodChannel('company/composer/$id'), (c) async {
            calls.add(c);
            return null;
          });
          return 1;
        case 'resize':
          final a = call.arguments as Map;
          return {'width': a['width'], 'height': a['height']};
      }
      return null;
    });
    addTearDown(() => m.setMockMethodCallHandler(SystemChannels.platform_views, null));
  }

  /// A message from the EditText (`changed`, `height`, `image`).
  Future<void> send(String method, Map<String, Object?> args) async {
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'company/composer/$id', const StandardMethodCodec().encodeMethodCall(MethodCall(method, args)), (_) {});
    await tester.pump();
  }

  List<MethodCall> sent(String method) => [for (final c in calls) if (c.method == method) c];
}

String? clipboard;

void mockClipboard(WidgetTester tester) {
  clipboard = null;
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'Clipboard.setData') clipboard = (call.arguments as Map)['text'] as String?;
    if (call.method == 'Clipboard.getData') return {'text': clipboard};
    return null;
  });
  addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
}

void main() {
  group('native field (Android)', () {
    setUp(() => NativeComposerField.debugNative = true);
    tearDown(() => NativeComposerField.debugNative = null);

    testWidgets('is an EditText with the draft, the hint and the theme', (tester) async {
      final edit = FakeEditText(tester)..install();
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'dana'));
      await tester.pump();
      expect(find.byType(TextField), findsNothing, reason: 'the chat search is closed; the composer has no Flutter field');
      expect(find.byType(AndroidView), findsOneWidget);
      expect(edit.created!['text'], 'ושגם ה-web יקבל את התיקון');
      expect(edit.created!['hint'], 'הודעה לדנה');
      expect(edit.created!['size'], 15.5);
      expect(edit.created!['color'], isA<int>());
    });

    testWidgets('what is typed comes back, send clears the EditText, and a late keystroke does not bring the text back', (tester) async {
      final edit = FakeEditText(tester)..install();
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'yoav'));
      await tester.pump();
      final chat = store.data!.chats['yoav']!;
      expect(find.bySemanticsLabel('שליחה'), findsNothing);
      await edit.send('changed', {'text': 'git status\nזה מה שיצא', 'start': 21, 'end': 21, 'seq': 0});
      expect(store.data!.chats['yoav']!.draft, 'git status\nזה מה שיצא');
      await tester.tap(find.bySemanticsLabel('שליחה'));
      await tester.pump();
      expect(chat.items.whereType<UserMsg>().last.text, 'git status\nזה מה שיצא');
      final clear = edit.sent('setValue').last.arguments as Map;
      expect(clear['text'], '');
      // Typed on the phone just before the clear arrived there: dropped.
      await edit.send('changed', {'text': 'git status\nזה מה שיצאx', 'start': 22, 'end': 22, 'seq': (clear['seq'] as int) - 1});
      expect(find.bySemanticsLabel('שליחה'), findsNothing);
      // After it, typing works as usual.
      await edit.send('changed', {'text': 'שוב', 'start': 3, 'end': 3, 'seq': clear['seq']});
      expect(find.bySemanticsLabel('שליחה'), findsOneWidget);
    });

    testWidgets('grows with its lines as the EditText reports them, and takes focus when asked', (tester) async {
      final edit = FakeEditText(tester)..install();
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'yoav'));
      await tester.pump();
      double height() => tester.getSize(find.byType(AndroidView)).height;
      expect(height(), 46);
      await edit.send('height', {'px': 158.5});
      expect(height(), 158.5);
      await edit.send('height', {'px': 10.0});
      expect(height(), 46, reason: 'never shorter than one line');
      final state = tester.state<NativeComposerFieldState>(find.byType(NativeComposerField));
      state.widget.focus.requestFocus();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 1));
      expect(edit.sent('focus'), hasLength(1));
    });

    testWidgets('an image from the keyboard or a paste waits above the field', (tester) async {
      final edit = FakeEditText(tester)..install();
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'yoav'));
      await tester.pump();
      final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGO4E2Bj03OHIWpL1IcTNgArVgZpg9MzkAAAAABJRU5ErkJggg==');
      await edit.send('image', {'bytes': png, 'mime': 'image/png', 'name': 'shot.png'});
      expect(store.images('yoav'), hasLength(1));
      await edit.send('image', {'error': true});
      expect(store.error, contains('לא הצלחתי לקרוא את התמונה'));
      // The image put the focus back in the field: that goes to the EditText right after.
      await tester.pump(const Duration(milliseconds: 1));
      expect(edit.sent('focus'), isNotEmpty);
    });
  });

  group('copying from the chat', () {
    testWidgets('a long press then "העתקה" copies the whole message as written', (tester) async {
      mockClipboard(tester);
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'yoav'));
      await store.send('yoav', 'הרצתי `npm run build` ב-prod (#12).', Priority.next);
      await tester.pump();
      await tester.longPress(findShown('הרצתי npm run build').last);
      await tester.pump();
      await tester.tap(find.byTooltip('העתקה'));
      await tester.pump();
      expect(clipboard, 'הרצתי `npm run build` ב-prod (#12).');
    });

    testWidgets('"בחירת טקסט" opens the message; a long press selects, and copy gives the characters, not the bidi marks', (tester) async {
      mockClipboard(tester);
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'yoav'));
      await store.send('yoav', 'עדכנתי את `deploy/hq.sh` ב-prod.\nnpm test passed.', Priority.next);
      await tester.pump();
      await tester.longPress(findShown('עדכנתי את').last);
      await tester.pump();
      await tester.tap(find.byTooltip('בחירת טקסט'));
      await tester.pumpAndSettle();
      final sheet = find.byType(CopySelectionArea);
      expect(sheet, findsOneWidget);
      expect(find.descendant(of: sheet, matching: find.byType(Markdown)), findsOneWidget);
      await tester.longPress(find.descendant(of: sheet, matching: findShown('עדכנתי את')));
      await tester.pumpAndSettle();
      expect(find.text('העתקה'), findsOneWidget, reason: 'the menu is up after the long press');
      // "בחירת הכול" (the device run taps it; here the menu overflows the test's narrow screen).
      tester.state<SelectableRegionState>(find.descendant(of: sheet, matching: find.byType(SelectableRegion))).selectAll(SelectionChangedCause.toolbar);
      await tester.pumpAndSettle();
      await tester.tap(find.text('העתקה'));
      await tester.pump();
      expect(clipboard, isNotNull);
      expect(clipboard, stripBidi(clipboard!), reason: 'no LRI/PDI, word joiners or code padding');
      expect(clipboard, contains('deploy/hq.sh'));
      expect(clipboard, contains('ב-prod.\nnpm test passed.'), reason: 'each line on its own line');
    });

    testWidgets('Ctrl+C on desktop copies a selection without the marks', (tester) async {
      mockClipboard(tester);
      await pumpApp(tester, home: Scaffold(body: CopySelectionArea(child: Markdown('ראיתי ש-`git status` נקי (exit 0).'))));
      // A click puts the keyboard in the region, as on the desktop page.
      await tester.tap(findShown('ראיתי'));
      await tester.pump();
      tester.state<SelectableRegionState>(find.byType(SelectableRegion)).selectAll(SelectionChangedCause.keyboard);
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyC);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
      expect(clipboard, isNotNull);
      expect(clipboard, stripBidi(clipboard!));
      expect(clipboard, contains('git status'));
    });

    testWidgets('a code block copies its raw text', (tester) async {
      mockClipboard(tester);
      await pumpApp(tester, home: Scaffold(body: Markdown('הפקודה:\n```bash\nnpm ci && npm test -- --grep "ב-prod"\n```')));
      await tester.tap(find.byTooltip('העתקה'));
      await tester.pump();
      expect(clipboard, 'npm ci && npm test -- --grep "ב-prod"');
    });
  });
}
