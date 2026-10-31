// Error 802d88feff: a task to check came into its worker's conversation again on every snapshot, two rows
// with one key, and the chat's list broke ("RenderBox was not laid out", then a null check on screen).
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a check, a GO and a question each come into the conversation once, however many snapshots', () {
    final at = DateTime(2026, 10, 31, 9).millisecondsSinceEpoch;
    Map<String, Object?> row(int id, String kind, {String? ref}) =>
        {'id': id, 'kind': kind, 'title': 't$id', 'body': '', 'from_identity': 'adi', 'ref': ref, 'urgency': 'normal', 'blocking': true, 'state': 'open', 'created_at': at};
    final d = mapSnapshot(board: const [], toggles: const [], asks: const [
      {'id': 'ask-7', 'question': 'מה?', 'options': ['כן', 'לא'], 'from_identity': 'adi'},
    ], inbox: [
      row(1, 'go'),
      row(2, 'ask', ref: 'ask-7'),
      row(3, 'awaiting', ref: 'task-5'),
    ]);
    final chat = Conversation(identityId: 'adi', items: []);
    for (var i = 0; i < 3; i++) {
      syncAskCards(chat, 'adi', d);
    }
    expect(chat.items.map((i) => i.id).toList()..sort(), ['ask:ask-7', 'check:3', 'go:1']);
    expect(chat.items.whereType<CheckCard>().single.askId, 'check:3');
  });
}
