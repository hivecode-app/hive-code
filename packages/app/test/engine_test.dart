import 'package:agent_company/data/engine_model.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> ev(int seq, String kind, Map<String, dynamic> body, {int ts = 1000}) =>
    {'seq': seq, 'ts': ts, 'type': 'engine.$kind', 'identity': 'ido', 'data': {'shift': 'ido-2', 'seq': seq, 'ev': {'kind': kind, ...body}}};

void main() {
  test('a turn becomes text, one tool group, text; replay adds nothing', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    final events = [
      ev(1, 'text', {'text': 'בודק.', 'messageId': 'a'}),
      ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'Read', 'input': {'file_path': 'internal/billing/renew.go'}}),
      ev(3, 'tool_result', {'toolUseId': 't1', 'isError': false, 'preview': ''}),
      ev(4, 'tool_use', {'toolUseId': 't2', 'name': 'Grep', 'input': {'pattern': 'ErrCardDeclined', 'path': 'internal/'}}),
      ev(5, 'tool_result', {'toolUseId': 't2', 'isError': false, 'preview': ''}),
      ev(6, 'tool_use', {'toolUseId': 't3', 'name': 'Edit', 'input': {'file_path': 'internal/billing/renew.go'}}),
      ev(7, 'tool_result', {'toolUseId': 't3', 'isError': false, 'preview': ''}, ts: 22000),
      ev(8, 'text', {'text': 'תיקנתי.', 'messageId': 'b'}),
      ev(9, 'result', {'subtype': 'success', 'isError': false}),
    ];
    for (final e in events) {
      m.apply(e);
    }
    for (final e in events) {
      m.apply(e); // reconnect replay
    }
    expect(items.map((i) => i.runtimeType.toString()), ['TextMsg', 'ToolGroup', 'TextMsg']);
    final g = items[1] as ToolGroup;
    expect(g.summary, "קרא קובץ · חיפש פעם אחת · ערך `renew.go` · 21 שנ'");
    expect(g.outcome, Outcome.ok);
    expect(g.tools.map((t) => t.label), ['internal/billing/renew.go', '"ErrCardDeclined" in internal/', 'internal/billing/renew.go']);
  });

  test('streaming deltas grow one bubble and the final text replaces it', () {
    final items = <ChatItem>[];
    LiveState? live;
    final m = EngineModel(items: items, gender: Gender.f, onLive: (l) => live = l);
    m.apply({'seq': 0, 'ts': 1, 'type': 'engine.delta', 'identity': 'dana', 'data': {'kind': 'text_delta', 'text': 'משה ', 'messageId': 'x'}});
    m.apply({'seq': 0, 'ts': 2, 'type': 'engine.delta', 'identity': 'dana', 'data': {'kind': 'text_delta', 'text': 'יקבל', 'messageId': 'x'}});
    expect((items.single as TextMsg).text, 'משה יקבל');
    expect((items.single as TextMsg).streaming, isTrue);
    expect(live?.phase, LivePhase.writing);
    m.apply(ev(10, 'text', {'text': 'משה יקבל הודעה.', 'messageId': 'x'}));
    expect(items, hasLength(1));
    expect((items.single as TextMsg).text, 'משה יקבל הודעה.');
    expect((items.single as TextMsg).streaming, isFalse);
  });

  test('a running Bash test command is "מריצה בדיקות" and stop must ask', () {
    final items = <ChatItem>[];
    LiveState? live;
    final m = EngineModel(items: items, gender: Gender.f, onLive: (l) => live = l);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'flutter test'}}));
    expect((items.single as ToolGroup).liveLabel, 'מריצה בדיקות');
    expect(live?.runningCommand, 'flutter test');
    m.apply(ev(2, 'result', {'subtype': 'error', 'isError': true}));
    expect((items.first as ToolGroup).tools.single.outcome, Outcome.interrupted);
    expect(items.last, isA<ErrorLine>());
  });

  test('hq snapshot maps to the app model', () {
    final d = mapSnapshot(
      board: [
        {'id': 'ido', 'name': 'עידו', 'title': 'מפתח', 'symbol': '', 'team': 'lumo', 'team_kind': 'project', 'lifecycle': 'ephemeral', 'status': 'waiting_for_you', 'shift': {'id': 'ido-2', 'state': 'live', 'started_at': 0}},
        {'id': 'yoav', 'name': 'יואב', 'title': 'מנהל החברה', 'symbol': 'explore', 'team': 'mgmt', 'team_kind': 'permanent', 'lifecycle': 'resident', 'status': 'working', 'shift': null},
      ],
      inbox: [
        {'id': 7, 'kind': 'ask', 'title': 'שאלה', 'body': '', 'from_identity': 'ido', 'urgency': 'normal', 'blocking': true, 'ref': 'ask-1', 'state': 'open', 'created_at': 0},
        {'id': 8, 'kind': 'go', 'title': 'לומו 1.1.20', 'body': 'תיקון הטקסט', 'from_identity': 'yoav', 'urgency': 'normal', 'blocking': true, 'ref': null, 'state': 'open', 'created_at': 0},
      ],
      asks: [
        {'id': 'ask-1', 'from_identity': 'ido', 'question': 'מה עושים עם 37 המנויים?', 'options': ['ניסיון נוסף', 'ביטול'], 'blocking': true, 'state': 'open'},
      ],
      toggles: [
        {'key': 'focus', 'enabled': true, 'manual': true, 'description': 'מצב פוקוס', 'updated_at': 0},
      ],
    );
    expect(d.presence['ido']!.status, WorkerStatus.waiting);
    expect(d.presence['ido']!.shift, 2);
    expect(d.who('ido').temp, isTrue);
    expect(d.focus, isTrue);
    final ask = d.waiting.firstWhere((w) => w.inboxId == 7);
    expect(ask.kind, WaitKind.blockingAsk);
    expect(ask.body, 'מה עושים עם 37 המנויים?');
    expect(ask.options.map((o) => o.label), ['ניסיון נוסף', 'ביטול']);
    expect(d.waiting.firstWhere((w) => w.inboxId == 8).kind, WaitKind.go);
  });
}
