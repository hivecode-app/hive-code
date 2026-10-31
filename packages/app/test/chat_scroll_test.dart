// Task 1014 (31/10): "20 החלטות פתוחות" in Shachar's chat while hq had none of his open, a tap on the banner
// that ran back and forth instead of landing on the card, and a chat that moved whenever text came in.
// The banner counts what hq has open; a jump lands in one move, however far up; new text never moves what
// he reads, and at the end the view follows it in the same frame.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

DateTime _at(int h, int m) => DateTime(2026, 10, 20, h, m);

WaitItem _wait(String askId, {WaitKind kind = WaitKind.softAsk}) =>
    WaitItem(id: 'w-$askId', kind: kind, from: 'dana', time: '12:00', kicker: 'שאלה', body: 'q', askId: askId, inboxId: askId.hashCode, createdAt: _at(12, 0));

/// Dana's chat: what [before] gives, then [after] lines of talk.
Conversation _chat(AppStore store, {List<ChatItem> before = const [], int after = 0}) {
  final d = store.data!;
  d.waiting.removeWhere((w) => w.from == 'dana');
  return d.chats['dana'] = Conversation(identityId: 'dana', items: [
    ...before,
    for (var i = 0; i < after; i++) TextMsg(id: 'pad$i', ts: _at(13, 0).add(Duration(seconds: i)), text: 'שורה $i \nעוד שורה של טקסט כדי שתהיה גבוהה'),
  ]);
}

Future<void> pumpScreen(WidgetTester tester, AppStore store, Widget home) async {
  await tester.pumpWidget(CompanyApp(store: store, themeMode: ThemeMode.light, home: home));
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

ScrollPosition _position(WidgetTester tester) => tester.state<ScrollableState>(find.byType(Scrollable).first).position;

/// The conversation's list (the composer's field scrolls too, below it).
final _listFinder = find.byType(Scrollable).first;

Rect _list(WidgetTester tester) => tester.getRect(_listFinder);

void main() {
  testWidgets('the banner counts what hq has open, not cards the history left open', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    // Twenty cards in the history that were answered, replaced or handed back: hq has none of them open.
    _chat(store, before: [
      for (var i = 0; i < 14; i++) AskCard(id: 'a$i', ts: _at(9, i), askId: 'ask-$i', from: 'dana', question: 'שאלה $i', options: const [AskOption(id: 'y', label: 'כן')]),
      for (var i = 0; i < 6; i++) GoCard(id: 'g$i', ts: _at(10, i), askId: 'inbox:${100 + i}', from: 'dana', details: 'GO $i'),
      // A task to check is not a decision.
      CheckCard(id: 'check:7', ts: _at(11, 0), askId: 'check:7', from: 'dana', details: 'לבדוק'),
    ]);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.textContaining('החלטות פתוחות'), findsNothing);
    expect(find.text('לראשונה'), findsNothing);
    expect(find.text('לשאלה'), findsNothing);
    expect(find.text('לבקשה'), findsNothing);

    // Two of them open in hq: two.
    store.data!.waiting.addAll([_wait('ask-3'), _wait('inbox:105', kind: WaitKind.go)]);
    store.touch();
    await tester.pump();
    expect(find.text('2 החלטות פתוחות'), findsOneWidget);

    // hq closes one: the count follows, though the card in the history still reads open.
    store.data!.waiting.removeWhere((w) => w.askId == 'ask-3');
    store.touch();
    await tester.pump();
    expect(find.textContaining('החלטות פתוחות'), findsNothing);
    expect(find.text('לבקשה'), findsOneWidget);
  });

  testWidgets('the banner lands on a card far up in one move, a fifth of the screen from the top', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _chat(store, before: [
      AskCard(id: 'far', ts: _at(9, 0), askId: 'ask-far', from: 'dana', headline: 'הכרטיס הרחוק', question: 'לשלוח?', options: const [AskOption(id: 'y', label: 'כן')]),
    ], after: 300);
    store.data!.waiting.add(_wait('ask-far'));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    expect(find.text('הכרטיס הרחוק'), findsNothing, reason: 'far up, not built yet');

    final pos = _position(tester);
    final seen = <double>[];
    pos.addListener(() => seen.add(pos.pixels));
    await tester.tap(find.text('לשאלה'));
    await tester.pump();
    // The first frame after the tap: there, not on the way.
    final card = findShown('הכרטיס הרחוק');
    expect(card, findsOneWidget);
    final list = _list(tester);
    final top = tester.getTopLeft(card).dy;
    expect(top, inInclusiveRange(list.top, list.top + list.height * 0.35), reason: 'near the top of the list');
    // And it stays: no frames that run on, nothing that bounces back.
    for (var i = 0; i < 40; i++) {
      await tester.pump(const Duration(milliseconds: 50));
      expect(tester.getTopLeft(card).dy, top);
    }
    expect(seen.toSet().length, lessThanOrEqualTo(1), reason: 'one jump, no steps: $seen');
  });

  testWidgets('a card the history brings later is still reached in one move', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    final chat = _chat(store, after: 40);
    ChatScreen.pendingTarget['dana'] = 'ask-late';
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    // The history lands: the card, and a long talk after it.
    chat.items.insert(0, AskCard(id: 'late', ts: _at(8, 0), askId: 'ask-late', from: 'dana', headline: 'הכרטיס שהגיע', question: 'לשלוח?', options: const [AskOption(id: 'y', label: 'כן')]));
    chat.items.insertAll(1, [for (var i = 0; i < 200; i++) TextMsg(id: 'old$i', ts: _at(8, 1).add(Duration(seconds: i)), text: 'ישן $i')]);
    store.touch();
    await tester.pump();
    final card = findShown('הכרטיס שהגיע');
    expect(card, findsOneWidget);
    final top = tester.getTopLeft(card).dy;
    await tester.pump(const Duration(seconds: 2));
    expect(tester.getTopLeft(card).dy, top);
  });

  testWidgets('scrolled up, new messages and a streaming reply move nothing he reads', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    final chat = _chat(store, after: 60);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await tester.drag(_listFinder, const Offset(0, 500));
    await tester.pumpAndSettle();
    final line = findShown('שורה 50');
    expect(line, findsOneWidget);
    final y = tester.getTopLeft(line).dy;

    final reply = TextMsg(id: 'live', ts: _at(14, 0), text: 'מתחילה', streaming: true);
    chat.items.add(reply);
    store.touch();
    await tester.pump();
    expect(tester.getTopLeft(line).dy, y);
    for (var i = 0; i < 12; i++) {
      reply.text += '\nעוד שורה $i';
      store.touch();
      await tester.pump();
      expect(tester.getTopLeft(line).dy, y, reason: 'the reply grows below');
    }
    reply.streaming = false;
    for (var i = 0; i < 5; i++) {
      chat.items.add(TextMsg(id: 'new$i', ts: _at(14, 1 + i), text: 'הודעה חדשה $i'));
      store.touch();
      await tester.pump();
      expect(tester.getTopLeft(line).dy, y, reason: 'a new message lands below');
    }
  });

  testWidgets('at the end, new text keeps the end in view in the same frame', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    final chat = _chat(store, after: 60);
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    final reply = TextMsg(id: 'live', ts: _at(14, 0), text: 'מתחילה', streaming: true);
    chat.items.add(reply);
    store.touch();
    await tester.pump();
    final list = _list(tester);
    double bottomOf(String s) => tester.getBottomLeft(findShown(s)).dy;
    expect(bottomOf('מתחילה'), inInclusiveRange(list.bottom - 120, list.bottom));
    for (var i = 0; i < 12; i++) {
      reply.text += '\nשורה חיה $i';
      store.touch();
      await tester.pump();
      expect(bottomOf('שורה חיה $i'), inInclusiveRange(list.bottom - 120, list.bottom), reason: 'the newest line is in view, frame $i');
    }
    chat.items.add(TextMsg(id: 'n1', ts: _at(14, 2), text: 'ההודעה האחרונה'));
    store.touch();
    await tester.pump();
    expect(bottomOf('ההודעה האחרונה'), inInclusiveRange(list.bottom - 120, list.bottom));
  });

  testWidgets('answering a card on screen folds it in place: nothing above it moves', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    final chat = _chat(store, after: 30);
    chat.items.add(AskCard(id: 'mid', ts: _at(13, 0).add(const Duration(seconds: 19, milliseconds: 500)), askId: 'ask-mid', from: 'dana', headline: 'שאלה באמצע', question: 'פרטים ארוכים\nעוד שורה\nועוד אחת', options: const [AskOption(id: 'y', label: 'כן'), AskOption(id: 'n', label: 'לא')]));
    chat.items.sort((a, b) => a.ts.compareTo(b.ts));
    store.data!.waiting.add(_wait('ask-mid'));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    // Up to the card, so it sits on the screen with talk above it.
    await tester.dragUntilVisible(findShown('שאלה באמצע'), _listFinder, const Offset(0, 200));
    await tester.pumpAndSettle();
    final list = _list(tester);
    final pos = _position(tester);
    pos.jumpTo(pos.pixels + (list.top + 250 - tester.getTopLeft(findShown('שאלה באמצע')).dy));
    await tester.pump();
    expect(tester.getTopLeft(findShown('שאלה באמצע')).dy, inInclusiveRange(list.top, list.bottom - 100));
    // The line right above the card: it must not move when the card folds.
    final above = findShown('שורה 19');
    expect(above, findsOneWidget);
    final y = tester.getTopLeft(above).dy;

    await tester.tap(find.text('כן'));
    await tester.pump();
    expect(findShown('ענית: כן'), findsOneWidget, reason: 'the card folded');
    expect(tester.getTopLeft(above).dy, y, reason: 'nothing above the card moved');
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    expect(tester.getTopLeft(above).dy, y);
  });

  testWidgets('a jump to the first card leaves no empty band above the conversation', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    _chat(store, before: [
      AskCard(id: 'first', ts: _at(9, 0), askId: 'ask-first', from: 'dana', headline: 'הכרטיס הראשון', question: 'לשלוח?', options: const [AskOption(id: 'y', label: 'כן')]),
    ], after: 100);
    store.data!.waiting.add(_wait('ask-first'));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await tester.tap(find.text('לשאלה'));
    await tester.pump();
    final list = _list(tester);
    final card = findShown('הכרטיס הראשון');
    expect(card, findsOneWidget);
    // Only a day line above it: the conversation starts at the top of the list, not below a gap.
    expect(tester.getTopLeft(card).dy, lessThan(list.top + 120));
    await tester.drag(_listFinder, const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(card).dy, lessThan(list.top + 120), reason: 'no scrolling into an empty band');
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('opening a card\'s details while scrolled up moves nothing above it', (tester) async {
    final store = await pumpApp(tester, home: const SizedBox());
    final chat = _chat(store, after: 30);
    chat.items.add(GoCard(id: 'go:9', ts: _at(13, 0).add(const Duration(seconds: 19, milliseconds: 500)), askId: 'inbox:9', from: 'dana', headline: 'בקשה באמצע', details: '**מה נכנס:** הרבה\n**סיכון:** נמוך\n**חזרה:** revert\nועוד שורה\nועוד שורה'));
    chat.items.sort((a, b) => a.ts.compareTo(b.ts));
    store.data!.waiting.add(_wait('inbox:9', kind: WaitKind.go));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await tester.dragUntilVisible(findShown('בקשה באמצע'), _listFinder, const Offset(0, 200));
    await tester.pumpAndSettle();
    final list = _list(tester);
    final pos = _position(tester);
    pos.jumpTo(pos.pixels + (list.top + 250 - tester.getTopLeft(findShown('בקשה באמצע')).dy));
    await tester.pump();
    final above = findShown('שורה 19');
    final head = findShown('בקשה באמצע');
    final y = tester.getTopLeft(above).dy, hy = tester.getTopLeft(head).dy;
    await tester.tap(find.text('פרטים'));
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 30));
      expect(tester.getTopLeft(above).dy, y, reason: 'frame $i');
      expect(tester.getTopLeft(head).dy, hy);
    }
    expect(find.text('הסתרת הפרטים'), findsOneWidget);
  });

  testWidgets('a touch on a card keeps what is open below it open', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1200), home: const SizedBox());
    final chat = _chat(store, after: 60);
    chat.items.addAll([
      GoCard(id: 'go:9', ts: _at(13, 0).add(const Duration(seconds: 19, milliseconds: 400)), askId: 'inbox:9', from: 'dana', headline: 'בקשה באמצע', details: 'פרטים\nעוד שורה'),
      ToolGroup(id: 'tg', ts: _at(13, 0).add(const Duration(seconds: 19, milliseconds: 600)), summary: 'קרא 2 קבצים', tools: const [
        ToolLine(icon: 'description', label: 'lib/a.dart'),
        ToolLine(icon: 'description', label: 'lib/b.dart'),
      ]),
    ]);
    chat.items.sort((a, b) => a.ts.compareTo(b.ts));
    store.data!.waiting.add(_wait('inbox:9', kind: WaitKind.go));
    await pumpScreen(tester, store, const ChatScreen(identityId: 'dana'));
    await tester.dragUntilVisible(findShown('בקשה באמצע'), _listFinder, const Offset(0, 200));
    await tester.pumpAndSettle();
    final list = _list(tester);
    final pos = _position(tester);
    pos.jumpTo(pos.pixels + (list.top + 200 - tester.getTopLeft(findShown('בקשה באמצע')).dy));
    await tester.pump();
    await tester.tap(find.textContaining('קרא 2 קבצים'));
    await tester.pumpAndSettle();
    expect(find.text('lib/a.dart'), findsOneWidget);
    await tester.tap(find.text('פרטים'));
    await tester.pumpAndSettle();
    expect(find.text('הסתרת הפרטים'), findsOneWidget);
    expect(find.text('lib/a.dart'), findsOneWidget, reason: 'the tool group below the card stayed open');
  });
}
