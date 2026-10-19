// Dictation: the WAV the service gets, the client's Hebrew errors, and the composer's mic flow
// (record -> transcribe -> text in the field, not sent). The real service: dictate_live_test.dart.
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:agent_company/data/dictation.dart';
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
      expect(await err(client((_) => http.Response('bad token', 401))), contains('טוקן'));
      expect(await err(client((_) => http.Response('openai 500', 502))), contains('לא הצליח לתמלל'));
      expect(await err(client((_) => http.Response('{"text":"  "}', 200))), contains('לא נשמע דיבור'));
      expect(await err(client((_) => http.Response('<html>', 200))), contains('לא צפויה'));
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

    testWidgets('a long recording stops by itself at 2:00 and goes to transcription', (tester) async {
      final rec = FakeRecorder();
      Dictation.instance = Dictation(recorder: rec, client: client((_) => http.Response('{"text":"הכתבה ארוכה"}', 200, headers: {'content-type': 'application/json; charset=utf-8'})));
      await pumpApp(tester, size: const Size(342, 1500), home: const ChatScreen(identityId: 'ido'));
      await tester.tap(find.bySemanticsLabel('הכתבה'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 119));
      expect(find.text('1:59'), findsOneWidget);
      expect(rec.stops, 0);
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(rec.stops, 1);
      expect(find.text('הכתבה ארוכה'), findsOneWidget);
    });
  });
}
