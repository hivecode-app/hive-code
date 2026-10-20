// "לא עכשיו" and closing a card are kept by hq (#74): after a full reload from the server the card is
// where he left it, never open again. hq here keeps its inbox like the real one (inbox.ts snooze/dismiss).
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Hq {
  late HttpServer server;
  final calls = <String>[];
  final items = [
    {'id': 16, 'kind': 'ask', 'state': 'open', 'from_identity': 'yoav', 'title': 'יואב שואל', 'body': 'להעביר?', 'ref': 'ask-16', 'blocking': true, 'created_at': 1000, 'snoozed_at': null},
    {'id': 17, 'kind': 'go', 'state': 'open', 'from_identity': 'yoav', 'title': 'GO', 'body': 'פריסה', 'blocking': true, 'created_at': 2000, 'snoozed_at': null},
  ];

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
      final cmd = RegExp(r'^/api/inbox/(\d+)/(\w+)$').firstMatch(path);
      if (req.method == 'POST' && cmd != null) {
        final b = jsonDecode(await utf8.decodeStream(req)) as Map<String, dynamic>;
        calls.add('${cmd[2]} ${cmd[1]}');
        final it = items.firstWhere((i) => i['id'] == int.parse(cmd[1]!));
        if (cmd[2] == 'snooze') it['snoozed_at'] = b['on'] == false ? null : 5000;
        if (cmd[2] == 'dismiss') it['state'] = 'dismissed';
        body = {'item': it};
      } else if (path == '/api/inbox') {
        body = {'items': items.where((i) => i['state'] == 'open').toList()};
      } else if (path == '/api/asks') {
        body = {
          'asks': [
            {'id': 'ask-16', 'from_identity': 'yoav', 'question': 'להעביר?', 'options': ['כן', 'לא'], 'blocking': true, 'state': 'open', 'created_at': 1000},
          ],
        };
      } else if (path == '/api/board' || path == '/api/toggles') {
        body = jsonDecode(File('test/fixtures/samples/hq/${path.substring(5)}.json').readAsStringSync());
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
  // hq's texts in these fixtures name רן: the names his org.yaml gives (an older hq's board has none).
  setUpAll(() => companyNames = const CompanyNames(ownerId: 'ran', owner: 'רן', ownerGender: Gender.m, managerId: 'yoav', manager: 'יואב', managerGender: Gender.m));

  test('"לא עכשיו", its undo and closing survive a full reload from hq', () async {
    SharedPreferences.setMockInitialValues({});
    final hq = _Hq();
    await hq.start();
    addTearDown(() => hq.server.close(force: true));
    final b = HqBackend(baseUrl: 'http://127.0.0.1:${hq.server.port}', token: 't');
    addTearDown(b.dispose);
    await b.start();
    await until(() => b.data!.waiting.length == 2);
    WaitItem item(int id) => b.data!.waiting.firstWhere((w) => w.inboxId == id);

    // לא עכשיו on the question, then a reload: still put off, not open again.
    expect((await b.notNow(item(16))).ok, isTrue);
    expect(hq.calls, ['snooze 16']);
    await b.debugReload();
    expect(item(16).state, WaitState.notNow, reason: 'the reload does not bring it back');

    // ביטול: open again, after a reload too.
    expect((await b.resume(item(16))).ok, isTrue);
    await b.debugReload();
    expect(item(16).state, WaitState.open);

    // סגירה waits its 3 seconds like any one-tap answer: "ביטול" inside them sends nothing.
    final store = AppStore(b, undoSeconds: 1);
    addTearDown(store.dispose);
    final go = item(17);
    expect((await b.notNow(go)).ok, isTrue);
    store.dismiss(go);
    expect(store.pending('inbox:17')!.label, "ייסגר בעוד 1 שנ'");
    store.cancelUndo('inbox:17');
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    expect(hq.calls.where((c) => c.startsWith('dismiss')), isEmpty);

    // ...and without it: closed, and gone after the reload, for good.
    store.dismiss(go);
    await until(() => go.state == WaitState.answered);
    expect(hq.calls.last, 'dismiss 17');
    expect(go.answerLine, 'נסגר', reason: 'this hq told no one: no claim that it did');
    await b.debugReload();
    expect(b.data!.waiting.map((w) => w.inboxId), [16], reason: 'a closed card does not come back');
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a closed question reads as closed on its card', () {
    expect(answerText('רן סגר את השאלה בלי תשובה: הבוטים'), ('נסגר', true));
    expect(answerText('רן דחה: GO: x'), ('נסגר', true));
  });

  test("another owner's names: hq's lines read by her name and gender", () {
    final was = companyNames;
    companyNames = CompanyNames.fromJson({
      'owner': {'id': 'dana', 'name': 'דנה', 'gender': 'female'},
      'manager': {'id': 'mira', 'name': 'מירה', 'gender': 'female'},
    });
    addTearDown(() => companyNames = was);
    expect(answerText('דנה סגרה את השאלה בלי תשובה: הבוטים'), ('נסגר', true));
    expect(answerText('דנה דחתה: GO: x'), ('נסגר', true));
    expect(answerText('דנה סיימה: x'), ('סיימתי', true));
    expect(answerText('תשובה של דנה על "x": כן'), ('כן', false));
    expect(answerText('רן דחה: GO: x'), ('רן דחה: GO: x', false));
    expect(companyNames.manager, 'מירה');
  });
}
