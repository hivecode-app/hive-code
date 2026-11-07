import 'dart:io';
import 'package:agent_company/theme/icons.dart';
import 'package:agent_company/native/native_bridge.dart';
import 'dart:convert';
import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/product_client.dart';
import 'package:agent_company/ui/onboarding/setup.dart';
import 'package:agent_company/ui/product/work_settings.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'product_test.dart' show productApp;

const initial = {'pending': true, 'consent': false, 'version': '2026-11-04', 'manager': 'yoav', 'selected': <String>[]};
class SetupApi {
  bool failClaude = false, failSave = false;
  int starts = 0;
  bool reposEmpty = false, reposFail = false;
  final calls = <String>[];
  Map<String, dynamic>? savedSettings;
  final settings = <String, dynamic>{'parallel': 2, 'autoAccounts': false};
  late final client = ProductClient(const Session('https://company.example/hq', 'device'), httpClient: MockClient((r) async {
    final path = r.url.path.replaceFirst('/hq', '');
    calls.add('${r.method} $path');
    Object value = {};
    if (path == '/api/setup') value = {'pending': false};
    if (path == '/api/setup/check') value = {'connected': !(jsonDecode(r.body)['service'] == 'claude' && failClaude)};
    if (path == '/api/setup/repos') {
      if (reposFail) return http.Response('{}', 403);
      value = {'repos': reposEmpty ? [] : [{'name': 'owner/one', 'description': 'One'}, {'name': 'owner/two', 'description': 'Two'}], 'more': false};
    }
    if (path == '/api/setup/start') starts++;
    if (path == '/api/settings/work') {
      if (r.method == 'POST') savedSettings = jsonDecode(r.body) as Map<String, dynamic>;
      if (r.method == 'POST' && failSave) return http.Response('{}', 503);
      if (r.method == 'POST') settings.addAll(savedSettings!);
      value = {'settings': settings};
    }
    return http.Response(jsonEncode(value), 200);
  }));
}

void main() {
  test('every literal setup and work icon maps to a Material Symbol', () {
    for (final path in ['lib/ui/onboarding/setup.dart', 'lib/ui/product/work_settings.dart']) {
      final source = File(path).readAsStringSync();
      for (final match in RegExp(r"Ic\('([^']+)'").allMatches(source)) {
        expect(kIcons, contains(match[1]), reason: '$path: ${match[1]}');
      }
    }
  });

  for (final language in ['en', 'he']) {
    testWidgets('consent disabled until checked, terms preserve selection ($language)', (tester) async {
      final api = SetupApi(); addTearDown(api.client.close);
      await productApp(tester, language: language, home: SetupScreen(client: api.client, initial: initial, onDone: () {}));
      expect(tester.widget<FilledButton>(find.byKey(const Key('setup-continue'))).onPressed, isNull);
      await expectLater(find.byType(Scaffold), matchesGoldenFile('golden/product/setup-consent-$language.png'));
      await tester.ensureVisible(find.byKey(const Key('setup-consent')));
      await tester.tap(find.byType(Checkbox)); await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byKey(const Key('setup-continue'))).onPressed, isNotNull);
      await tester.tap(find.text(language == 'en' ? 'Terms of use' : 'תנאי השימוש'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.text(language == 'en' ? 'Back' : 'חזרה').last); await tester.pumpAndSettle();
      expect(tester.widget<CheckboxListTile>(find.byKey(const Key('setup-consent'))).value, true);
    });
  }
  testWidgets('retry only the failed connection, select repositories, start once and continue in conversation', (tester) async {
    final api = SetupApi()..failClaude = true; addTearDown(api.client.close);
    await productApp(tester, home: SetupScreen(client: api.client, initial: {...initial, 'consent': true}, onDone: () {}));
    expect(find.text('Hive Code server connected'), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    final githubChecks = api.calls.where((c) => c.endsWith('/api/setup/check')).length;
    api.failClaude = false;
    await tester.tap(find.byTooltip('Try again').first); await tester.pumpAndSettle();
    expect(api.calls.where((c) => c.endsWith('/api/setup/check')).length, githubChecks + 1);
    await tester.tap(find.text('Continue')); await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(find.byKey(const Key('setup-start'))).onPressed, isNull);
    await tester.tap(find.text('owner/one')); await tester.pumpAndSettle();
    await tester.tap(find.text('owner/two')); await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('setup-start'))); await tester.pumpAndSettle();
    expect(api.starts, 1); expect(find.text('Open conversation'), findsOneWidget);
    expect(api.calls.indexOf('POST /api/setup/projects'), lessThan(api.calls.indexOf('POST /api/setup/start')));
  });
  testWidgets('pairing existing company reaches its content without setup', (tester) async {
    final api = SetupApi(); addTearDown(api.client.close);
    await productApp(tester, home: SetupGate(client: api.client, child: const Scaffold(body: Text('Existing company'))));
    expect(find.text('Existing company'), findsOneWidget);
    expect(find.byKey(const Key('setup-consent')), findsNothing);
  });
  for (final language in ['en', 'he']) {
    testWidgets('work settings save capacity and accounts without a night schedule ($language)', (tester) async {
      final api = SetupApi(); addTearDown(api.client.close);
      await productApp(tester, language: language, home: WorkSettingsScreen(client: api.client));
      expect(find.byType(SwitchListTile), findsOneWidget);
      expect(find.text(language == 'en' ? 'Scheduled night work' : 'עבודת לילה מתוזמנת'), findsNothing);
      expect(find.text('23:00'), findsNothing);
      expect(find.text('07:00'), findsNothing);
      await tester.tap(find.byTooltip(language == 'en' ? 'More workers in parallel' : 'הגדלת מספר העובדים במקביל'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('auto-accounts')));
      await tester.pumpAndSettle();
      final save = find.text(language == 'en' ? 'Save work settings' : 'שמירת הגדרות העבודה');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(api.savedSettings, {'parallel': 3, 'autoAccounts': true});
      expect(find.text(language == 'en' ? 'Work settings saved' : 'הגדרות העבודה נשמרו'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
  testWidgets('work settings failure restores the confirmed value and reports failure', (tester) async {
    final api = SetupApi()..failSave = true; addTearDown(api.client.close);
    await productApp(tester, home: WorkSettingsScreen(client: api.client));
    expect(find.byTooltip('Back'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('auto-accounts')));
    await tester.tap(find.byKey(const Key('auto-accounts'))); await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('auto-accounts'))).value, true);
    await tester.ensureVisible(find.text('Save work settings')); await tester.tap(find.text('Save work settings')); await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('auto-accounts'))).value, false);
    expect(find.text('Work settings saved'), findsNothing);
    expect(find.text('The change could not be saved. Check the server connection and try again.'), findsOneWidget);
  });
  testWidgets('setup remains scrollable at 200 percent in dark Hebrew', (tester) async {
    final api = SetupApi(); addTearDown(api.client.close);
    await productApp(tester, language: 'he', dark: true, scale: 2, home: SetupScreen(client: api.client, initial: initial, onDone: () {}));
    await expectLater(find.byType(Scaffold), matchesGoldenFile('golden/product/setup-consent-he-dark-large-top.png'));
    await tester.drag(find.byType(ListView), const Offset(0, -900));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await expectLater(find.byType(Scaffold), matchesGoldenFile('golden/product/setup-consent-he-dark-large.png'));
  });
  for (final language in ['en', 'he']) {
    for (final screen in ['connections', 'connection-failed', 'repositories', 'repositories-empty', 'repositories-failed', 'first-task', 'work']) {
      for (final large in [false, true]) {
        testWidgets('setup golden $screen $language large=$large', (tester) async {
          final api = SetupApi()..failClaude = screen == 'connection-failed'..reposEmpty = screen == 'repositories-empty'..reposFail = screen == 'repositories-failed';
          addTearDown(api.client.close);
          await productApp(tester, language: language, dark: large, scale: large ? 2 : 1,
            home: screen == 'work' ? WorkSettingsScreen(client: api.client) : SetupScreen(client: api.client, initial: {...initial, 'consent': true, 'started': screen == 'first-task'}, onDone: () {}));
          if (screen.startsWith('repositories')) {
            await tester.tap(find.text(language == 'en' ? 'Continue' : 'המשך')); await tester.pumpAndSettle();
          }
          expect(tester.takeException(), isNull);
          await expectLater(find.byType(Scaffold), matchesGoldenFile('golden/product/setup-$screen-$language${large ? '-dark-large' : ''}.png'));
        });
      }
    }
  }

  testWidgets('notification permission is requested explicitly and disappears when granted', (tester) async {
    NativeBridge.debugSupportedOverride = true;
    var allowed = false, requests = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeBridge.channel, (call) async {
      if (call.method == 'notificationsEnabled') return allowed;
      if (call.method == 'requestNotificationPermission') { requests++; allowed = true; return true; }
      return null;
    });
    addTearDown(() {
      NativeBridge.debugSupportedOverride = null;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(NativeBridge.channel, null);
    });
    final api = SetupApi(); addTearDown(api.client.close);
    await productApp(tester, home: SetupScreen(client: api.client, initial: {...initial, 'started': true}, onDone: () {}));
    expect(requests, 0);
    await tester.tap(find.text('Enable notifications')); await tester.pumpAndSettle();
    expect(requests, 1); expect(find.text('Enable notifications'), findsNothing);
    expect(find.text('Open conversation'), findsOneWidget);
  });

}
