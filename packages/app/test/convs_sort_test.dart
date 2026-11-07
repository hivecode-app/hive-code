// The desktop conversation list can be ordered (owner, 20/10): newest message (the default), working ones
// on top, waiting-for-you on top, or by name. Yoav stays pinned and finished ones stay last; the choice
// stays on this device across restarts. The phone's main screen has its own order since #53 (layout_test).
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:agent_company/ui/product/chats.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

void main() {
  const shown = ['יואב', 'עידו', 'רותם', 'דנה', 'נועה', 'איתי', 'עמית', 'נגה', 'אלי'];

  List<String> order(WidgetTester tester) {
    final ys = {for (final n in shown) n: tester.getTopLeft(find.text(n).first).dy};
    return [...shown]..sort((a, b) => ys[a]!.compareTo(ys[b]!));
  }

  Future<void> pick(WidgetTester tester, String label) async {
    await tester.tap(find.byTooltip('מיון'));
    await tester.pumpAndSettle();
    await tester.tap(find.text(label));
    await tester.pumpAndSettle();
  }

  List<String> names(AppStore s, ConvSort sort) {
    final d = s.data!;
    return [for (final c in sortConversations(d, d.conversations, sort)) d.who(c.identityId).name];
  }

  testWidgets('the default is the newest message, as before', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    expect(store.convSort, ConvSort.recent);
    expect(order(tester), shown);
  });

  testWidgets('"עובדים עכשיו למעלה": working ones first, each group by newest message, Yoav pinned', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    await pick(tester, 'עובדים עכשיו למעלה');
    expect(store.convSort, ConvSort.working);
    expect(order(tester), ['יואב', 'דנה', 'נועה', 'נגה', 'עידו', 'רותם', 'איתי', 'עמית', 'אלי']);
    // Live: one that starts working moves up, among the working ones by its last message.
    store.data!.presence['itai'] = const Presence(status: WorkerStatus.working);
    store.notifyListeners();
    await tester.pump();
    expect(order(tester), ['יואב', 'דנה', 'נועה', 'איתי', 'נגה', 'עידו', 'רותם', 'עמית', 'אלי']);
  });

  testWidgets('"מחכה לך למעלה" and "לפי שם"', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    await pick(tester, 'מחכה לך למעלה');
    expect(order(tester), ['יואב', 'עידו', 'רותם', 'עמית', 'דנה', 'נועה', 'איתי', 'נגה', 'אלי']);
    await pick(tester, 'לפי שם');
    expect(order(tester), ['יואב', 'איתי', 'אלי', 'דנה', 'נגה', 'נועה', 'עידו', 'עמית', 'רותם']);
    expect(names(store, ConvSort.name).first, 'יואב');
  });

  testWidgets('a finished one stays last under any order', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    store.data!.presence['noa'] = const Presence(status: WorkerStatus.done, activity: 'נגן ב-web');
    await pick(tester, 'לפי שם');
    final ys = {for (final n in shown) n: tester.getTopLeft(find.text(n).first).dy};
    for (final n in shown.where((n) => n != 'נועה')) {
      expect(ys['נועה']!, greaterThan(ys[n]!), reason: n);
    }
  });

  testWidgets('the sheet marks the current choice with a check, and the choice is saved', (tester) async {
    final store = await pumpApp(tester, size: const Size(342, 1600), home: const Scaffold(body: ProductChats(compact: true)));
    await pick(tester, 'עובדים עכשיו למעלה');
    expect((await SharedPreferences.getInstance()).getString(AppStore.kConvSortKey), 'working');
    await tester.tap(find.byTooltip('מיון'));
    await tester.pumpAndSettle();
    final row = find.ancestor(of: find.text('עובדים עכשיו למעלה'), matching: find.byType(ListTile));
    final check = find.byWidgetPredicate((w) => w is Ic && w.name == 'check');
    expect(find.descendant(of: row, matching: check), findsOneWidget);
    expect(check, findsOneWidget);
    expect(store.convSort, ConvSort.working);
  });

  test('after a restart the saved order comes back; an unknown value falls back to the default', () async {
    SharedPreferences.setMockInitialValues({AppStore.kConvSortKey: 'working'});
    final a = AppStore(FakeBackend(simulate: false, now: DateTime(2026, 10, 20, 14, 6)));
    await a.start();
    expect(a.convSort, ConvSort.working);
    a.setConvSort(ConvSort.name);
    final b = AppStore(FakeBackend(simulate: false, now: DateTime(2026, 10, 20, 14, 6)));
    await b.start();
    expect(b.convSort, ConvSort.name);

    SharedPreferences.setMockInitialValues({AppStore.kConvSortKey: 'nonsense'});
    final c = AppStore(FakeBackend(simulate: false, now: DateTime(2026, 10, 20, 14, 6)));
    await c.start();
    expect(c.convSort, ConvSort.recent);
  });
}
