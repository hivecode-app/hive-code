// "מחכה לך" rows (WaitingList, the desktop peek): one-tap answers with an undo, rows that never move.
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/home/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  const list = Scaffold(body: WaitingList());

  testWidgets('waiting list at 130% text keeps the first answer visible', (tester) async {
    await pumpApp(tester, textScale: 1.3, home: list);
    expect(find.text('ניסיון נוסף אחרי 24 שעות'), findsOneWidget);
  });

  testWidgets('one tap decides: folded at once with "ביטול" for 5s, then collapses (#258)', (tester) async {
    final store = await pumpApp(tester, home: list);
    expect(find.text('מחכה לך'), findsWidgets);
    await tester.tap(find.text('ניסיון נוסף אחרי 24 שעות').first);
    await tester.pump();
    expect(findShown('ענית: ניסיון נוסף אחרי 24 שעות · 14:06'), findsOneWidget);
    expect(find.text('ביטול'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    expect(find.text('ביטול'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    expect(find.textContaining('ענית: ניסיון נוסף אחרי 24 שעות'), findsOneWidget);
    final ido = store.data!.waiting.firstWhere((w) => w.from == 'ido');
    expect(ido.state, WaitState.answered);
    expect(store.data!.waitingCount, 2);
  });

  testWidgets('undo cancels the answer and brings the buttons back', (tester) async {
    final store = await pumpApp(tester, home: list);
    await tester.tap(find.text('אישור').first);
    await tester.pump();
    expect(findShown('אישרת · 14:06'), findsOneWidget);
    await tester.tap(find.text('ביטול'));
    await tester.pump(const Duration(seconds: 6));
    expect(find.text('אישור'), findsWidgets);
    expect(store.data!.waiting.firstWhere((w) => w.from == 'dana').state, WaitState.open);
  });

  testWidgets('rows keep their place after an answer (nothing moves under the finger)', (tester) async {
    await pumpApp(tester, home: list);
    final before = tester.getTopLeft(find.text('עמית').first);
    await tester.tap(find.text('אישור').first);
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    final after = tester.getTopLeft(find.text('עמית').first);
    // The answered row collapses (buttons -> one line), rows below may move up but never reorder.
    expect(after.dy <= before.dy, isTrue);
    expect(findShown('האישור נשלח'), findsOneWidget);
  });
}
