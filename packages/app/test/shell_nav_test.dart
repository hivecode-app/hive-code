// Android behaviour found on the emulator (QA-LOG, סבב 6): back on another tab goes home before it
// leaves the app, and a phone turned on its side keeps the phone layout.
import 'package:agent_company/ui/desktop.dart';
import 'package:agent_company/ui/home/home_screen.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:agent_company/ui/shell.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  testWidgets('back on the chats tab goes to home first', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('שיחות').last);
    await tester.pump();
    final nav = NavScope.read(tester.element(find.byType(Shell)));
    expect(nav.tab, AppTab.convs);
    final handled = await tester.binding.handlePopRoute();
    await tester.pump();
    expect(handled, isTrue, reason: 'the app stays open');
    expect(nav.tab, AppTab.home);
  });

  testWidgets('back with a chat open closes the chat and keeps the tab', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('שיחות').last);
    await tester.pump();
    final nav = NavScope.read(tester.element(find.byType(Shell)));
    tester.state<NavigatorState>(find.byType(Navigator).first).push(MaterialPageRoute(builder: (_) => const Scaffold(body: Text('צ׳אט'))));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('צ׳אט'), findsNothing);
    expect(nav.tab, AppTab.convs);
  });

  testWidgets('back with search open closes the search first, then goes home', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('שיחות').last);
    await tester.pump();
    await tester.tap(find.byTooltip('חיפוש'));
    await tester.pump();
    expect(find.byTooltip('סגירת החיפוש'), findsOneWidget);
    final nav = NavScope.read(tester.element(find.byType(Shell)));
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.byTooltip('סגירת החיפוש'), findsNothing);
    expect(nav.tab, AppTab.convs);
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(nav.tab, AppTab.home);
  });

  testWidgets('leaving the tab closes its search, so back never finds it open with nothing behind', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.text('שיחות').last);
    await tester.pump();
    await tester.tap(find.byTooltip('חיפוש'));
    await tester.pump();
    await tester.tap(find.text('בית').last);
    await tester.pump();
    await tester.tap(find.text('שיחות').last);
    await tester.pump();
    expect(find.byTooltip('סגירת החיפוש'), findsNothing);
    final nav = NavScope.read(tester.element(find.byType(Shell)));
    expect(nav.backHandler, isNull);
  });

  testWidgets('a short but wide window is still a desktop', (tester) async {
    await pumpApp(tester, size: const Size(1280, 520));
    expect(find.byType(DesktopFrame), findsOneWidget);
  });

  testWidgets('a phone on its side keeps the phone layout', (tester) async {
    await pumpApp(tester, size: const Size(914, 411));
    expect(find.byType(DesktopFrame), findsNothing);
    expect(find.byType(BottomNav), findsOneWidget);
    expect(find.byType(HomeScreen), findsOneWidget);
  });

  testWidgets('a desktop window still gets the desktop frame', (tester) async {
    await pumpApp(tester, size: const Size(1440, 900));
    expect(find.byType(DesktopFrame), findsOneWidget);
  });
}
