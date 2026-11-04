// What waits on him (task 986): the pinned row over the chats, the stack of cards it opens, its swipes and buttons,
// and that only an ask or a GO is his. The queue's order and a GO's text are the same as the tab's were (task 306).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart' show mapSnapshot;
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/decisions/decisions_screen.dart';
import 'package:agent_company/ui/nav.dart';

import 'helpers.dart';


WaitItem item(String id, WaitKind kind, {String from = 'dana', String body = 'גוף', String? headline}) =>
    WaitItem(id: id, kind: kind, from: from, time: '04:00', kicker: 'k', body: body, headline: headline);

CompanyData data(List<WaitItem> waiting) => CompanyData(
      teams: const {},
      identities: const {},
      presence: const {},
      waiting: waiting,
      decisions: const [],
      digest: const [],
      digestSince: '',
      activity: const [],
      conversations: const [],
      chats: const {},
      tickets: const [],
      ticketDetails: const {},
      boardSubtitle: '',
      orgTeams: const [],
      orgSubtitle: '',
      capacity: const [],
      automations: const [],
    );

void main() {
  test('most urgent first; a decision moves to the next and counts in "2 מתוך 3"', () {
    final ask = item('a', WaitKind.softAsk), go = item('g', WaitKind.go, from: 'adi'), block = item('b', WaitKind.blockingAsk, from: 'eli');
    final d = data([ask, go, block]);
    final q = DecisionQueue();
    q.sync(d);
    expect(q.order, ['b', 'g', 'a']);
    expect(q.current, 'b');
    expect(q.position, (1, 3));
    q.decided(block, 'ענית: כן');
    q.sync(d);
    expect(q.current, 'g');
    expect(q.position, (2, 3));
  });

  test('"אחר כך" puts it at the end; "ביטול" brings the decision back', () {
    final a = item('a', WaitKind.go, from: 'adi'), b = item('b', WaitKind.go, from: 'eli'), c = item('c', WaitKind.go, from: 'gil');
    final d = data([a, b, c]);
    final q = DecisionQueue();
    q.sync(d);
    q.later();
    expect(q.order, ['b', 'c', 'a']);
    expect(q.current, 'b');
    var undone = false;
    q.decided(b, 'אישרת', undo: () => undone = true);
    expect(q.current, 'c');
    q.undoLast();
    expect(undone, isTrue);
    expect(q.current, 'b');
    expect(q.done, isEmpty);
  });

  test('"ביטול" after "לא עכשיו": hq\'s answer that says "put off" arriving after the undo keeps the item in its place', () {
    final a = item('a', WaitKind.go, from: 'adi'), b = item('b', WaitKind.go, from: 'eli'), c = item('c', WaitKind.go, from: 'gil');
    final d = data([a, b, c]);
    final q = DecisionQueue();
    q.sync(d);
    expect(q.order, ['a', 'b', 'c']);
    // "לא עכשיו" on a: shown at once, the next comes in.
    a.state = WaitState.notNow;
    q.decided(a, 'לא עכשיו', undo: () => a.state = WaitState.open);
    q.sync(d);
    expect(q.current, 'b');
    // "ביטול": open again, a is the one on screen.
    q.undoLast();
    a.state = WaitState.open;
    q.sync(d); // a build between the undo and hq's answer
    expect(q.current, 'a');
    // hq's update to the snooze arrives after that: a is put off in it.
    final late = item('a', WaitKind.go, from: 'adi')..state = WaitState.notNow;
    final stale = data([late, b, c]);
    q.sync(stale);
    expect(q.current, 'a', reason: 'the same one, on the screen');
    expect(q.order, ['a', 'b', 'c'], reason: 'in the same place');
    // and the update for the resume: open, nothing moves.
    q.sync(data([item('a', WaitKind.go, from: 'adi'), b, c]));
    expect(q.current, 'a');
    expect(q.order, ['a', 'b', 'c']);
  });

  test('taken back, then closed elsewhere: it leaves the queue', () {
    final a = item('a', WaitKind.go, from: 'adi'), b = item('b', WaitKind.go, from: 'eli');
    final q = DecisionQueue();
    q.sync(data([a, b]));
    a.state = WaitState.notNow;
    q.decided(a, 'לא עכשיו', undo: () => a.state = WaitState.open);
    q.undoLast();
    a.state = WaitState.open;
    q.sync(data([a, b]));
    q.sync(data([b]));
    expect(q.order, ['b']);
    expect(q.current, 'b');
  });

  test('the last one decided leaves the queue empty; an item closed elsewhere leaves it', () {
    final a = item('a', WaitKind.go);
    final d = data([a]);
    final q = DecisionQueue();
    q.sync(d);
    q.decided(a, 'אישרת');
    q.sync(d);
    expect(q.current, isNull);
    expect(q.position, isNull);

    final b = item('b', WaitKind.go, from: 'eli');
    final d2 = data([b]);
    final q2 = DecisionQueue()..sync(d2);
    b.state = WaitState.answered;
    q2.sync(d2);
    expect(q2.order, isEmpty);
  });

  test("a GO's text: hq's trailer lines become the risk in words and the PR", () {
    final t = DecisionText.of(item('g', WaitKind.go,
        headline: 'עדכון לאפליקציה',
        body: 'מה נכנס: שורה אחת.\nחזרה אחורה: revert.\nPR: https://github.com/hivecode-app/hive-code/pull/210\nסיכון: low'));
    expect(t.headline, 'עדכון לאפליקציה');
    expect(t.details, 'מה נכנס: שורה אחת.\nחזרה אחורה: revert.');
    expect(t.risk, 'סיכון נמוך');
    expect(t.prUrl, 'https://github.com/hivecode-app/hive-code/pull/210');

    final n = DecisionText.of(item('h', WaitKind.go, body: 'כותרת\nפרטים\nPR: 211\nסיכון: medium'));
    expect(n.headline, 'כותרת');
    expect(n.details, 'פרטים');
    expect(n.prUrl, isNull, reason: 'a bare number is not a link: hq sends the link');
    expect(n.risk, 'סיכון בינוני');
  });

  void resetQueue() => decisionQueue
    ..order.clear()
    ..done.clear()
    ..lastId = null
    ..current = null;

  WaitItem go({List<WaitLink> links = const [], String from = 'dana'}) => WaitItem(
        id: 'g-$from',
        kind: WaitKind.go,
        from: from,
        time: '13:41',
        kicker: 'GO לפרודקשן · לומו 1.1.20',
        headline: 'לפרוס את עדכון הלומו: הטקסט בטלפון מתוקן',
        body: 'תיקון הטקסט בטלפון.\nחזרה אחורה: כדקה.\nPR: 3698\nסיכון: low',
        options: const [AskOption(id: 'go', label: 'GO', primary: true)],
        askId: 'inbox:7',
        inboxId: 7,
        links: links,
        createdAt: DateTime(2026, 10, 20, 13, 41),
      );

  WaitItem ask({String id = 'a-1', String from = 'ido', bool blocking = true, bool yesNo = false}) => WaitItem(
        id: id,
        kind: blocking ? WaitKind.blockingAsk : WaitKind.softAsk,
        from: from,
        time: '14:02',
        kicker: 'חוסם',
        headline: 'מה עושים עם 37 המנויים שהכרטיס שלהם נדחה?',
        body: 'רותם מצאה 37 מנויים עם כרטיס שנדחה פעמיים השבוע.',
        options: yesNo
            ? const [AskOption(id: 'no', label: 'לא'), AskOption(id: 'yes', label: 'כן')]
            : const [AskOption(id: 'retry24', label: 'ניסיון נוסף אחרי 24 שעות'), AskOption(id: 'cancel', label: 'ביטול המנוי מיד')],
        askId: 'ask-$id',
        inboxId: 9,
        createdAt: DateTime(2026, 10, 20, 14, 2),
      );

  /// The stack with only [items] waiting.
  Future<AppStore> stack(WidgetTester tester, List<WaitItem> items, {bool dark = false, double scale = 1, Size size = kPhone}) async {
    final store = await pumpApp(tester, dark: dark, textScale: scale, size: size, home: const SizedBox());
    store.data!.waiting
      ..clear()
      ..addAll(items);
    resetQueue();
    await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: const DecisionStack()));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    return store;
  }

  Finder card(String text) => find.textContaining(text, findRichText: true);

  test('only an ask or a GO is his: an incident, a fault hq caught and a deploy are not; a check is a message', () {
    final at = DateTime(2026, 10, 31, 9).millisecondsSinceEpoch;
    Map<String, Object?> row(int id, String kind, {String from = 'adi', String? ref}) =>
        {'id': id, 'kind': kind, 'title': 't$id', 'body': '', 'from_identity': from, 'ref': ref, 'urgency': 'normal', 'blocking': true, 'state': 'open', 'created_at': at};
    final d = mapSnapshot(board: const [], asks: const [], toggles: const [], inbox: [
      row(1, 'go'),
      row(2, 'incident'),
      row(3, 'awaiting', ref: 'task-5'),
      row(4, 'delivery_failure', from: 'hq'),
    ]);
    expect(d.waiting.map((w) => w.inboxId), [1]);
    expect(d.checks.map((w) => w.inboxId), [3]);
    // The manager himself down is his: nobody else would see it. What the manager decided (a note) is not.
    final m = mapSnapshot(board: const [], asks: const [], toggles: const [], manager: 'yoav', inbox: [
      row(5, 'delivery_failure', from: 'yoav'),
      row(6, 'shift_failure', from: 'yoav'),
      row(7, 'escalation_note', from: 'yoav'),
      row(8, 'incident', from: 'yoav', ref: 'accounts-all-full'),
      row(9, 'delivery_failure', from: 'dana'),
    ]);
    expect(m.waiting.map((w) => w.inboxId).toSet(), {5, 6, 8});
  });

  test('"all the accounts are full" says so, with no GO on it', () {
    final w = mapSnapshot(board: const [], asks: const [], toggles: const [], manager: 'yoav', inbox: [
      {'id': 8, 'kind': 'incident', 'title': 'כל החשבונות של Claude מלאים', 'body': '', 'from_identity': 'yoav', 'ref': 'accounts-all-full', 'urgency': 'urgent', 'blocking': true, 'state': 'open', 'created_at': 0},
    ]).waiting.single;
    expect(w.kind, WaitKind.failure);
    expect(w.kicker, 'החשבונות מלאים');
    expect(w.options.where((o) => o.id == 'go'), isEmpty);
  });

  testWidgets('"אחר כך" on the only card left brings it back to the middle', (tester) async {
    await stack(tester, [go()]);
    final before = tester.getTopLeft(card('לפרוס').first);
    await tester.drag(card('לפרוס').first, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(decisionQueue.current, 'g-dana');
    expect(tester.getTopLeft(card('לפרוס').first), before);
  });

  testWidgets('"אחר כך" on the only card left, with "הסר אנימציות": back in the middle too', (tester) async {
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await stack(tester, [go()]);
    final before = tester.getTopLeft(card('לפרוס').first);
    await tester.drag(card('לפרוס').first, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(decisionQueue.current, 'g-dana');
    expect(tester.getTopLeft(card('לפרוס').first), before);
  });

  testWidgets('the pinned row: how many, on top of the chats; a tap opens the stack; gone when nothing waits', (tester) async {
    final store = await pumpApp(tester);
    final n = store.data!.waitingCount;
    expect(n, greaterThan(0));
    expect(find.text(waitingLine(n)), findsOneWidget);
    await tester.tap(find.text(waitingLine(n)));
    await tester.pumpAndSettle();
    expect(find.byType(DecisionStack), findsOneWidget);
    expect(find.text('1 מתוך $n'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('סגירה'));
    await tester.pumpAndSettle();
    expect(find.byType(DecisionStack), findsNothing);
    store.data!.waiting.clear();
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text(waitingLine(n)), findsNothing);
    expect(find.byType(WaitingRow), findsOneWidget);
    expect(tester.getSize(find.byType(WaitingRow)).height, 0);
  });

  test('the row in words', () {
    expect([for (final n in [1, 2, 3, 12]) waitingLine(n)], ['אחת מחכה לך', 'שתיים מחכות לך', '3 מחכות לך', '12 מחכות לך']);
  });

  testWidgets('one card at a time, its title and who asks; "GO" sends it and brings the next', (tester) async {
    final store = await stack(tester, [go(), ask(blocking: false)]);
    expect(find.text('1 מתוך 2'), findsOneWidget);
    expect(card('לפרוס את עדכון הלומו'), findsOneWidget);
    expect(card('37 המנויים'), findsOneWidget, reason: 'the next card is under it');
    await tester.tap(find.text('GO'));
    await tester.pumpAndSettle();
    expect(store.decision('inbox:7', 'g-dana'), isNotNull);
    expect(find.text('2 מתוך 2'), findsOneWidget);
    expect(card('לפרוס את עדכון הלומו'), findsNothing);
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('swipe right is the "כן" of a yes-or-no, left its "לא", down is later', (tester) async {
    final store = await stack(tester, [ask(id: 'a-1', yesNo: true), ask(id: 'a-2', from: 'dana', yesNo: true), go()]);
    // Down: later, at the end; nothing is sent.
    await tester.drag(card('37 המנויים').first, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(decisionQueue.order.last, 'a-1');
    expect(store.decision('ask-a-1', 'a-1'), isNull);
    expect(decisionQueue.current, 'a-2');
    // Right: yes, wherever it is in the list.
    await tester.drag(card('37 המנויים').first, const Offset(300, 0));
    await tester.pumpAndSettle();
    expect(store.decision('ask-a-2', 'a-2')?.line, endsWith('כן'));
    expect(decisionQueue.current, 'g-dana');
    // A short drag goes back to the middle.
    await tester.drag(card('לפרוס').first, const Offset(-40, 0));
    await tester.pumpAndSettle();
    expect(decisionQueue.current, 'g-dana');
    // Left on a GO: no, as dismissed.
    await tester.drag(card('לפרוס').first, const Offset(-300, 0));
    await tester.pumpAndSettle();
    expect(decisionQueue.current, 'a-1');
    // Left on the question: no.
    await tester.drag(card('37 המנויים').first, const Offset(-300, 0));
    await tester.pumpAndSettle();
    expect(store.decision('ask-a-1', 'a-1')?.line, endsWith('לא'));
    expect(find.text('שום דבר לא מחכה לך.'), findsOneWidget);
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('after the last answer, once its "ביטול" is over, the pile closes by itself', (tester) async {
    final store = await pumpApp(tester, home: Builder(builder: (context) => Center(child: TextButton(onPressed: () => openDecisions(context), child: const Text('פתיחה')))));
    store.data!.waiting
      ..clear()
      ..add(go());
    resetQueue();
    await tester.tap(find.text('פתיחה'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(find.byType(DecisionStack), findsOneWidget, reason: 'its "ביטול" is still there');
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(find.byType(DecisionStack), findsNothing);
  });

  testWidgets('a page opened from the pile is not closed by it; the pile closes once it is back on top', (tester) async {
    final store = await pumpApp(tester, home: Builder(builder: (context) => Center(child: TextButton(onPressed: () => openDecisions(context), child: const Text('פתיחה')))));
    store.data!.waiting
      ..clear()
      ..add(go());
    resetQueue();
    await tester.tap(find.text('פתיחה'));
    await tester.pumpAndSettle();
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    nav.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('דף מעל'))));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(find.text('דף מעל'), findsOneWidget, reason: 'the page he reads stays');
    // The settle above is the guard (a try on every frame never settles); and after one more frame, none waits.
    await tester.pump();
    expect(tester.binding.hasScheduledFrame, isFalse, reason: 'no try on every frame');
    nav.pop();
    await tester.pumpAndSettle();
    expect(find.byType(DecisionStack), findsNothing);
  });

  testWidgets('two answers that are not a yes and a no: buttons only, a swipe sideways does nothing', (tester) async {
    final store = await stack(tester, [ask()]);
    for (final l in ['ניסיון נוסף אחרי 24 שעות', 'ביטול המנוי מיד']) {
      expect(find.text(l), findsOneWidget);
    }
    for (final dx in [-300.0, 300.0]) {
      await tester.drag(card('37 המנויים').first, Offset(dx, 0));
      await tester.pumpAndSettle();
      expect(store.decision('ask-a-1', 'a-1'), isNull);
      expect(decisionQueue.current, 'a-1');
    }
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pumpAndSettle();
    expect(store.decision('ask-a-1', 'a-1'), isNull);
  });

  test('a yes-or-no is told by its words, in either order', () {
    const y = AskOption(id: 'y', label: 'כן'), n = AskOption(id: 'n', label: 'לא.');
    expect(yesNo(const [y, n]), (y, n));
    expect(yesNo(const [n, y]), (y, n));
    // An answer that goes on after the comma is an act: buttons only.
    expect(yesNo(const [AskOption(id: 'a', label: 'כן, לפרוס'), n]), isNull);
    expect(yesNo(const [y, AskOption(id: 'b', label: 'לא, לבטל מיד')]), isNull);
    expect(yesNo(const [AskOption(id: 'a', label: 'ניסיון נוסף'), n]), isNull);
    expect(yesNo(const [y, n, AskOption(id: 'c', label: 'אחר')]), isNull);
  });

  test('the queue forgets what he decided when the pile closes', () {
    final q = DecisionQueue();
    q.order.addAll(['a', 'b', 'c']);
    q.done['a'] = DecisionDone('אישרת', 'check_circle');
    q.close();
    expect(q.order, ['b', 'c']);
    expect(q.done, isEmpty);
  });

  testWidgets('the keyboard: right, left, down, and Esc closes', (tester) async {
    final store = await stack(tester, [ask(yesNo: true), go()]);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pumpAndSettle();
    expect(decisionQueue.current, 'g-dana');
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pumpAndSettle();
    expect(store.decision('inbox:7', 'g-dana'), isNotNull);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pumpAndSettle();
    expect(store.decision('ask-a-1', 'a-1')?.line, endsWith('לא'));
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('a question of three answers: buttons only, and a swipe does nothing', (tester) async {
    final three = WaitItem(id: 't', askId: 'ask-t', kind: WaitKind.blockingAsk, from: 'dana', time: '04:00', kicker: 'חוסם', body: 'איזה צבע?',
        options: const [AskOption(id: 'a', label: 'כחול'), AskOption(id: 'b', label: 'ירוק'), AskOption(id: 'c', label: 'אדום')]);
    final store = await stack(tester, [three]);
    for (final l in ['כחול', 'ירוק', 'אדום', 'תשובה אחרת']) {
      expect(find.text(l), findsOneWidget);
    }
    await tester.drag(card('איזה צבע?').first, const Offset(300, 0));
    await tester.pumpAndSettle();
    expect(store.decision('ask-t', 't'), isNull);
    expect(decisionQueue.current, 't');
  });

  testWidgets('an escalated ask has the manager\'s note under the asker\'s card', (tester) async {
    final w = WaitItem(id: 'n', askId: 'ask-n', kind: WaitKind.blockingAsk, from: 'dana', time: '04:00', kicker: 'חוסם', body: 'באיזה צבע?',
        options: const [AskOption(id: 'a', label: 'כחול'), AskOption(id: 'b', label: 'ירוק')], managerNote: 'את זה אני לא יכול לענות במקומו', managerNoteBy: 'yoav');
    await stack(tester, [w]);
    expect(find.textContaining('את זה אני לא יכול לענות במקומו', findRichText: true), findsOneWidget);
    expect(card('באיזה צבע?'), findsOneWidget);
  });

  testWidgets('"כל הפרטים": the report, the PR and the conversation; what does not exist is not shown', (tester) async {
    await stack(tester, [go(links: const [WaitLink(WaitLinkKind.report, 'https://example.com/r'), WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo/pull/3698')])]);
    expect(findShown('סיכון נמוך'), findsOneWidget);
    await tester.tap(find.text('כל הפרטים'));
    await tester.pumpAndSettle();
    expect(find.text('הדוח המלא'), findsOneWidget);
    expect(find.text('ה-PR'), findsOneWidget);
    expect(find.textContaining('השיחה עם'), findsOneWidget);
  });

  testWidgets('a notification\'s item comes up first', (tester) async {
    await stack(tester, [go(), ask()]);
    decisionQueue.focus('a-1', now: true);
    await tester.pumpAndSettle();
    expect(decisionQueue.current, 'a-1');
  });

  // ── as pictures: for the design review and the GO ──

  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('phone: a GO, a question under it ($look)', (tester) async {
      await stack(tester, [go(links: const [WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo/pull/3698')]), ask(blocking: false)], dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_stack/phone-go-$look.png'));
    });
    testWidgets('phone: a question swiped halfway right ($look)', (tester) async {
      await stack(tester, [ask(yesNo: true), go()], dark: dark, scale: scale);
      final g = await tester.startGesture(tester.getCenter(card('37 המנויים').first));
      await g.moveBy(const Offset(40, 0));
      await g.moveBy(const Offset(60, 0));
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_stack/phone-swipe-$look.png'));
      await g.up();
      await tester.pumpAndSettle();
    });
    testWidgets('phone: nothing waits ($look)', (tester) async {
      await stack(tester, const [], dark: dark, scale: scale);
      expect(find.text('שום דבר לא מחכה לך.'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_stack/phone-empty-$look.png'));
    });
    testWidgets('phone: the pinned row over the chats ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale);
      store.touch();
      await tester.pumpAndSettle();
      expect(NavScope.read(tester.element(find.byType(Scaffold).first)).tab, AppTab.chats);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_stack/phone-row-$look.png'));
    });
  }

  testWidgets('desktop: G D opens the stack in the middle', (tester) async {
    await pumpApp(tester, size: const Size(1440, 860));
    await tester.pumpAndSettle();
    resetQueue();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyG);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyD);
    await tester.pumpAndSettle();
    expect(find.byType(DecisionStack), findsOneWidget);
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_stack/desktop-light.png'));
  });
}
