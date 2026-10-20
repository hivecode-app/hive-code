// lib/ui/bidi.dart. Same cases as android/.../BidiTest.kt: the two implementations must agree.
import 'dart:io';

import 'package:agent_company/ui/bidi.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/chat/markdown.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

String show(String s) => s.replaceAll(kLRI, '⟦').replaceAll(kFSI, '⟦').replaceAll(kPDI, '⟧').replaceAll(kWJ, '');

void main() {
  const rtl = TextDirection.rtl, ltr = TextDirection.ltr;

  test('paragraph direction', () {
    expect(paragraphDirection('שלום world'), rtl);
    expect(paragraphDirection('t2790 סיים, וסגרתי אותו.'), rtl);
    expect(paragraphDirection('CI נכשל על guard אמיתי'), rtl);
    expect(paragraphDirection('`hooks` עבר הפעם.'), rtl);
    expect(paragraphDirection('**`main` ירוק.**'), rtl);
    expect(paragraphDirection('\u200Ft3720 opened two PRs'), rtl);
    expect(paragraphDirection('Smoke test from the app'), ltr);
    expect(paragraphDirection("Yossi isn't tagged, and «צירוף חברים» is showing"), ltr);
    expect(paragraphDirection('`git status`'), ltr);
    expect(paragraphDirection('12:30'), rtl);
    expect(paragraphDirection(''), rtl);
  });

  test('LTR runs are isolated', () {
    expect(show(isolateLtr('ה-CI של PR #191 ירוק.')), 'ה-⟦CI⟧ של ⟦PR #191⟧ ירוק.');
    expect(show(isolateLtr('נעצר (SIGTERM, exit 143) ב-11:16')), 'נעצר (⟦SIGTERM, exit 143⟧) ב-11:16');
    expect(show(isolateLtr('ירד ל-35–37ms ב-worker.')), 'ירד ל-⟦35–37ms⟧ ב-⟦worker⟧.');
    expect(show(isolateLtr('גרסה 0.3.121 ב-prod (#2575).')), 'גרסה ⟦0.3.121⟧ ב-⟦prod⟧ (⟦#2575⟧).');
    expect(show(isolateLtr('קרא /tmp/dispatch/brief.md ואחר כך')), 'קרא ⟦/tmp/dispatch/brief.md⟧ ואחר כך');
    expect(show(isolateLtr('[t6-1:mvfvj66l-010ab3d094]')), '[t6-1:mvfvj66l-010ab3d094]', reason: 'no Hebrew: untouched');
    expect(show(isolateLtr('ref: agent-company-t6-1:mvf]', force: true)), '⟦ref⟧: ⟦agent-company-t6-1:mvf⟧]', reason: 'brackets stay outside');
    expect(isolateLtr('Smoke test'), 'Smoke test');
    expect(show(isolateLtr('בבדיקה של 05:43Z, הבאה ב-07:43Z')), 'בבדיקה של ⟦05:43Z⟧, הבאה ב-⟦07:43Z⟧');
    expect(show(isolateLtr('לגרסה 2.5.6-wa.3 במוצאי שבת')), 'לגרסה ⟦2.5.6-wa.3⟧ במוצאי שבת');
  });

  test('an English line keeps its Hebrew quote without isolates', () {
    const s = 'Here the code sent GPT-Live the line "אני עכשיו מעביר אתכם לסדרן", but GPT-Live didn\'t say it.';
    expect(isolateLtr(s), s);
  });

  test('paths, URLs and code stay on one line', () {
    expect(keepWhole('/tmp/dispatch/brief-common.md'), '/$kWJ' 'tmp/$kWJ' 'dispatch/$kWJ' 'brief-$kWJ' 'common.md');
    expect(keepWhole('Internal error -100'), 'Internal error -100');
    expect(keepWhole('ridematch/'), 'ridematch/');
  });

  test('a Hebrew prefix is glued to the LTR run after it', () {
    expect(isolateLtr('ב-prod.'), 'ב-$kWJ${kLRI}prod$kPDI.');
    expect(endsWithHebrewPrefix('נשארו app ו-'), isTrue);
    expect(endsWithHebrewPrefix('מה-'), isTrue);
    expect(endsWithHebrewPrefix('קריאות-'), isFalse);
  });

  test('stripBidi removes only the controls', () {
    expect(stripBidi(isolateLtr('ב-prod (#12).')), 'ב-prod (#12).');
  });

  test('the time goes where the last line ends', () {
    expect(markdownEndDirection('שלום\nOK, done'), ltr);
    expect(markdownEndDirection('OK\nשלום'), rtl);
    expect(markdownEndDirection('- one\n- two'), ltr);
    expect(markdownEndDirection('קוד:\n```\nx\n```'), rtl);
  });

  testWidgets('the composer turns with what is typed', (tester) async {
    await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'yoav'));
    TextDirection? dir() => tester.widget<TextField>(find.byType(TextField)).textDirection;
    await tester.enterText(find.byType(TextField), 'git status');
    await tester.pump();
    expect(dir(), ltr);
    await tester.enterText(find.byType(TextField), 'CI נכשל על guard');
    await tester.pump();
    expect(dir(), rtl);
    await tester.enterText(find.byType(TextField), '');
    await tester.pump();
    expect(dir(), rtl);
  });

  test('Android uses the same patterns, character for character', () {
    final kt = File('android/app/src/main/kotlin/app/hivecode/notify/Bidi.kt').readAsStringSync();
    final block = kt.substring(kt.indexOf('// BEGIN shared patterns'), kt.indexOf('// END shared patterns'));
    final fromKt = {for (final m in RegExp(r'const val (\w+) = """(.*)"""').allMatches(block)) m[1]!: m[2]!};
    expect(fromKt, kBidiPatterns);
  });

  test('no pattern backtracks on long or repetitive text', () {
    final inputs = [
      'שלום abc${', ' * 60}!',
      'אבג ${'1' * 5000} דהו',
      'קרא ${List.filled(400, 'dir').join('/')}.',
      'ב-${'a-' * 2000}b',
      'מספרים ${List.filled(500, '12:30').join(' ')} סוף',
      'שלום ${'ab ' * 30000}',
    ];
    for (final s in inputs) {
      final sw = Stopwatch()..start();
      isolateLtr(s);
      paragraphDirection(s);
      expect(sw.elapsedMilliseconds, lessThan(1000), reason: s.substring(0, 20));
    }
  });

  test('a Hebrew word glued to English is not swallowed into the run', () {
    expect(show(isolateLtr('שלחתי commitים חדשים')), 'שלחתי ⟦commit⟧ים חדשים');
  });

  test('tables only when they really are tables', () {
    expect(parseMarkdown('| כותרת\n---\nטקסט').whereType<MdTable>(), isEmpty, reason: 'a rule under a pipe line');
    expect(parseMarkdown('| a | b |\n|---|\nx').whereType<MdTable>(), isEmpty, reason: 'column count differs');
    final t = parseMarkdown('| פקודה | מה |\n|---|---|\n| `a | b` | צינור |\n| x \\| y | z | עוד |').single as MdTable;
    expect(t.rows[0], ['`a | b`', 'צינור', '']);
    expect(t.rows[1], ['x | y', 'z', 'עוד']);
    expect(t.header.length, 3, reason: 'a longer row widens the table');
  });

  test('four-space and two-space nesting look the same', () {
    final a = parseMarkdown('1. אחד\n    - פנימי\n2. שתיים').single as MdList;
    final b = parseMarkdown('1. אחד\n  - פנימי\n2. שתיים').single as MdList;
    expect([for (final i in a.items) i.depth], [0, 1, 0]);
    expect([for (final i in b.items) i.depth], [0, 1, 0]);
  });

  test('lists keep their numbers and nesting', () {
    final l = parseMarkdown('3. שלוש\n  - פנימי\n4. ארבע').single as MdList;
    expect([for (final i in l.items) i.marker], ['3.', '•', '4.']);
    expect([for (final i in l.items) i.depth], [0, 1, 0]);
  });
}
