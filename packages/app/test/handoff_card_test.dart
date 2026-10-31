// The browser request card (B.9, 31/10): every state it can be in, and "סיימתי" that only says done when hq took it.
import 'package:agent_company/main.dart';
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

final _ts = DateTime(2026, 10, 31, 14, 4);

/// amit's live login in the demo's "מחכה לך" (fake_backend.dart): a card is tied to its request by this text.
const _amitWhat = "נדרש קוד אימות כדי להוריד את דוח אוקטובר. בתוקף עוד 8 דק'.";

/// Open (amit has a live login in "מחכה לך"), done, closed, never reached him, and waiting for its link.
Widget _states() => Scaffold(
      body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
        HandoffCardView(from: 'amit', card: HandoffCard(id: 'a', ts: _ts, what: _amitWhat, expires: "בתוקף עוד 8 דק'")),
        HandoffCardView(from: 'nobody', card: HandoffCard(id: 'b', ts: _ts, domain: 'mercury.com', what: 'להזין את קוד האימות', done: true)),
        HandoffCardView(from: 'nobody', card: HandoffCard(id: 'c', ts: _ts, what: 'לאשר את העוגיות')..ended = true),
        HandoffCardView(from: 'nobody', card: HandoffCard(id: 'd', ts: _ts, what: 'Sign in with the Google account you use for Cloudflare')..ended = true..failed = true),
        HandoffCardView(from: 'nobody', card: HandoffCard(id: 'e', ts: _ts, what: 'לסמן את התיבה "אני לא רובוט"')),
      ]),
    );

class _FailingDone extends FakeBackend {
  _FailingDone() : super(simulate: false, now: kDemoNow);
  @override
  Future<CommandResult> handoffDone(WaitItem item) async => const CommandResult.fail('אין חיבור לשרת', transient: true);
}

void main() {
  for (final (name, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('light_13', false, 1.3)]) {
    testWidgets('browser request card, every state ($name)', (tester) async {
      await pumpApp(tester, dark: dark, textScale: scale, size: const Size(390, 900), home: _states());
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/handoff_card_$name.png'));
    });
  }

  testWidgets('"סיימתי" that hq did not take keeps the buttons and shows why, never "בוצע"', (tester) async {
    await loadFonts();
    Motion.frozen = true;
    pinClock(kDemoNow);
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(390, 900) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final store = AppStore(_FailingDone());
    await store.start();
    final card = HandoffCard(id: 'a', ts: _ts, what: _amitWhat);
    await tester.pumpWidget(CompanyApp(store: store, themeMode: ThemeMode.light, home: Scaffold(body: ListView(children: [HandoffCardView(from: 'amit', card: card)]))));
    await tester.pump();
    await tester.tap(find.text('סיימתי'));
    await tester.pumpAndSettle();
    expect(card.done, isFalse);
    expect(find.text('סיימתי'), findsOneWidget);
    expect(find.textContaining('בוצע', findRichText: true), findsNothing);
    expect(store.error, isNotNull);
  });

  testWidgets('a worker that asks twice: the first, finished card does not take over the second request', (tester) async {
    await pumpApp(tester, size: const Size(390, 900), home: Scaffold(body: ListView(children: [
      HandoffCardView(from: 'amit', card: HandoffCard(id: 'old', ts: _ts, what: 'להיכנס ל-Mercury')..ended = true),
      HandoffCardView(from: 'amit', card: HandoffCard(id: 'new', ts: _ts, what: _amitWhat)),
    ])));
    expect(find.text('סיימתי'), findsOneWidget, reason: 'only the card of the live request has buttons');
    expect(find.textContaining('הבקשה נסגרה', findRichText: true), findsOneWidget);
  });
}
