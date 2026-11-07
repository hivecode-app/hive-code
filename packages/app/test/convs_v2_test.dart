// What the old phone list (task 205) left behind for the product's lists (lib/ui/convs/convs_v2.dart): search by
// the start of a word, his own closed cards as what he did, and lines cut between words.
import 'package:agent_company/data/hq_backend.dart' show ownLine;
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  test('search matches only the start of a word', () {
    expect(wordStart('דנה ביקשה לבדוק', 'ביק'), 4);
    expect(wordStart('עדנה כתבה', 'דנה'), -1, reason: 'inside a word');
    expect(wordStart('עדנה ו(דנה)', 'דנה'), 7, reason: 'after a bracket is a word start');
    expect(wordStart('Rancher בקלאסטר', 'ranch'), 0);
    expect(wordStart('anything', ''), -1);
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

  testWidgets('WordFit: a Hebrew label that starts with a Latin word keeps the Hebrew order', (t) async {
    Future<String> shown(String text) async {
      await t.pumpWidget(MaterialApp(home: Material(child: Directionality(textDirection: TextDirection.rtl, child: Center(child: SizedBox(width: 600, child: WordFit(lead: 'דנה ', text: text, style: const TextStyle())))))));
      return t.widget<Text>(find.byType(Text)).textSpan!.toPlainText();
    }

    expect(await shown('· GO לפרודקשן'), 'דנה $kRLI· GO לפרודקשן$kPDI');
    expect(await shown('· git push failed'), 'דנה $kLRI· git push failed$kPDI');
  });
}
