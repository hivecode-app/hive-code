// What a worker did with a tool, in plain Hebrew (task 281): the row's Hebrew label, and the details a tap opens.
import 'package:agent_company/data/engine_model.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/items.dart';
import 'package:agent_company/ui/chat/tool_details.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'engine_test.dart' show ev;
import 'helpers.dart';

void main() {
  test('a tool call keeps its input, its result, its times and the sentence before it', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.f);
    for (final e in [
      ev(1, 'text', {'text': 'בודקת את הגרסה.\n\nמריצה את הבדיקות.', 'messageId': 'a'}, ts: 1000),
      ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'Bash', 'input': {'command': 'npm test', 'description': 'מריצה בדיקות'}}, ts: 2000),
      ev(3, 'tool_result', {'toolUseId': 't1', 'isError': true, 'preview': 'Exit code 1\nFAIL x.test.ts'}, ts: 4100),
      ev(4, 'tool_use', {'toolUseId': 't2', 'name': 'mcp__company__remember', 'input': {'scope': 'company', 'kind': 'lesson', 'text': 'לקח'}}, ts: 5000),
      ev(5, 'tool_result', {'toolUseId': 't2', 'isError': false, 'preview': '{"ok":true}'}, ts: 5100),
      ev(6, 'result', {'subtype': 'success', 'isError': false}),
      ev(7, 'tool_use', {'toolUseId': 't3', 'name': 'Read', 'input': {'file_path': 'a.dart'}}, ts: 9000),
    ]) {
      m.apply(e);
    }
    final groups = items.whereType<ToolGroup>().toList();
    final bash = groups.first.tools.first.call!;
    expect(bash.name, 'Bash');
    expect(bash.isError, isTrue);
    expect(bash.preview, 'Exit code 1\nFAIL x.test.ts');
    expect(bash.ended!.difference(bash.started).inMilliseconds, 2100);
    expect(bash.why, 'בודקת את הגרסה.\n\nמריצה את הבדיקות.');
    expect(groups.first.tools[1].call!.input['kind'], 'lesson');
    // A new turn starts without the last one's sentence.
    expect(groups.last.tools.single.call!.why, isNull);
  });

  test('Hebrew labels, never the internal name', () {
    expect(toolLabel('mcp__company__remember', Gender.m), 'רשם לזיכרון');
    expect(toolLabel('mcp__company__remember', Gender.f), 'רשמה לזיכרון');
    expect(toolLabel('mcp__company__tell', Gender.m), 'שלח הודעה');
    expect(toolLabel('Bash', Gender.m), 'הריץ פקודה');
    expect(toolLabel('Grep', Gender.m), 'חיפש בקוד');
    expect(toolLabel('mcp__browser__browser_navigate', Gender.m), 'השתמש בכלי');
    expect(toolHasDetail('mcp__company__remember'), isFalse);
    expect(toolHasDetail('Read'), isTrue);
  });

  testWidgets('the row says the Hebrew label, and a tap opens what was written to memory', (tester) async {
    const id = 'dana';
    final call = ToolCall(
      name: 'mcp__company__remember',
      input: const {'scope': 'company', 'kind': 'decision', 'file': 'memory/company/design-taste.md', 'text': 'נייר **חם**', 'quote': 'נייר חם'},
      started: kDemoNow,
      ended: kDemoNow.add(const Duration(milliseconds: 300)),
      why: 'רושמת את ההכרעה.',
    );
    final group = ToolGroup(id: 'g', ts: kDemoNow, summary: 'רשם לזיכרון', tools: [
      ToolLine(icon: toolIcon(call.name), label: toolDetail(call.name, call.input), name: call.name, call: call),
    ]);
    final store = await pumpApp(tester, home: Scaffold(body: ToolGroupRow(group: group, forceOpen: true, identityId: id)));
    final d = store.data!;
    expect(find.text('mcp__company__remember'), findsNothing);
    await tester.tap(find.text(toolLabel(call.name, d.who(id).gender)));
    await tester.pumpAndSettle();
    expect(find.byType(ToolDetails), findsOneWidget);
    expect(findShown('מה נרשם'), findsOneWidget);
    expect(findShown('זיכרון החברה · ספר העיצוב'), findsOneWidget);
    expect(findShown('החלטה'), findsOneWidget);
    expect(findShown('«נייר חם»'), findsOneWidget);
    expect(findShown('רושמת את ההכרעה.'), findsOneWidget);
  });

  testWidgets('a failed command says so in a word, with the last line of the error', (tester) async {
    const id = 'dana';
    final call = ToolCall(
      name: 'Bash',
      input: const {'command': 'go test ./...', 'description': 'מריץ את הבדיקות'},
      started: kDemoNow,
      ended: kDemoNow.add(const Duration(milliseconds: 2100)),
      preview: 'Exit code 1\nok  a\nFAIL b [setup failed]',
      isError: true,
    );
    await pumpApp(tester, home: Scaffold(body: ToolDetails(identityId: id, call: call, onClose: () {})));
    expect(findShown('מריץ את הבדיקות'), findsOneWidget);
    expect(findShown("נכשל · 2.1 שנ'"), findsOneWidget);
    expect(findShown('FAIL b [setup failed]'), findsWidgets);
  });

  testWidgets('an unknown tool shows its name only on the details, as code', (tester) async {
    const id = 'dana';
    const name = 'mcp__browser__browser_navigate';
    final call = ToolCall(name: name, input: const {'url': 'https://example.com'}, started: kDemoNow, ended: kDemoNow, preview: '{"ok":true}');
    await pumpApp(tester, home: Scaffold(body: ToolDetails(identityId: id, call: call, onClose: () {})));
    expect(findShown(name), findsOneWidget);
    expect(findShown('כתובת'), findsOneWidget);
    expect(findShown('פרטים טכניים'), findsOneWidget);
  });
}
