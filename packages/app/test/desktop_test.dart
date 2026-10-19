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
      NavScope.read(ctx).go(AppTab.convs);
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/desktop_$t.png'));
    });
  }

  testWidgets('desktop: G then B opens the board, by physical key', (tester) async {
    await pumpApp(tester, size: const Size(1440, 860));
    await tester.sendKeyEvent(LogicalKeyboardKey.keyG, physicalKey: PhysicalKeyboardKey.keyG);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyB, physicalKey: PhysicalKeyboardKey.keyB);
    await tester.pump();
    final ctx = tester.element(find.byType(Scaffold).first);
    expect(NavScope.read(ctx).tab, AppTab.board);
  });
}
