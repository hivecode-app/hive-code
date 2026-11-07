import 'package:agent_company/data/upload_files.dart';

import 'dart:async';

import 'package:agent_company/theme/icons.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/home_v2.dart' show HomeV2;
import 'package:agent_company/ui/product/approval.dart';
import 'package:agent_company/ui/product/chats.dart';
import 'package:agent_company/ui/product/product_theme.dart';
import 'package:agent_company/data/search.dart';
import 'package:agent_company/l10n/app_localizations.dart';
import 'package:agent_company/model/task_progress.dart';
import 'package:agent_company/ui/product/search_screen.dart';
import 'package:agent_company/ui/product/settings.dart';
import 'package:agent_company/ui/product/notifications_settings.dart';
import 'package:agent_company/ui/settings/settings_screen.dart' show AccountSwitch;
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/ui/product/shell.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart' show loadFonts, pinClock, kDemoNow;

Future<AppStore> productApp(
  WidgetTester tester, {
  String language = 'en',
  bool dark = false,
  bool settle = true,
  double scale = 1,
  Size size = const Size(390, 844),
  Widget? home,
  FakeBackend? backend,
  void Function(AppStore)? prepare,
}) async {
  await loadFonts();
  Motion.frozen = true;
  pinClock(kDemoNow);
  SharedPreferences.setMockInitialValues({'language': language});
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.reset);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  final store = AppStore(backend ?? FakeBackend(simulate: false, now: kDemoNow), uploadFiles: MemoryUploadFiles());
  await store.start();
  prepare?.call(store);
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light, home: home));
  if (settle) await tester.pumpAndSettle();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox.shrink());
    store.dispose();
    store.backend.dispose();
  });
  return store;
}

WaitItem releaseItem() => WaitItem(
  id: 'release',
  kind: WaitKind.go,
  from: 'dana',
  askId: 'release',
  time: '10:42',
  kicker: 'Map fix',
  headline: 'the map crash fix',
  action: 'release',
  body: 'What changes for users: The map opens normally.\nRisk: Low. Map screen only.\nIf there is a problem: Restore the previous release.\nWhat was checked: Automated tests and review passed.',
);

class OfflineBackend extends FakeBackend {
  OfflineBackend() : super(simulate: false, now: kDemoNow);
  @override
  SystemStatus get status => const SystemStatus(LinkState.offline, since: '10:52');
}

class SlowBackend extends FakeBackend {
  SlowBackend(this.ready) : super(simulate: false, now: kDemoNow);
  final Completer<void> ready;
  @override
  Future<void> start() async {
    await ready.future;
    await super.start();
  }
}

class FailedStartupBackend extends FakeBackend {
  FailedStartupBackend() : super(simulate: false, now: kDemoNow);
  int starts = 0;
  @override
  Future<void> start() async {
    if (starts++ == 0) throw StateError('startup unavailable');
    await super.start();
  }
}

void main() {
  testWidgets('English is default; switching language mirrors the whole live route and persists', (tester) async {
    final store = await productApp(tester, home: const Scaffold(body: ProductSettings(embedded: true)));
    expect(find.text('Language'), findsOneWidget);
    final ctx = tester.element(find.byType(ProductSettings));
    expect(Directionality.of(ctx), TextDirection.ltr);
    await store.preferences.setLanguage('he');
    await tester.pumpAndSettle();
    expect(find.text('שפה'), findsOneWidget);
    expect(Directionality.of(tester.element(find.byType(ProductSettings))), TextDirection.rtl);
    expect((await SharedPreferences.getInstance()).getString('language'), 'he');
    await store.preferences.setLanguage('en');
    await tester.pumpAndSettle();
    expect(find.text('Language'), findsOneWidget);
    expect(Directionality.of(tester.element(find.byType(ProductSettings))), TextDirection.ltr);
  });

  testWidgets('one needs-you entry and project filtering; opening a chat keeps the existing behavior', (tester) async {
    final store = await productApp(tester);
    expect(find.textContaining('Needs you ·'), findsOneWidget);
    expect(find.byType(ProductChatRow), findsWidgets);
    final row = tester.widget<ProductChatRow>(find.byType(ProductChatRow).first);
    final who = store.data!.who(row.conversation.identityId);
    await tester.tap(find.byType(ProductChatRow).first);
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(find.text(who.name), findsWidgets);
  });

  testWidgets('global search opens with Ctrl K, arrow keys select, Esc closes', (tester) async {
    await productApp(tester, size: const Size(1280, 840));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(find.byType(ProductSearch), findsOneWidget);
    await tester.enterText(find.byKey(const Key('global-search')), 'דנה');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    // The chip and the group heading.
    expect(find.text('People'), findsNWidgets(2));
    await tester.tap(find.byKey(const Key('search-filter-tasks')));
    await tester.pump();
    expect(find.text('People'), findsOneWidget);
    await tester.tap(find.byKey(const Key('search-filter-people')));
    await tester.pump();
    expect(find.text('People'), findsNWidgets(2));
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    expect(find.byType(ProductSearch), findsNothing);
  });

  testWidgets('search on the phone is a full screen that closes back to the chats', (tester) async {
    await productApp(tester);
    await tester.tap(find.text('Search').first);
    await tester.pumpAndSettle();
    expect(find.byWidgetPredicate((w) => w is ProductSearch && w.fullScreen), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
    await tester.tap(find.byTooltip('Close'));
    await tester.pumpAndSettle();
    expect(find.byType(ProductSearch), findsNothing);
  });

  testWidgets('"all" is a summary: three of a group, then "all N" opens its chip; a task without a stage has no check mark', (tester) async {
    final store = await productApp(tester, home: const Scaffold(body: SafeArea(child: ProductSearch(fullScreen: true))));
    await tester.enterText(find.byKey(const Key('global-search')), 'לומו');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    final people = (await store.backend.search('לומו')).where((h) => h.kind == 'person').length;
    expect(people, greaterThan(3));
    expect(find.byType(ProjectMonogram), findsNWidgets(3));
    expect(find.text('All $people'), findsOneWidget);
    await tester.tap(find.byKey(const Key('search-more-person')));
    await tester.pump();
    expect(find.byType(ProjectMonogram), findsNWidgets(people));
    expect(find.byKey(const Key('search-more-person')), findsNothing);
    final state = tester.state(find.byType(ProductSearch)) as dynamic;
    expect(state.icon(const SearchHit(kind: 'task', id: '1', title: 't')), 'radio_button_unchecked');
    expect(state.icon(const SearchHit(kind: 'task', id: '1', title: 't', outcome: 'completed')), 'check_circle');
    // The second line: words, never ids; the stage says what waits on him and how a task ended.
    final l = AppLocalizations.of(tester.element(find.byType(ProductSearch)));
    String meta(SearchHit h) => state.meta(l, store.data!, h) as String;
    expect(meta(const SearchHit(kind: 'task', id: '1', title: 't', projectName: 'Field log', stage: TaskStage.review, waiting: true)), 'Field log · ${l.needsYou}');
    expect(meta(const SearchHit(kind: 'task', id: '1', title: 't', projectName: 'Field log', outcome: 'cancelled')), 'Field log · Cancelled');
    expect(meta(const SearchHit(kind: 'task', id: '1', title: 't', projectName: 'Field log', outcome: 'completed')), 'Field log · Finished');
    expect(meta(const SearchHit(kind: 'person', id: 'a', title: 'A', leadName: 'Mira')), "In Mira's team");
    expect(meta(const SearchHit(kind: 'person', id: 'a', title: 'A', leadName: 'Yoav', leads: true)), l.reportsTo('Yoav'));
    // "מחכה לך" is what asks him (needsYou), not the presence word.
    expect(meta(const SearchHit(kind: 'person', id: 'a', title: 'A', status: 'waiting_for_you', leadName: 'Mira')), "In Mira's team");
    store.data!.waiting.add(WaitItem(id: 'go-a', kind: WaitKind.go, from: 'a', time: '10:00', kicker: 'k', body: 'b'));
    expect(meta(const SearchHit(kind: 'person', id: 'a', title: 'A', leadName: 'Mira')), l.needsYou);
  });

  test('a note shows the words that matched, in bold, even deep in a long note', () {
    final span = matchSpan('${'מילה ' * 20}לומו נפל', 'לומו', const TextStyle());
    expect(span.toPlainText(), startsWith('…'));
    expect(span.toPlainText(), endsWith('לומו נפל'));
    expect(span.children![1].toPlainText(), 'לומו');
    expect((span.children![1] as TextSpan).style!.fontWeight, FontWeight.w700);
    // A Hebrew note with English in it keeps each English run isolated, as ProductContentText does.
    final mixed = matchSpan('לומו נפל ב-feature/wa-retry אחרי PR #452.', 'לומו', const TextStyle());
    expect(mixed.toPlainText(), contains('${kLRI}feature/'));
    expect(stripBidi(mixed.toPlainText()), 'לומו נפל ב-feature/wa-retry אחרי PR #452.');
    expect(matchSpan('fixed lumo retry', 'lumo', const TextStyle()).toPlainText(), 'fixed lumo retry');
  });

  test('approval fact adapter retains source facts and discloses missing facts', () {
    expect(approvalFacts('Risk: Low\nRollback: Restore\nChecked: Review\nChanges: A fix'), ['A fix', 'Low', 'Restore', 'Review']);
    expect(approvalFacts('Plain old server body'), ['Plain old server body', null, null, null]);
    expect(twoLetters('Mira'), 'Mi');
    expect(twoLetters('מירה'), 'מי');
    expect(twoLetters('Maya Cohen'), 'MC');
  });

  testWidgets('release approval keeps two fixed actions, sends through existing undo path', (tester) async {
    final item = releaseItem();
    final store = await productApp(
      tester,
      home: Scaffold(body: ApprovalSheet(item: item)),
    );
    store.data!.waiting.add(item);
    store.touch();
    await tester.pump();
    expect(find.text('Release the map crash fix?'), findsOneWidget);
    expect(find.text('Release to users'), findsOneWidget);
    expect(find.text('Not now'), findsOneWidget);
    await tester.tap(find.text('Release to users'));
    await tester.pump();
    expect(store.decision(item.askId, item.id), isNotNull);
    expect(tester.takeException(), isNull);
    store.cancelUndo(AppStore.decisionKey(item.askId, item.id));
  });

  for (final language in ['en', 'he']) {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 1.3, 2.0]) {
        for (final screen in ['home', 'chat', 'approval']) {
          final name = '$screen-$language-${dark ? 'dark' : 'light'}-$scale';
          testWidgets('product golden $name', (tester) async {
            final approval = releaseItem();
            final home = switch (screen) {
              'chat' => const ChatScreen(identityId: 'dana'),
              'approval' => Scaffold(body: ApprovalSheet(item: approval)),
              _ => null,
            };
            await productApp(
              tester,
              language: language,
              dark: dark,
              scale: scale,
              home: home,
              prepare: screen == 'approval'
                  ? (store) {
                      store.data!.waiting.removeWhere((w) => w.from == approval.from && w.kind == WaitKind.go);
                      store.data!.waiting.add(approval);
                    }
                  : null,
            );
            await tester.pump(const Duration(milliseconds: 500));
            // Layout exceptions are left for the binding to report with their render location.
            await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/product/$name.png'));
          });
        }
      }
      for (final width in [840.0, 1280.0]) {
        testWidgets('desktop golden $language $dark $width', (tester) async {
          await productApp(tester, language: language, dark: dark, size: Size(width, 900));
          await tester.pump(const Duration(milliseconds: 500));
          expect(tester.takeException(), isNull);
          await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/product/desktop-$language-$dark-$width.png'));
        });
      }
    }
  }
  for (final language in ['en', 'he']) {
    for (final dark in [false, true]) {
      for (final screen in ['offline', 'stuck', 'quiet', 'settings', 'search']) {
        testWidgets('state golden $screen $language $dark', (tester) async {
          final backend = screen == 'offline' ? OfflineBackend() : FakeBackend(simulate: false, now: kDemoNow);
          Widget? home;
          if (screen == 'settings') home = const Scaffold(body: ProductSettings(embedded: true));
          if (screen == 'search') home = const Scaffold(body: SafeArea(child: ProductSearch(fullScreen: true)));
          final store = await productApp(tester, language: language, dark: dark, backend: backend, home: home);
          if (screen == 'quiet') {
            store.data!.waiting.clear();
            store.touch();
          }
          if (screen == 'stuck') {
            final c = store.data!.conversations.first;
            store.data!.conversations
              ..clear()
              ..add(c);
            store.data!.presence[c.identityId] = const Presence(status: WorkerStatus.stuck);
            store.touch();
          }
          if (screen == 'search') {
            await tester.enterText(find.byKey(const Key('global-search')), 'לומו');
            await tester.pump(const Duration(milliseconds: 200));
          }
          await tester.pump(const Duration(milliseconds: 500));
          expect(tester.takeException(), isNull);
          await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/product/$screen-$language-$dark.png'));
        });
      }
    }
  }
  testWidgets('settings follow the mockup: no interface or advanced switches; the tools are one row', (tester) async {
    await productApp(tester, home: const Scaffold(body: ProductSettings(embedded: true)));
    for (final gone in ['New interface', 'Advanced mode']) {
      expect(find.text(gone), findsNothing);
    }
    expect(find.byType(AccountSwitch), findsNothing);
    final order = ['Claude subscription', 'Server', 'Notifications', 'Language', 'Appearance', 'Tools'];
    for (final t in order) {
      await tester.scrollUntilVisible(find.text(t), 200);
    }
    expect(find.text('Company map'), findsNothing);
    await tester.tap(find.byKey(const Key('settings-tools')));
    await tester.pumpAndSettle();
    for (final t in ['Company overview', 'Company map', 'Automations']) {
      expect(find.text(t), findsOneWidget);
    }
  });

  testWidgets('the account switch lives in the Claude subscription page', (tester) async {
    await productApp(tester, home: const Scaffold(body: ProductSettings(embedded: true)));
    await tester.tap(find.text('Claude subscription'));
    await tester.pumpAndSettle();
    expect(find.byType(SettingsPageView), findsOneWidget);
    expect(find.byType(AccountSwitch), findsOneWidget);
    expect(find.text('Work settings'), findsOneWidget);
  });

  test('the subscription line is the Claude week as one, and its nearest reset', () {
    final l = lookupAppLocalizations(const Locale('he'));
    final now = DateTime(2026, 11, 7, 9);
    final friday = DateTime(2026, 11, 13, 6), sunday = DateTime(2026, 11, 8, 6);
    expect(claudeWeek(l, const [], now), isNull);
    final line = claudeWeek(l, [
      QuotaLine(name: 'a', label: 'a', sevenDay: 30, sevenDayResets: friday),
      QuotaLine(name: 'b', label: 'b', sevenDay: 46, sevenDayResets: friday),
      const QuotaLine(name: 'codex', label: 'Codex', sevenDay: 99),
      QuotaLine(name: 'c', label: 'c', usable: false, sevenDay: 100, sevenDayResets: sunday),
    ], now)!;
    expect(stripBidi(line), 'נוצל 38% השבוע · מתאפס ביום שישי');
    // The day it resets is "today" on that day; a week that already reset counts as unused, not last week's.
    final tonight = DateTime(2026, 11, 7, 22), lastNight = DateTime(2026, 11, 7, 3);
    expect(stripBidi(claudeWeek(l, [
      QuotaLine(name: 'a', label: 'a', sevenDay: 80, sevenDayResets: tonight),
      QuotaLine(name: 'b', label: 'b', sevenDay: 90, sevenDayResets: lastNight),
    ], now)!), 'נוצל 40% השבוע · מתאפס היום');
  });

  test('the reset day is his day on the company clock, not the phone\'s', () {
    final l = lookupAppLocalizations(const Locale('he'));
    addTearDown(CompanyTime.reset);
    // Friday 23:00 UTC is already Saturday in Bangkok (+7).
    final resets = DateTime.utc(2026, 11, 13, 23), now = DateTime.utc(2026, 11, 7, 9);
    CompanyTime.offset = const Duration(hours: 7);
    expect(stripBidi(claudeWeek(l, [QuotaLine(name: 'a', label: 'a', sevenDay: 10, sevenDayResets: resets)], now)!), 'נוצל 10% השבוע · מתאפס ביום שבת');
    CompanyTime.offset = const Duration(hours: -5);
    expect(stripBidi(claudeWeek(l, [QuotaLine(name: 'a', label: 'a', sevenDay: 10, sevenDayResets: resets)], now)!), 'נוצל 10% השבוע · מתאפס ביום שישי');
  });

  testWidgets('notifications say what hq does: what rings, what is silent, the number; focus is one tap', (tester) async {
    final store = await productApp(tester, home: const Scaffold(body: ProductSettings(embedded: true)));
    await tester.tap(find.byKey(const Key('notifications-settings')));
    await tester.pumpAndSettle();
    expect(find.byType(NotificationsSettings), findsOneWidget);
    for (final t in ['A request to approve a release', 'A message from a worker', 'An update with an expected time', 'An update for your information']) {
      expect(find.text(t), findsOneWidget);
    }
    expect(find.text('Rings'), findsWidgets);
    expect(find.text('Silent'), findsOneWidget);
    expect(find.text('Number only'), findsOneWidget);
    // The number is what waits for him (and unread messages only in the browser); off still rings on Android.
    expect(find.textContaining('What waits for you: approval requests and questions.'), findsOneWidget);
    expect(lookupAppLocalizations(const Locale('he')).notifPushHint, contains('באנדרואיד'));
    expect(find.textContaining('all accounts being full'), findsOneWidget);
    final before = store.data!.focus;
    await tester.tap(find.byKey(const Key('notif-focus')));
    await tester.pumpAndSettle();
    expect(store.data!.focus, !before);
  });

  testWidgets('on a wide screen settings are a menu with the page beside it', (tester) async {
    await productApp(tester, size: const Size(1280, 840), home: const Scaffold(body: ProductSettings(embedded: true)));
    expect(find.byType(SettingsPageView), findsOneWidget);
    await tester.tap(find.text('Notifications'));
    await tester.pumpAndSettle();
    expect(find.byType(NotificationsSettings), findsOneWidget);
    expect(find.byType(SettingsPageView), findsOneWidget);
    expect(Navigator.of(tester.element(find.byType(NotificationsSettings))).canPop(), isFalse);
  });

  testWidgets('settings choices use mapped symbols and one notifications destination', (tester) async {
    await productApp(tester, home: const Scaffold(body: ProductSettings(embedded: true)));
    for (final icon in tester.widgetList<Ic>(find.byType(Ic))) {
      expect(kIcons.containsKey(icon.name), isTrue, reason: icon.name);
    }
    expect(find.text('Notifications'), findsOneWidget);
    expect(find.byType(DropdownButton<String>), findsNothing);
    await tester.tap(find.byKey(const Key('language-choice')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('עברית'));
    await tester.pumpAndSettle();
    expect(find.text('שפה'), findsOneWidget);
    expect(find.text('רן'), findsOneWidget);
  });
  testWidgets('symbol geometry stays fixed at 200 percent and the zero-count chat icon stays visible', (tester) async {
    final store = await productApp(tester, scale: 2);
    for (final text in tester.widgetList<Text>(find.descendant(of: find.byType(ProjectMonogram), matching: find.byType(Text)))) {
      expect(text.textScaler, TextScaler.noScaling);
    }
    for (final text in tester.widgetList<Text>(find.descendant(of: find.byType(ProductUnreadBadge), matching: find.byType(Text)))) {
      expect(text.textScaler, TextScaler.noScaling);
    }
    final rows = store.data!.conversations.map((c) => ConversationSummary(identityId: c.identityId, lastLine: c.lastLine, time: c.time)).toList();
    store.data!.conversations
      ..clear()
      ..addAll(rows);
    store.touch();
    await tester.pump();
    final icon = find.byWidgetPredicate((w) => w is Ic && w.name == 'chat');
    expect(icon, findsOneWidget);
    expect(tester.getSize(icon).height, greaterThan(20));
    for (final rich in tester.widgetList<RichText>(find.descendant(of: icon, matching: find.byType(RichText)))) {
      expect(rich.text.style!.color, isNot(Colors.white), reason: 'the selected chat symbol must contrast with the light navigation surface');
    }
  });
  for (final language in ['en', 'he']) {
    testWidgets('opposite-language content keeps its own direction: $language', (tester) async {
      final sample = language == 'en' ? 'טיקיבוט: ה-webhook מחזיר 502 מ-13:58.' : 'The map crashes on Android 15. Can you check?';
      await productApp(
        tester,
        language: language,
        prepare: (store) {
          final c = store.data!.conversations.first;
          store.data!.conversations
            ..clear()
            ..add(ConversationSummary(identityId: c.identityId, lastLine: sample, time: c.time));
        },
      );
      final content = find.byWidgetPredicate((w) => w is ProductContentText && w.text == sample);
      final rendered = tester.widget<Text>(find.descendant(of: content, matching: find.byType(Text)));
      expect(rendered.textDirection, language == 'en' ? TextDirection.rtl : TextDirection.ltr);
      expect(stripBidi(rendered.data!), sample);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/product/mixed-content-$language.png'));
    });
  }

  testWidgets('saved interface is never flashed before backend startup completes', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({'language': 'he'});
    final ready = Completer<void>();
    await tester.pumpWidget(AuthGate(initial: SlowBackend(ready), hqUrl: '', locale: const Locale('he')));
    await tester.pump();
    expect(find.byType(ProductShell), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    ready.complete();
    await tester.pumpAndSettle();
    expect(find.byType(ProductShell), findsOneWidget);
    expect(tester.widget<MaterialApp>(find.byType(MaterialApp)).locale, const Locale('he'));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a failed startup shows a retry and can recover without a permanent spinner', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final backend = FailedStartupBackend();
    await tester.pumpWidget(AuthGate(initial: backend, hqUrl: ''));
    await tester.pumpAndSettle();
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.text('Try again'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Try again'));
    await tester.pumpAndSettle();
    expect(find.byType(ProductShell), findsOneWidget);
    expect(backend.starts, 2);
    await tester.pumpWidget(const SizedBox.shrink());
  });
  testWidgets('the company overview opens from the tools row', (tester) async {
    await productApp(tester, home: const Scaffold(body: ProductSettings(embedded: true)));
    await tester.scrollUntilVisible(find.byKey(const Key('settings-tools')), 200);
    await tester.tap(find.byKey(const Key('settings-tools')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Company overview'));
    await tester.pumpAndSettle();
    expect(find.byType(HomeV2), findsOneWidget);
  });
  testWidgets('back arrows follow the locale and pending answers keep their language key', (tester) async {
    final store = await productApp(tester, home: const ChatScreen(identityId: 'dana'));
    var context = tester.element(find.byType(ChatScreen));
    expect(backIcon(context), 'arrow_back');
    final item = releaseItem();
    store.data!.waiting.add(item);
    store.answerWait(item, const AskOption(id: 'go', label: 'Approve'));
    final pending = store.decision(item.askId, item.id)!;
    expect(pending.line, 'Approved');
    await store.preferences.setLanguage('he');
    await tester.pump();
    context = tester.element(find.byType(ChatScreen));
    expect(backIcon(context), 'arrow_forward');
    expect(pending.line, 'אישרת');
    store.cancelUndo(AppStore.decisionKey(item.askId, item.id));
  });

  testWidgets('monograms in both scripts and modes', (tester) async {
    for (final dark in [false, true]) {
      await productApp(
        tester,
        dark: dark,
        home: const Scaffold(
          body: Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ProjectMonogram(name: 'Mira', tone: 'teal'),
                SizedBox(width: 16),
                ProjectMonogram(name: 'מירה', tone: 'teal'),
              ],
            ),
          ),
        ),
      );
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('golden/product/monograms-$dark.png'));
    }
  });
}
