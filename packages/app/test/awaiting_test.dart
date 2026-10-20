// "מה לבדוק" (#108): the block and its data (the hq side of "בדקתי" is in awaiting_hq_test.dart).
import 'dart:convert';

import 'package:agent_company/data/hq_backend.dart' show mapSnapshot;
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

final _at = DateTime(2026, 10, 20, 14, 6);

Map<String, dynamic> _task(int id, String kind, {String? note, String? summary, int at = 0}) => {
      'id': id, 'ref': null, 'project': 'agent-company', 'title': 'אפליקציה: משימה $id', 'summary': summary, 'identity': 'agent-company-t$id',
      'awaiting': kind, 'awaiting_note': note, 'awaiting_at': at, 'pr': '$id',
    };

Future<AppStore> _block(WidgetTester tester, {bool dark = false, double textScale = 1}) async {
  final store = await pumpApp(tester, dark: dark, textScale: textScale, size: const Size(342, 400));
  final ctx = tester.element(find.byType(Scaffold).first);
  Navigator.of(ctx).push(MaterialPageRoute(
    builder: (context) => Scaffold(
      backgroundColor: context.p.surface,
      body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
        BlockCard(label: 'מה לבדוק', child: AwaitingBlock(data: AwaitingData.of(StoreScope.of(context).data!), now: _at)),
      ]),
    ),
  ));
  await tester.pumpAndSettle();
  return store;
}

void main() {
  test('the board\'s awaiting: parsed, a kind this app does not know is left out', () {
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [],
        awaiting: [_task(1, 'check', note: 'לבדוק'), _task(2, 'later'), _task(3, 'deploy', summary: 'עלה')]);
    expect(d.awaiting.map((t) => t.id), [1, 3]);
    expect(d.awaiting.first.kind, AwaitingKind.check);
    expect(d.awaiting.first.note, 'לבדוק');
    expect(d.awaiting.first.line, 'משימה 1', reason: 'no summary: the title without its area');
    expect(d.awaiting.last.line, 'עלה');
  });

  test('AwaitingData: all of it, or the recipe\'s ids in its order; one that left is gone; JSON and back', () {
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], awaiting: [_task(1, 'check'), _task(2, 'deploy'), _task(3, 'check')]);
    expect(AwaitingData.of(d).items.map((x) => x.id), [1, 2, 3]);
    expect(AwaitingData.of(d, [3, 9, 1]).items.map((x) => x.id), [3, 1]);
    final a = AwaitingData.of(d);
    expect(jsonEncode(AwaitingData.fromJson(jsonDecode(jsonEncode(a.toJson())) as Map<String, dynamic>).toJson()), jsonEncode(a.toJson()));
    expect(AwaitingData.fromJson({'items': [{'id': 1, 'kind': 'later', 'text': 'x', 'at': 0}]}).items, isEmpty, reason: 'an unknown kind, as from hq');
  });

  testWidgets('the block: a row each, "בדקתי" takes it off at once', (tester) async {
    final store = await _block(tester);
    expect(findShown('התמונות בצ\'אט עולות גם מהטלפון'), findsOneWidget);
    expect(findShown('לבדוק · לשלוח תמונה מהטלפון ולראות שהיא עולה'), findsOneWidget);
    expect(findShown('מחכה לפריסה · מחכה ל-GO שלך'), findsOneWidget);
    expect(find.text('בדקתי'), findsOneWidget);
    expect(find.text('נפרס'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp(r'^לבדוק\. התמונות')), findsOneWidget);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/awaiting.png'));

    await tester.tap(find.text('בדקתי'));
    await tester.pumpAndSettle();
    expect(find.text('בדקתי'), findsNothing);
    expect(store.data!.awaiting.map((t) => t.id), [3711]);
    await tester.tap(find.text('נפרס'));
    await tester.pumpAndSettle();
    expect(store.data!.awaiting, isEmpty);
    expect(find.byType(InkWell), findsNothing, reason: 'an empty block shows nothing');
  });

  testWidgets('the block: dark and text at 130%', (tester) async {
    await _block(tester, dark: true);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/awaiting-dark.png'));
    await tester.pumpWidget(const SizedBox());
    await _block(tester, textScale: 1.3);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/awaiting-text-130.png'));
  });

  testWidgets('"סטטוס": "מה לבדוק" under "מחכה לך", only when something waits', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: StatusScreen()), size: const Size(342, 1100));
    await tester.pumpAndSettle();
    expect(find.text('מה לבדוק'), findsOneWidget);
    expect(find.text('בדקתי'), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/blocks/status.png'));
    store.data!.awaiting = [];
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text('מה לבדוק'), findsNothing);
  });
}
