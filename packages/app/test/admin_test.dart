import 'package:agent_company/ui/board/board_screen.dart';
import 'package:agent_company/ui/board/ticket_screen.dart';
import 'package:agent_company/ui/handoff/handoff_screen.dart';
import 'package:agent_company/ui/org/org_screen.dart';
import 'package:agent_company/ui/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  for (final dark in [false, true]) {
    final t = dark ? 'dark' : 'light';
    testWidgets('board golden ($t)', (tester) async {
      await pumpApp(tester, dark: dark, home: const Scaffold(body: BoardScreen()));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/board_$t.png'));
    });
    testWidgets('ticket golden ($t)', (tester) async {
      await pumpApp(tester, dark: dark, size: const Size(342, 900), home: const TicketScreen(number: '#3711'));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/ticket_$t.png'));
    });
    testWidgets('org golden ($t)', (tester) async {
      await pumpApp(tester, dark: dark, size: const Size(342, 1100), home: const Scaffold(body: OrgScreen()));
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/org_$t.png'));
    });
  }

  testWidgets('board filter by project hides other sections', (tester) async {
    await pumpApp(tester, home: const Scaffold(body: BoardScreen()));
    await tester.tap(find.text('טיקיבוט'));
    await tester.pump();
    expect(find.text('פרסור "בעוד שבועיים"'), findsOneWidget);
    expect(find.text('תשלומים נכשלים בחידוש מנוי'), findsNothing);
    expect(find.text('מחכה לך'), findsNothing);
    await tester.tap(find.text('הכול'));
    await tester.pump();
  });

  testWidgets('automations: one tap turns a check off and says so', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1100), home: const Scaffold(body: OrgScreen()));
    await tester.tap(find.text('אוטומציות'));
    await tester.pump();
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

  testWidgets('settings golden', (tester) async {
    await pumpApp(tester, home: const SettingsScreen());
    await tester.pump();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/settings_light.png'));
  });
}
