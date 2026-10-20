// One app for every server (docs/generic/PLAN.md §2): which server a device uses, and what an older
// build left in its prefs. A device that is signed in today stays signed in, to the same server.
import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/backend_select.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const live = 'https://app.hq.example.com/hq';

Future<SharedPreferences> prefs(Map<String, Object> v) async {
  SharedPreferences.setMockInitialValues(v);
  return SharedPreferences.getInstance();
}

void main() {
  test('a device signed in by a build with HQ_URL built in keeps its session, and that server becomes its own', () async {
    final p = await prefs({kHqUrl: live, kHqToken: 'tok', HqBackend.kCacheKey: '{}'});
    final b = await selectBackend();
    expect(b, isA<HqBackend>());
    expect((b! as HqBackend).baseUrl, live);
    expect((await savedSession())!.token, 'tok');
    expect(p.getString(kHqServer), 'https://app.hq.example.com');
    expect(p.getString(HqBackend.kCacheKey), '{}', reason: 'the snapshot stays: nothing changed for this device');
    expect(await initialServer(), live);
    b.dispose();
  });

  test('a session saved under the old secret path moves to <origin>/hq, token kept', () async {
    final p = await prefs({kHqUrl: 'https://app.hq.example.com/00000000000000000000000000000000/hq', kHqToken: 'tok'});
    expect((await savedSession())!.baseUrl, live);
    expect(p.getString(kHqToken), 'tok');
  });

  test('another host or path stays as it is; nothing saved means no server yet', () async {
    await prefs({kHqUrl: 'https://app.hq.example.com/qa/hq', kHqToken: 'tok'});
    expect((await savedSession())!.baseUrl, 'https://app.hq.example.com/qa/hq');
    await prefs({kHqUrl: 'https://api.hq.example.com', kHqToken: 'tok'});
    expect((await savedSession())!.baseUrl, 'https://api.hq.example.com');
    await prefs({});
    expect(await savedSession(), isNull);
    expect(await initialServer(), '');
  });

  test('signing out keeps the server for the next sign-in; signing in elsewhere replaces it', () async {
    final p = await prefs({kHqUrl: live, kHqToken: 'tok'});
    await savedSession();
    await clearSession();
    expect(await savedSession(), isNull);
    expect(await initialServer(), live);
    await saveSession(const Session('https://box.tail1.ts.net/hq', 'tok2'));
    expect(p.getString(kHqServer), 'https://box.tail1.ts.net');
    expect(await initialServer(), 'https://box.tail1.ts.net/hq');
  });

  test('parseServer: links, QR and typed addresses', () {
    void same(String input, String origin, [String? code]) {
      final t = parseServer(input);
      expect(t, isNotNull, reason: input);
      expect(t!.origin, origin, reason: input);
      expect(t.code, code, reason: input);
    }

    same('https://box.tail1.ts.net/pair?code=abcd-efgh', 'https://box.tail1.ts.net', 'ABCD-EFGH');
    same('https://app.hq.example.com/?pair=K7QM-2XPA', 'https://app.hq.example.com', 'K7QM-2XPA');
    same('agentcompany://pair?url=${Uri.encodeComponent('https://box.tail1.ts.net/pair?code=ABCD-EFGH')}', 'https://box.tail1.ts.net', 'ABCD-EFGH');
    same('  app.hq.example.com ', 'https://app.hq.example.com');
    same('https://app.hq.example.com/hq', 'https://app.hq.example.com');
    same('company.example.com:8443', 'https://company.example.com:8443');
    same('http://10.0.2.2:7420', 'http://10.0.2.2:7420');
    expect(parseServer('https://box.tail1.ts.net/pair?code=X')!.hqUrl, 'https://box.tail1.ts.net/hq');

    for (final bad in ['', 'http://app.example.com', 'ftp://x.example.com', 'not a host', 'https://user:pw@x.example.com', 'intranet',
      'agentcompany://pair?url=agentcompany%3A%2F%2Fpair']) {
      expect(parseServer(bad), isNull, reason: bad);
    }
  });

  test('serverHost: what a person reads', () {
    expect(serverHost(live), 'app.hq.example.com');
    expect(serverHost('https://company.example.com:8443/hq'), 'company.example.com:8443');
  });
}
