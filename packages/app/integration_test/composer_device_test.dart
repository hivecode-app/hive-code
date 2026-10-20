// The composer's native field and copying from the chat, on a real Android build. The touches
// that must reach Android itself (a tap and a long press in the EditText, the keyboard's paste)
// come from the host: the test prints `QA-HOST <step>` and waits while the host runs it with adb
// and takes the screenshots (tool/qa/composer_device.sh). What the app ended up with is reported
// as composer.json.
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/bidi.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/composer_field.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

const mixed = 'git status\n'
    'זה מה שיצא, הכול נקי.\n'
    'npm run build עבר ב-prod (exit 0).\n'
    '`deploy/hq.sh` רץ על hq-host, ואז PR #17.\n'
    'Then restart hq.';

/// 2,000 characters of Hebrew, English and code, like a pasted log with notes.
String long2000() {
  const lines = [
    'בדקתי את `renew.go`: הלולאה ב-`retryCharge` מנסה שוב בלי השהיה.',
    'go test ./internal/billing/... -run TestRenew',
    '--- PASS: TestRenewDeclinedCard (0.01s)',
    'ה-CI רץ: 144 עברו, 2 נכשלו (TestRenewTwice).',
  ];
  final b = StringBuffer();
  for (var i = 0; b.length < 2000; i++) {
    b.writeln(lines[i % lines.length]);
  }
  return b.toString().substring(0, 2000);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  // The host's adb touches are real device touches: let them through to the app (and the EditText).
  binding.shouldPropagateDevicePointerEvents = true;

  testWidgets('composer on device', (tester) async {
    final store = AppStore(FakeBackend(simulate: false));
    await store.start();
    await tester.pumpWidget(CompanyApp(store: store, home: const ChatScreen(identityId: 'yoav')));
    final out = <String, Object?>{};

    Future<void> wait(double seconds) async {
      final end = DateTime.now().add(Duration(milliseconds: (seconds * 1000).round()));
      while (DateTime.now().isBefore(end)) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    Future<void> host(String step, {double seconds = 4}) async {
      debugPrint('QA-HOST $step');
      await wait(seconds);
    }

    String px(Offset o) {
      final r = tester.view.devicePixelRatio;
      return '${(o.dx * r).round()} ${(o.dy * r).round()}';
    }

    await wait(3);
    final field = find.byType(AndroidView);
    expect(field, findsOneWidget, reason: 'on Android the composer field is the native EditText');
    final ctrl = tester.widget<NativeComposerField>(find.byType(NativeComposerField)).controller;

    // 1. Mixed lines: each in its own direction.
    ctrl.text = mixed;
    await wait(2);
    out['mixedHeight'] = tester.getSize(field).height;
    await host('shot 1-mixed', seconds: 2);

    // 2. A 2,000-character paste from the keyboard: the field stops growing and scrolls inside.
    ctrl.clear();
    await Clipboard.setData(ClipboardData(text: long2000()));
    await wait(1);
    await host('tap ${px(tester.getCenter(field))}', seconds: 2);
    await host('key PASTE', seconds: 3);
    out['pastedLength'] = ctrl.text.length;
    out['pastedSame'] = ctrl.text == long2000();
    out['pastedHeight'] = tester.getSize(field).height;
    await host('shot 2-paste-2000', seconds: 2);

    // 3. Selecting inside the field: Android's handles and menu.
    ctrl.text = mixed;
    await wait(2);
    final r = tester.getRect(field);
    await host('longpress ${px(Offset(r.left + 40, r.top + 22))}', seconds: 3);
    await host('shot 3-field-select', seconds: 2);
    out['fieldSelection'] = ctrl.selection.isValid ? ctrl.selection.textInside(ctrl.text) : null;
    await host('key PASTE', seconds: 2);
    ctrl.clear();
    await wait(2);

    // 4. A long press on a message, then "העתקה": the whole message as written.
    const msg = 'הרצתי `npm run build` ב-prod (exit 0).\nAll green on `main`.';
    await store.send('yoav', msg, Priority.next);
    await wait(2);
    final bubble = find.byWidgetPredicate((w) => w is RichText && stripBidi(w.text.toPlainText()).contains('הרצתי')).last;
    await tester.longPress(bubble);
    await wait(1);
    await host('shot 4-message-selected', seconds: 1);
    await tester.tap(find.byTooltip('העתקה'));
    await wait(1);
    out['copiedMessage'] = (await Clipboard.getData('text/plain'))?.text;

    // 5. Part of a message: "בחירת טקסט", then a long press on a word: handles and Android's menu.
    await tester.longPress(bubble);
    await wait(1);
    await tester.tap(find.byTooltip('בחירת טקסט'));
    await wait(2);
    final word = find.descendant(of: find.byType(BottomSheet), matching: find.byType(RichText)).first;
    await host('longpress ${px(tester.getCenter(word))}', seconds: 3);
    await host('shot 5-select-text', seconds: 1);
    await tester.tap(find.text('בחירת הכול'));
    await wait(1);
    await host('shot 6-select-all', seconds: 1);
    await tester.tap(find.text('העתקה').last);
    await wait(1);
    final partial = (await Clipboard.getData('text/plain'))?.text;
    out['copiedSelection'] = partial;
    out['selectionClean'] = partial != null && partial == stripBidi(partial);

    binding.reportData = {'composer': out};
  });
}
