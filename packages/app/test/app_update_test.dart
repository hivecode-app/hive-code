import 'dart:convert';

import 'package:agent_company/data/backend_select.dart';
import 'package:agent_company/native/app_update.dart';
import 'package:agent_company/native/native_bridge.dart';
import 'package:agent_company/ui/system_bar.dart';
import 'package:agent_company/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

final _sha = 'ab' * 32;
Map<String, Object?> _json(int code) =>
    {'version_code': code, 'version_name': '0.1.0', 'sha': 'abc1234', 'sha256': _sha, 'bytes': 21000000, 'apk_path': '/api/app/apk/$code'};
AppRelease _rel(int code) => AppRelease.fromJson(_json(code))!;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final calls = <MethodCall>[];
  var installed = 2001;
  var canInstall = true;
  Object? installAnswer = 'started';
  Object? reopenAnswer = 'shown';

  /// The Kotlin side: version, permission, installUpdate (AppUpdater.kt).
  void mockNative() {
    messenger.setMockMethodCallHandler(NativeBridge.channel, (call) async {
      calls.add(call);
      return switch (call.method) {
        'appVersionCode' => installed,
        'canInstallPackages' => canInstall,
        'installUpdate' => installAnswer,
        'reopenUpdate' => reopenAnswer,
        _ => null,
      };
    });
  }

  /// AppUpdater.kt reporting progress to Dart.
  Future<void> fromNative(Map<String, Object?> event) async {
    await messenger.handlePlatformMessage(
      NativeBridge.channel.name,
      NativeBridge.channel.codec.encodeMethodCall(MethodCall('update', event)),
      (_) {},
    );
  }

  setUp(() {
    calls.clear();
    installed = 2001;
    canInstall = true;
    installAnswer = 'started';
    reopenAnswer = 'shown';
    NativeBridge.debugSupportedOverride = true;
    mockNative();
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(NativeBridge.channel, null);
    NativeBridge.debugSupportedOverride = null;
  });

  test('AppRelease.fromJson takes only what hq vouches for', () {
    final r = _rel(2085);
    expect(r.versionCode, 2085);
    expect(r.apkPath, '/api/app/apk/2085');
    expect(AppRelease.fromJson(null), isNull);
    expect(AppRelease.fromJson({..._json(2085), 'sha256': 'nope'}), isNull);
    expect(AppRelease.fromJson({..._json(2085), 'bytes': 0}), isNull);
    expect(AppRelease.fromJson({..._json(2085), 'version_code': '2085'}), isNull);
    expect(AppRelease.fromJson({..._json(2085), 'apk_path': 'https://evil.example/x.apk'}), isNull);
  });

  test('fetchLatestRelease asks the signed-in hq with the device token', () async {
    SharedPreferences.setMockInitialValues({'language': 'he'});
    expect(await fetchLatestRelease(client: MockClient((_) async => fail('no call when signed out'))), isNull);

    SharedPreferences.setMockInitialValues({kHqUrl: 'https://app.hq.example.com/hq', kHqToken: 'dev-tok'});
    http.Request? seen;
    final r = await fetchLatestRelease(client: MockClient((req) async {
      seen = req;
      return http.Response(jsonEncode({'latest': _json(2090)}), 200);
    }));
    expect(seen!.url.toString(), 'https://app.hq.example.com/hq/api/app/latest');
    expect(seen!.headers['authorization'], 'Bearer dev-tok');
    expect(r!.versionCode, 2090);

    expect(await fetchLatestRelease(client: MockClient((_) async => http.Response(jsonEncode({'latest': null}), 200))), isNull);
    expect(await fetchLatestRelease(client: MockClient((_) async => http.Response('{}', 401))), isNull);
    expect(await fetchLatestRelease(client: MockClient((_) async => throw const SocketLikeError())), isNull);
  });

  test('offers only a newer version, and "לא עכשיו" hides it until a newer one', () async {
    AppRelease? latest = _rel(2001);
    var now = DateTime(2026, 10, 20, 12);
    final u = AppUpdate(fetch: () async => latest, now: () => now);
    await u.check(force: true);
    expect(u.phase, UpdatePhase.none, reason: 'same version');

    latest = _rel(2085);
    await u.check();
    expect(u.phase, UpdatePhase.none, reason: 'asked a moment ago: no new request');
    now = now.add(AppUpdate.recheckAfter);
    await u.check();
    expect(u.phase, UpdatePhase.available);
    expect(u.release!.versionCode, 2085);

    u.dismiss();
    expect(u.phase, UpdatePhase.none);
    await u.check(force: true);
    expect(u.phase, UpdatePhase.none, reason: 'dismissed for this version');
    latest = _rel(2086);
    await u.check(force: true);
    expect(u.phase, UpdatePhase.available, reason: 'a newer one shows again');
    u.dispose();
  });

  test('one tap: download with progress, Android dialog, cancel and failure', () async {
    final u = AppUpdate(fetch: () async => _rel(2085));
    await u.check(force: true);
    await u.install();
    final call = calls.singleWhere((c) => c.method == 'installUpdate');
    expect(call.arguments, {'path': '/api/app/apk/2085', 'sha256': _sha, 'bytes': 21000000});
    expect(u.phase, UpdatePhase.downloading);

    await fromNative({'state': 'downloading', 'received': 10500000, 'total': 21000000});
    expect(u.progress, 0.5);
    await fromNative({'state': 'installing'});
    expect(u.phase, UpdatePhase.installing);
    await u.check(force: true);
    expect(u.phase, UpdatePhase.installing, reason: 'a check never interrupts an install');
    await fromNative({'state': 'aborted'});
    expect(u.phase, UpdatePhase.available, reason: 'closed Android\'s dialog: the offer stays');

    await u.install();
    await u.cancel();
    expect(calls.last.method, 'cancelUpdate');
    await fromNative({'state': 'cancelled'});
    expect(u.phase, UpdatePhase.available);

    await u.install();
    await fromNative({'state': 'failed', 'reason': 'integrity'});
    expect(u.phase, UpdatePhase.failed);
    u.dispose();
  });

  test('without "install unknown apps", it continues by itself once he allows it', () async {
    canInstall = false;
    installAnswer = 'needs_permission';
    final u = AppUpdate(fetch: () async => _rel(2085));
    await u.check(force: true);
    await u.install();
    expect(u.phase, UpdatePhase.needsPermission);

    await u.resumed();
    expect(u.phase, UpdatePhase.needsPermission, reason: 'came back without allowing');
    expect(calls.where((c) => c.method == 'installUpdate'), hasLength(1));

    canInstall = true;
    installAnswer = 'started';
    await u.resumed();
    expect(u.phase, UpdatePhase.downloading);
    expect(calls.where((c) => c.method == 'installUpdate'), hasLength(2));
    u.dispose();
  });

  test('back in the app during "installing": the dialog comes back, or the offer does', () async {
    final u = AppUpdate(fetch: () async => _rel(2085));
    await u.check(force: true);
    await u.install();
    await fromNative({'state': 'installing'});

    await u.resumed();
    expect(calls.last.method, 'reopenUpdate');
    expect(u.phase, UpdatePhase.installing, reason: 'Android\'s dialog is open again');
    reopenAnswer = 'waiting';
    await u.resumed();
    expect(u.phase, UpdatePhase.installing, reason: 'Android has not answered yet');
    reopenAnswer = 'none';
    await u.resumed();
    expect(u.phase, UpdatePhase.available, reason: 'nothing pending: never stuck on "installing"');
    u.dispose();
  });

  testWidgets('the strip: words, "עדכון", the ring with an X that cancels', (tester) async {
    NativeBridge.debugSupportedOverride = false;
    await pumpApp(tester, home: const Scaffold(body: SizedBox.shrink()));
    NativeBridge.debugSupportedOverride = true;
    final u = AppUpdate(fetch: () async => _rel(2085));
    await tester.runAsync(() => u.check(force: true));
    await tester.pumpWidget(MaterialApp(
      theme: Theme.of(tester.element(find.byType(Scaffold))),
      locale: const Locale('he'),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: UpdateStrip(update: u)),
    ));
    expect(find.text('יש גרסה חדשה של האפליקציה.'), findsOneWidget);

    await tester.tap(find.text('עדכון'));
    await tester.pump();
    expect(calls.where((c) => c.method == 'installUpdate'), hasLength(1));
    await fromNative({'state': 'downloading', 'received': 4200000, 'total': 10000000});
    await tester.pump();
    expect(find.text('הורדת הגרסה החדשה · 42%'), findsOneWidget);
    await tester.tap(find.byTooltip('ביטול ההורדה'));
    await tester.pump();
    expect(calls.last.method, 'cancelUpdate');

    await fromNative({'state': 'installing'});
    await tester.pump();
    expect(find.text('יש לאשר את ההתקנה בחלון של אנדרואיד.'), findsOneWidget);

    await fromNative({'state': 'failed', 'reason': 'download'});
    await tester.pump();
    expect(find.text('העדכון לא הצליח.'), findsOneWidget);
    await tester.tap(find.byTooltip('לא עכשיו'));
    await tester.pump();
    expect(find.byType(Container), findsNothing);
    u.dispose();
  });
}

class SocketLikeError implements Exception {
  const SocketLikeError();
}
