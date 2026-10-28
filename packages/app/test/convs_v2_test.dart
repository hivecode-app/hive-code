// The conversations list on the phone (lib/ui/convs/convs_v2.dart, task 205): one list by latest activity, his
// own lines first-class with the delivery ticks, the home as the list's first item, and the search field.
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart' show ownLine;
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/icons.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

ConversationSummary _c(String id, int minutesAgo, {Delivery? delivery, int unread = 0, String text = 'שורה'}) => ConversationSummary(
      identityId: id,
      lastLine: text,
      text: text,
      time: '',
      at: kDemoNow.subtract(Duration(minutes: minutesAgo)),
      delivery: delivery,
      unread: unread,
    );

/// The fake company's conversations, replaced by these (newest is not first on purpose).
void _set(CompanyData d, List<ConversationSummary> list) => d.conversations
  ..clear()
  ..addAll(list);

/// The text as read, without the bidi isolates (FSI, LRI, PDI) the rows put around a line.
Finder _shown(String text) => find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().replaceAll(RegExp('[\u2066-\u2069]'), '').contains(text));

Iterable<String> _icons(WidgetTester tester) => tester.widgetList<Ic>(find.byType(Ic)).map((i) => i.name);

void main() {
  testWidgets('Yoav first, then by the last message either way; a finished task worker only while it has something unread', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: SizedBox()));
    final d = store.data!;
    d.presence['shira'] = const Presence(status: WorkerStatus.done);
    d.presence['noa'] = const Presence(status: WorkerStatus.done);
    _set(d, [
      _c('rotem', 50),
      _c('dana', 5, delivery: Delivery.delivered), // he wrote last, 5 minutes ago
      _c('yoav', 300),
      _c('ido', 1), // a task worker still on its task, read: stays, so he can go back to it (task 890)
      _c('shira', 3), // a finished task worker, read: lives in its project
      _c('noa', 4, unread: 1), // a finished task worker with an unread line
      _c('itai', 30, unread: 1), // a task worker on its task with an unread line
      _c('eli', 20),
    ]);
    expect([for (final c in convsByActivity(d)) c.identityId], ['yoav', 'ido', 'noa', 'dana', 'eli', 'itai', 'rotem']);
    // The search finds the finished one too: one who wrote to him is never out of reach.
    expect([for (final c in convsByActivity(d, withDone: true)) c.identityId], ['yoav', 'ido', 'shira', 'noa', 'dana', 'eli', 'itai', 'rotem']);
  });

  testWidgets('his last line says "אתה: " after the ticks: queued, delivered, read', (tester) async {
    // Tall, so every row is built under the home.
    final store = await pumpApp(tester, size: const Size(342, 4000), home: const Scaffold(body: ConversationsV2()));
    _set(store.data!, [
      _c('noga', 3, delivery: Delivery.queued, text: 'מה עם ה-GO?'),
      _c('rotem', 4, delivery: Delivery.delivered, text: 'תבדוק את השרת'),
      _c('eli', 6, delivery: Delivery.read, text: 'תודה'),
      _c('amit', 8, text: 'סיימתי'),
    ]);
    store.touch();
    await tester.pump();
    expect(_shown('אתה: מה עם ה-GO?'), findsOneWidget);
    expect(_shown('אתה: תבדוק את השרת'), findsOneWidget);
    expect(_shown('אתה: תודה'), findsOneWidget);
    expect(_shown('אתה: סיימתי'), findsNothing);
    expect(_icons(tester), containsAll(['schedule', 'done', 'done_all']));
    // Today a time, yesterday "אתמול".
    expect(find.text('14:03'), findsOneWidget);
  });

  testWidgets('typing hides the home and shows the conversations and the messages that match', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsV2()));
    final d = store.data!;
    _set(d, [_c('dana', 3), _c('rotem', 4)]);
    d.recent = [
      (id: 'rotem', text: 'דנה ביקשה לבדוק את השרת של טיקי בוט', at: kDemoNow.subtract(const Duration(minutes: 4)), mine: false),
      (id: 'eli', text: 'שום דבר על זה', at: kDemoNow.subtract(const Duration(minutes: 9)), mine: true),
    ];
    store.touch();
    await tester.pump();
    expect(find.byType(HomeV2), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'דנה');
    await tester.pump();
    expect(find.byType(HomeV2), findsNothing);
    expect(find.text('שיחות'), findsWidgets);
    expect(find.text('הודעות'), findsOneWidget);
    expect(_shown('ביקשה לבדוק'), findsOneWidget);
    expect(_shown('שום דבר על זה'), findsNothing);
    await tester.enterText(find.byType(TextField), 'אין כזה');
    await tester.pump();
    expect(_shown('לא נמצאה שיחה או הודעה'), findsOneWidget);
  });

  testWidgets('once the home has gone up, its sentence stays under the title, and a tap brings it back', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsV2()));
    final d = store.data!;
    _set(d, [for (final (i, id) in [for (final w in d.identities.values) if (!w.temp) w.id].indexed) _c(id, i * 7)]);
    // A stuck worker keeps the home open (its card); with only decisions waiting it is already one row.
    d.presence['rotem'] = const Presence(status: WorkerStatus.stuck);
    store.touch();
    await tester.pump();
    expect(find.byType(HomeBarV2), findsNothing);
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -2500));
    await tester.pumpAndSettle();
    expect(find.byType(HomeBarV2), findsOneWidget);
    // With decisions waiting the sentence leads to them; the chevron brings the home back.
    await tester.tap(find.descendant(of: find.byType(HomeBarV2), matching: find.byIcon(kIcons['expand_more']!)));
    await tester.pumpAndSettle();
    expect(find.byType(HomeBarV2), findsNothing);
  });

  testWidgets('the home is one row with the count of decisions; its sentence leads to them, its chevron opens the rest', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 3000), home: const Scaffold(body: ConversationsV2()));
    expect(store.data!.waitingCount, greaterThan(0), reason: 'the fake company has something waiting');
    expect(find.text('הפרויקטים'), findsNothing);
    expect(find.textContaining('החלטות מחכות לך'), findsOneWidget);
    expect(find.text('מחכה לך'), findsNothing);
    await tester.tap(find.byIcon(kIcons['expand_more']!).first);
    await tester.pumpAndSettle();
    expect(find.text('הפרויקטים'), findsOneWidget);
  });

  testWidgets('the fold follows the finger, and stopped halfway it finishes to the nearer end', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsV2()));
    final d = store.data!;
    _set(d, [for (final (i, id) in [for (final w in d.identities.values) if (!w.temp) w.id].indexed) _c(id, i * 7)]);
    store.touch();
    await tester.pump();
    double? fold() {
      final a = find.ancestor(of: find.byType(HomeBarV2), matching: find.byWidgetPredicate((w) => w is Align && w.heightFactor != null));
      return a.evaluate().isEmpty ? null : tester.widget<Align>(a.first).heightFactor;
    }

    final g = await tester.startGesture(tester.getCenter(find.byType(CustomScrollView)));
    // Into the fold, a little at a time, until the row is part way down; then held still.
    for (var i = 0; i < 120 && (fold() ?? 0) < 0.3; i++) {
      await g.moveBy(const Offset(0, -8));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await tester.pump(const Duration(milliseconds: 300));
    final mid = fold();
    expect(mid, isNotNull);
    expect(mid!, inExclusiveRange(0.0, 1.0), reason: 'the row is part way down, with the finger');
    await g.up();
    await tester.pumpAndSettle();
    expect(fold(), anyOf(isNull, 1.0), reason: 'never left half folded');
  });

  testWidgets('the state is at the end of the second line: the hand when he decides, עובד with play', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 3000), home: const Scaffold(body: ConversationsV2()));
    final d = store.data!;
    _set(d, [_c('rotem', 2), _c('eli', 4), _c('amit', 6)]);
    d.presence['rotem'] = const Presence(status: WorkerStatus.waiting);
    d.presence['eli'] = const Presence(status: WorkerStatus.working);
    d.presence['amit'] = const Presence(status: WorkerStatus.resting);
    store.touch();
    await tester.pump();
    Finder inRow(String name, Finder f) => find.descendant(of: find.ancestor(of: find.text(name), matching: find.byType(ConversationRowV2)), matching: f);
    expect(inRow('רותם', find.text('מחכה לך')), findsNothing, reason: 'the hand alone: what he decides is in the "החלטות" tab');
    expect(inRow('רותם', find.byIcon(kIcons['front_hand']!)), findsOneWidget);
    expect(inRow('אלי', find.byIcon(kIcons['play_arrow']!)), findsOneWidget);
    expect(inRow('עמית', find.byIcon(kIcons['bedtime']!)), findsNothing, reason: '"נח" says nothing in the row');
    expect(inRow('עמית', find.text('נח')), findsNothing);
  });

  testWidgets('at text scale 1.3 the name and the time stay whole, and a long line is cut between words', (tester) async {
    const long = 'הכיול של הערכות הזמן מוכן ובדקתי מאתיים עשרים ושבע התחייבויות מהשיחות שלך עם כל הצוותים';
    final store = await pumpApp(tester, textScale: 1.3, home: const Scaffold(body: ConversationsV2()));
    _set(store.data!, [_c('noga', 2, text: long, unread: 3)]);
    store.touch();
    await tester.pump();
    await tester.scrollUntilVisible(find.text('נגה'), 300, scrollable: find.byType(Scrollable).first);
    expect(tester.takeException(), isNull);
    expect(find.text('14:04'), findsOneWidget);
    final shown = tester.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText().replaceAll(RegExp('[\u2066-\u2069]'), '')).firstWhere((s) => s.startsWith('הכיול'));
    expect(shown.endsWith('…'), isTrue, reason: shown);
    final kept = shown.substring(0, shown.length - 1);
    expect(long.startsWith(kept) && long[kept.length] == ' ', isTrue, reason: 'cut on a word boundary: "$kept"');
  });

  test('search matches only the start of a word', () {
    expect(wordStart('דנה ביקשה לבדוק', 'ביק'), 4);
    expect(wordStart('עדנה כתבה', 'דנה'), -1, reason: 'inside a word');
    expect(wordStart('עדנה ו(דנה)', 'דנה'), 7, reason: 'after a bracket is a word start');
    expect(wordStart('Rancher בקלאסטר', 'ranch'), 0);
    expect(wordStart('anything', ''), -1);
  });

  testWidgets('typing part of a word inside a name finds nothing; its start finds the conversation', (tester) async {
    final store = await pumpApp(tester, home: const Scaffold(body: ConversationsV2()));
    _set(store.data!, [_c('dana', 3), _c('rotem', 4)]);
    store.data!.recent = [];
    store.touch();
    await tester.pump();
    await tester.enterText(find.byType(TextField), 'נה');
    await tester.pump();
    expect(_shown('לא נמצאה שיחה או הודעה'), findsOneWidget, reason: '"נה" is inside "דנה"');
    await tester.enterText(find.byType(TextField), 'דנ');
    await tester.pump();
    expect(find.byType(ConversationRowV2), findsOneWidget);
  });

  test('a card he closed with a tap is what he did, not words of his, whatever button word hq adds; a typed answer is his words', () {
    final o = companyNames.owner;
    final done = ownLine({'body': '$o סיים: GO: מה נכנס:', 'from_identity': 'owner'});
    expect(done.tapped, isTrue);
    expect(done.text, 'סיימת: GO: מה נכנס:');
    final dismissed = ownLine({'body': '$o דחה: פריסה של 2.6.10', 'from_identity': 'owner'});
    expect((dismissed.text, dismissed.tapped), ('דחית: פריסה של 2.6.10', true));
    // As hq writes it on a GO tap (live hq.db, inbox-141-done): the title over several lines, then the button's word.
    final go = ownLine({'body': '$o סיים: GO: מה נכנס:\n1. **שתיקה ארוכה:** הבוט מחכה\nGO', 'from_identity': 'owner'});
    expect((go.text, go.tapped), ('סיימת: GO: מה נכנס:', true));
    final retry = ownLine({'body': '$o סיים: הכניסה לאתר\nretry', 'from_identity': 'owner'});
    expect((retry.text, retry.tapped), ('סיימת: הכניסה לאתר', true));
    // An answer he typed is his words, without hq's wrapping.
    final typed = ownLine({'body': 'תשובה לשאלה ask-12: רק אחרי הקנרי', 'from_identity': 'owner'});
    expect((typed.text, typed.tapped), ('רק אחרי הקנרי', false));
    final plain = ownLine({'body': 'מה עם ה-GO?', 'from_identity': 'owner'});
    expect((plain.text, plain.tapped), ('מה עם ה-GO?', false));
  });

  testWidgets('a row whose last line is a card he closed: no "אתה: " and no ticks', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 3000), home: const Scaffold(body: ConversationsV2()));
    _set(store.data!, [_c('amit', 3, text: 'סיימת: GO: מה נכנס:')]);
    store.touch();
    await tester.pump();
    expect(_shown('סיימת: GO: מה נכנס'), findsOneWidget);
    expect(_shown('אתה: '), findsNothing);
    expect(_icons(tester), isNot(contains('done_all')));
  });

  test('fitWords: whole words with "…", a mark a cut left open is closed, a too-long first word is cut inside', () {
    bool fitsIn(int n, String s) => s.length <= n;
    expect(fitWords('ממילא הוא לא עובד כבר', (s) => fitsIn(18, s)), 'ממילא הוא לא עובד…');
    expect(fitWords('קצר', (s) => fitsIn(18, s)), 'קצר');
    expect(fitWords('https://example.com/a/very/long/path', (s) => fitsIn(10, s)), 'https://e…');
    expect(fitWords('ראו `npm run check` כאן', (s) => fitsIn(14, s), close: (t) => '`'.allMatches(t).length.isOdd ? '$t`' : t), 'ראו `npm run`…');
  });

  testWidgets('a clamped line is cut between words, never inside one ("כב…")', (tester) async {
    const text = 'לכבות את Rancher בקלאסטר כדי לעצור את העומס שמפיל אותו. ממילא הוא לא עובד כבר שבוע';
    await pumpApp(tester, home: const Scaffold(body: Center(child: SizedBox(width: 260, child: Rich(text, maxLines: 2)))));
    final shown = tester.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText().replaceAll(RegExp('[\u2066-\u2069]'), '')).firstWhere((s) => s.startsWith('לכבות'));
    expect(shown.endsWith('…'), isTrue, reason: shown);
    final kept = shown.substring(0, shown.length - 1);
    expect(text.startsWith(kept) && text[kept.length] == ' ', isTrue, reason: 'cut on a word boundary: "$kept"');
  });

  test('the folded home shows the first sentence only, whole', () {
    expect(firstSentence('שום דבר לא מחכה לך. 5 משימות רצות ב-4 פרויקטים.'), 'שום דבר לא מחכה לך.');
    expect(firstSentence('GO לגרסה 2.6.10 מחכה לך'), 'GO לגרסה 2.6.10 מחכה לך');
    expect(firstSentence('מה עם הקנרי? הוא רץ מהבוקר.'), 'מה עם הקנרי?');
  });

  // noa 22/10: "דנה · GO לפרודקשן" in the waiting card read "דנה לפרודקשן GO ·", the isolate turned LTR by its first letter.
  testWidgets('WordFit: a Hebrew label that starts with a Latin word keeps the Hebrew order', (t) async {
    Future<String> shown(String text) async {
      await t.pumpWidget(MaterialApp(home: Material(child: Directionality(textDirection: TextDirection.rtl, child: Center(child: SizedBox(width: 600, child: WordFit(lead: 'דנה ', text: text, style: const TextStyle())))))));
      return t.widget<Text>(find.byType(Text)).textSpan!.toPlainText();
    }

    expect(await shown('· GO לפרודקשן'), 'דנה $kRLI· GO לפרודקשן$kPDI');
    expect(await shown('· git push failed'), 'דנה $kLRI· git push failed$kPDI');
  });
}
