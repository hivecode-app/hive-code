// Sign-in, pairing and devices (#23) against a fake hq (MockClient) and fake passkeys.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/backend_select.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/passkey.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/ui/auth/sign_in_screen.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/settings/devices_screen.dart';
import 'package:agent_company/theme/theme.dart';
import 'package:agent_company/theme/tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

const base = 'https://app.example/p/hq';
// Local times, so the goldens read the same in any time zone.
final t0 = DateTime(2026, 10, 19, 15, 53).millisecondsSinceEpoch;
final t1 = DateTime(2026, 10, 20, 13, 46).millisecondsSinceEpoch;
final t2 = DateTime(2026, 10, 20, 14, 16).millisecondsSinceEpoch;

class FakePasskeys implements Passkeys {
  FakePasskeys({this.supported = true, this.createError, this.getError});
  @override
  final bool supported;
  PasskeyError? createError, getError;
  final calls = <String>[];
  @override
  Future<PasskeyResult> create(String optionsJson) async {
    calls.add('create ${(jsonDecode(optionsJson) as Map)['challenge']}');
    return createError != null ? PasskeyResult.fail(createError!) : const PasskeyResult.ok('{"id":"cred-1","type":"public-key"}');
  }

  @override
  Future<PasskeyResult> get(String optionsJson) async {
    calls.add('get ${(jsonDecode(optionsJson) as Map)['challenge']}');
    return getError != null ? PasskeyResult.fail(getError!) : const PasskeyResult.ok('{"id":"cred-1","type":"public-key"}');
  }
}

/// A tiny hq: the auth and devices endpoints, recording what was called.
class FakeHq {
  final requests = <String>[];
  final hosts = <String>[];
  final bodies = <String, Map<String, dynamic>>{};
  var devices = <Map<String, dynamic>>[
    {'id': 'dev_a', 'name': 'OnePlus 13', 'via': 'register', 'passkey_id': 'cred-1', 'created_at': t0, 'last_seen_at': t1, 'current': true},
    {'id': 'dev_b', 'name': 'דפדפן במחשב', 'via': 'passkey', 'passkey_id': 'cred-1', 'created_at': t0, 'last_seen_at': null, 'current': false},
  ];

  late final client = MockClient((r) async {
    final path = r.url.path.replaceFirst(RegExp(r'^(/p)?/hq'), '');
    requests.add('${r.method} $path');
    hosts.add(r.url.host);
    if (r.body.isNotEmpty) bodies[path] = (jsonDecode(r.body) as Map).cast<String, dynamic>();
    final authed = r.headers['authorization'] == 'Bearer tok-a';
    http.Response j(Object v, [int s = 200]) => http.Response(jsonEncode(v), s, headers: {'content-type': 'application/json'});
    if (path == '/health') {
      return r.url.host.startsWith('not-hq') ? http.Response('<html></html>', 200) : j({'ok': true, 'schema': 30});
    }
    switch (path) {
      case '/api/auth/login/options':
        return j({'challenge': 'ch-login', 'rpId': 'app.example'});
      case '/api/auth/register/options':
        return bodies[path]!['code'] == 'GOOD-CODE' ? j({'challenge': 'ch-reg'}) : j({'error': 'pairing code is wrong, used or expired'}, 401);
      case '/api/auth/login':
      case '/api/auth/register':
        return j({'token': 'tok-new', 'device': {}});
      case '/api/auth/pair':
        return bodies[path]!['code'] == 'GOOD-CODE' ? j({'token': 'tok-paired', 'device': {}}) : j({'error': 'pairing code is wrong, used or expired'}, 401);
    }
    if (!authed) return j({'error': 'unauthorized'}, 401);
    if (path == '/api/devices') {
      return j({'devices': devices, 'passkeys': [{'id': 'cred-1', 'name': 'OnePlus 13', 'created_at': t0, 'last_used_at': t1}]});
    }
    if (path == '/api/devices/pair') return j({'code': 'K7QM-2XPA', 'expires_at': t2, 'link': 'https://app.example/p/?pair=K7QM-2XPA'});
    final m = RegExp(r'^/api/devices/([^/]+)/revoke$').firstMatch(path);
    if (m != null) {
      devices = devices.where((d) => d['id'] != m.group(1)).toList();
      return j({'device': {}});
    }
    return j({'error': 'not found'}, 404);
  });
}

Future<void> pumpScreen(WidgetTester tester, Widget screen, {Size size = const Size(342, 716)}) async {
  await loadFonts();
  Motion.frozen = true;
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildTheme(Palette.light),
    locale: const Locale('he'),
    supportedLocales: const [Locale('he')],
    localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
    home: screen,
  ));
  await tester.pump();
}

void main() {
  group('server', serverTests);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('login: options → passkey → token, with this device\'s name', () async {
    final hq = FakeHq(), keys = FakePasskeys();
    final s = await AuthClient(base, client: hq.client, passkeys: keys).login('דפדפן במחשב');
    expect(s.token, 'tok-new');
    expect(s.baseUrl, base);
    expect(keys.calls, ['get ch-login']);
    expect(hq.bodies['/api/auth/login']!['name'], 'דפדפן במחשב');
    expect(hq.bodies['/api/auth/login']!['credential'], {'id': 'cred-1', 'type': 'public-key'});
  });

  test('a cancelled fingerprint and a wrong code read as plain sentences', () async {
    final hq = FakeHq();
    final c = AuthClient(base, client: hq.client, passkeys: FakePasskeys(getError: PasskeyError.cancelled));
    await expectLater(c.login('x'), throwsA(isA<AuthFailure>().having((e) => e.code, 'code', PasskeyError.cancelled)));
    await expectLater(c.register('BAD', 'x'), throwsA(isA<AuthFailure>().having((e) => e.message, 'message', contains('הקוד שגוי'))));
    expect(hq.requests, isNot(contains('POST /api/auth/register')));
  });

  testWidgets('sign-in golden, and fingerprint login hands the session up', (tester) async {
    final hq = FakeHq();
    Session? got;
    await pumpScreen(tester, SignInScreen(client: AuthClient(base, client: hq.client, passkeys: FakePasskeys()), onSignedIn: (s) => got = s));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_in_light.png'));
    await tester.tap(find.text('כניסה עם טביעת אצבע'));
    await tester.pumpAndSettle();
    expect(got?.token, 'tok-new');
  });

  testWidgets('pairing: the code from the link registers a passkey here', (tester) async {
    final hq = FakeHq(), keys = FakePasskeys();
    Session? got;
    await pumpScreen(tester, SignInScreen(client: AuthClient(base, client: hq.client, passkeys: keys), pairCode: 'GOOD-CODE', onSignedIn: (s) => got = s));
    await tester.tap(find.text('צימוד ויצירת passkey'));
    await tester.pumpAndSettle();
    expect(keys.calls, ['create ch-reg']);
    expect(got?.token, 'tok-new');
  });

  testWidgets('pairing: a passkey already here signs in with it; none possible pairs with the code', (tester) async {
    final hq = FakeHq(), keys = FakePasskeys(createError: PasskeyError.exists);
    Session? got;
    await pumpScreen(tester, SignInScreen(client: AuthClient(base, client: hq.client, passkeys: keys), pairCode: 'GOOD-CODE', onSignedIn: (s) => got = s));
    await tester.tap(find.text('צימוד ויצירת passkey'));
    await tester.pumpAndSettle();
    expect(keys.calls, ['create ch-reg', 'get ch-login']);
    expect(got?.token, 'tok-new');

    got = null;
    await pumpScreen(tester, SignInScreen(client: AuthClient(base, client: hq.client, passkeys: FakePasskeys(supported: false)), onSignedIn: (s) => got = s));
    expect(find.text('כניסה עם טביעת אצבע'), findsNothing, reason: 'no passkeys here');
    await tester.enterText(find.byKey(const Key('pair-code')), 'GOOD-CODE');
    await tester.tap(find.text('צימוד'));
    await tester.pumpAndSettle();
    expect(got?.token, 'tok-paired');
  });

  testWidgets('pairing: a dismissed prompt offers the code alone, a wrong code says so', (tester) async {
    final hq = FakeHq(), keys = FakePasskeys(createError: PasskeyError.cancelled);
    Session? got;
    await pumpScreen(tester, SignInScreen(client: AuthClient(base, client: hq.client, passkeys: keys), pairCode: 'GOOD-CODE', onSignedIn: (s) => got = s));
    await tester.tap(find.text('צימוד ויצירת passkey'));
    await tester.pumpAndSettle();
    expect(got, isNull);
    expect(find.text('הכניסה בוטלה.'), findsOneWidget);
    await tester.tap(find.text('צימוד בלי טביעת אצבע'));
    await tester.pumpAndSettle();
    expect(got?.token, 'tok-paired');

    await tester.enterText(find.byKey(const Key('pair-code')), 'BAD');
    await tester.tap(find.text('צימוד ויצירת passkey'));
    await tester.pumpAndSettle();
    expect(find.textContaining('הקוד שגוי'), findsOneWidget);
  });

  testWidgets('devices golden; revoking one asks, revokes and reloads; a pairing code shows', (tester) async {
    final hq = FakeHq();
    await pumpScreen(tester, DevicesScreen(client: AuthClient(base, client: hq.client), session: const Session(base, 'tok-a')), size: const Size(342, 900));
    await tester.pumpAndSettle();
    expect(find.text('המכשיר הזה'), findsOneWidget);
    await tester.tap(find.text('קוד צימוד'));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pair-code-shown')), findsOneWidget);
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/devices_light.png'));

    await tester.tap(find.text('ביטול'));
    await tester.pumpAndSettle();
    expect(find.textContaining('לבטל את "דפדפן במחשב"'), findsOneWidget);
    await tester.tap(find.text('ביטול המכשיר'));
    await tester.pumpAndSettle();
    expect(hq.requests, contains('POST /api/devices/dev_b/revoke'));
    expect(find.text('דפדפן במחשב'), findsNothing);
  });

  testWidgets('a device hq refuses (revoked elsewhere) forgets its token and returns to sign-in', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({kHqUrl: base, kHqToken: 'tok-revoked'});
    final refused = MockClient((r) async => http.Response('{"error":"unauthorized"}', 401));
    await tester.pumpWidget(AuthGate(
      initial: HqBackend(baseUrl: base, token: 'tok-revoked', client: refused),
      hqUrl: base,
      client: AuthClient(base, client: FakeHq().client, passkeys: FakePasskeys()),
    ));
    await tester.pumpAndSettle();
    expect(find.text('המכשיר הזה נותק מהחברה. אפשר להיכנס שוב.'), findsOneWidget);
    expect(find.text('כניסה עם טביעת אצבע'), findsOneWidget);
    expect(await savedSession(), isNull);

    // Signing in again stores the new token.
    await tester.tap(find.text('כניסה עם טביעת אצבע'));
    await tester.pump();
    await tester.pump();
    expect((await savedSession())?.token, 'tok-new');
    await tester.pumpWidget(const SizedBox());
  });

  test('revoked while the live link was down: the reconnect finds out and signs out', () async {
    String fixture(String name) => File('test/fixtures/samples/hq/$name.json').readAsStringSync();
    var revoked = false;
    final client = MockClient((r) async {
      // Only the retry's probe sees the refusal, so nothing else can trip it.
      if (revoked && r.url.path.endsWith('/api/toggles')) return http.Response('{"error":"unauthorized"}', 401);
      final name = r.url.path.split('/').last;
      return http.Response.bytes(utf8.encode(fixture(name)), 200, headers: {'content-type': 'application/json'});
    });
    // The WS never connects here (no server), so the backend keeps retrying as if the link were down.
    final hq = HqBackend(baseUrl: 'http://127.0.0.1:9', token: 'tok-a', client: client);
    await hq.start();
    expect(hq.data, isNotNull);
    expect(hq.unauthorized, isFalse);
    revoked = true;
    for (var i = 0; i < 80 && !hq.unauthorized; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(hq.unauthorized, isTrue);
    hq.dispose();
  });
}

void serverTests() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the app asks for the server: a pasted link fills the address and the code, then pairs there', (tester) async {
    final hq = FakeHq();
    Session? got;
    await pumpScreen(tester, SignInScreen(
        askServer: true, client: AuthClient('', client: hq.client, passkeys: FakePasskeys(supported: false)), onSignedIn: (s) => got = s));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/sign_in_server_light.png'));
    await tester.enterText(find.byKey(const Key('server-address')), 'https://box.example.net/pair?code=good-code');
    await tester.pump();
    expect(find.text('box.example.net'), findsOneWidget);
    expect(find.text('GOOD-CODE'), findsOneWidget);
    await tester.tap(find.text('צימוד'));
    await tester.pumpAndSettle();
    expect(got?.baseUrl, 'https://box.example.net/hq');
    expect(got?.token, 'tok-paired');
    expect(hq.requests, ['GET /health', 'POST /api/auth/pair']);
    expect(hq.hosts.toSet(), {'box.example.net'});
  });

  testWidgets('an address without hq behind it, or none at all, says so in one sentence', (tester) async {
    final hq = FakeHq();
    Session? got;
    await pumpScreen(tester, SignInScreen(askServer: true, client: AuthClient('', client: hq.client, passkeys: FakePasskeys()), onSignedIn: (s) => got = s));
    await tester.tap(find.text('כניסה עם טביעת אצבע'));
    await tester.pumpAndSettle();
    expect(find.text('צריך את הכתובת של השרת, מה-QR או מהקישור שקיבלת.'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('server-address')), 'not-hq.example.com');
    await tester.tap(find.text('כניסה עם טביעת אצבע'));
    await tester.pumpAndSettle();
    expect(find.text('לא נמצא שרת של החברה בכתובת הזו. כדאי לבדוק את הכתובת ולנסות שוב.'), findsOneWidget);
    expect(got, isNull);
    expect(hq.requests, ['GET /health'], reason: 'no passkey prompt for a server that is not there');
  });

  testWidgets('opened from a pairing link: sign-in starts with that server and code', (tester) async {
    await loadFonts();
    final link = 'agentcompany://pair?url=${Uri.encodeComponent('https://box.example.net/pair?code=GOOD-CODE')}';
    await tester.pumpWidget(AuthGate(initial: null, hqUrl: '', askServer: true, pairLink: link,
        client: AuthClient('', client: FakeHq().client, passkeys: FakePasskeys(supported: false))));
    await tester.pumpAndSettle();
    expect(find.text('box.example.net'), findsOneWidget);
    expect(find.text('GOOD-CODE'), findsOneWidget);
    await tester.tap(find.text('צימוד'));
    await tester.pump();
    await tester.pump();
    expect((await savedSession())?.baseUrl, 'https://box.example.net/hq');
    expect((await SharedPreferences.getInstance()).getString(kHqServer), 'https://box.example.net');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a device that was signed out starts sign-in with its last server', (tester) async {
    await loadFonts();
    await tester.pumpWidget(AuthGate(initial: null, hqUrl: 'https://app.hq.example.com/hq', askServer: true,
        client: AuthClient('', client: FakeHq().client, passkeys: FakePasskeys())));
    await tester.pumpAndSettle();
    expect(find.text('app.hq.example.com'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('switching servers keeps the current one until the new one lets the device in, then leaves the old one', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({kHqUrl: 'https://old.example.net/hq', kHqToken: 'tok-a'});
    final hq = FakeHq();
    await tester.pumpWidget(AuthGate(initial: FakeBackend(simulate: false), hqUrl: 'https://old.example.net/hq', askServer: true,
        client: AuthClient('', client: hq.client, passkeys: FakePasskeys(supported: false))));
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsNothing);

    // Settings → "החלפת שרת", then cancel: back in the app, nothing changed.
    kSwitchServer!();
    await tester.pumpAndSettle();
    expect(find.text('החלפת שרת'), findsOneWidget);
    expect(find.textContaining('המכשיר מחובר עכשיו ל-'), findsOneWidget);
    await tester.tap(find.text('ביטול'));
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsNothing);
    expect((await savedSession())?.token, 'tok-a');

    // A pairing link for another server: the new session replaces the old, whose device is revoked there.
    kSwitchServer!('https://new.example.net/pair?code=GOOD-CODE');
    await tester.pumpAndSettle();
    expect(find.text('new.example.net'), findsOneWidget);
    await tester.tap(find.text('צימוד'));
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsNothing);
    final s = await savedSession();
    expect(s?.baseUrl, 'https://new.example.net/hq');
    expect(s?.token, 'tok-paired');
    expect(hq.requests, containsAllInOrder(['GET /health', 'POST /api/auth/pair', 'GET /api/devices', 'POST /api/devices/dev_a/revoke']));
    expect(hq.hosts.last, 'old.example.net');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('opened from a pairing link for another server while signed in: an offer to switch, and the app stays', (tester) async {
    await loadFonts();
    SharedPreferences.setMockInitialValues({kHqUrl: 'https://old.example.net/hq', kHqToken: 'tok-a'});
    await tester.pumpWidget(AuthGate(initial: FakeBackend(simulate: false), hqUrl: 'https://old.example.net/hq', askServer: true,
        pairLink: 'agentcompany://pair?url=${Uri.encodeComponent('https://new.example.net/pair?code=GOOD-CODE')}',
        client: AuthClient('', client: FakeHq().client, passkeys: FakePasskeys(supported: false))));
    await tester.pumpAndSettle();
    expect(find.text('החלפת שרת'), findsOneWidget);
    expect(find.text('new.example.net'), findsOneWidget);
    expect(find.text('GOOD-CODE'), findsOneWidget);
    await tester.tap(find.text('ביטול'));
    await tester.pumpAndSettle();
    expect(find.byType(SignInScreen), findsNothing);
    expect((await savedSession())?.token, 'tok-a');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('typing a path by hand keeps it as typed', (tester) async {
    await pumpScreen(tester, SignInScreen(askServer: true, client: AuthClient('', client: FakeHq().client, passkeys: FakePasskeys()), onSignedIn: (_) {}));
    await tester.enterText(find.byKey(const Key('server-address')), 'app.example.com/hq');
    await tester.pump();
    expect(find.text('app.example.com/hq'), findsOneWidget);
  });
}
