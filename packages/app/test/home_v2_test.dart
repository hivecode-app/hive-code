// The v2 home (lib/ui/convs/home_v2.dart): its sentence from live data, a tone per team from hq's board, and
// the seven project tones side by side in light and dark (goldens/home_v2/tones-*.png).
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/theme/theme.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/home_v2.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

CompanyData _data({List<OpenTask> tasks = const []}) => mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [])..openTasks = tasks;

void main() {
  test('the sentence says what runs, from live data; how many decisions wait is its lead', () {
    final run = [
      for (final (i, p) in [(1, 'a'), (2, 'a'), (3, 'b')]) OpenTask(id: i, title: 't$i', state: OpenTaskState.running, project: p),
    ];
    expect(homeSentence(_data(), stuck: 0), 'שום דבר לא מחכה לך. הכול שקט.');
    expect(homeSentence(_data(tasks: run), stuck: 0), 'שום דבר לא מחכה לך. 3 משימות רצות בשני פרויקטים.');
    expect(homeSentence(_data(tasks: run.take(1).toList()), stuck: 0, decisions: 1), 'בינתיים משימה אחת רצה.');
    expect(homeSentence(_data(), stuck: 0, decisions: 2), '', reason: 'the lead says it all');
    expect(homeSentence(_data(tasks: run), stuck: 1, decisions: 2), 'תקלה אחת צריכה אותך עכשיו.');
    expect([for (final n in [0, 1, 2, 3, 12]) decisionsLead(n)], [null, 'החלטה אחת מחכה לך.', 'שתי החלטות מחכות לך.', '3 החלטות מחכות לך.', '12 החלטות מחכות לך.']);
  });

  test("the composer's headline while it is fresh, else the live sentence", () {
    final at = DateTime(2026, 10, 21, 9);
    HomeRecipe recipe({String source = 'agent'}) =>
        HomeRecipe(version: 3, composedBy: 'adi', composedAt: at, source: source, blocks: const [HomeBlock(type: 'headline', text: 'בוקר שקט, שתי משימות רצות')]);
    final now = at.add(const Duration(minutes: 20));
    final quiet = _data();
    expect(topSentence(quiet, recipe(), stuck: 0, now: now), 'בוקר שקט, שתי משימות רצות');
    // A stuck worker, or a headline older than hq's 30 minutes (from the cache): live.
    expect(topSentence(quiet, recipe(), stuck: 1, now: now), 'תקלה אחת צריכה אותך עכשיו.');
    expect(topSentence(quiet, recipe(), stuck: 0, now: at.add(const Duration(minutes: 31))), 'שום דבר לא מחכה לך. הכול שקט.');
    // hq's own sentence, written from facts (`home-headline` on): shown like the composer's.
    expect(topSentence(quiet, recipe(source: 'hq'), stuck: 0, now: now), 'בוקר שקט, שתי משימות רצות');
    // hq's plain default (switched off), or no recipe: live.
    expect(topSentence(quiet, recipe(source: 'default'), stuck: 0, now: now), 'שום דבר לא מחכה לך. הכול שקט.');
    expect(topSentence(quiet, null, stuck: 0, now: now), 'שום דבר לא מחכה לך. הכול שקט.');
    // With decisions waiting, the lead comes first and nothing else says "שום דבר".
    final d = mapSnapshot(board: const [], asks: const [], toggles: const [], inbox: [
      {'id': 1, 'kind': 'go', 'title': 'GO: hq', 'body': '', 'from_identity': 'adi', 'urgency': 'normal', 'blocking': true, 'state': 'open', 'created_at': at.add(const Duration(minutes: 10)).millisecondsSinceEpoch},
    ]);
    expect(fullSentence(d, null, stuck: 0, now: now), 'החלטה אחת מחכה לך.');
    expect(fullSentence(d, recipe(), stuck: 0, now: now), 'החלטה אחת מחכה לך. בוקר שקט, שתי משימות רצות');
  });

  testWidgets('a project line is cut between words, never inside one (T2)', (tester) async {
    await loadFonts();
    const rest = 'אחרון: נסיעה טובה עברה לגרסה החדשה של הספרייה, וכל ארבע התחנות עובדות עליה מהבוקר בלי תקלה אחת';
    await tester.pumpWidget(const MaterialApp(
      home: Directionality(
        textDirection: TextDirection.rtl,
        child: Scaffold(body: Center(child: SizedBox(width: 240, child: WordClamp(lead: 'שקט', rest: rest, style: TextStyle(fontSize: 13))))),
      ),
    ));
    final shown = (tester.widget<RichText>(find.byType(RichText).first).text as TextSpan).toPlainText();
    expect(shown.endsWith('…'), isTrue, reason: shown);
    final kept = shown.substring('שקט · '.length, shown.length - 1);
    expect(rest.startsWith(kept), isTrue);
    expect(rest[kept.length], anyOf(' ', ','), reason: 'the cut falls on a word boundary: "$kept"');
    expect(kept.length, lessThan(rest.length));
  });

  test('a team takes its tone from the board; a task worker without a project takes its opener\'s', () {
    final d = mapSnapshot(board: [
      {'id': 'adi', 'name': 'עדי', 'team': 'agent-company', 'team_kind': 'project', 'project': 'agent-company', 'lifecycle': 'lead', 'tone': 'blue'},
      {'id': 'agent-company-t7', 'name': 'איתי', 'team': 'agent-company-t7', 'team_kind': 'task', 'project': 'agent-company', 'lifecycle': 'ephemeral', 'tone': 'blue'},
      {'id': 'eli', 'name': 'אלי', 'team': 'personal', 'team_kind': 'permanent', 'lifecycle': 'lead', 'tone': 'slate'},
      {'id': 'company-t9', 'name': 'עמית', 'team': 'company-t9', 'team_kind': 'task', 'reports_to': 'eli', 'lifecycle': 'ephemeral'},
      {'id': 'yoav', 'name': 'יואב', 'team': 'management', 'team_kind': 'permanent', 'lifecycle': 'resident'},
    ], inbox: const [], asks: const [], toggles: const []);
    expect([for (final id in ['adi', 'agent-company-t7', 'eli', 'company-t9', 'yoav']) d.teamOf(id)?.tone], ['blue', 'blue', 'slate', 'slate', null]);
    // None, or a name this app doesn't know: slate.
    expect(Palette.lightV2.identity(null), Palette.lightV2.identity('slate'));
    expect(Palette.lightV2.identity('purple'), Palette.lightV2.identity('slate'));
  });

  testWidgets('the home leads with the live count of decisions, a tap goes to the tab, and no card of them is under it', (tester) async {
    late CompanyData d;
    late AppNav nav;
    await pumpApp(tester, size: const Size(412, 2400), home: Builder(builder: (c) {
      d = StoreScope.of(c).data!;
      nav = NavScope.read(c);
      // Nobody stuck: the composer's headline stands.
      for (final id in d.presence.keys.toList()) {
        if (d.presence[id]!.status == WorkerStatus.stuck) d.presence[id] = Presence(status: WorkerStatus.working);
      }
      // A composer's recipe that says nothing of what waits: the count is the app's.
      final recipe = HomeRecipe(version: 1, composedBy: 'adi', composedAt: kDemoNow, source: 'agent', blocks: const [HomeBlock(type: 'headline', text: 'בוקר שקט')]);
      return Scaffold(body: ListView(children: [HomeV2(recipe: recipe, data: d, now: kDemoNow)]));
    }));
    expect(d.waitingCount, greaterThan(0), reason: 'the demo data has something waiting');
    expect(find.text(decisionsLead(d.waitingCount)!), findsOneWidget);
    expect(findShown('בוקר שקט'), findsOneWidget);
    expect(find.text('מחכה לך'), findsNothing, reason: 'no card of what waits');
    await tester.tap(find.text(decisionsLead(d.waitingCount)!));
    expect(nav.tab, AppTab.decisions);
  });

  // The seven projects of org.yaml with the tones decided on 21/10, by the icons the app draws for them today, so
  // the close ones are judged side by side. The second row has coral back in olive's place, the way it was
  // before 21/10: coral and clay read as one (language-v2 §3).
  const projects = [
    ('החברה', 'architecture', 'blue'),
    ('האפליקציה לומו', 'local_shipping', 'teal'),
    ('לומו בוט', 'smart_toy', 'green'),
    ('הבוט הקולי', 'graphic_eq', 'sky'),
    ('טיקי בוט', 'directions_car', 'clay'),
    ('פינטו', 'build', 'rose'),
    ('מה חדש בעיר', 'campaign', 'olive'),
    ('הצוותים הקבועים', 'folder_shared', 'slate'),
  ];
  const coral = (Color(0xFFFFE2DA), Color(0xFF643D31), Color(0xFF573226), Color(0xFFFFD3C7));
  for (final dark in [false, true]) {
    testWidgets('the project tones side by side (${dark ? 'dark' : 'light'})', (tester) async {
      await loadFonts();
      tester.view.physicalSize = const Size(900, 290) * 2;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final p = dark ? Palette.darkV2 : Palette.lightV2;
      Widget face(String symbol, String tone) {
        if (tone != 'coral') return ProjectFace(symbol: symbol, tone: tone, size: 56);
        final (bg, fg) = dark ? (coral.$3, coral.$4) : (coral.$1, coral.$2);
        return Container(width: 56, height: 56, alignment: Alignment.center, decoration: BoxDecoration(shape: BoxShape.circle, color: bg), child: Ic(symbol, size: 28, color: fg));
      }

      Widget row(List<(String, String, String)> list) => Row(mainAxisAlignment: MainAxisAlignment.center, children: [
            for (final (name, symbol, tone) in list)
              SizedBox(
                width: 108,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  face(symbol, tone),
                  const SizedBox(height: 8),
                  Text(name, textAlign: TextAlign.center, style: T.small.copyWith(color: p.text)),
                  Text(tone, style: T.meta.copyWith(color: p.text2)),
                ]),
              ),
          ]);
      await tester.pumpWidget(MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildTheme(p),
        home: Directionality(
          textDirection: TextDirection.rtl,
          child: Scaffold(
            backgroundColor: p.bg,
            body: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              row(projects),
              const SizedBox(height: 20),
              row([for (final x in projects) x.$3 == 'olive' ? (x.$1, x.$2, 'coral') : x]),
            ]),
          ),
        ),
      ));
      await expectLater(find.byType(Scaffold), matchesGoldenFile('goldens/home_v2/tones-${dark ? 'dark' : 'light'}.png'));
    });
  }

  testWidgets('a project nothing moved in during the last day folds into "שקט גם ב:", also with no recipe', (tester) async {
    int ago(Duration x) => kDemoNow.subtract(x).millisecondsSinceEpoch;
    Map<String, dynamic> task(int id, String project, String state, Duration at) =>
        {'id': id, 'project': project, 'title': 'משימה $id', 'state': state, 'labels': '[]', 'identity': null, 'created_at': ago(at), 'updated_at': ago(at), 'started_at': ago(at), 'summary': state == 'done' ? 'הסתיים $id' : null};
    final d = mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], now: kDemoNow, projects: [
      for (final id in ['busy', 'done-today', 'still']) {'id': id, 'name': id, 'status': 'active', 'team': id},
    ], tasks: [
      task(1, 'busy', 'running', const Duration(minutes: 20)),
      task(2, 'done-today', 'done', const Duration(hours: 3)),
      task(3, 'still', 'done', const Duration(days: 3)),
    ]);
    await pumpApp(tester, size: const Size(342, 2400), home: Scaffold(body: ListView(children: [HomeV2(data: d, now: kDemoNow)])));
    expect(tester.widget<QuietBlock>(find.byType(QuietBlock)).projects, ['still']);
    expect(tester.widgetList<ProjectRowV2>(find.byType(ProjectRowV2)).map((r) => r.line.id).toSet(), {'busy', 'done-today'});
  });
}
