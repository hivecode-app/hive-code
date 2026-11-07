// Messages between workers and what a worker did (task 296): one kind of line in the chat, a run of them folded,
// a tap opening the whole message, and the people and the quoted message in it leading to their conversations.
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/chat/tool_details.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

DateTime _at(int min) => kDemoNow.subtract(Duration(minutes: min));

InternalMsg _msg(String id, int min, String from, String to, String body, {String? ref}) =>
    InternalMsg(id: 'msg:$id', ts: _at(min), from: from, to: to, body: body, ref: ref);

final _first = _msg('m1', 50, 'yoav', 'noa', 'את יכולה לבדוק למה המסך של ההחלטה נראה צפוף בטלפון? אני צריך תשובה עד הצהריים');
final _answer = _msg('m2', 40, 'noa', 'yoav', 'בדקתי: הרווח בין האפשרויות קטן מ-8, מתקנת', ref: 'm1');
final _third = _msg('m3', 30, 'yoav', 'noa', 'תודה, תשלחי לי כשזה ב-PR');
/// Something else between two lines, so they are not one run.
final _between = TextMsg(id: 'msg:x', ts: _at(20), text: 'עדכון מהעובד');
final _lone = _msg('m4', 10, 'yoav', 'gil', 'גיל, הבדיקה של ה-CI עברה?');

/// Puts the messages in the conversations they belong to, as hq's history does.
void _seed(AppStore store, Map<String, List<ChatItem>> chats) {
  final d = store.data!;
  for (final MapEntry(key: id, value: msgs) in chats.entries) {
    final chat = d.chats[id]!;
    chat.items
      ..clear()
      ..addAll(msgs);
    for (final m in msgs.whereType<InternalMsg>()) {
      chat.refs[m.messageId] = RefMessage(from: m.from, to: m.to, body: m.body, ts: m.ts);
    }
  }
  store.touch();
}

Finder _row(InternalMsg m) => find.byWidgetPredicate((w) => w is InternalMsgRow && w.msg == m);

Widget _lines(List<Widget> rows) => Builder(
      builder: (context) => Scaffold(backgroundColor: context.p.chatBg, body: ListView(padding: const EdgeInsets.only(top: 12), children: rows)),
    );

void main() {
  testWidgets('a message between workers is one line with its own mark, and a tap opens it whole', (tester) async {
    final store = await pumpApp(tester, home: const ChatScreen(identityId: 'yoav'));
    _seed(store, {'yoav': [_first, _between, _lone], 'noa': [_first]});
    await tester.pumpAndSettle();
    expect(find.bySemanticsLabel(RegExp('^יואב ← נועה')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('^יואב ← גיל')), findsOneWidget);
    expect(find.byType(InternalGroupRow), findsNothing);
    await tester.tap(_row(_first));
    await tester.pumpAndSettle();
    expect(find.byType(ToolDetails), findsOneWidget);
    expect(findShown('שלח הודעה'), findsOneWidget);
    expect(findShown('את יכולה לבדוק למה המסך של ההחלטה נראה צפוף בטלפון? אני צריך תשובה עד הצהריים'), findsWidgets);
    expect(findShown('לשיחה עם נועה'), findsOneWidget);
  });

  testWidgets('a run of them folds into one line that opens in place', (tester) async {
    final store = await pumpApp(tester, home: const ChatScreen(identityId: 'yoav'));
    _seed(store, {'yoav': [_first, _answer, _third, _lone]});
    await tester.pumpAndSettle();
    expect(findShown('4 הודעות בין העובדים'), findsOneWidget);
    expect(find.byType(InternalMsgRow), findsNothing);
    await tester.tap(find.text('4 הודעות בין העובדים'));
    await tester.pumpAndSettle();
    expect(find.byType(InternalMsgRow), findsNWidgets(4));
    await tester.tap(find.text('4 הודעות בין העובדים'));
    await tester.pumpAndSettle();
    expect(find.byType(InternalMsgRow), findsNothing);
  });

  testWidgets('the recipient leads to their conversation, with the message brought up and lit', (tester) async {
    final store = await pumpApp(tester, home: const ChatScreen(identityId: 'yoav'));
    _seed(store, {'yoav': [_first, _between, _lone], 'noa': [_first]});
    await tester.pumpAndSettle();
    await tester.tap(_row(_first));
    await tester.pumpAndSettle();
    // "למי": her face and her name are one target.
    await tester.tap(find.descendant(of: find.byType(ToolDetails), matching: find.text('נועה')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(ToolDetails), findsNothing);
    final noa = find.byWidgetPredicate((w) => w is ChatScreen && w.identityId == 'noa');
    expect(noa, findsOneWidget);
    final lit = find.descendant(
      of: noa,
      matching: find.byWidgetPredicate((w) => w is Container && w.color == productPalette(Brightness.light).accentSoft),
    );
    expect(lit, findsOneWidget);
    expect(find.descendant(of: lit, matching: find.byType(InternalMsgRow)), findsOneWidget);
    // Lit for a moment, not for good.
    await tester.pump(const Duration(seconds: 2));
    expect(lit, findsNothing);
  });

  testWidgets('"בתגובה ל־" leads to the message it answers', (tester) async {
    final store = await pumpApp(tester, home: const ChatScreen(identityId: 'noa'));
    _seed(store, {'noa': [_first, _answer], 'yoav': [_first, _answer]});
    await tester.pumpAndSettle();
    expect(find.byType(InternalGroupRow), findsOneWidget);
    await tester.tap(find.byType(InternalGroupRow));
    await tester.pumpAndSettle();
    await tester.tap(_row(_answer));
    await tester.pumpAndSettle();
    expect(findShown('בתגובה ל־'), findsOneWidget);
    await tester.tap(findShown(_first.body).last);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // The answered message was said by yoav: his conversation, where the folded run opened to show it.
    expect(find.byWidgetPredicate((w) => w is ChatScreen && w.identityId == 'yoav'), findsOneWidget);
    final yoav = find.byWidgetPredicate((w) => w is ChatScreen && w.identityId == 'yoav');
    expect(find.descendant(of: yoav, matching: find.byType(InternalMsgRow)), findsNWidgets(2));
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('on a desktop the details open in the side column, also from the recipient\'s conversation', (tester) async {
    final store = await pumpApp(tester, size: const Size(1440, 860));
    final ctx = tester.element(find.byType(Scaffold).first);
    NavScope.read(ctx).go(AppTab.chats);
    store.homeOpen = false;
    store.selectedConversation = 'noa';
    _seed(store, {'noa': [_first]});
    await tester.pumpAndSettle();
    // The message is yoav's: its sender is not the conversation it is opened from.
    await tester.tap(_row(_first));
    await tester.pumpAndSettle();
    expect(find.byType(ToolDetails), findsOneWidget);
    // The sender leads to his conversation, and the column gives itself back.
    await tester.tap(find.descendant(of: find.byType(ToolDetails), matching: find.text('יואב')).last);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byType(ToolDetails), findsNothing);
    expect(store.selectedConversation, 'yoav');
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('a command row says its Hebrew description, not the command', (tester) async {
    final call = ToolCall(name: 'Bash', input: const {'command': 'npm test -- --run', 'description': 'מריץ את הבדיקות'}, started: _at(5), ended: _at(4));
    final group = ToolGroup(id: 'g', ts: _at(5), summary: 'הריץ פקודה', tools: [
      ToolLine(icon: 'terminal', label: 'npm test -- --run', name: 'Bash', call: call),
    ]);
    await pumpApp(tester, home: Scaffold(body: ToolGroupRow(group: group, forceOpen: true, identityId: 'gil')));
    expect(findShown('מריץ את הבדיקות'), findsOneWidget);
    expect(find.text('npm test -- --run'), findsNothing);
    final bare = ToolCall(name: 'Bash', input: const {'command': 'ls', 'description': 'ls'}, started: _at(5), ended: _at(4));
    final g2 = ToolGroup(id: 'g2', ts: _at(5), summary: 'הריץ פקודה', tools: [ToolLine(icon: 'terminal', label: 'ls', name: 'Bash', call: bare)]);
    await pumpApp(tester, home: Scaffold(body: ToolGroupRow(group: g2, forceOpen: true, identityId: 'gil')));
    expect(find.text('ls'), findsNothing);
    expect(findShown('הריץ פקודה'), findsWidgets);
  });

  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('goldens: the line, the folded run, the open run ($look)', (tester) async {
      await pumpApp(tester, dark: dark, textScale: scale, size: const Size(342, 640), home: _lines([
        InternalMsgRow(msg: _lone),
        InternalMsgRow(msg: _first),
        const SizedBox(height: 16),
        InternalGroupRow(count: 4, open: false, onToggle: () {}, children: const []),
        const SizedBox(height: 16),
        InternalGroupRow(count: 3, open: true, onToggle: () {}, children: [
          for (final m in [_first, _answer, _third]) InternalMsgRow(msg: m, inGroup: true),
        ]),
      ]));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/internal/lines-$look.png'));
    });

    testWidgets('goldens: the details with the people and the answered message as targets ($look)', (tester) async {
      final store = await pumpApp(tester, dark: dark, textScale: scale, size: const Size(342, 716));
      _seed(store, {'noa': [_first, _answer]});
      final call = ToolCall(
        name: 'mcp__company__tell',
        input: {'to': 'yoav', 'body': _answer.body, 'ref': 'm1', 'messageId': 'm2'},
        started: _answer.ts,
        ended: _answer.ts,
      );
      await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: Scaffold(body: ToolDetails(identityId: 'noa', call: call, onClose: () {}))));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/internal/details-$look.png'));
    });
  }
}
