// The manager's note on an escalated ask (hq's `manager_note`) reaches the card as its own field.
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Map<String, dynamic> inbox() => {'id': 7, 'kind': 'ask', 'state': 'open', 'ref': 'ask-1', 'from_identity': 'dana', 'title': 'שאלה', 'blocking': true, 'created_at': 1000};
  Map<String, dynamic> ask(String state, [Object? note]) =>
      {'id': 'ask-1', 'from_identity': 'dana', 'question': 'באיזה צבע?', 'options': ['כחול', 'ירוק'], 'state': state, 'manager_note': note, 'created_at': 1000};

  WaitItem waitOf(Map<String, dynamic> a) =>
      mapSnapshot(board: const [], inbox: [inbox()], asks: [a], toggles: const [], manager: 'yoav').waiting.single;

  test('an escalated ask with a note: the note and who wrote it, the card stays the asker\'s', () {
    final w = waitOf(ask('escalated', '  את זה אני לא יכול לענות במקומו '));
    expect(w.managerNote, 'את זה אני לא יכול לענות במקומו');
    expect(w.managerNoteBy, 'yoav');
    expect(w.from, 'dana');
    expect(w.body, 'באיזה צבע?');
    expect(w.options.map((o) => o.label), ['כחול', 'ירוק']);
  });

  test('no note, an empty one, a field hq does not have yet, or an ask that is not escalated: no line', () {
    for (final a in [ask('escalated'), ask('escalated', ''), ask('escalated', '  '), ask('open', 'הערה')]) {
      expect(waitOf(a).managerNote, isNull);
    }
    final bare = ask('escalated')..remove('manager_note');
    expect(waitOf(bare).managerNote, isNull);
  });
}
