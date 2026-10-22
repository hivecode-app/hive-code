// The decisions tab (task 306, direction C): its order, what a decision does to it, and how a GO's text reads.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/convs/convs_v2.dart';
import 'package:agent_company/ui/convs/home_v2.dart' show decisionsLead;
import 'package:agent_company/ui/decision.dart';
import 'package:agent_company/data/hq_backend.dart' show mapSnapshot;
import 'package:agent_company/ui/convs/home_v2.dart' show HomeV2, fullSentence, topSentence;
import 'package:agent_company/main.dart';
import 'package:agent_company/ui/shell.dart' show BottomNav;
import 'package:flutter/services.dart';
import 'package:agent_company/ui/decisions/decisions_screen.dart';
import 'package:agent_company/ui/decisions/decisions_strip.dart';
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

  testWidgets('the screen: one decision, "אישור" brings the next with "ביטול" below, the last leaves "אין החלטות"', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: DecisionsScreen()));
    final d = store.data!;
    d.waiting.removeWhere((w) => w.kind != WaitKind.go);
    final total = d.waiting.length;
    expect(total, greaterThan(0));
    decisionQueue
      ..order.clear()
      ..done.clear()
      ..current = null;
    store.touch();
    await tester.pumpAndSettle();
    expect(find.text('1 מתוך $total'), findsOneWidget);
    for (var i = 0; i < total; i++) {
      await tester.tap(find.text('אישור'));
      await tester.pumpAndSettle();
      if (i < total - 1) expect(find.text('${i + 2} מתוך $total'), findsOneWidget);
      expect(find.text('ביטול'), findsOneWidget);
    }
    expect(find.text('אין החלטות. הכול רץ.'), findsOneWidget);
    // "ביטול" brings the last one back, and nothing is sent.
    await tester.tap(find.text('ביטול'));
    await tester.pumpAndSettle();
    expect(find.text('$total מתוך $total'), findsOneWidget);
    expect(store.decision(d.waiting.last.askId, d.waiting.last.id), isNull);
    await tester.pump(const Duration(seconds: 6));
  });

  // ── the tab: one decision, its links and its answers by kind ──

  void resetQueue() => decisionQueue
    ..order.clear()
    ..done.clear()
    ..lastId = null
    ..current = null;

  /// The tab with only [items] waiting.
  Future<AppStore> tab(WidgetTester tester, List<WaitItem> items, {bool dark = false, double scale = 1, Size size = kPhone}) async {
    final store = await pumpApp(tester, dark: dark, textScale: scale, size: size, home: const SizedBox());
    store.data!.waiting
      ..clear()
      ..addAll(items);
    resetQueue();
    await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: const Scaffold(body: DecisionsScreen())));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    return store;
  }

  WaitItem go({List<WaitLink> links = const [], String from = 'dana'}) => WaitItem(
        id: 'g-$from',
        kind: WaitKind.go,
        from: from,
        time: '13:41',
        kicker: 'GO לפרודקשן · לומו 1.1.20',
        headline: 'להחליט אם לפרוס את עדכון הלומו: הטקסט בטלפון מתוקן',
        body: 'תיקון הטקסט בטלפון.\nחזרה אחורה: כדקה.\nPR: 3698\nסיכון: low',
        options: const [AskOption(id: 'go', label: 'GO', primary: true)],
        askId: 'inbox:7',
        inboxId: 7,
        links: links,
        createdAt: DateTime(2026, 10, 20, 13, 41),
      );

  WaitItem check() => WaitItem(
        id: 'c-1',
        kind: WaitKind.awaiting,
        from: 'dana',
        time: '13:50',
        kicker: 'לבדוק',
        headline: 'לבדוק בטלפון שתמונה נשלחת ועולה בצ\'אט',
        body: 'לבדוק בטלפון שתמונה נשלחת ועולה בצ\'אט',
        options: kAwaitingOptions,
        inboxId: 8,
        createdAt: DateTime(2026, 10, 20, 13, 50),
      );

  WaitItem ask({bool recommended = false}) => WaitItem(
        id: 'a-1',
        kind: WaitKind.blockingAsk,
        from: 'ido',
        time: '14:02',
        kicker: 'חוסם',
        headline: 'להחליט מה עושים עם 37 המנויים שהכרטיס שלהם נדחה',
        body: 'רותם מצאה 37 מנויים עם כרטיס שנדחה פעמיים השבוע.',
        options: [
          AskOption(id: 'retry24', label: 'ניסיון נוסף אחרי 24 שעות', primary: recommended),
          const AskOption(id: 'cancel', label: 'ביטול המנוי מיד'),
        ],
        askId: 'ask-ido',
        inboxId: 9,
        createdAt: DateTime(2026, 10, 20, 14, 2),
      );

  testWidgets('the links under a decision: the report, the PR and the conversation; what does not exist is not shown', (tester) async {
    await tab(tester, [go(links: const [WaitLink(WaitLinkKind.report, 'https://example.com/r'), WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo/pull/3698')])]);
    expect(find.text('הדוח המלא'), findsOneWidget);
    expect(find.text('ה-PR'), findsOneWidget);
    expect(find.textContaining('השיחה עם'), findsOneWidget);
    // The trailer lines became the risk in words, not text under the headline.
    expect(findShown('סיכון נמוך'), findsOneWidget);
    expect(findShown('PR: 3698'), findsNothing);

    await tab(tester, [go()]);
    expect(find.text('הדוח המלא'), findsNothing);
    expect(find.text('ה-PR'), findsNothing);
    expect(find.textContaining('השיחה עם'), findsOneWidget, reason: 'the conversation is always there');
  });

  testWidgets('answers by kind: a decision "אישור" and "לא עכשיו", a check "עובד" and "לא עובד", a question its options', (tester) async {
    await tab(tester, [go()]);
    expect([find.text('אישור'), find.text('לא עכשיו')].map((f) => f.evaluate().length), [1, 1]);

    await tab(tester, [check()]);
    expect([find.text('עובד'), find.text('לא עובד')].map((f) => f.evaluate().length), [1, 1]);
    expect(find.text('אישור'), findsNothing);
    expect(findShown('לבדוק בטלפון שתמונה נשלחת'), findsWidgets, reason: 'the headline says what is asked');

    await tab(tester, [ask()]);
    expect(find.text('ניסיון נוסף אחרי 24 שעות'), findsOneWidget);
    expect(find.text('ביטול המנוי מיד'), findsOneWidget);
    expect(find.text('תשובה אחרת'), findsOneWidget);
    List<DecisionButton> buttons() => tester.widgetList<DecisionButton>(find.byType(DecisionButton)).toList();
    expect(buttons().where((b) => b.primary), isEmpty, reason: 'no recommendation: all of one weight');
    await tab(tester, [ask(recommended: true)]);
    expect(buttons().where((b) => b.primary).map((b) => b.label), ['ניסיון נוסף אחרי 24 שעות']);
  });

  testWidgets('"עובד" decides a check; "לא עובד" sends it as failed, each with "ביטול" for 5 seconds', (tester) async {
    final store = await tab(tester, [check()]);
    await tester.tap(find.text('לא עובד'));
    await tester.pump();
    expect(findShown('לא עובד · 14:06'), findsOneWidget);
    expect(find.text('ביטול'), findsOneWidget);
    expect(store.decision(null, 'c-1'), isNotNull);
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('"אחר כך" sends the decision to the end and the next comes in; the count does not move', (tester) async {
    await tab(tester, [go(from: 'dana'), ask()]);
    expect(find.text('1 מתוך 2'), findsOneWidget);
    final first = decisionQueue.current;
    await tester.tap(find.text('אחר כך'));
    await tester.pumpAndSettle();
    expect(decisionQueue.current, isNot(first));
    expect(decisionQueue.order.last, first);
    expect(find.text('1 מתוך 2'), findsOneWidget);
  });

  testWidgets('what he put off with "לא עכשיו" waits on the empty screen, with a way back', (tester) async {
    final g = go();
    g.state = WaitState.notNow;
    final store = await tab(tester, [g]);
    expect(find.text('אין החלטות. הכול רץ.'), findsOneWidget);
    expect(find.text('נדחו'), findsOneWidget);
    expect(find.text('החזרה לתור'), findsOneWidget);
    expect(store.data!.waitingCount, 0, reason: 'not counted while put off');
  });

  testWidgets('with decisions open, the put-off ones are a tap away at the foot, and "החזרה לתור" brings one back', (tester) async {
    final g = go(from: 'dana');
    g.state = WaitState.notNow;
    await tab(tester, [g, ask()]);
    expect(find.text('נדחו · 1'), findsOneWidget);
    await tester.tap(find.text('נדחו · 1'));
    await tester.pumpAndSettle();
    expect(find.text('החזרה לתור'), findsOneWidget);
    await tester.tap(find.text('החזרה לתור'));
    await tester.pumpAndSettle();
    expect(find.text('נדחו · 1'), findsNothing);
  });

  for (final (look, dark) in [('light', false), ('dark', true)]) {
    testWidgets('phone: nothing open, the put-off ones below ($look)', (tester) async {
      final a = go(from: 'dana'), b = ask();
      a.state = WaitState.notNow;
      b.state = WaitState.notNow;
      await tab(tester, [a, b], dark: dark);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-putoff-empty-$look.png'));
    });
  }
  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('phone: a decision with "נדחו · 2" at its foot, and the sheet ($look)', (tester) async {
      final a = go(from: 'dana'), b = ask();
      a.state = WaitState.notNow;
      b.state = WaitState.notNow;
      await tab(tester, [a, b, check()], dark: dark, scale: scale);
      expect(find.text('נדחו · 2'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-putoff-foot-$look.png'));
      await tester.tap(find.text('נדחו · 2'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-putoff-sheet-$look.png'));
    });
  }

  test('an inbox row from before `links` (an older hq) has none, and a bad link is dropped', () {
    final d = mapSnapshot(board: const [], asks: const [], toggles: const [], inbox: [
      {'id': 1, 'kind': 'go', 'title': 'GO: ישן', 'body': 'x', 'from_identity': 'adi', 'urgency': 'normal', 'blocking': true, 'state': 'open', 'created_at': 1},
      {'id': 2, 'kind': 'go', 'title': 'GO: חדש', 'body': 'x', 'from_identity': 'adi', 'urgency': 'normal', 'blocking': true, 'state': 'open', 'created_at': 2, 'links': [
        {'kind': 'report', 'url': 'https://example.com/r'}, {'kind': 'pr', 'url': 'javascript:alert(1)'}, {'kind': 'other', 'url': 'https://x.com'}, {'kind': 'pr'},
      ]},
    ]);
    final byId = {for (final w in d.waiting) w.inboxId: w};
    expect(byId[1]!.links, isEmpty);
    expect([for (final l in byId[2]!.links) (l.kind, l.url)], [(WaitLinkKind.report, 'https://example.com/r')]);
  });

  testWidgets('a decision from an older hq, with no links, shows only the conversation', (tester) async {
    final d = mapSnapshot(board: const [], asks: const [], toggles: const [], inbox: [
      {'id': 1, 'kind': 'go', 'title': 'GO: ישן', 'body': 'x', 'from_identity': 'dana', 'urgency': 'normal', 'blocking': true, 'state': 'open', 'created_at': 1},
    ]);
    final w = d.waiting.single;
    await tab(tester, [w]);
    expect(find.text('הדוח המלא'), findsNothing);
    expect(find.text('ה-PR'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the home with nothing waiting: no count of decisions, no empty line, no strip, and a quiet sentence', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1200), home: const SizedBox());
    final d = store.data!;
    d.waiting.clear();
    for (final id in d.presence.keys.toList()) {
      if (d.presence[id]!.status == WorkerStatus.stuck) d.presence[id] = const Presence(status: WorkerStatus.working);
    }
    await tester.pumpWidget(CompanyApp(store: store, home: Builder(builder: (c) => Scaffold(body: ListView(children: [HomeV2(recipe: null, data: d, now: kDemoNow)])))));
    await tester.pumpAndSettle();
    expect(find.textContaining('החלטות'), findsNothing);
    expect(find.textContaining('החלטה'), findsNothing);
    expect(find.textContaining('0 '), findsNothing);
    expect(findShown('שום דבר לא מחכה לך'), findsOneWidget);
    expect(decisionsLead(0), isNull);
    expect(fullSentence(d, null, stuck: 0, now: kDemoNow), isNot(contains('החלט')));
    // And the whole app on the status tab: no line above the bar.
    await tester.pumpWidget(CompanyApp(store: store));
    NavScope.read(tester.element(find.byType(Scaffold).first)).go(AppTab.status);
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byType(DecisionsStrip)).height, 0);
    expect(find.descendant(of: find.byType(BottomNav), matching: find.text('0')), findsNothing, reason: 'no "0" badge on the tab');
  });

  testWidgets('the home with decisions but nothing else to say has no empty line under the lead', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1200), home: const SizedBox());
    final d = store.data!;
    d.openTasks = [];
    for (final id in d.presence.keys.toList()) {
      if (d.presence[id]!.status == WorkerStatus.stuck) d.presence[id] = const Presence(status: WorkerStatus.working);
    }
    expect(topSentence(d, null, stuck: 0, now: kDemoNow), '');
    await tester.pumpWidget(CompanyApp(store: store, home: Builder(builder: (c) => Scaffold(body: ListView(children: [HomeV2(recipe: null, data: d, now: kDemoNow)])))));
    await tester.pumpAndSettle();
    expect(find.text(decisionsLead(d.waitingCount)!), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // ── the line above the navigation ──

  testWidgets('the line says how many wait on the other tabs, leads to the tab, and is not on it or on the chats tab', (tester) async {
    final store = await pumpApp(tester);
    final n = store.data!.waitingCount;
    expect(n, greaterThan(0));
    final nav = NavScope.read(tester.element(find.byType(Scaffold).first));
    expect(find.text(decisionsLeadText(n)), findsNothing, reason: 'the chats tab: the home\'s sentence leads there');
    nav.go(AppTab.status);
    await tester.pumpAndSettle();
    expect(find.byType(DecisionsStrip), findsOneWidget);
    expect(find.text(decisionsLeadText(n)), findsOneWidget);
    // A row of the column, above the bar: it shortens the content and never covers it.
    expect(tester.getRect(find.byType(DecisionsStrip)).bottom, tester.getRect(find.byType(BottomNav)).top);
    await tester.tap(find.text(decisionsLeadText(n)));
    await tester.pumpAndSettle();
    expect(nav.tab, AppTab.decisions);
    expect(find.text(decisionsLeadText(n)), findsNothing, reason: 'on the tab itself the line is hidden');
  });

  testWidgets('no line when nothing waits', (tester) async {
    final store = await pumpApp(tester);
    store.data!.waiting.clear();
    store.touch();
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byType(DecisionsStrip)).height, 0);
  });

  testWidgets('the home leads with the count, and the tab counts on the navigation bar', (tester) async {
    final store = await pumpApp(tester);
    final n = store.data!.waitingCount;
    expect(find.descendant(of: find.byType(BottomNav), matching: find.text('$n')), findsOneWidget);
    // Nobody stuck: the home is one row, led by the count.
    store.data!.presence['itai'] = const Presence(status: WorkerStatus.working);
    store.touch();
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byType(HomeBarV2), matching: find.textContaining('החלטות מחכות לך')), findsOneWidget);
  });

  // ── the tab, as pictures ──

  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('phone: a GO with its links ($look)', (tester) async {
      await tab(tester, [go(links: const [WaitLink(WaitLinkKind.report, 'https://example.com/r'), WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo/pull/3698')]), check()], dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-go-$look.png'));
    });
    testWidgets('phone: a question, all of one weight ($look)', (tester) async {
      await tab(tester, [ask(), go()], dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-ask-$look.png'));
    });
    testWidgets('phone: a check ($look)', (tester) async {
      await tab(tester, [check()], dark: dark, scale: scale);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-check-$look.png'));
    });
    testWidgets('phone: nothing waits ($look)', (tester) async {
      await tab(tester, const [], dark: dark, scale: scale);
      expect(find.text('אין החלטות. הכול רץ.'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-empty-$look.png'));
    });
    testWidgets('phone: the line above the bar on the status tab ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale);
      NavScope.read(tester.element(find.byType(Scaffold).first)).go(AppTab.status);
      store.touch();
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/phone-line-$look.png'));
    });
    testWidgets('desktop: the list at the side and the decision in the middle ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale, size: const Size(1440, 860));
      store.data!.waiting
        ..clear()
        ..addAll([go(links: const [WaitLink(WaitLinkKind.report, 'https://example.com/r'), WaitLink(WaitLinkKind.pr, 'https://github.com/hive-owner/lumo/pull/3698')]), ask(), check()]);
      resetQueue();
      NavScope.read(tester.element(find.byType(Scaffold).first)).go(AppTab.decisions);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/decisions_tab/desktop-$look.png'));
    });
  }

  testWidgets('desktop: 1 to 4 answer, J and K move, and the line is hidden on the tab', (tester) async {
    final store = await pumpApp(tester, size: const Size(1440, 860));
    store.data!.waiting
      ..clear()
      ..addAll([go(), ask(), check()]);
    resetQueue();
    NavScope.read(tester.element(find.byType(Scaffold).first)).go(AppTab.decisions);
    await tester.pumpAndSettle();
    expect(find.byType(DecisionsStrip), findsOneWidget);
    expect(tester.getSize(find.byType(DecisionsStrip)).height, 0);
    final first = decisionQueue.current;
    await tester.sendKeyEvent(LogicalKeyboardKey.keyJ);
    await tester.pumpAndSettle();
    expect(decisionQueue.current, isNot(first));
    await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
    await tester.pumpAndSettle();
    expect(decisionQueue.current, first);
    await tester.sendKeyEvent(LogicalKeyboardKey.digit1);
    await tester.pump();
    expect(decisionQueue.done, isNotEmpty);
    await tester.pump(const Duration(seconds: 6));
  });
}

String decisionsLeadText(int n) => decisionsLead(n)!.replaceFirst(RegExp(r'\.$'), '');
