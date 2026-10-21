import 'package:agent_company/data/store.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  for (final dark in [false, true]) {
    final t = dark ? 'dark' : 'light';
    testWidgets('desktop: rail, list, chat, context ($t)', (tester) async {
      await pumpApp(tester, dark: dark, size: const Size(1440, 860));
      final ctx = tester.element(find.byType(Scaffold).first);
      NavScope.read(ctx).go(AppTab.chats);
      // The app opens on the home (desktop_home_test.dart); a conversation shows the chat and its context.
      final store = StoreScope.read(ctx);
      store.homeOpen = false;
      store.touch();
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/desktop_$t.png'));
    });
  }

  testWidgets('desktop: G then P opens the projects, by physical key', (tester) async {
    await pumpApp(tester, size: const Size(1440, 860));
    await tester.sendKeyEvent(LogicalKeyboardKey.keyG, physicalKey: PhysicalKeyboardKey.keyG);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyP, physicalKey: PhysicalKeyboardKey.keyP);
    await tester.pump();
    final ctx = tester.element(find.byType(Scaffold).first);
    expect(NavScope.read(ctx).tab, AppTab.projects);
  });
}
