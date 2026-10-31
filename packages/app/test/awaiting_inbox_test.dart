// #219: a finished task that waits on him is a card in "מחכה לך", with "עובד" and "לא עובד" (one tap each).
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/home/home_screen.dart';
import 'package:agent_company/ui/home/wait_item_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// A finished task's card, as hq maps it, beside the fake company's GO and question.
WaitItem _check(String id, {WaitState state = WaitState.open, String? answerLine, bool failed = false, String? outcome}) => WaitItem(
      id: id,
      kind: WaitKind.awaiting,
      from: 'dana',
      time: '01:58',
      kicker: 'לבדוק',
      headline: 'לבדוק את build 20 של לומו ב-TestFlight',
      body: 'התמונות בצ\'אט עולות גם מהטלפון',
      options: kAwaitingOptions,
      inboxId: 41,
      ref: 'task-160',
      state: state,
      answerLine: answerLine,
    )
      ..failed = failed
      ..outcome = outcome;

Future<void> _list(WidgetTester tester, List<WaitItem> Function(AppStore) items, String name, {bool dark = false, double scale = 1, bool alone = false}) async {
  final store = await pumpApp(tester, home: const Scaffold(body: WaitingList()), dark: dark, textScale: scale);
  final d = store.data!;
  final keep = items(store);
  d.waiting
    ..removeWhere((w) => alone || (w.kind != WaitKind.go && w.kind != WaitKind.blockingAsk))
    ..insertAll(0, keep);
  // A fresh list: its order is frozen at its first build.
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: Scaffold(key: UniqueKey(), body: const WaitingList())));
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/awaiting_inbox/$name.png'));
}

List<Map<String, dynamic>> _load(String name, String key) =>
    (jsonDecode(File('test/fixtures/samples/hq/$name.json').readAsStringSync())[key] as List).cast<Map<String, dynamic>>();

void main() {
  test('an hq `awaiting` item maps to a check with "עובד" and "לא עובד", not to what waits on him (task 986)', () {
    final at = DateTime(2026, 10, 22, 1, 58).millisecondsSinceEpoch;
    final d = mapSnapshot(
      board: _load('board', 'identities'),
      inbox: [
        {'id': 41, 'kind': 'awaiting', 'title': 'build 20 של לומו', 'body': 'build 20 של לומו · PR #3737', 'headline': 'לבדוק את build 20 ב-TestFlight',
          'from_identity': 'yoav', 'urgency': 'normal', 'blocking': false, 'ref': 'task-160', 'state': 'open', 'created_at': at},
        {'id': 42, 'kind': 'awaiting', 'title': 'x', 'body': 'x', 'from_identity': 'yoav', 'urgency': 'normal', 'blocking': false,
          'ref': 'task-161', 'state': 'resolved', 'created_at': at},
      ],
      asks: const [],
      toggles: const [],
    );
    expect(d.waiting, isEmpty, reason: 'a check is a message in the worker\'s chat, not a card in the stack');
    final w = d.checks.single;
    expect(w.kind, WaitKind.awaiting);
    expect(w.blocking, isFalse);
    expect(w.kicker, 'לבדוק');
    expect(w.headline, 'לבדוק את build 20 ב-TestFlight');
    expect(w.ref, 'task-160');
    expect(w.inboxId, 41);
    expect(w.askId, isNull);
    expect([for (final o in w.options) o.label], ['עובד', 'לא עובד', 'לא רלוונטי']);
    expect(w.options.first.primary, isTrue);
  });

  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('"מחכה לך": a card to check beside a GO and a question ($look)', (tester) async {
      await _list(tester, (_) => [_check('inbox:41')], 'open-$look', dark: dark, scale: scale);
      expect(find.text('עובד'), findsOneWidget);
      expect(find.text('לא עובד'), findsOneWidget);
      expect(find.text('לא רלוונטי'), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('inbox:41')), matching: find.text('פתיחה')), findsNothing, reason: 'a tap on the card opens its page');
    });
    testWidgets('"מחכה לך": after "עובד" and after "לא עובד", folded ($look)', (tester) async {
      await _list(tester, (_) => [
            _check('inbox:41', state: WaitState.answered, answerLine: 'עובד'),
            _check('inbox:42', state: WaitState.answered, answerLine: 'לא עובד', failed: true),
          ], 'answered-$look', dark: dark, scale: scale);
    });
    // #297: the three folded lines alone, so the last one is in the picture too.
    testWidgets('"מחכה לך": after "עובד", "לא עובד" and "לא רלוונטי", folded ($look)', (tester) async {
      await _list(tester, (_) => [
            _check('inbox:41', state: WaitState.answered, answerLine: 'עובד', outcome: 'done'),
            _check('inbox:42', state: WaitState.answered, answerLine: 'לא עובד', failed: true, outcome: 'failed'),
            _check('inbox:43', state: WaitState.answered, answerLine: 'לא רלוונטי', outcome: 'irrelevant'),
          ], 'answered-all-$look', dark: dark, scale: scale, alone: true);
      expect(find.text('לא רלוונטי'), findsOneWidget);
    });
  }

  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('a tap on the card opens its page, with "עובד" and "לא עובד" ($look)', (tester) async {
      await _list(tester, (_) => [_check('inbox:41')], 'open-$look', dark: dark, scale: scale);
      await tester.tap(find.descendant(of: find.byKey(const ValueKey('inbox:41')), matching: find.byType(InkWell)).first);
      await tester.pumpAndSettle();
      expect(find.byType(WaitItemScreen), findsOneWidget, reason: 'not the conversation: the card is in none');
      expect(find.text('עובד'), findsOneWidget);
      expect(find.text('לא עובד'), findsOneWidget);
      expect(find.text('סגירה'), findsNothing);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/awaiting_inbox/page-$look.png'));
    });
  }
}
