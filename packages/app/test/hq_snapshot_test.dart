// Every screen renders an hq snapshot (test/fixtures/samples/hq/*.json: the shape the live hq returned on
// 20/10/2026, with invented projects, titles and messages) without throwing.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

class SnapshotBackend extends FakeBackend {
  SnapshotBackend(this.snapshot) : super(simulate: false);
  final CompanyData snapshot;
  @override
  CompanyData? get data => snapshot;
  @override
  SystemStatus get status => const SystemStatus(LinkState.online);
  @override
  Future<void> start() async => notifyListeners();
}

List<Map<String, dynamic>> _load(String name, String key) =>
    (jsonDecode(File('test/fixtures/samples/hq/$name.json').readAsStringSync())[key] as List).cast<Map<String, dynamic>>();

void main() {
  for (final size in [kPhone, const Size(1440, 860)]) {
    testWidgets('hq snapshot renders on every tab (${size.width.toInt()}px)', (tester) async {
      await loadFonts();
      Motion.frozen = true;
      SharedPreferences.setMockInitialValues({'language': 'he', 'new_interface': false});
      tester.view.physicalSize = size * 2;
      tester.view.devicePixelRatio = 2;
      addTearDown(tester.view.reset);
      final d = mapSnapshot(board: _load('board', 'identities'), inbox: _load('inbox', 'items'), asks: _load('asks', 'asks'), toggles: _load('toggles', 'toggles'),
          tasks: _load('board', 'tasks'), projects: _load('board', 'projects'));
      final store = AppStore(SnapshotBackend(d));
      await store.start();
      await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: ThemeMode.light));
      await tester.pump();
      final ctx = tester.element(find.byType(Scaffold).first);
      for (final t in AppTab.values) {
        NavScope.read(ctx).go(t);
        await tester.pump();
        expect(tester.takeException(), isNull, reason: 'tab $t');
      }
      // Projects come from hq (org.yaml), by the owner's names, never from names written in the code.
      NavScope.read(ctx).go(AppTab.projects);
      await tester.pump();
      expect(find.text('טיקיבוט'), findsNothing);
      store.selectedConversation = 'yoav';
      Nav.chat(ctx, 'yoav');
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'chat');
    });
  }
}
