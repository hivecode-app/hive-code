// error-catcher against an hq server (apart from the widget tests: their binding blocks real HTTP):
// an error shown goes to POST /api/client-errors with the device's token, and hq's card for a fault
// (from the system, titled "תפסתי תקלה") is read with that title and its two answers.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/error_report.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Hq {
  late HttpServer server;
  final errors = <Map<String, dynamic>>[];
  final auth = <String?>[];

  Future<void> start() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      if (path == '/ws') {
        final ws = await WebSocketTransformer.upgrade(req);
        ws.add(jsonEncode({'type': 'live', 'seq': 1}));
        return;
      }
      Object? body;
      if (req.method == 'POST' && path == '/api/client-errors') {
        errors.add(jsonDecode(await utf8.decodeStream(req)) as Map<String, dynamic>);
        auth.add(req.headers.value('authorization'));
        body = {'ok': true, 'seq': errors.length};
      } else if (path == '/api/board') {
        body = jsonDecode(File('test/fixtures/samples/hq/board.json').readAsStringSync());
      } else if (path == '/api/toggles') {
        body = jsonDecode(File('test/fixtures/samples/hq/toggles.json').readAsStringSync());
      } else if (path == '/api/inbox') {
        body = {
          'items': [
            {'id': 90, 'kind': 'ask', 'state': 'open', 'blocking': false, 'urgency': 'normal', 'from_identity': 'hq', 'title': 'תפסתי תקלה · 14:02',
              'headline': 'שגיאה באפליקציה במסך שיחות', 'body': 'שגיאה באפליקציה במסך שיחות. פעם אחת, ב-14:02, בטלפון.', 'ref': 'err-3f9a2c11d0-1', 'created_at': 2000},
            // Another question of the system's (accounts.ts), with hq's default title: not a fault card.
            {'id': 91, 'kind': 'ask', 'state': 'open', 'blocking': false, 'urgency': 'normal', 'from_identity': 'hq', 'title': 'hq שואל/ת',
              'body': 'לחבר את החשבון?', 'ref': 'acct-1', 'created_at': 2100},
          ],
        };
      } else if (path == '/api/asks') {
        body = {
          'asks': [
            {'id': 'err-3f9a2c11d0-1', 'from_identity': 'hq', 'question': 'שגיאה באפליקציה במסך שיחות. פעם אחת, ב-14:02, בטלפון.',
              'headline': 'שגיאה באפליקציה במסך שיחות', 'options': ['לטפל', 'לא עכשיו'], 'blocking': false, 'state': 'open', 'created_at': 2000},
            {'id': 'acct-1', 'from_identity': 'hq', 'question': 'לחבר את החשבון?', 'options': ['כן', 'לא'], 'blocking': false, 'state': 'open', 'created_at': 2100},
          ],
        };
      } else {
        body = {'messages': [], 'events': []};
      }
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode(body));
      await req.response.close();
    });
  }
}

Future<void> until(bool Function() ok, {int ms = 5000}) async {
  for (var i = 0; i < ms ~/ 20 && !ok(); i++) {
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({'language': 'he', 'new_interface': false});
    ErrorReports.instance.reset();
  });
  tearDown(ErrorReports.instance.reset);

  test('hq: what waited goes once signed in, with the token; and a later one at once', () async {
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    reportShown('bar', 'לפני שהיה חיבור', screen: 'שיחות');
    expect(ErrorReports.instance.active, isFalse);
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${hq.server.port}', token: 't');
    await b.start();
    expect(ErrorReports.instance.active, isTrue);
    await until(() => hq.errors.isNotEmpty);
    expect(hq.errors.single['message'], 'לפני שהיה חיבור');
    expect(hq.auth.single, 'Bearer t');
    reportShown('screen', 'השרת לא החזיר את רשימת המכשירים.', screen: 'הגדרות · מכשירים');
    await until(() => hq.errors.length == 2);
    expect(hq.errors.last['screen'], 'הגדרות · מכשירים');
    expect(hq.errors.last['shown'], true);
    b.dispose();
    expect(ErrorReports.instance.active, isFalse, reason: 'signed out: nothing says "נשלח לטיפול"');
  });

  test('hq: a fault it caught is the manager\'s, not a card for him; its other questions are (task 986)', () async {
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${hq.server.port}', token: 't');
    addTearDown(b.dispose);
    await b.start();
    await until(() => b.data?.waiting.any((w) => w.from == 'hq') ?? false);
    expect(b.data!.waiting.where((w) => w.askId == 'err-3f9a2c11d0-1'), isEmpty);
    final other = b.data!.waiting.firstWhere((w) => w.askId == 'acct-1');
    expect(other.kicker, 'שאלה', reason: "the system's other questions keep their kicker");
    expect(other.options.map((o) => o.primary), [false, false]);
  });
}
