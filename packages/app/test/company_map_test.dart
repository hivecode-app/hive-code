// The company map: the layout keeps everyone in place, lines merge past twelve, his lines are told by weight, faces
// hold 3:1 against the background at half strength, the replay runs a day and stops, a line's text is loaded when
// touched, and the screen opens from "סטטוס". Goldens: the map, the replay, the tables, light and dark, desktop and
// a phone on its side (goldens/company_map/).
import 'package:agent_company/data/demo_map.dart';
import 'package:agent_company/model/map_day.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:agent_company/ui/company_map/map_ink.dart';
import 'package:agent_company/ui/company_map/map_screen.dart';
import 'package:agent_company/ui/company_map/map_stats.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

const _h = 3600000;
const _day = '2026-10-20';
const _desktop = Size(1440, 900);
const _phoneSide = Size(844, 390);

MapDay _small() => MapDay.fromJson({
      'day': _day,
      'upTo': kDayMs,
      'teams': [
        {'id': 'management', 'name': 'הנהלה', 'symbol': 'account_tree', 'tone': 'slate', 'lead': 'yoav', 'project': null},
        {'id': 'lumo', 'name': 'לומו', 'symbol': 'forum', 'tone': 'teal', 'lead': 'dana', 'project': 'lumo'},
      ],
      'people': [
        {'id': 'owner', 'name': 'רן', 'mono': 'עק', 'team': 'management', 'role': 'owner'},
        {'id': 'hq', 'name': 'hq', 'mono': '', 'team': 'management', 'role': 'system'},
        {'id': 'yoav', 'name': 'יואב', 'mono': 'יו', 'team': 'management', 'role': 'lead'},
        {'id': 'dana', 'name': 'דנה', 'mono': 'דנ', 'team': 'lumo', 'role': 'lead'},
        {'id': 'lumo-t1', 'name': 'עומר', 'mono': 'עו', 'team': 'lumo', 'role': 'task'},
        {'id': 'lumo-t2', 'name': 'שקד', 'mono': 'שק', 'team': 'lumo', 'role': 'task'},
        {'id': 'lumo-t3', 'name': 'אסף', 'mono': 'אס', 'team': 'lumo', 'role': 'task'},
      ],
      'presence': [
        {'id': 'lumo-t1', 'from': 1 * _h, 'to': 3 * _h},
        {'id': 'lumo-t2', 'from': 2 * _h, 'to': 4 * _h},
        {'id': 'lumo-t3', 'from': 5 * _h, 'to': 6 * _h},
      ],
      'messages': [
        {'id': 'a', 't': 1 * _h + 60000, 'f': 'dana', 'to': 'lumo-t1', 'k': 'tell'},
        {'id': 'b', 't': 2 * _h, 'f': 'owner', 'to': 'dana', 'k': 'tell'},
      ],
      'marks': [
        {'t': 3 * _h, 'k': 'task', 'label': 'x', 'project': 'lumo'},
        {'t': 4 * _h, 'k': 'merge', 'label': 'y', 'project': 'lumo', 'repo': 'lumo-app'},
      ],
      'stats': {
        'projects': [
          {'project': 'lumo', 'opened': 3, 'done': 1, 'open': 2},
        ],
        'workers': [
          {'id': 'dana', 'in': 1, 'out': 1, 'asked': 1, 'answered': 1, 'answerMs': 30000, 'workMs': 2 * _h, 'hourly': List.filled(24, 0.1)},
        ],
        'estimates': [
          {'kind': 'feature', 'n': 2, 'onTime': 1, 'late': 1, 'open': 0, 'ratio': 0.5},
        ],
      },
    });

/// The minute of the afternoon and evening with the most lines alive at once: the busy moment the goldens stop on.
int _busiest(MapDay d) {
  final life = (kLineLife.inMilliseconds * kDayMs / kReplay.inMilliseconds).round();
  var best = 0, at = 0;
  for (var t = 14 * _h; t < 22 * _h; t += 60000) {
    final n = d.messages.skip(d.msgIndex(t - life)).takeWhile((m) => m.t <= t).length;
    if (n > best) {
      best = n;
      at = t;
    }
  }
  return at;
}

Widget _screen(MapDay day, {int? at, bool play = false, String? open, Future<MapBody?> Function(String)? body}) => CompanyMapScreen(
      load: (_) async => day,
      loadBody: body ?? (id) async => demoMapBody(id),
      date: day.day,
      at: at,
      play: play,
      open: open,
    );

void main() {
  test('a satellite keeps its slot, and a slot is reused only after its holder left', () {
    final l = MapLayout(_small());
    expect(l.pos['lumo-t1'], isNot(l.pos['lumo-t2'])); // overlapping in time
    expect(l.pos['lumo-t3'], l.pos['lumo-t1']); // came after t1 left
    expect(l.alpha('lumo-t1', 2 * _h), 1);
    expect(l.alpha('lumo-t1', 8 * _h), 0);
    expect(l.alpha('dana', 8 * _h), 1);
  });

  test('a wide short screen spreads the teams along it, and the circles stay the size they are', () {
    expect(mapCanvas(const Size(1200, 660)), kMapSize);
    final side = mapCanvas(const Size(844, 270));
    expect(side.height, 660);
    expect(side.width, greaterThan(1800));
    final rest = MapLayout(_small()), wide = MapLayout(_small(), side);
    expect(wide.pos['dana']!.dx, greaterThan(rest.pos['dana']!.dx));
    expect(wide.pos['dana']!.dy, rest.pos['dana']!.dy);
    expect((wide.pos['lumo-t1']! - wide.pos['dana']!).distance, (rest.pos['lumo-t1']! - rest.pos['dana']!).distance, reason: 'the rings do not stretch');
    final tall = mapCanvas(const Size(390, 500));
    expect(tall.width, 1200);
    expect(tall.height, greaterThan(660));
  });

  test('lines: one each up to twelve; more, and each pair has one, thicker; his by weight', () {
    MapMsg m(String id, int t, String f, String to) => MapMsg(id, t, f, to, 'tell');
    List<(MapMsg, double)> live(int n, {String f = 'dana', String to = 'yoav'}) => [for (var i = 0; i < n; i++) (m('$i', i, i.isEven ? f : to, i.isEven ? to : f), i / 20)];
    expect(segments(live(12)).length, 12);
    final merged = segments([...live(10), ...live(5, f: 'owner', to: 'dana')]);
    expect(merged.length, 2, reason: 'two pairs');
    final pair = merged.firstWhere((s) => s.m.from == 'dana' || s.m.to == 'dana');
    expect(pair.n, 10);
    expect(pair.width(false), 3, reason: '1 + 9 x 0.75, held at 3 for the rest');
    final his = merged.firstWhere((s) => s.m.from == 'owner' || s.m.to == 'owner');
    expect([his.n, his.width(true)], [5, 4]);
    expect(MapSeg(m('x', 0, 'owner', 'dana'), 1, 0).width(true), 2);
    expect(MapSeg(m('x', 0, 'yoav', 'dana'), 1, 0).width(false), 1);
    expect(MapSeg(m('x', 0, 'owner', 'dana'), 2, 0).width(true), 2.75);
    expect(MapSeg(m('x', 0, 'yoav', 'dana'), 2, 0).width(false), 1.75);
    expect(merged.map((s) => s.age).reduce((a, b) => a < b ? a : b), 0, reason: 'a merged line is as young as its newest message');
  });

  test('faces hold 3:1 against the background in every tone, light and dark, and the letter reads on the fill', () {
    for (final b in [Brightness.light, Brightness.dark]) {
      final p = Palette.of(b);
      for (final tone in [...kTones.keys, null]) {
        expect(contrast(faceRing(p, tone), p.bg), greaterThanOrEqualTo(kFaceContrast), reason: '$tone on ${b.name}');
        expect(contrast(tone == null ? p.text : p.identity(tone).$2, faceFill(p, tone)), greaterThanOrEqualTo(4.5), reason: 'the letter on $tone, ${b.name}');
      }
    }
  });

  testWidgets('the replay plays the whole day in 20 seconds and stops', (tester) async {
    await pumpApp(tester, size: _desktop, home: _screen(_small(), at: 0));
    await tester.pump();
    expect(find.text('המפה של החברה'), findsOneWidget);
    await tester.tap(find.byTooltip('הפעלה'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 10));
    expect(find.text('12:00'), findsOneWidget);
    await tester.pump(const Duration(seconds: 11));
    expect(find.text('24:00'), findsOneWidget);
    expect(find.text('היום: משימה אחת, מיזוג אחד, 0 פריסות'), findsOneWidget);
    expect(find.byTooltip('הפעלה'), findsOneWidget); // stopped by itself
    await tester.pumpAndSettle();
  });

  testWidgets('touching a line loads its text on its own; a failure says so and tries again', (tester) async {
    var calls = 0;
    await pumpApp(tester, size: _desktop, home: _screen(_small(), at: 2 * _h + 1000, open: 'b', body: (id) async => ++calls == 1 ? null : const MapBody('b', 'מה המצב בפרויקט?')));
    await tester.pump();
    await tester.pump();
    expect(find.text('לא הצלחתי לטעון את ההודעה.'), findsOneWidget);
    expect(find.text('מה המצב בפרויקט?'), findsNothing);
    await tester.tap(find.text('לנסות שוב'));
    await tester.pump();
    await tester.pump();
    expect(find.text('מה המצב בפרויקט?'), findsOneWidget);
    expect(calls, 2);
  });

  testWidgets('the days: back one day asks hq for it, and a day that fails says so', (tester) async {
    final asked = <String>[];
    await pumpApp(
      tester,
      size: _desktop,
      home: CompanyMapScreen(
        load: (d) async {
          asked.add(d);
          return d == '2026-10-19' ? null : _small();
        },
        loadBody: (id) async => null,
        date: _day,
      ),
    );
    await tester.pump();
    expect(find.byTooltip('היום הבא'), findsNothing, reason: 'that day is today (the demo clock): nothing after it');
    await tester.tap(find.byTooltip('היום הקודם'));
    await tester.pump();
    await tester.pump();
    expect(asked, [_day, '2026-10-19']);
    expect(find.text('לא הצלחתי לטעון את היום.'), findsOneWidget);
    await tester.tap(find.text('לנסות שוב'));
    await tester.pump();
    await tester.pump();
    expect(asked.last, '2026-10-19');
  });

  testWidgets('"סטטוס" opens the map', (tester) async {
    await pumpApp(tester, home: const Scaffold(body: StatusScreen()));
    await tester.pump();
    await tester.tap(find.byTooltip('המפה של החברה'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();
    expect(find.byType(CompanyMapScreen), findsOneWidget);
    expect(find.byTooltip('הפעלה'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  final day = demoMapDay(_day);
  for (final dark in [false, true]) {
    final t = dark ? 'dark' : 'light';

    testWidgets('golden: the map at a busy moment, desktop ($t)', (tester) async {
      await pumpApp(tester, size: _desktop, dark: dark, home: _screen(day, at: _busiest(day)));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/company_map/map-desktop-$t.png'));
    });

    testWidgets('golden: the map on a phone on its side ($t)', (tester) async {
      await pumpApp(tester, size: _phoneSide, dark: dark, home: _screen(day, at: _busiest(day)));
      await tester.pump();
      expect(tester.takeException(), isNull);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/company_map/map-phone-$t.png'));
    });

    testWidgets('golden: a line opened, with its text ($t)', (tester) async {
      final at = _busiest(day);
      final id = day.messages.lastWhere((m) => m.t <= at && (m.from == 'owner' || m.to == 'owner')).id;
      await pumpApp(tester, size: _desktop, dark: dark, home: _screen(day, at: at, open: id));
      await tester.pump();
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/company_map/line-open-$t.png'));
    });

    testWidgets('golden: the replay halfway, a quiet hour ($t)', (tester) async {
      await pumpApp(tester, size: _desktop, dark: dark, home: _screen(day, at: 13 * _h + 30 * 60000));
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/company_map/replay-midway-$t.png'));
    });

    testWidgets('golden: the tables ($t)', (tester) async {
      await pumpApp(tester, size: const Size(1440, 1000), dark: dark, home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.only(top: 24), child: MapStats(day: day)))));
      await tester.pump();
      expect(find.text('כמה זמן לקח לענות לך'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/company_map/tables-$t.png'));
    });
  }

  testWidgets('golden: the tables on a phone on its side', (tester) async {
    await pumpApp(tester, size: const Size(844, 1700), home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.only(top: 24), child: MapStats(day: day)))));
    await tester.pump();
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/company_map/tables-phone.png'));
  });
}
