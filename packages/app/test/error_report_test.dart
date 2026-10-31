// error-catcher, the app's part: every error shown to him goes to hq by itself (POST /api/client-errors),
// with the version, the screen and a stack; offline it waits on the device and goes later; "נשלח לטיפול"
// shows next to it; a screen loading for 15 seconds is an error too; and hq's card for a fault
// ("תפסתי תקלה", "לטפל" / "לא עכשיו") reads well at home.
import 'dart:convert';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/error_report.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/data/hq_backend.dart' show isHis;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

final r = ErrorReports.instance;

/// A sink like hq's: what it took, and the status it answers with.
class _Sink {
  final took = <Map<String, dynamic>>[];
  int status = 200;
  Future<int> post(Map<String, dynamic> body) async {
    if (status == 200) took.add(body);
    return status;
  }
}

/// hq's card for a fault, as hq_backend.dart reads it off the inbox (kicker: the inbox title).
WaitItem _faultCard() => WaitItem(
      id: 'inbox:90',
      inboxId: 90,
      askId: 'err-3f9a2c11d0-1792613',
      kind: WaitKind.softAsk,
      from: 'hq',
      time: '14:02',
      createdAt: DateTime(2026, 10, 20, 14, 2),
      kicker: 'תפסתי תקלה · 3 פעמים מ-13:40',
      headline: 'שגיאה באפליקציה במסך הגדרות · מכשירים',
      body: 'שגיאה באפליקציה במסך הגדרות · מכשירים «השרת לא החזיר את רשימת המכשירים.». 3 פעמים, מ-13:40 עד 14:02, באפליקציה בטלפון.',
      options: const [AskOption(id: 'לטפל', label: 'לטפל', primary: true), AskOption(id: 'לא עכשיו', label: 'לא עכשיו')],
    );

/// Lets the queue's own work (the device's storage) run out of the test's fake clock.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump();
  }
}

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    r.reset();
    r.appVersion = 'android 42';
  });
  tearDown(r.reset);

  group('reportShown', () {
    test('sends the contract hq takes: kind, message, screen, version, stack, shown', () async {
      final sink = _Sink();
      r.attach(sink.post);
      r.reportShown('bar', 'השרת לא קיבל את הפעולה. אפשר לנסות שוב.', screen: 'שיחות');
      await r.flush();
      expect(sink.took, hasLength(1));
      final b = sink.took.single;
      expect(b.keys.toSet(), {'kind', 'message', 'screen', 'app_version', 'stack', 'shown'});
      expect(b['kind'], 'bar');
      expect(b['message'], 'השרת לא קיבל את הפעולה. אפשר לנסות שוב.');
      expect(b['screen'], 'שיחות');
      expect(b['app_version'], 'android 42');
      expect(b['shown'], true);
      expect(b['stack'], isNotEmpty);
    });

    test('a crash is not marked shown, and the screen comes from where he is', () async {
      final sink = _Sink();
      r.attach(sink.post);
      r.screenOf = () => 'סטטוס';
      r.reportShown('flutter', 'RenderFlex overflowed by 12 pixels', stack: '#0 main');
      await r.flush();
      expect(sink.took.single['shown'], false);
      expect(sink.took.single['screen'], 'סטטוס');
      expect(sink.took.single['stack'], '#0 main');
    });

    test('the same error again within ten minutes is not sent again', () async {
      final sink = _Sink();
      r.attach(sink.post);
      for (var i = 0; i < 5; i++) {
        r.reportShown('bar', 'אותה שגיאה', screen: 'שיחות');
      }
      r.reportShown('bar', 'שגיאה אחרת', screen: 'שיחות');
      await r.flush();
      expect(sink.took.map((b) => b['message']), ['אותה שגיאה', 'שגיאה אחרת']);
    });

    test('without hq it waits on the device, survives a restart, and goes in order once there is a link', () async {
      r.reportShown('bar', 'ראשונה', screen: 'שיחות');
      r.reportShown('screen', 'שנייה', screen: 'מחכה לך');
      await r.flush();
      expect(r.queued, hasLength(2));
      final saved = (await SharedPreferences.getInstance()).getString(kErrorQueueKey)!;
      expect((jsonDecode(saved) as List).map((e) => e['message']), ['ראשונה', 'שנייה']);

      // The app starts again: the queue is read back.
      r.reset();
      final sink = _Sink()..status = 0; // no link yet
      r.attach(sink.post);
      await r.flush();
      expect(r.queued.map((e) => e['message']), ['ראשונה', 'שנייה']);
      sink.status = 200;
      await r.flush();
      expect(sink.took.map((b) => b['message']), ['ראשונה', 'שנייה']);
      expect(r.queued, isEmpty);
      expect((await SharedPreferences.getInstance()).getString(kErrorQueueKey), isNull);
    });

    test('hq busy (429, 5xx) keeps it; a refusal (400) drops it', () async {
      final sink = _Sink()..status = 503;
      r.attach(sink.post);
      r.reportShown('bar', 'א', screen: 'שיחות');
      await r.flush();
      expect(r.queued, hasLength(1));
      sink.status = 429;
      await r.flush();
      expect(r.queued, hasLength(1));
      sink.status = 400;
      await r.flush();
      expect(r.queued, isEmpty);
    });

    test('one queued before the version was known goes with it', () async {
      r.appVersion = '';
      r.reportShown('uncaught', 'קריסה בהפעלה', screen: 'שיחות');
      r.appVersion = 'android 43';
      final sink = _Sink();
      r.attach(sink.post);
      await r.flush();
      expect(sink.took.single['app_version'], 'android 43');
    });

    test('a backend replaced before it was closed does not stop the new one', () async {
      final old = _Sink(), fresh = _Sink()..status = 503;
      r.attach(old.post);
      r.attach(fresh.post);
      r.detach(old.post);
      expect(r.active, isTrue);
      r.reportShown('bar', 'א', screen: 'שיחות');
      await r.flush();
      expect(r.queued, hasLength(1), reason: 'kept for the retry of the new one');
      fresh.status = 200;
      await r.flush();
      expect(fresh.took, hasLength(1));
      expect(old.took, isEmpty);
    });

    test('the queue keeps the newest fifty', () async {
      for (var i = 0; i < 60; i++) {
        r.reportShown('bar', 'שגיאה $i', screen: 'שיחות');
      }
      await r.flush();
      expect(r.queued, hasLength(50));
      expect(r.queued.first['message'], 'שגיאה 10');
    });
  });

  group('the store', () {
    test('an error on the bar is sent; no link and a notice are only shown', () async {
      final sink = _Sink();
      r.attach(sink.post);
      final store = AppStore(FakeBackend(simulate: false));
      store.error = 'השרת לא קיבל את הפעולה. אפשר לנסות שוב.';
      expect(store.errorReported, true);
      store.notice('אפשר לצרף עד 10 תמונות להודעה אחת.');
      expect(store.errorReported, false);
      expect(store.error, 'אפשר לצרף עד 10 תמונות להודעה אחת.');
      await r.flush();
      expect(sink.took.map((b) => b['message']), ['השרת לא קיבל את הפעולה. אפשר לנסות שוב.']);
      expect(sink.took.single['kind'], 'bar');
    });

    test('a command that did not reach hq is shown, not sent', () async {
      final sink = _Sink();
      r.attach(sink.post);
      final store = AppStore(_Refusing(const CommandResult.fail('אין חיבור לשרת, ולכן הפעולה לא נשלחה. אפשר לנסות שוב.', transient: true)));
      await store.start();
      await store.stop('dana');
      expect(store.error, startsWith('אין חיבור לשרת'));
      expect(store.errorReported, false);
      await r.flush();
      expect(sink.took, isEmpty);
    });
  });

  group('on screen', () {
    testWidgets('the error bar says "נשלח לטיפול" under an error that went', (tester) async {
      final store = await pumpApp(tester);
      r.attach((_) async => 200);
      store.error = 'השרת לא קיבל את הפעולה. אפשר לנסות שוב.';
      store.touch();
      await tester.pumpAndSettle();
      expect(find.text('נשלח לטיפול'), findsOneWidget);
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/errors/bar_light.png'));
      store.notice('אפשר לצרף עד 10 תמונות להודעה אחת.');
      store.touch();
      await tester.pumpAndSettle();
      expect(find.text('נשלח לטיפול'), findsNothing);
    });

    testWidgets('a screen error is sent once and says so; one that is his to fix is not', (tester) async {
      final store = await pumpApp(tester, home: const SizedBox());
      final took = <Map<String, dynamic>>[];
      r.attach((b) async {
        took.add(b);
        return 200;
      });
      Widget host(String text, {bool report = true}) =>
          CompanyApp(store: store, themeMode: ThemeMode.light, home: Scaffold(body: ShownError(text, screen: 'הגדרות · מכשירים', report: report)));
      await tester.pumpWidget(host('השרת לא החזיר את רשימת המכשירים.'));
      await tester.pump();
      await tester.pumpWidget(host('השרת לא החזיר את רשימת המכשירים.'));
      await tester.pump();
      expect(find.text('נשלח לטיפול'), findsOneWidget);
      await tester.pumpWidget(host('הקוד שגוי, כבר שומש או שפג תוקפו.', report: false));
      await tester.pump();
      expect(find.text('נשלח לטיפול'), findsNothing);
      await _settle(tester);
      expect(took.map((b) => b['message']), ['השרת לא החזיר את רשימת המכשירים.']);
      expect(took.single['screen'], 'הגדרות · מכשירים');
    });

    testWidgets('loading for 15 seconds is an error: sent, and "נשלח לטיפול" under the spinner', (tester) async {
      final store = await pumpApp(tester, home: const SizedBox());
      final took = <Map<String, dynamic>>[];
      r.attach((b) async {
        took.add(b);
        return 200;
      });
      await tester.pumpWidget(CompanyApp(store: store, home: const Scaffold(body: Center(child: LoadingWatch(screen: 'טעינה ראשונה', child: Text('מתעדכן'))))));
      await tester.pump(const Duration(seconds: 14));
      expect(find.text('נשלח לטיפול'), findsNothing);
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('נשלח לטיפול'), findsOneWidget);
      await _settle(tester);
      expect(took.single['kind'], 'stuck');
      expect(took.single['screen'], 'טעינה ראשונה');
      expect(took.single['message'], contains('15'));
    });

    testWidgets('done loading before 15 seconds: nothing', (tester) async {
      await pumpApp(tester, home: const SizedBox());
      final took = <Map<String, dynamic>>[];
      r.attach((b) async {
        took.add(b);
        return 200;
      });
      await tester.pumpWidget(const MaterialApp(home: LoadingWatch(screen: 'טעינה ראשונה', child: Text('מתעדכן'))));
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpWidget(const MaterialApp(home: Text('מוכן')));
      await tester.pump(const Duration(seconds: 20));
      await _settle(tester);
      expect(took, isEmpty);
    });

    test('a fault hq caught is the manager\'s, not his: it never reaches what waits on him (task 986)', () {
      expect(isCaughtFault(_faultCard().from, _faultCard().askId), isTrue);
      expect(isHis(_faultCard()), isFalse);
    });
  });

}

/// A backend whose every command comes back with [result].
class _Refusing extends FakeBackend {
  _Refusing(this.result) : super(simulate: false);
  final CommandResult result;
  @override
  Future<CommandResult> stop(String identityId) async => result;
}
