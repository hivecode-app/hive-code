// Coming online must not move the screen (APP-SPEC §4.2, §7.5): "מתעדכן" shows next to the title,
// not as a strip that pushes the content down and then pulls it back up.
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

class _LinkBackend extends FakeBackend {
  _LinkBackend() : super(simulate: false, now: DateTime(2026, 10, 20, 14, 6));
  SystemStatus link = const SystemStatus(LinkState.connecting);
  @override
  SystemStatus get status => link;
  void set(LinkState s) {
    link = SystemStatus(s, updated: 3);
    notifyListeners();
  }
}

void main() {
  testWidgets('connecting shows next to the title and nothing below it moves', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({'language': 'he'});
    tester.view.physicalSize = kPhone * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final backend = _LinkBackend();
    final store = AppStore(backend);
    await store.start();
    await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: ThemeMode.light, home: const Scaffold(body: StatusScreen())));
    await tester.pump();

    final first = find.text('מחכה לך').first;
    final y0 = tester.getTopLeft(first).dy;
    expect(find.text('מתעדכן'), findsNothing, reason: 'not before half a second');
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('מתעדכן'), findsOneWidget);
    expect(tester.getTopLeft(first).dy, y0);

    backend.set(LinkState.online);
    await tester.pump(); // rebuilds and starts the 150ms fade
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(); // the faded-out child leaves on the next frame
    expect(find.text('מתעדכן'), findsNothing);
    expect(tester.getTopLeft(first).dy, y0, reason: 'the list did not jump when the link came up');

    backend.set(LinkState.reconnected);
    await tester.pump(); // rebuilds and starts the 150ms fade
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(); // the faded-out child leaves on the next frame
    expect(find.text('עודכן'), findsOneWidget);
    expect(tester.getTopLeft(first).dy, y0);
  });
}
