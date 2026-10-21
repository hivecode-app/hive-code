// The conversations list on the phone (convs_v2.dart, task 205) as he approved it in company-engine#37 (version B,
// scroll 2), in every state, light and dark and with text at 130%: at rest with nothing waiting (the home is one
// row), at rest with something waiting (the sentence and "מחכה לך"), scrolled (the home folded under the title),
// and typing in the search. Three of his own last lines carry each delivery state, and one is a card he closed.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// His last lines on the fake company's conversations: queued, delivered, read, and a GO he closed with a tap.
void _his(AppStore store) {
  final d = store.data!;
  ConversationSummary mine(String id, int minutesAgo, String text, Delivery? delivery) {
    final c = d.conversations.firstWhere((c) => c.identityId == id);
    return ConversationSummary(
      identityId: id,
      lastLine: text,
      text: text,
      time: '',
      at: kDemoNow.subtract(Duration(minutes: minutesAgo)),
      delivery: delivery,
      unread: c.unread,
      pinned: c.pinned,
      muted: c.muted,
    );
  }

  // The fake company's lines have no time of their own; hq's always do (_applyLastLines).
  for (final (i, c) in [...d.conversations].indexed) {
    if (c.at != null) continue;
    d.conversations[i] = ConversationSummary(
      identityId: c.identityId, lastLine: c.lastLine, text: c.text, time: c.time, unread: c.unread, pinned: c.pinned, muted: c.muted,
      at: kDemoNow.subtract(Duration(minutes: 30 + i * 47)),
    );
  }
  for (final c in [
    mine('rotem', 1, 'מצאת מה שולח לי את ההתראות?', Delivery.queued),
    mine('noga', 6, 'תודה. אפשר לקבל את הטבלה המלאה?', Delivery.delivered),
    mine('eli', 9, 'הזמנתי, תודה', Delivery.read),
    mine('amit', 12, 'סיימת: GO לפרודקשן: גרסה 2.6.10', null),
  ]) {
    final i = d.conversations.indexWhere((x) => x.identityId == c.identityId);
    d.conversations[i] = c;
  }
  store.touch();
}

/// Nothing waits and nothing burns.
void _quiet(AppStore store) {
  final d = store.data!;
  d.waiting.removeWhere((w) => w.state == WaitState.open || w.state == WaitState.pending);
  for (final id in [...d.presence.keys]) {
    if (d.presence[id]!.status == WorkerStatus.stuck) d.presence[id] = const Presence(status: WorkerStatus.working);
  }
  store.touch();
}

Future<void> _shot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/convs_v2/$name.png'));
}

void main() {
  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('at rest, nothing waits: the home is one row ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale);
      _his(store);
      _quiet(store);
      await _shot(tester, 'rest-quiet-$look');
    });

    testWidgets('at rest, something waits: the sentence and "מחכה לך" ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale);
      _his(store);
      await _shot(tester, 'rest-waiting-$look');
    });

    testWidgets('scrolled: the home folded to its row under the title ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale);
      _his(store);
      _quiet(store);
      await tester.pump();
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -900));
      await _shot(tester, 'scrolled-$look');
    });

    testWidgets('typing: conversations and messages that start with it ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale);
      _his(store);
      store.data!.recent = [
        (id: 'rotem', text: 'דנה ביקשה לבדוק את השרת של טיקי בוט לפני הפריסה', at: kDemoNow.subtract(const Duration(minutes: 4)), mine: false),
        (id: 'eli', text: 'הזמנתי לדנה את החדר ליום חמישי', at: kDemoNow.subtract(const Duration(hours: 26)), mine: true),
      ];
      store.touch();
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'דנ');
      await _shot(tester, 'typing-$look');
    });
  }
}
