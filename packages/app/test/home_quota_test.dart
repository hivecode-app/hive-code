// "המכסה" on the home (lib/ui/convs/home_quota.dart, task 482): each account's 5-hour and weekly use with when each
// resets, a full account as "חסום עד …", and the card up top while every account is full (goldens/home_quota/*.png).
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/ui/convs/home_quota.dart';
import 'package:agent_company/ui/convs/home_v2.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

String _p(int v) => '\u2066$v%\u2069';
final _now = kDemoNow; // Tuesday 20/10 14:06
QuotaLine _q(String name, {num five = 17, num week = 71, bool full = false, DateTime? reopens, bool usable = true, Duration measured = const Duration(minutes: 4)}) => QuotaLine(
      name: name,
      label: name,
      usable: usable,
      full: full,
      reopensAt: reopens,
      fiveHour: five,
      sevenDay: week,
      fiveHourResets: _now.add(const Duration(hours: 2, minutes: 54)),
      sevenDayResets: DateTime(2026, 10, 24, 6),
      measuredAt: _now.subtract(measured),
    );

HomeRecipe _recipe(List<QuotaLine> quota) => HomeRecipe(version: 0, composedBy: 'hq', composedAt: _now, source: 'default', blocks: const [], quota: quota);

void main() {
  test('each account: both windows and their resets, a full one first says until when, an old read says when it was taken', () {
    expect(quotaLines(_q('a'), _now), ['5 שעות ${_p(17)}, מתאפס 17:00', 'שבועי ${_p(71)}, מתאפס שבת 24/10 06:00']);
    expect(quotaLines(_q('a', week: 100, full: true, reopens: DateTime(2026, 10, 21, 6, 59)), _now),
        ['חסום עד מחר 06:59', '5 שעות ${_p(17)}, מתאפס 17:00', 'שבועי ${_p(100)}, מתאפס שבת 24/10 06:00']);
    expect(quotaLines(_q('a', full: true), _now).first, 'חסום');
    expect(quotaLines(_q('a', usable: false), _now), ['לא מחובר']);
    expect(quotaLines(_q('a', measured: const Duration(hours: 2)), _now).last, 'נמדד 12:06');
  });

  test('the quota comes and goes with the recipe JSON (the cache keeps it)', () {
    final r = HomeRecipe.fromJson({'version': 1, 'composed_by': 'hq', 'composed_at': 0, 'blocks': [], 'quota': [
      {'name': 'hive-owner', 'label': 'hive-owner', 'usable': true, 'full': true, 'reopens_at': 1000, 'five_hour_pct': 0, 'seven_day_pct': 100,
        'five_hour_resets_at': null, 'seven_day_resets_at': 1000, 'snapshot_at': 500},
    ]});
    expect(r.quota.single.full, isTrue);
    expect(r.quota.single.sevenDay, 100);
    expect(HomeRecipe.fromJson(r.toJson()).quota.single.reopensAt, DateTime.fromMillisecondsSinceEpoch(1000));
    expect(HomeRecipe.fromJson({'version': 1, 'blocks': []}).quota, isEmpty, reason: 'an older hq');
  });

  CompanyData data() => mapSnapshot(board: const [], inbox: const [], asks: const [], toggles: const [], now: kDemoNow);

  testWidgets('with room the card is at the end and folds with the home; all full, it is under the sentence and stays folded', (tester) async {
    final open = _recipe([_q('החשבון הראשי'), _q('hive-owner', week: 100, full: true, reopens: DateTime(2026, 10, 21, 13, 59))]);
    await pumpApp(tester, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: open)])));
    expect(find.byType(QuotaCard), findsOneWidget);
    expect(find.text('חסום עד מחר 13:59'), findsOneWidget);
    await pumpApp(tester, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: open, folded: true)])));
    await tester.pumpAndSettle(); // the card folds away with the rest
    expect(find.byType(QuotaCard), findsNothing);

    final down = _recipe([
      _q('החשבון הראשי', week: 100, full: true, reopens: DateTime(2026, 10, 24, 6)),
      _q('hive-owner', five: 0, week: 100, full: true, reopens: DateTime(2026, 10, 21, 13, 59)),
    ]);
    await pumpApp(tester, size: const Size(360, 1600), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: down, folded: true)])));
    expect(find.byType(QuotaCard), findsOneWidget);
  });

  for (final dark in [false, true]) {
    testWidgets('golden: the card, one account full (${dark ? 'dark' : 'light'})', (tester) async {
      final r = _recipe([_q('החשבון הראשי', five: 2, week: 2), _q('hive-owner', five: 0, week: 100, full: true, reopens: DateTime(2026, 10, 21, 13, 59))]);
      await pumpApp(tester, dark: dark, size: const Size(360, 900), home: Scaffold(body: ListView(children: [HomeV2(data: data(), now: _now, recipe: r)])));
      await expectLater(find.byType(Scaffold).first, matchesGoldenFile('goldens/home_quota/card-${dark ? 'dark' : 'light'}.png'));
    });
  }
}
