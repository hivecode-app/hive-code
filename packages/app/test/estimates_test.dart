// הערכת זמן ליד משימה (t238): the estimate in a task's meta line, after the state word: on time, near, overdue, done;
// a cancelled one shows nothing. The hq side is packages/hq/test/estimates.test.ts.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/blocks/estimate.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

/// Numbers and units are joined by a non-breaking space; the tests read them with plain ones.
String _plain(String s) => s.replaceAll('\u00A0', ' ');
Finder _shown(String text) => find.byWidgetPredicate((w) => w is RichText && _plain(w.text.toPlainText()).contains(text));

DateTime _at(int h, int m) => DateTime(2026, 10, 20, h, m);

Estimate _est(int task, DateTime created, int min, {DateTime? closed, String? messageId, String identity = 'noa'}) => Estimate(
      task: task, identity: identity, createdAt: created, dueAt: created.add(Duration(minutes: min)), estimatedMin: min,
      closedAt: closed, actualMin: closed?.difference(created).inMinutes, messageId: messageId,
    );

Map<String, dynamic> _row(int task, String state, {int created = 1000, int due = 61000, int? closed, String? message}) => {
      'id': task * 10, 'task': task, 'identity': 'noa', 'message_id': message, 'state': state, 'created_at': created, 'due_at': due,
      'closed_at': closed, 'estimated_min': 1, 'actual_min': closed == null ? null : 1,
    };

void main() {
  test('minutes: under an hour in minutes, from there "1 שע\' 20 דק\'", no seconds', () {
    expect(_plain(minutesText(20)), "20 דק'");
    expect(_plain(minutesText(59)), "59 דק'");
    expect(_plain(minutesText(60)), "1 שע'");
    expect(_plain(minutesText(80)), "1 שע' 20 דק'");
    expect(_plain(minutesText(12, unit: false)), '12');
    expect(_plain(minutesText(80, unit: false)), "1 שע' 20 דק'");
  });

  test('spoken: Hebrew words, feminine, "עשרים דקות"', () {
    expect(minutesSpoken(20), 'עשרים דקות');
    expect(minutesSpoken(12), 'שתים עשרה דקות');
    expect(minutesSpoken(1), 'דקה');
    expect(minutesSpoken(2), 'שתי דקות');
    expect(minutesSpoken(21), 'עשרים ואחת דקות');
    expect(minutesSpoken(60), 'שעה');
    expect(minutesSpoken(120), 'שעתיים');
    expect(minutesSpoken(80), 'שעה ועשרים דקות');
  });

  test('the four states, and the line each reads', () {
    final now = _at(14, 6);
    var s = estimateShown(_est(1, _at(13, 54), 20), now)!;
    expect([s.phase, s.icon, _plain(s.text), s.spoken], [EstimatePhase.onTime, 'schedule', "הערכה 20 דק' · עברו 12", 'הערכה עשרים דקות, עברו שתים עשרה דקות']);

    s = estimateShown(_est(1, _at(13, 50), 20), now)!;
    expect([s.phase, s.icon, _plain(s.text)], [EstimatePhase.near, 'hourglass_bottom', "נשארו 4 דק' מתוך 20"]);

    s = estimateShown(_est(1, _at(13, 31), 20), now)!;
    expect([s.phase, s.icon, _plain(s.strong), _plain(s.text)], [EstimatePhase.overdue, 'running_with_errors', "באיחור של 15 דק'", "באיחור של 15 דק' · הערכה 20"]);

    s = estimateShown(_est(1, _at(13, 30), 20, closed: _at(13, 48)), now)!;
    expect([s.phase, s.icon, _plain(s.text)], [EstimatePhase.done, 'check_circle', "הסתיים ב-18 דק' מתוך 20"]);
  });

  test('near: the smaller of 20% and 5 minutes', () {
    // 100 minutes: 20% is 20, 5 is smaller. 10 minutes: 20% is 2.
    expect(estimateShown(_est(1, _at(12, 30), 100), _at(14, 6))!.phase, EstimatePhase.near); // 4 left
    expect(estimateShown(_est(1, _at(12, 30), 100), _at(14, 0))!.phase, EstimatePhase.onTime); // 10 left
    expect(estimateShown(_est(1, _at(14, 0), 10), _at(14, 7))!.phase, EstimatePhase.onTime); // 3 left, 20% is 2
    expect(estimateShown(_est(1, _at(14, 0), 10), _at(14, 8))!.phase, EstimatePhase.near); // 2 left
  });

  test('hq rows: the newest of a task decides; cancelled or closed-other-than-done shows nothing', () {
    final m = Estimate.byTask([
      _row(1, 'open'),
      _row(1, 'cancelled'), // older, replaced
      _row(2, 'cancelled'),
      _row(2, 'open'), // older than the cancelled one
      _row(3, 'missed'),
      _row(4, 'missed', closed: 5), // the task ended past its time
      _row(5, 'done', closed: 61000),
      {..._row(6, 'open'), 'task': null},
    ]);
    expect(m.keys.toSet(), {1, 3, 5});
    expect(m[3]!.overdueSwept, isTrue);
    expect(m[5]!.closedAt, isNotNull);
  });

  Future<void> pumpRows(WidgetTester tester, {bool dark = false, Size size = const Size(342, 520)}) async {
    final store = await pumpApp(tester, size: size, dark: dark);
    OpenTask task(int id, String title, OpenTaskState s) => OpenTask(id: id, title: title, state: s, project: 'shop', openedBy: 'yoav', worker: 'noa', since: _at(13, 30));
    store.data!.openTasks = [
      task(91, 'כפתור המשלוח בצ׳קאאוט', OpenTaskState.running),
      task(92, 'תיקון הגלילה ברשימה', OpenTaskState.running),
      task(93, 'שגיאת המפתח בקבלות', OpenTaskState.running),
      task(94, 'תשלומים כפולים', OpenTaskState.running),
      task(95, 'מעבר של כל הנתונים לשרת החדש, כולל הגיבויים והבדיקות אחריו', OpenTaskState.running),
    ];
    store.data!.estimates = {
      91: _est(91, _at(13, 54), 20),
      92: _est(92, _at(13, 50), 20),
      93: _est(93, _at(13, 31), 20, messageId: 'm-77'),
      94: _est(94, _at(13, 30), 20, closed: _at(13, 48)),
      95: _est(95, _at(11, 10), 80),
    };
    final ctx = tester.element(find.byType(Scaffold).first);
    Navigator.of(ctx).push(MaterialPageRoute(
      builder: (context) => Scaffold(body: ListView(children: [TasksBlock(tasks: StoreScope.of(context).data!.openTasks, now: kDemoNow)])),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('goldens: on time, near, overdue, done and a long line that wraps, light', (tester) async {
    await pumpRows(tester);
    expect(find.byType(EstimateLine), findsNWidgets(5));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/estimates/estimates-light.png'));
  });

  testWidgets('goldens: the same, dark', (tester) async {
    await pumpRows(tester, dark: true);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/estimates/estimates-dark.png'));
  });

  testWidgets('a screen reader gets the whole line in words', (tester) async {
    await pumpRows(tester);
    final h = tester.ensureSemantics();
    expect(find.bySemanticsLabel(RegExp('הערכה עשרים דקות, עברו שתים עשרה דקות')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('באיחור של חמש עשרה דקות, הערכה עשרים דקות')), findsOneWidget);
    h.dispose();
  });

  testWidgets('overdue: a tap opens the conversation at the message it was promised in; on time it does not', (tester) async {
    await pumpRows(tester);
    await tester.tap(find.byKey(const ValueKey('open-task-93')));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(find.textContaining('נועה'), findsWidgets);
  });

  testWidgets('a task that went overdue while the screen stayed open opens the promise at the tap', (tester) async {
    await pumpRows(tester);
    pinClock(_at(14, 20)); // 91 was due at 14:14; no rebuild in between
    await tester.tap(find.byKey(const ValueKey('open-task-91')));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
  });

  testWidgets('it moves once a minute', (tester) async {
    await pumpRows(tester);
    expect(_shown("הערכה 20 דק' · עברו 12"), findsOneWidget);
    pinClock(_at(14, 8));
    await tester.pump(const Duration(minutes: 1));
    expect(_shown("הערכה 20 דק' · עברו 14"), findsOneWidget);
    expect(_shown("נשארו 2 דק' מתוך 20"), findsOneWidget); // was 4 left
  });
}
