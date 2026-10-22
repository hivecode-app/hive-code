// "משאבים": a card for each machine with its numbers and a word, who holds it by project ("לא מזוהה" always a row), who
// waits and for whom, the leases on a tap; a part that was not read says so; it opens from "סטטוס".
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/model/resources.dart';
import 'package:agent_company/ui/resources/resources_screen.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

Widget _screen([Future<ResourcesView?> Function()? load]) => ResourcesScreen(load: load ?? () async => demoResources());

void main() {
  test('the words: memory, CPU and disk by their thresholds', () {
    MachineRes m({double? used, double? load, int? disk}) => MachineRes(
          name: 'x', label: 'x', measured: true, memTotalMb: 1000, memUsedMb: used, load1: load, cpus: 4, diskPct: disk, diskFreeMb: 1);
    expect(m(used: 700).memory!.word, 'תקין');
    expect(m(used: 800).memory!.word, 'עמוס');
    expect(m(used: 950).memory!.warn, isTrue);
    expect(m(load: 1.0).cpu!.word, 'שקט');
    expect(m(load: 2.0).cpu!.word, 'עמוס');
    expect(m(load: 4.0).cpu!.word, 'עמוס מאוד');
    expect(m(disk: 80).disk!.warn, isFalse);
    expect(m(disk: 88).disk!.word, 'מתמלא');
    expect(m(disk: 95).disk!.word, 'כמעט מלא');
    expect(m().memory, isNull, reason: 'not read is not a word');
  });

  test('names and errors he can read', () {
    expect(const Unidentified(name: 'system.slice/gradle.service', memMb: 1).readable, 'gradle (בנייה)');
    expect(const Unidentified(name: 'system.slice/docker-0123456789abcdef.scope', memMb: 1).readable, 'קונטיינר docker');
    expect(const Unidentified(name: 'system.slice/foo.service', memMb: 1).readable, 'foo');
    expect(const MachineRes(name: 'x', label: 'x', measured: false, error: 'ssh timeout').errorWords, 'השרת לא ענה');
    expect(const MachineRes(name: 'x', label: 'x', measured: false, error: 'אין קריאה חדשה מ-12:00:00').errorWords, 'אין קריאה חדשה מ-12:00:00');
  });

  testWidgets('a card for each machine, with numbers and words, and "לא מזוהה" with what is in it', (tester) async {
    await pumpApp(tester, home: _screen(), size: const Size(342, 2400));
    await tester.pump();
    await tester.pump();
    expect(findShown('hq-host'), findsOneWidget);
    expect(findShown('17.0 מתוך 22.9GB'), findsOneWidget);
    expect(findShown('עומס 3.2 על 8 ליבות'), findsOneWidget);
    expect(findShown('71% מלא'), findsOneWidget);
    expect(findShown('לומו'), findsWidgets);
    expect(find.byKey(const ValueKey('unidentified')), findsNWidgets(2), reason: 'every machine that was read has the row, even with nothing in it; one that was not read does not say "אין"');
    expect(findShown('gradle (בנייה) 7.0GB'), findsOneWidget);
    expect(findShown('system.slice/gradle.service'), findsOneWidget, reason: 'the full name stays under it');
    expect(findShown('לא נמדד: docker'), findsOneWidget);
    expect(findShown('אין קריאה עדכנית: השרת לא ענה'), findsOneWidget, reason: 'a machine that was not read says it, without the code');
    expect(findShown('ssh timeout'), findsNothing);
    expect(find.text('מתמלא'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('who waits, for whom and in how long; the leases on a tap', (tester) async {
    await pumpApp(tester, home: _screen(), size: const Size(342, 2400));
    await tester.pump();
    await tester.pump();
    expect(findShown('תיקון דחוף בשרת'), findsOneWidget);
    expect(findShown('צרכן לא מזוהה מחזיק 7.0GB, ומתפנה בעוד כ-12 דקות.'), findsOneWidget);
    expect(findShown("מחכה 4 דק'"), findsOneWidget);
    expect(findShown('צריך 8.0GB. ה-build של לומו (משימה 351) מחזיק אותם, ומסתיים בעוד כ-14 דקות.'), findsOneWidget);
        expect(findShown('build של לומו (משימה 351)').evaluate().length, 1, // only inside the queued lease's sentence
        reason: 'the open leases are folded');
    expect(findShown('רץ 12 דק'), findsNothing, reason: 'the open leases are folded');
    await tester.tap(findShown('הזמנה פעילה אחת'));
    await tester.pump();
    expect(findShown('build של לומו (משימה 351)').evaluate().length, 2);
    expect(findShown("רץ 12 דק'"), findsOneWidget);
    expect(findShown('8.0GB · נשאר כ-14 דקות · APK'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a task without an honest estimate says so', (tester) async {
    final v = ResourcesView.fromJson({
      'machines': [
        {'name': 'local', 'label': 'a', 'measured': true, 'unmeasured': <String>[], 'holders': <Object>[], 'unidentified': <Object>[]},
      ],
      'waiting': [
        {'task': 5, 'title': 'משהו', 'waiting_min': 2, 'waiting_for': 'לומו מחזיק 6.1GB', 'eta_min': null},
      ],
      'leases': <Object>[],
    });
    await pumpApp(tester, home: _screen(() async => v));
    await tester.pump();
    await tester.pump();
    expect(findShown('לומו מחזיק 6.1GB. אין הערכה למתי יתפנה.'), findsOneWidget);
    expect(findShown('אין הזמנות פעילות'), findsOneWidget);
  });

  testWidgets('hq does not answer: a sentence and a retry; then it loads', (tester) async {
    var calls = 0;
    await pumpApp(tester, home: _screen(() async => ++calls == 1 ? null : demoResources()));
    await tester.pump();
    await tester.pump();
    expect(find.text('לא הצלחתי לטעון את המשאבים.'), findsOneWidget);
    await tester.tap(find.text('לנסות שוב'));
    await tester.pump();
    await tester.pump();
    expect(findShown('hq-host'), findsOneWidget);
  });

  for (final dark in [false, true]) {
    testWidgets('no overflow at double text size on a phone (${dark ? 'dark' : 'light'})', (tester) async {
      await pumpApp(tester, home: _screen(), dark: dark, textScale: 2.0);
      await tester.pump();
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  }

  for (final dark in [false, true]) {
    final t = dark ? 'dark' : 'light';
    testWidgets('golden: the screen on a phone ($t)', (tester) async {
      await pumpApp(tester, home: _screen(), dark: dark, size: const Size(342, 1500));
      await tester.pump();
      await tester.pump();
      await tester.tap(findShown('הזמנה פעילה אחת'));
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/resources/resources-phone-$t.png'));
    });
  }

  testWidgets('"סטטוס" opens it', (tester) async {
    await pumpApp(tester, home: const Scaffold(body: StatusScreen()));
    await tester.pump();
    await tester.tap(find.byTooltip('משאבים'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();
    expect(find.byType(ResourcesScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
