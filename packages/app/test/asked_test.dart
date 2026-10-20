// "ביקשת" (#118): his requests to workers, open or answered, until he reads the answer. The data (hq's
// `asked`), the recipe block, the block itself and a tap to the answer (hq's `asked.changed` is in asked_hq_test.dart).
import 'dart:convert';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/convs/home_blocks.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// 12 minutes after Dana's request in the fake (14:06).
final _now = DateTime(2026, 10, 20, 14, 18);

Map<String, dynamic> _asked(String id, {String state = 'open', String identity = 'ido', int at = 0, int count = 1, Map<String, dynamic>? reply}) => {
      'id': id, 'identity': identity, 'body': 'בקשה $id', 'created_at': at, 'count': count, 'state': state, 'reply': reply,
    };

Future<AppStore> _block(WidgetTester tester) async {
  final store = await pumpApp(tester, size: const Size(342, 716));
  final ctx = tester.element(find.byType(Scaffold).first);
  Navigator.of(ctx).push(MaterialPageRoute(
    builder: (context) => Scaffold(
      backgroundColor: context.p.surface,
      body: ListView(padding: const EdgeInsets.symmetric(vertical: 8), children: [
        BlockCard(label: 'ביקשת', child: AskedBlock(data: AskedData.of(StoreScope.of(context).data!), now: _now)),
      ]),
    ),
  ));
  await tester.pumpAndSettle();
  return store;
}

void main() {
  test('the board\'s asked: parsed with its answer; a state this app does not know is left out', () {
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], asked: [
      _asked('m3', state: 'answered', at: 3, count: 2, reply: {'id': 'r1', 'body': 'הנה הבעיה', 'created_at': 5}),
      _asked('m2', state: 'later'),
      _asked('m1', at: 1),
    ]);
    expect(d.asked.map((a) => a.id), ['m3', 'm1']);
    final a = d.asked.first;
    expect(a.state, AskedState.answered);
    expect(a.count, 2);
    expect(a.reply!.id, 'r1');
    expect(a.reply!.body, 'הנה הבעיה');
    expect(a.reply!.at.millisecondsSinceEpoch, 5);
    expect(d.asked.last.state, AskedState.open);
    expect(d.asked.last.reply, isNull);
    expect(d.asked.last.count, 1);
  });

  test('AskedData: all of it, or the recipe\'s ids in its order; one that left is gone; JSON and back', () {
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], asked: [
      _asked('a'),
      _asked('b', state: 'answered', reply: {'id': 'rb', 'body': 'x', 'created_at': 9}),
    ]);
    expect(AskedData.of(d).items.map((x) => x.id), ['a', 'b']);
    expect(AskedData.of(d, ['b', 'gone', 'a']).items.map((x) => x.id), ['b', 'a']);
    expect(AskedData.of(d).items.last.reply, 'rb');
    final j = AskedData.of(d);
    expect(jsonEncode(AskedData.fromJson(jsonDecode(jsonEncode(j.toJson())) as Map<String, dynamic>).toJson()), jsonEncode(j.toJson()));
  });

  test('recipe: the asked block round trips, its key is "asked"; ids hq doesn\'t have are skipped, none left hides it', () {
    final r = HomeRecipe.fromJson({
      'version': 1, 'composed_by': 'adi', 'composed_at': 1, 'source': 'agent',
      'blocks': [
        {'type': 'asked', 'messages': ['m1', 'gone', 'm3'], 'emphasis': 'strong'},
        {'type': 'asked', 'messages': ['gone']},
      ],
    });
    expect(r.blocks.map((b) => b.type), ['asked', 'asked']);
    expect(r.blocks.first.messages, ['m1', 'gone', 'm3']);
    expect(r.blocks.first.key, 'asked');
    expect(r.blocks.first.emphasis, Emphasis.strong);
    expect(HomeRecipe.fromJson(r.toJson()).toJson(), r.toJson());
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], asked: [_asked('m3'), _asked('m1')]);
    final live = liveBlocks(r, d);
    expect(live.length, 1, reason: 'a block with no id left is gone');
    expect(live.single.messages, ['m1', 'm3']);
  });

  testWidgets('the block: an open row says who it waits for and since when, an answered one says "ענו"', (tester) async {
    await _block(tester);
    expect(findShown('ותוסיפי לרשימה גם את #3711 כשהוא ימוזג'), findsOneWidget);
    expect(findShown("מחכה לדנה · לפני 12 דק'"), findsOneWidget);
    expect(findShown('עידו, מה עם התשלומים שנכשלים?'), findsOneWidget);
    expect(findShown('ענו · עידו · לפני שעה'), findsOneWidget);
    expect(find.text('לתשובה'), findsOneWidget, reason: 'only the answered row links to an answer');
    expect(find.bySemanticsLabel(RegExp(r'^ביקשת מעידו: .*\. ענו\. לפני שעה$')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the block: the answer read on another device leaves at once', (tester) async {
    final store = await _block(tester);
    store.data!.asked = [for (final a in store.data!.asked) if (a.id != 'u1') a];
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text('לתשובה'), findsNothing);
    expect(findShown('מחכה לדנה'), findsOneWidget);
  });

  testWidgets('a tap on an answered row opens the conversation at the answer', (tester) async {
    await _block(tester);
    await tester.tap(find.text('לתשובה'));
    await tester.pumpAndSettle();
    final chat = tester.widget<ChatScreen>(find.byType(ChatScreen));
    expect(chat.identityId, 'ido');
    expect(ChatScreen.pendingTarget, isEmpty, reason: 'the conversation took the target');
    // Ido's conversation is long: the answer is brought into view, not left above the fold.
    final answer = find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().startsWith('בדקתי. אין חיוב כפול'));
    expect(answer, findsOneWidget);
    final y = tester.getTopLeft(answer).dy;
    expect(y, inInclusiveRange(0, 716));
  });

  testWidgets('an answer that streamed in (another id on screen) is found by its start', (tester) async {
    await _block(tester);
    final ctx = tester.element(find.byType(AskedBlock));
    openAsked(ctx, AskedItem(id: 'u1', who: 'ido', text: 'x', at: _now, reply: 'stored-id', replyText: 'בדקתי. אין חיוב כפול. הבעיה היא ניסיון חוזר מיידי…', replyAt: _now));
    await tester.pumpAndSettle();
    final answer = find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().startsWith('בדקתי. אין חיוב כפול'));
    expect(answer, findsOneWidget);
    expect(ChatScreen.pendingTargetText, isEmpty);
  });
}
