// Dictation: the WAV the service gets, the client's Hebrew errors, and the composer's mic flow
// (record -> transcribe -> text in the field, not sent). The real service: dictate_live_test.dart.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/dictation.dart';
import 'package:agent_company/data/dictation_files.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers.dart';

class FakeRecorder implements Recorder {
  FakeRecorder({this.pcm, this.startError, this.gate});
  Uint8List? pcm;
  DictationError? startError;
  Completer<void>? gate; // holds start() open, like a permission prompt
  bool started = false, cancelled = false;
  int starts = 0, stops = 0;
  @override
  Future<void> start() async {
    starts++;
    if (gate != null) await gate!.future;
    if (startError != null) throw startError!;
    started = true;
  }

  @override
  Future<Uint8List> stop() async {
    stops++;
    return pcm ?? Uint8List(kDictateRate * 2);
  }
  @override
  Future<void> cancel() async => cancelled = true;
}

DictateClient client(http.Response Function(http.Request) answer) =>
    DictateClient(baseUrl: 'https://d.example/dictate', token: 'gateway', client: MockClient((r) async => answer(r)));

void main() {
  test('wavFromPcm writes a 16 kHz mono 16-bit header', () {
    final wav = wavFromPcm(Uint8List(320));
    final b = ByteData.sublistView(wav);
    expect(String.fromCharCodes(wav.sublist(0, 4)), 'RIFF');
    expect(String.fromCharCodes(wav.sublist(8, 16)), 'WAVEfmt ');
    expect(b.getUint32(4, Endian.little), 36 + 320);
    expect(b.getUint16(22, Endian.little), 1);
    expect(b.getUint32(24, Endian.little), 16000);
    expect(b.getUint16(34, Endian.little), 16);
    expect(b.getUint32(40, Endian.little), 320);
    expect(wav.length, 44 + 320);
  });

  group('DictateClient', () {
    test('posts the WAV as multipart with the token and returns the text', () async {
      late http.Request seen;
      final c = DictateClient(
        baseUrl: 'https://d.example/dictate/',
        token: 'gateway',
        client: MockClient((r) async {
          seen = r;
          return http.Response('{"text":"שלום","ms":900,"engine":"openai"}', 200, headers: {'content-type': 'application/json; charset=utf-8'});
        }),
      );
      expect(await c.transcribe(wavFromPcm(Uint8List(4))), 'שלום');
      expect(seen.url.toString(), 'https://d.example/dictate/transcribe');
      expect(seen.headers['authorization'], 'Bearer gateway');
      expect(seen.headers['content-type'], startsWith('multipart/form-data'));
      final body = String.fromCharCodes(seen.bodyBytes);
      expect(body, contains('name="audio"; filename="audio.wav"'));
      expect(body, contains('name="engine"'));
      expect(body, contains('RIFF'));
    });

    test('Hebrew text comes back as UTF-8, trimmed', () async {
      final c = client((_) => http.Response('{"text":" שלום עולם "}', 200, headers: {'content-type': 'application/json; charset=utf-8'}));
      expect(await c.transcribe(Uint8List(0)), 'שלום עולם');
    });

    Future<String> err(DictateClient c) async {
      try {
        await c.transcribe(Uint8List(0));
      } on DictationError catch (e) {
        return e.message;
      }
      fail('expected DictationError');
    }

    test('network failure is reported in Hebrew', () async {
      final c = DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((_) => throw const SocketException('down')));
      expect(await err(c), 'אין חיבור לשירות ההכתבה, ולכן ההקלטה לא תומללה. אפשר לנסות שוב.');
    });
    test('bad token, server error, empty text', () async {
      expect(await err(client((_) => http.Response('bad token', 401))), contains('החיבור'));
      expect(await err(client((_) => http.Response('openai 500', 502))), contains('לא הצליח לתמלל'));
      expect(await err(client((_) => http.Response('{"text":"  "}', 200))), contains('לא נשמע דיבור'));
      expect(await err(client((_) => http.Response('<html>', 200))), contains('לא צפויה'));
    });

    test('through hq: posts to <hq>/api/dictate/transcribe with the device token', () async {
      late http.Request seen;
      final c = DictateClient.viaHq(
        () async => const Session('https://app.example/hq', 'dev-token'),
        client: MockClient((r) async {
          seen = r;
          return http.Response('{"text":"שלום"}', 200, headers: {'content-type': 'application/json; charset=utf-8'});
        }),
      );
      expect(await c.transcribe(wavFromPcm(Uint8List(4))), 'שלום');
      expect(seen.url.toString(), 'https://app.example/hq/api/dictate/transcribe');
      expect(seen.headers['authorization'], 'Bearer dev-token');
    });

    test('through hq: no session or a revoked device is a Hebrew error, nothing is sent without a session', () async {
      var sent = 0;
      final none = DictateClient.viaHq(() async => null, client: MockClient((_) async { sent++; return http.Response('', 200); }));
      expect(await err(none), contains('ממכשיר מחובר'));
      expect(sent, 0);
      final revoked = DictateClient.viaHq(() async => const Session('https://app.example/hq', 'old'),
          client: MockClient((_) async => http.Response('{"error":"unauthorized"}', 401)));
      expect(await err(revoked), contains('להתחבר מחדש'));
    });
  });

  group('composer mic', () {
    testWidgets('record, stop: the text lands in the field and is not sent', (tester) async {
      final rec = FakeRecorder();
      Dictation.instance = Dictation(recorder: rec, client: client((_) => http.Response('{"text":"תבדוק את הבילד"}', 200, headers: {'content-type': 'application/json; charset=utf-8'})));
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      final sentBefore = store.data!.chats['ido']!.items.whereType<UserMsg>().length;
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      expect(rec.started, isTrue);
      expect(find.text('0:00'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      await tester.pump();
      await tester.pump();
      expect(find.text('תבדוק את הבילד'), findsOneWidget);
      expect(find.bySemanticsLabel('שליחה'), findsOneWidget);
      expect(store.data!.chats['ido']!.items.whereType<UserMsg>().length, sentBefore);
    });

    testWidgets('a network error shows in Hebrew and the field stays empty', (tester) async {
      Dictation.instance = Dictation(
          recorder: FakeRecorder(),
          client: DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((_) => throw const SocketException('down'))));
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      await tester.pump();
      await tester.pump();
      expect(store.error, 'אין חיבור לשירות ההכתבה, ולכן ההקלטה לא תומללה. אפשר לנסות שוב.');
      expect(find.bySemanticsLabel('הכתבה'), findsOneWidget);
    });

    testWidgets('no microphone permission: Hebrew error, no recording', (tester) async {
      Dictation.instance = Dictation(
          recorder: FakeRecorder(startError: const DictationError('אין הרשאה למיקרופון. אפשר לאשר אותה בהגדרות המכשיר ולנסות שוב.')),
          client: client((_) => http.Response('{}', 200)));
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      expect(store.error, startsWith('אין הרשאה למיקרופון'));
      expect(find.bySemanticsLabel('עצירת ההקלטה'), findsNothing);
    });

    testWidgets('cancel drops the recording', (tester) async {
      final rec = FakeRecorder();
      Dictation.instance = Dictation(recorder: rec, client: client((_) => fail('nothing should be sent')));
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.text('ביטול'));
      await tester.pump();
      expect(rec.cancelled, isTrue);
      expect(find.bySemanticsLabel('הכתבה'), findsOneWidget);
    });

    testWidgets('taps while the mic is starting do not start a second recording', (tester) async {
      final rec = FakeRecorder(gate: Completer<void>());
      Dictation.instance = Dictation(recorder: rec, client: client((_) => http.Response('{"text":"א"}', 200)));
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      rec.gate!.complete();
      await tester.pump();
      expect(rec.starts, 1);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('0:03'), findsOneWidget);
      await tester.tap(find.text('ביטול'));
      await tester.pump();
    });

    testWidgets('a long recording stops by itself at 13:00 and goes to transcription', (tester) async {
      final rec = FakeRecorder();
      Dictation.instance = Dictation(recorder: rec, client: client((_) => http.Response('{"text":"הכתבה ארוכה"}', 200, headers: {'content-type': 'application/json; charset=utf-8'})));
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 13 * 60 - 1));
      expect(find.text('12:59'), findsOneWidget);
      expect(rec.stops, 0);
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(rec.stops, 1);
      expect(find.text('הכתבה ארוכה'), findsOneWidget);
    });

    testWidgets('a failed recording is kept: "לנסות שוב" sends it again and the text lands in the field', (tester) async {
      var up = false;
      final jobs = DictationJobs(MemoryDictationFiles());
      Dictation.instance = Dictation(
        recorder: FakeRecorder(),
        jobs: jobs,
        client: DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((_) async {
          if (!up) throw const SocketException('down');
          return http.Response('{"text":"עכשיו זה עבר"}', 200, headers: {'content-type': 'application/json; charset=utf-8'});
        })),
      );
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      await tester.pump();
      await tester.pump();
      expect(store.error, contains('אין חיבור'));
      expect(jobs.of('ido'), hasLength(1));
      expect(find.text('לנסות שוב'), findsOneWidget);
      up = true;
      await tester.tap(find.text('לנסות שוב'));
      await tester.pump();
      await tester.pump();
      expect(find.text('עכשיו זה עבר'), findsOneWidget);
      expect(find.text('לנסות שוב'), findsNothing);
      expect(jobs.pending, isEmpty);
    });

    testWidgets('a recording kept by an earlier run of the app shows with "לנסות שוב"', (tester) async {
      final files = MemoryDictationFiles();
      final pcm = Uint8List(kDictateRate * 2 * 3);
      await files.write('1-0', PendingDictation(id: '1-0', identityId: 'ido', at: DateTime(2026, 10, 20, 0, 48), seconds: 3, texts: [null]).toJson(), pcm: pcm);
      final jobs = DictationJobs(files);
      Dictation.instance = Dictation(
          recorder: FakeRecorder(),
          jobs: jobs,
          client: client((_) => http.Response('{"text":"מהפעם הקודמת"}', 200, headers: {'content-type': 'application/json; charset=utf-8'})));
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.pump();
      expect(find.text('הקלטה מ-00:48 (0:03) לא תומללה'), findsOneWidget);
      await tester.tap(find.text('לנסות שוב'));
      await tester.pump();
      await tester.pump();
      expect(find.text('מהפעם הקודמת'), findsOneWidget);
      expect(files.meta, isEmpty);
      expect(files.audio, isEmpty);
    });

    testWidgets('while it goes out: which piece, how much was sent, and for how long', (tester) async {
      final answer = Completer<http.Response>();
      var calls = 0;
      Dictation.instance = Dictation(
          recorder: FakeRecorder(pcm: Uint8List(kDictateRate * 2 * 150)),
          client: client((_) => http.Response('', 500)).withHttp(MockClient((_) {
            calls++;
            return answer.future;
          })));
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('חלק 1 מתוך 3 · מתמלל'), findsOneWidget);
      expect(find.text('0:02'), findsOneWidget);
      answer.complete(http.Response('{"text":"א"}', 200, headers: {'content-type': 'application/json; charset=utf-8'}));
      await tester.pump();
      await tester.pump();
      expect(calls, 3);
      expect(find.text('א א א'), findsOneWidget);
    });

    testWidgets('no answer: the request is dropped after the timeout and the recording is kept', (tester) async {
      final jobs = DictationJobs(MemoryDictationFiles());
      Dictation.instance = Dictation(recorder: FakeRecorder(), jobs: jobs, client: DictateClient(baseUrl: 'https://d.example', token: 't', client: _Hanging()));
      final store = await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('מתמלל'), findsOneWidget);
      await tester.pump(DictateClient.answerTimeout + const Duration(seconds: 1));
      await tester.pump();
      expect(store.error, contains('אין חיבור'));
      expect(find.text('לנסות שוב'), findsOneWidget);
      expect(jobs.of('ido'), hasLength(1));
    });
  });

  group('the text reaches its own chat', () {
    // One answer per request, released by the test.
    (Dictation, List<Completer<http.Response>>) gated({DictationJobs? jobs}) {
      final answers = <Completer<http.Response>>[];
      final d = Dictation(
        recorder: FakeRecorder(),
        jobs: jobs,
        client: DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((_) {
          final c = Completer<http.Response>();
          answers.add(c);
          return c.future;
        })),
      );
      return (d, answers);
    }

    http.Response ok(String text) => http.Response('{"text":"$text"}', 200, headers: {'content-type': 'application/json; charset=utf-8'});

    Future<void> record(WidgetTester tester) async {
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      await tester.pump();
      await tester.pump();
    }

    testWidgets('he leaves the chat while it goes out and comes back: the text is in the field, also after typing', (tester) async {
      final (d, answers) = gated();
      Dictation.instance = d;
      final shown = ValueNotifier<int?>(0);
      final store = await pumpApp(tester, size: const Size(342, 1500), home: _Host(shown, id: 'ido'));
      await record(tester);
      expect(answers, hasLength(1));
      shown.value = null; // back to the list
      await tester.pump();
      shown.value = 1; // a new ChatScreen, as the phone opens one
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('מתמלל'), findsOneWidget);
      answers.single.complete(ok('חזרתי לשיחה'));
      await tester.pump();
      await tester.pump();
      expect(find.text('חזרתי לשיחה'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'חזרתי לשיחה ועוד');
      await tester.pump();
      expect(store.data!.chats['ido']!.draft, 'חזרתי לשיחה ועוד');
      expect(d.jobs.pending, isEmpty);
    });

    testWidgets('closed right after stop: it still goes out, and the text waits for the chat', (tester) async {
      final (d, answers) = gated();
      Dictation.instance = d;
      final shown = ValueNotifier<int?>(0);
      await pumpApp(tester, size: const Size(342, 1500), home: _Host(shown, id: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.tap(find.bySemanticsLabel('עצירת ההקלטה'));
      shown.value = null; // gone before stop() and the save came back
      await tester.pump();
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(answers, hasLength(1));
      answers.single.complete(ok('לא הלך לאיבוד'));
      await tester.pump();
      await tester.pump();
      expect(d.jobs.of('ido').single.done, isTrue);
      shown.value = 1;
      await tester.pump();
      await tester.pump();
      expect(find.text('לא הלך לאיבוד'), findsOneWidget);
    });

    testWidgets('desktop: he picks another chat while it goes out; the text goes to the chat it was recorded in', (tester) async {
      final (d, answers) = gated();
      Dictation.instance = d;
      final id = ValueNotifier('ido');
      await pumpApp(tester, size: const Size(342, 1500), home: _Desk(id));
      await record(tester);
      id.value = 'dana'; // same ChatScreen and Composer, no key: didUpdateWidget
      await tester.pump();
      expect(find.textContaining('מתמלל'), findsNothing);
      answers.single.complete(ok('לעידו בלבד'));
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('לעידו בלבד'), findsNothing);
      id.value = 'ido';
      await tester.pump();
      await tester.pump();
      expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, endsWith(' לעידו בלבד'));
    });

    testWidgets('a recording of yesterday says so, and "לנסות שוב" waits while another one goes out', (tester) async {
      final files = MemoryDictationFiles();
      final y = kDemoNow.subtract(const Duration(days: 1));
      final pcm = Uint8List(kDictateRate * 2 * 3);
      for (final (i, at) in [y, kDemoNow.subtract(const Duration(minutes: 5))].indexed) {
        await files.write('$i', PendingDictation(id: '$i', identityId: 'ido', at: at, seconds: 3, texts: [null]).toJson(), pcm: pcm);
      }
      final (d, answers) = gated(jobs: DictationJobs(files));
      Dictation.instance = d;
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.pump();
      expect(find.textContaining('מאתמול, '), findsOneWidget);
      expect(find.text('לנסות שוב'), findsNWidgets(2));
      await tester.tap(find.text('לנסות שוב').first);
      await tester.pump();
      await tester.pump();
      final retry = tester.widget<TextButton>(find.ancestor(of: find.text('לנסות שוב'), matching: find.byType(TextButton)));
      expect(retry.onPressed, isNull);
      answers.single.complete(ok('אתמול'));
      await tester.pump();
      await tester.pump();
      expect(find.text('אתמול'), findsOneWidget);
    });
  });

  group('long recordings', () {
    test('splitPcm: pieces of at most a minute, cut where it is quiet, nothing lost', () {
      final pcm = Uint8List(kDictateRate * 2 * 150);
      final b = ByteData.sublistView(pcm);
      for (var i = 0; i < pcm.length; i += 2) {
        b.setInt16(i, 3000, Endian.little);
      }
      // A quiet 200 ms at 55 s: the first cut goes there.
      final q = kDictateRate * 2 * 55;
      for (var i = q; i < q + kDictateRate * 2 ~/ 5; i += 2) {
        b.setInt16(i, 0, Endian.little);
      }
      final parts = splitPcm(pcm);
      expect(parts, hasLength(3));
      expect(parts.fold<int>(0, (n, p) => n + p.length), pcm.length);
      for (final p in parts) {
        expect(p.length, lessThanOrEqualTo(kDictateRate * 2 * 60));
        expect(p.length.isEven, isTrue);
      }
      expect(parts.first.length, inInclusiveRange(q, q + kDictateRate * 2 ~/ 5));
      expect(splitPcm(Uint8List(kDictateRate * 2 * 30)), hasLength(1));
    });

    test('splitPcm: cuts on a sample at any rate, and pieces shorter than the 10 s window', () {
      for (final (rate, secs) in [(22050, 60), (16000, 5), (11025, 3)]) {
        final pcm = Uint8List(rate * 2 * 23 + 2);
        final parts = splitPcm(pcm, seconds: secs, rate: rate);
        expect(parts.fold<int>(0, (n, p) => n + p.length), pcm.length, reason: '$rate/$secs');
        for (final p in parts) {
          expect(p.length.isEven, isTrue, reason: '$rate/$secs');
          expect(p.length, lessThanOrEqualTo(rate * 2 * secs));
          expect(p.length, greaterThan(0));
        }
      }
    });

    testWidgets('no upload progress for 30 s: the request is dropped', (tester) async {
      Object? err;
      unawaited(DictateClient(baseUrl: 'https://d.example', token: 't', client: _Stuck()).transcribe(Uint8List(100)).then((_) {}, onError: (Object e) => err = e));
      await tester.pump(DictateClient.stallTimeout - const Duration(seconds: 1));
      expect(err, isNull);
      await tester.pump(const Duration(seconds: 2));
      expect(err, isA<DictationError>().having((e) => e.message, 'message', contains('אין חיבור')));
    });

    test('a piece that fails keeps what was done; the retry sends only the rest', () async {
      final files = MemoryDictationFiles();
      final jobs = DictationJobs(files);
      final sent = <int>[];
      var fail = true;
      final c = DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((r) async {
        sent.add(r.bodyBytes.length);
        if (sent.length == 2 && fail) return http.Response('openai 500', 502);
        return http.Response('{"text":"חלק${sent.length}"}', 200, headers: {'content-type': 'application/json; charset=utf-8'});
      }));
      final job = await jobs.add('ido', Uint8List(kDictateRate * 2 * 130));
      expect(job.pieces, 3);
      expect(files.audio, contains(job.id));
      await expectLater(jobs.run(job, c), throwsA(isA<DictationError>()));
      expect(job.texts, ['חלק1', null, null]);
      expect(job.error, contains('לא הצליח לתמלל'));
      expect(files.meta[job.id], contains('חלק1'));
      fail = false;
      await jobs.run(job, c);
      expect(sent, hasLength(4));
      // All text now, but kept until the composer of its chat takes it.
      expect(files.audio, contains(job.id));
      expect(jobs.take('dana'), isNull);
      expect(jobs.take('ido'), 'חלק1 חלק3 חלק4');
      await pumpEventQueue();
      expect(jobs.pending, isEmpty);
      expect(files.audio, isEmpty);
    });

    test('a recording that is all silence is dropped with the no-speech notice', () async {
      final jobs = DictationJobs(MemoryDictationFiles());
      final job = await jobs.add('ido', Uint8List(kDictateRate * 2 * 70));
      await expectLater(jobs.run(job, client((_) => http.Response('{"text":""}', 200))), throwsA(kNoSpeech));
      expect(jobs.pending, isEmpty);
    });
  });
}

/// Takes no byte of the upload and never answers, until the request is aborted.
class _Stuck extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    await (request as http.Abortable).abortTrigger;
    throw http.RequestAbortedException(request.url);
  }
}

/// The phone: leaving a chat disposes its screen, and opening it again builds a new one ([shown]: its key; null: no chat).
class _Host extends StatelessWidget {
  const _Host(this.shown, {required this.id});
  final ValueNotifier<int?> shown;
  final String id;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: shown,
        builder: (_, k, _) => k == null ? const Scaffold() : ChatScreen(key: ValueKey(k), identityId: id),
      );
}

/// The desktop: one ChatScreen, its chat changed in place (desktop.dart builds it without a key).
class _Desk extends StatelessWidget {
  const _Desk(this.id);
  final ValueNotifier<String> id;
  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
        valueListenable: id,
        builder: (_, v, _) => Scaffold(body: ChatScreen(identityId: v, embedded: true)),
      );
}

/// Takes the whole upload and never answers, until the request is aborted.
class _Hanging extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    await request.finalize().drain<void>();
    await (request as http.Abortable).abortTrigger;
    throw http.RequestAbortedException(request.url);
  }
}

extension on DictateClient {
  DictateClient withHttp(http.Client c) => DictateClient(baseUrl: baseUrl, token: token, client: c);
}
