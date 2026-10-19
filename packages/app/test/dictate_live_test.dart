// The real dictate-server. Skipped unless DICTATE_TEST_URL, DICTATE_TEST_TOKEN and DICTATE_TEST_WAV are set:
//   DICTATE_TEST_URL=https://dictate.203-0-113-10.sslip.io DICTATE_TEST_TOKEN=... \
//   DICTATE_TEST_WAV=$HOME/projects/dictate-server/test/s1.wav flutter test test/dictate_live_test.dart
// Its own file: once a testWidgets runs, flutter_test answers every real HTTP request with 400.
import 'dart:io';
import 'dart:typed_data';

import 'package:agent_company/data/dictation.dart';
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
}
