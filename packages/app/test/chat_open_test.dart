// The open chat must stay put while things happen: opening it fetches once (not on every store
// change), and a question card sits where it was asked, so new messages appear below it.
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

class _CountingBackend extends FakeBackend {
  _CountingBackend() : super(simulate: false, now: DateTime(2026, 10, 20, 14, 6));
  final opened = <String>[];
  @override
  Future<void> openConversation(String identityId) async => opened.add(identityId);
}

void main() {
  testWidgets('opening a chat fetches it once, not on every change', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({'language': 'he'});
    tester.view.physicalSize = kPhone * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final backend = _CountingBackend();
    final store = AppStore(backend);
    await store.start();
    await tester.pumpWidget(CompanyApp(store: legacyStore(store), themeMode: ThemeMode.light, home: const ChatScreen(identityId: 'ido')));
    await tester.pump();
    for (var i = 0; i < 10; i++) {
      store.touch();
      await tester.pump();
    }
    expect(backend.opened, ['ido']);
  });

  testWidgets('switching the conversation in place (desktop) opens the new one', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({'language': 'he'});
    tester.view.physicalSize = kPhone * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final backend = _CountingBackend();
    final store = AppStore(backend);
    await store.start();
    final who = ValueNotifier('ido');
    await tester.pumpWidget(CompanyApp(
      store: legacyStore(store),
      themeMode: ThemeMode.light,
      home: Scaffold(body: ValueListenableBuilder<String>(valueListenable: who, builder: (_, id, _) => ChatScreen(identityId: id, embedded: true))),
    ));
    await tester.pump();
    who.value = 'dana';
    await tester.pump();
    expect(backend.opened, ['ido', 'dana']);
  });

  test('messages between workers lose their internal ids', () {
    expect(withoutIds('שלחתי לרן request_go על PR #35 (מזהה agent-company-t5-2:mvfww7y1-010ec676ca): מה נכנס'),
        'שלחתי לרן request_go על PR #35: מה נכנס');
    expect(withoutIds('הודעה yoav-2:mvg0dd7p-0z0ba93427 נמסרה'), 'הודעה נמסרה');
    expect(withoutIds('PR #35 מוזג'), 'PR #35 מוזג');
  });

  test('a question card keeps the time it was asked', () {
    final inbox = [
      {'id': 7, 'kind': 'ask', 'state': 'open', 'blocking': true, 'from_identity': 'yoav', 'title': 'q', 'body': '', 'ref': 'a1', 'created_at': DateTime(2026, 10, 20, 9, 30).millisecondsSinceEpoch},
    ];
    final asks = [
      {'id': 'a1', 'question': 'מה לעשות?', 'options': ['כן', 'לא']},
    ];
    final d = mapSnapshot(board: const [], inbox: inbox, asks: asks, toggles: const []);
    expect(d.waiting.single.createdAt, DateTime(2026, 10, 20, 9, 30));
  });
}
