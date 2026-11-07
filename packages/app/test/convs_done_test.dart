// #40: a finished task worker's conversation says "הושלם" (check_circle and the word), shows the task it
// did as its second line, and sits below every live conversation; every row says which team it is in.
// ignore_for_file: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/product/chats.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  Future<void> finish(WidgetTester tester, AppStore store, String id, String task) async {
    store.data!.presence[id] = Presence(status: WorkerStatus.done, activity: task);
    // What it still asks him would win the third line ("מחכה לך"): finished and asking nothing.
    store.data!.waiting.removeWhere((w) => w.from == id);
    store.notifyListeners();
    await tester.pump();
  }

  double rowY(WidgetTester tester, String name) => tester.getTopLeft(find.text(name).first).dy;

  testWidgets('wide screen: a finished task worker with unread lines goes below the live ones, marked "הושלם"', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    // Ido is first after Yoav in the demo, with 2 unread: done, he stays in the list (not folded), at its end.
    expect(rowY(tester, 'עידו'), lessThan(rowY(tester, 'רותם')));
    await finish(tester, store, 'ido', 'חידוש כרטיס שנדחה');
    for (final live in ['יואב', 'רותם', 'דנה']) {
      expect(rowY(tester, 'עידו'), greaterThan(rowY(tester, live)), reason: live);
    }
    final row = find.ancestor(of: find.text('עידו'), matching: find.byType(InkWell)).first;
    expect(find.descendant(of: row, matching: find.textContaining('הושלם')), findsOneWidget);
    // The icon is check_circle (company.md: הושלם), never a colour.
    final icons = find.descendant(of: row, matching: find.byType(Ic)).evaluate().map((e) => (e.widget as Ic).name).toList();
    expect(icons, contains('check_circle'));
  });

  testWidgets('the desktop list does not fold: finished ones are still last', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    await finish(tester, store, 'noa', 'נגן ב-web');
    await finish(tester, store, 'ido', 'חידוש כרטיס');
    final names = [for (final c in store.data!.conversations) store.data!.who(c.identityId).name];
    final ys = {for (final n in names) n: rowY(tester, n)};
    final lastLive = ys.entries.where((e) => e.key != 'נועה' && e.key != 'עידו').map((e) => e.value).reduce((a, b) => a > b ? a : b);
    expect(ys['נועה']!, greaterThan(lastLive));
    expect(ys['עידו']!, greaterThan(lastLive));
  });

  testWidgets('every row says the team: a task worker shows its project, not its task id', (tester) async {
    await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    // The phone's row (task 290): the name, then "· team".
    expect(findShown('· לומו'), findsWidgets);
    expect(findShown('· הנהלה'), findsOneWidget);
    expect(findShown('t3711'), findsNothing);
  });
}
