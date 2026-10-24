// "השימוש" on the home (lib/ui/convs/home_usage.dart, task 496): the weekly % of the last hour and day, tasks in
// parallel, and the day's spend by kind and worker, one ink with a thin bar each (goldens/home_usage/*.png).
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/ui/convs/home_usage.dart';
import 'package:agent_company/ui/convs/home_v2.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

String _p(int v) => '\u2066$v%\u2069';
String _n(String v) => '\u2066$v\u2069';
final _now = kDemoNow;

const _u = UsageData(
  hourPct: 1.4,
  dayPct: 22,
  kinds: [('tasks', 0.42), ('leads_workers', 0.385), ('leads_owner', 0.13), ('leads_hq', 0.04), ('leads_other', 0.025)],
  people: [('שחר', 0.12, false), ('יואב', 0.11, false), ('תמר', 0.064, true)],
  parallelNow: 2,
  parallelAvg: 0.4,
  parallelPeak: 3,
);

HomeRecipe _recipe(UsageData? u) => HomeRecipe(version: 0, composedBy: 'hq', composedAt: _now, source: 'default', blocks: const [], usage: u);

void main() {
  test('the rate and parallel lines', () {
    expect(rateLines(_u), ['בשעה האחרונה \u20661.4%\u2069', 'ב-24 השעות האחרונות ${_p(22)}']);
    expect(rateLines(const UsageData(dayPct: 5)), ['ב-24 השעות האחרונות ${_p(5)}'], reason: 'the title says of what');
    expect(rateLines(const UsageData(parallelNow: 1)), ['עוד אין מדידה של המכסה']);
    expect(parallelLines(_u), ['2 משימות רצות עכשיו', 'ביממה ${_n('0.4')} בממוצע, ${_n('3')} בשעה העמוסה']);
    expect(parallelLines(const UsageData(parallelNow: 1)).first, 'משימה אחת רצה עכשיו');
  });

  test('the kinds: the leads once, with their sum, and what woke them under it', () {
    final rows = kindRows(_u.kinds);
    expect([for (final r in rows) r.$1], ['ראשי צוות', 'הודעות מעובדים', 'הודעות ממך', 'תזכורות מהמערכת', 'עבודה שחזרה', 'משימות']);
    expect(rows.first.$2, closeTo(0.58, 1e-9));
    expect([for (final r in rows) r.$3], [false, true, true, true, true, false]);
    expect([for (final r in kindRows(const [('tasks', 0.7), ('leads_owner', 0.3)])) r.$1], ['משימות', 'ראשי צוות', 'הודעות ממך']);
    expect(const UsageData(people: [('אלי', 1, false)]).isEmpty, isFalse);
  });

  test('usage comes and goes with the recipe JSON', () {
    final r = HomeRecipe.fromJson({'version': 1, 'composed_by': 'hq', 'composed_at': 0, 'blocks': [], 'usage': {
      'measured_at': 1000, 'hour_pct': 2, 'day_pct': null, 'kinds': [{'kind': 'tasks', 'share': 0.5}],
      'people': [{'id': 'eli', 'name': 'אלי', 'share': 0.5, 'task': false}], 'parallel': {'now': 1, 'avg': 0.5, 'peak': 2},
    }});
    expect(r.usage!.kinds.single, ('tasks', 0.5));
    expect(r.usage!.parallelNow, 1);
    expect(HomeRecipe.fromJson(r.toJson()).usage!.people.single, ('אלי', 0.5, false));
    expect(HomeRecipe.fromJson({'version': 1, 'blocks': []}).usage, isNull, reason: 'an older hq');
  });

  CompanyData data() => mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], now: kDemoNow);

  testWidgets('the card is on the home and folds with it; nothing measured, no card', (tester) async {
    await pumpApp(tester, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: _recipe(_u))])));
    expect(find.byType(UsageCard), findsOneWidget);
    await pumpApp(tester, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: _recipe(_u), folded: true)])));
    await tester.pumpAndSettle();
    expect(find.byType(UsageCard), findsNothing);
    await pumpApp(tester, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: _recipe(const UsageData()))])));
    expect(find.byType(UsageCard), findsNothing);
  });

  testWidgets('golden: large text, a long name wraps and is never cut', (tester) async {
    const u = UsageData(dayPct: 22, kinds: [('tasks', 0.6), ('leads_workers', 0.4)],
        people: [('שם ארוך מאוד של עובד בצוות', 0.3, true)], parallelNow: 1, parallelAvg: 1, parallelPeak: 2);
    await pumpApp(tester, textScale: 2, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: _recipe(u))])));
    expect(find.text('שם ארוך מאוד של עובד בצוות, משימה'), findsOneWidget);
    await expectLater(find.byType(Scaffold).first, matchesGoldenFile('goldens/home_usage/card-large-text.png'));
  });

  for (final dark in [false, true]) {
    testWidgets('golden: the card (${dark ? 'dark' : 'light'})', (tester) async {
      await pumpApp(tester, dark: dark, size: const Size(360, 1000), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: _recipe(_u))])));
      await expectLater(find.byType(Scaffold).first, matchesGoldenFile('goldens/home_usage/card-${dark ? 'dark' : 'light'}.png'));
    });
  }
}
