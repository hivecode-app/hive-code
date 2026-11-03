// The composer's dictation states on the phone (342 px), light, dark and text at 130%: a recording kept after
// a failure (from today and from yesterday, with "לנסות שוב" and "מחיקה"), and one on its way ("חלק 2 מתוך 5 · שולח 40%").
import 'dart:typed_data';

import 'package:agent_company/data/dictation.dart';
import 'package:agent_company/data/dictation_files.dart';
import 'package:agent_company/ui/chat/chat_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers.dart';

PendingDictation _job(String id, DateTime at, int seconds, int pieces) =>
    PendingDictation(id: id, identityId: 'ido', at: at, seconds: seconds, texts: List.filled(pieces, null), pcm: Uint8List(0));

void main() {
  for (final (look, dark, scale) in [('light', false, 1.0), ('dark', true, 1.0), ('text13', false, 1.3)]) {
    testWidgets('kept recordings ($look)', (tester) async {
      final jobs = DictationJobs(MemoryDictationFiles());
      jobs.pending.addAll([
        _job('a', kDemoNow.subtract(const Duration(days: 1, hours: 2)), 109, 2)..onDisk = true,
        _job('b', kDemoNow.subtract(const Duration(minutes: 20)), 312, 6)..onDisk = true,
      ]);
      Dictation.instance = Dictation(recorder: _NoMic(), jobs: jobs, client: DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((_) async => http.Response('', 500))));
      await pumpApp(tester, dark: dark, textScale: scale, home: const ChatScreen(identityId: 'ido'));
      await tester.pumpAndSettle();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/dictation/kept-$look.png'));
    });

    testWidgets('on its way: piece 2 of 5, 40% sent ($look)', (tester) async {
      final jobs = DictationJobs(MemoryDictationFiles());
      jobs.pending.add(_job('c', kDemoNow, 290, 5)
        ..texts[0] = 'א'
        ..running = true
        ..piece = 1
        ..sent = 0.4
        ..startedAt = kDemoNow.subtract(const Duration(seconds: 34)));
      Dictation.instance = Dictation(recorder: _NoMic(), jobs: jobs, client: DictateClient(baseUrl: 'https://d.example', token: 't', client: MockClient((_) async => http.Response('', 500))));
      await pumpApp(tester, dark: dark, textScale: scale, home: const ChatScreen(identityId: 'ido'));
      await tester.pump();
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/dictation/sending-$look.png'));
    });
  }
}

class _NoMic implements Recorder {
  @override
  Future<void> start() async {}
  @override
  Future<Uint8List> stop() async => Uint8List(0);
  @override
  Future<void> cancel() async {}
}
