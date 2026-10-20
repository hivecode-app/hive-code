// Frame timings on a real Android build (quality.md §1 "חלקות"). Run in profile mode:
//   tool/qa/device.sh perf --profile
// Each scenario reports build/raster times per frame (watchPerformance) under its own key; the
// driver writes them to ~/.local/state/agent-company/qa/device/perf/.
import 'dart:io';

import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

/// A long, realistic history: mixed Hebrew/English text, code, lists.
void addHistory(Conversation chat, int n) {
  final start = DateTime.now().subtract(Duration(minutes: n * 2));
  const texts = [
    'בדקתי את `renew.go`. הלולאה ב-`retryCharge` מנסה שוב בלי השהיה, ו-Stripe מחזיר את אותה שגיאה.',
    'PR #3712 נפתח. ה-CI רץ: 144 עברו, 2 נכשלו (`TestRenewTwice`, `TestRenewDeclinedCard`).',
    '**מה השתנה:**\n- ניסיון שני אחרי 24 שעות\n- בלי ניסיון שלישי\n- לוג ברור ב-`billing.log`',
    'מריצה את הבדיקות שוב:\n```\ngo test ./internal/billing/...\n--- PASS: TestRenewDeclinedCard (0.01s)\nok  lumo/internal/billing 1.92s\n```',
    'OK, the retry window is now 24h. Waiting for CI on `main`.',
  ];
  final items = <ChatItem>[];
  for (var i = 0; i < n; i++) {
    final ts = start.add(Duration(minutes: i * 2));
    if (i % 7 == 3) {
      items.add(UserMsg(id: 'h-u$i', ts: ts, text: 'מה המצב עם הבדיקות? תעדכני כשזה ירוק', delivery: Delivery.read));
    } else {
      items.add(TextMsg(id: 'h-t$i', ts: ts, text: texts[i % texts.length]));
    }
  }
  chat.items.insertAll(0, items);
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('perf: home, tabs, chat with 2,000 items, streaming', (tester) async {
    // On the host (flutter test -d flutter-tester) run at the phone's size, not the desktop layout.
    if (!Platform.isAndroid) {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 2.625;
      addTearDown(tester.view.reset);
    }
    final store = AppStore(FakeBackend(simulate: false));
    await store.start();
    final ido = store.data!.chats['ido']!;
    addHistory(ido, 2000);
    await tester.pumpWidget(CompanyApp(store: store));
    // Never pumpAndSettle: the "working" spinners rotate forever, so the app never goes idle.
    await tester.pump(const Duration(seconds: 2));

    void where(String step) => debugPrint('QA $step: chat=${find.byType(ChatScreen).evaluate().length} '
        'fields=${find.byType(TextField).evaluate().length} scaffolds=${find.byType(Scaffold).evaluate().length}');

    // Real time passes (fullyLive): frames are produced by the engine as they would be for a user.
    Future<void> settle(int ms) async {
      await Future<void>.delayed(Duration(milliseconds: ms));
      await tester.pump();
    }

    where('start');
    await binding.watchPerformance(() async {
      for (final tab in ['שיחות', 'לוח', 'ארגון', 'בית']) {
        await tester.tap(find.text(tab).last);
        await settle(600);
      }
    }, reportKey: 'tabs');
    where('tabs');

    await binding.watchPerformance(() async {
      await tester.tap(find.text('שיחות').last);
      await settle(400);
      await tester.tap(find.text('עידו').first);
      await settle(1200);
    }, reportKey: 'open_chat_2000');
    where('open');
    expect(find.byType(ChatScreen), findsOneWidget, reason: 'the chat with Ido is open');

    await binding.watchPerformance(() async {
      final list = find.byType(Scrollable).last;
      for (var i = 0; i < 6; i++) {
        await tester.fling(list, const Offset(0, 900), 3000);
        await settle(700);
      }
      for (var i = 0; i < 6; i++) {
        await tester.fling(list, const Offset(0, -900), 3000);
        await settle(700);
      }
    }, reportKey: 'scroll_chat_2000');
    where('scroll');

    // Streaming: a worker writes ~20 words a second into a new bubble at the bottom.
    await binding.watchPerformance(() async {
      final msg = TextMsg(id: 'live', ts: DateTime.now(), text: '', streaming: true);
      ido.items.add(msg);
      const words = ['בודקת', 'את', '`renew.go`', 'ואת', 'הבדיקות', 'ב-CI,', 'ומעדכנת', 'את', 'PR #3712.', '\n-', 'ניסיון', 'שני', 'אחרי', '24h'];
      for (var i = 0; i < 100; i++) {
        msg.text += '${i == 0 ? '' : ' '}${words[i % words.length]}';
        store.touch();
        await settle(50);
      }
      msg.streaming = false;
      store.touch();
      await settle(500);
    }, reportKey: 'streaming_2000');
    where('streaming');

    // The same streaming, traced with one timeline event per widget build, to see what it costs.
    debugProfileBuildsEnabled = true;
    await binding.traceAction(() async {
      final msg = TextMsg(id: 'live2', ts: DateTime.now(), text: '', streaming: true);
      ido.items.add(msg);
      for (var i = 0; i < 30; i++) {
        msg.text += '${i == 0 ? '' : ' '}מילה';
        store.touch();
        await settle(50);
      }
      msg.streaming = false;
      store.touch();
      await settle(300);
    }, reportKey: 'streaming_timeline');
    debugProfileBuildsEnabled = false;

    await binding.watchPerformance(() async {
      // On a device the real keyboard owns text input, so type through the controller.
      tester.widget<TextField>(find.byType(TextField).last).controller!.text = 'בדיקת QA של האפליקציה: תעני במילה אחת';
      await settle(300);
      await tester.tap(find.byWidgetPredicate((w) => w is Semantics && w.properties.label == 'שליחה').last);
      await settle(1000);
    }, reportKey: 'send');
    where('send');
  });
}
