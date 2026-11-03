// The real dictate-server. Skipped unless DICTATE_TEST_URL, DICTATE_TEST_TOKEN and DICTATE_TEST_WAV are set:
//   DICTATE_TEST_URL=https://dictate.203-0-113-10.sslip.io DICTATE_TEST_TOKEN=... \
//   DICTATE_TEST_WAV=$HOME/projects/dictate-server/test/s1.wav flutter test test/dictate_live_test.dart
// Its own file: once a testWidgets runs, flutter_test answers every real HTTP request with 400.
import 'dart:io';
import 'dart:typed_data';

import 'package:agent_company/data/dictation.dart';
import 'package:agent_company/data/dictation_files.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final url = Platform.environment['DICTATE_TEST_URL'];
  final token = Platform.environment['DICTATE_TEST_TOKEN'];
  final wav = Platform.environment['DICTATE_TEST_WAV'];
  final skip = url == null || token == null || wav == null ? 'DICTATE_TEST_URL/TOKEN/WAV not set' : null;

  test('a short Hebrew recording comes back as Hebrew text', () async {
    // Rebuild the WAV from its PCM, the way the app does after recording.
    final pcm = Uint8List.sublistView(File(wav!).readAsBytesSync(), 44);
    final text = await DictateClient(baseUrl: url!, token: token!).transcribe(wavFromPcm(pcm));
    // ignore: avoid_print
    print('dictate-server: $text');
    expect(text, matches(RegExp(r'[֐-׿]')));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 1)));

  test('a wrong token is reported in Hebrew', () async {
    await expectLater(
      DictateClient(baseUrl: url!, token: 'wrong').transcribe(Uint8List(0)),
      throwsA(isA<DictationError>().having((e) => e.message, 'message', contains('טוקן'))),
    );
  }, skip: skip);

  test('five minutes go out in pieces, with upload progress, and come back as one text', () async {
    final one = Uint8List.sublistView(File(wav!).readAsBytesSync(), 44);
    final pcm = Uint8List(kDictateRate * 2 * 300);
    for (var at = 0; at < pcm.length; at += one.length) {
      pcm.setRange(at, at + one.length > pcm.length ? pcm.length : at + one.length, one);
    }
    final jobs = DictationJobs(MemoryDictationFiles());
    final job = await jobs.add('live', pcm);
    final ticks = <double>[];
    jobs.addListener(() => ticks.add(job.sent));
    final t = Stopwatch()..start();
    await jobs.run(job, DictateClient(baseUrl: url!, token: token!));
    final text = jobs.take('live')!;
    // ignore: avoid_print
    print('${job.pieces} pieces, ${ticks.toSet().length} progress steps, ${t.elapsedMilliseconds} ms: ${text.length} chars');
    expect(job.pieces, inInclusiveRange(5, 6)); // cuts land at the quiet spot before each minute
    expect(ticks.toSet().length, greaterThan(10));
    expect(text, matches(RegExp(r'[֐-׿]')));
  }, skip: skip, timeout: const Timeout(Duration(minutes: 3)));
}
