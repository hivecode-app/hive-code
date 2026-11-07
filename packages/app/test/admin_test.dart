import 'package:agent_company/ui/handoff/handoff_screen.dart';
import 'package:agent_company/ui/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  testWidgets('automations: one tap turns a check off and says so', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1100), home: const AutomationsScreen());
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/automations_light.png'));
    await tester.tap(find.bySemanticsLabel('רותם בודקת את כל הפרודקשן כל 5 דקות'));
    await tester.pump();
    final a = store.data!.automations.first;
    expect(a.enabled, isFalse);
    expect(find.textContaining('כובתה ידנית'), findsNWidgets(2));
  });

  testWidgets('tab handoff: six digits finish it and the screen thanks the worker', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: SizedBox()));
    final item = store.data!.waiting.firstWhere((w) => w.from == 'amit');
    await tester.pumpWidget(Container());
    await pumpApp(tester, home: HandoffScreen(item: item));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/handoff_light.png'));
    await tester.enterText(find.byType(TextField), '482913');
    await tester.pump();
    expect(find.text('תודה. עמית ממשיך.'), findsOneWidget);
    await tester.pump(const Duration(seconds: 2));
  });
}
