// Contract check against a real hq (packages/hq). Skipped unless HQ_TEST_URL and HQ_TEST_TOKEN are set:
//   HQ_TEST_URL=http://127.0.0.1:7499 HQ_TEST_TOKEN=... flutter test test/hq_live_test.dart
// Seed it first with one open ask and one GO (see the PR description).
import 'dart:io';

import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final url = Platform.environment['HQ_TEST_URL'];
  final token = Platform.environment['HQ_TEST_TOKEN'];
  final skip = url == null || token == null ? 'HQ_TEST_URL/HQ_TEST_TOKEN not set' : null;

  test('snapshot, live link, answer, GO and tell against hq', () async {
    final hq = HqBackend(baseUrl: url!, token: token!);
    await hq.start();
    expect(hq.data, isNotNull);
    expect(hq.data!.identities, isNotEmpty);
    for (var i = 0; i < 50 && hq.status.state != LinkState.online; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(hq.status.state, LinkState.online, reason: 'the WebSocket replays and says live');

    final ask = hq.data!.waiting.firstWhere((w) => w.askId != null && w.kind != WaitKind.go);
    expect(ask.options, isNotEmpty);
    final r1 = await hq.answerAsk(ask.askId!, ask.options.first);
    expect(r1.ok, isTrue, reason: r1.error);

    final go = hq.data!.waiting.firstWhere((w) => w.kind == WaitKind.go);
    final r2 = await hq.go(go);
    expect(r2.ok, isTrue, reason: r2.error);

    await Future<void>.delayed(const Duration(milliseconds: 800));
    expect(hq.data!.waiting.where((w) => w.inboxId == go.inboxId || w.askId == ask.askId), isEmpty, reason: 'both left the inbox');

    final who = hq.data!.identities.keys.first;
    final msg = UserMsg(id: 'm-live-${DateTime.now().millisecondsSinceEpoch}', ts: DateTime.now(), text: 'בדיקת חוזה מהאפליקציה', priority: Priority.later);
    final r3 = await hq.send(who, msg);
    expect(r3.ok, isTrue, reason: r3.error);
    await hq.openConversation(who);
    expect(hq.data!.chats[who]!.items.whereType<UserMsg>().any((m) => m.id == msg.id), isTrue, reason: 'the sent message comes back from /api/messages');
    hq.dispose();
  }, skip: skip, timeout: const Timeout(Duration(seconds: 30)));
}
