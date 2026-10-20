// The day lanes on the web (#148): `1 << 52` is 0 in JavaScript, where `<<` is 32-bit, so a clamp up to it threw
// and the block fell to a grey box. No dart:io here, so this file also runs in `flutter test --platform chrome`;
// the guard against the same shift anywhere in lib/ is in shift_guard_test.dart (it reads files, so VM only).
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/ui/blocks/data.dart';
import 'package:agent_company/ui/blocks/lanes.dart';
import 'package:agent_company/theme/theme.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(LanesData d) => MaterialApp(
  theme: buildTheme(Palette.light),
  home: StoreScope(
    store: AppStore(FakeBackend(simulate: false)),
    version: 0,
    child: Directionality(
      textDirection: TextDirection.rtl,
      child: Scaffold(
        body: SingleChildScrollView(child: LanesBlock(data: d)),
      ),
    ),
  ),
);

void main() {
  final now = DateTime(2026, 10, 20, 23, 10);
  final lane = Lane(
    id: 'agent-company',
    name: 'agent-company',
    done: [LaneDone(at: now.subtract(const Duration(hours: 3)), text: 'מוזג')],
    running: [
      LaneRun(from: now.subtract(const Duration(hours: 1)), text: 'רץ'),
    ],
    waiting: 1,
  );

  testWidgets('a day of lanes draws without throwing', (tester) async {
    await tester.pumpWidget(
      _wrap(
        LanesData(
          from: now.subtract(const Duration(hours: 16)),
          now: now,
          lanes: [lane],
        ),
      ),
    );
    expect(find.text('agent-company'), findsOneWidget);
  });

  testWidgets('a zero-length day (from == now) draws too', (tester) async {
    await tester.pumpWidget(
      _wrap(LanesData(from: now, now: now, lanes: [lane])),
    );
    expect(find.text('agent-company'), findsOneWidget);
  });
}
