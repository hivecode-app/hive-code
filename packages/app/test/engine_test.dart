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

  test('an English Bash description is not shown; a Hebrew one is', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'ls', 'description': 'Stop k3s, back up its DB'}}));
    expect((items.single as ToolGroup).liveLabel, 'מריץ פקודה');
    m.apply(ev(2, 'tool_use', {'toolUseId': 'c', 'name': 'Bash', 'input': {'command': 'ls', 'description': 'מגבה את הבסיס'}}));
    expect((items.single as ToolGroup).liveLabel, 'מגבה את הבסיס');
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

  test('a turn the host cut on purpose (his message mid-turn) is no error; a real failure still is', () {
    // rotem, 21/10 23:54:52: his GO answer cut her turn, error_during_execution, and he saw "הסבב נגמר בשגיאה".
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.f);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'r', 'name': 'Read', 'input': {'file_path': 'a.md'}}));
    m.apply(ev(2, 'result', {'subtype': 'error_during_execution', 'isError': true, 'interrupted': true}));
    expect(items.whereType<ErrorLine>(), isEmpty);
    expect((items.single as ToolGroup).outcome, Outcome.interrupted);
    m.apply(ev(3, 'text', {'text': 'ממשיכה.', 'messageId': 'c'}));
    m.apply(ev(4, 'result', {'subtype': 'error_during_execution', 'isError': true}));
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

  // 08/11, adi: a test tell to him, then "מה נשאר לפני ההשקה". He watched it stream and it vanished at the end of the turn.
  test('in a turn he opened, the text after a tell to him stays: it is the reply, the tell is a separate message', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.f);
    final events = [
      ev(1, 'user_echo', {'uuid': 'u', 'text': '[הודעה מ-רן (owner) · דחיפות: רגילה · m-1]\nתשלחי התראה ואז תגידי מה נשאר'}),
      ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'body': 'הודעת בדיקה'}}),
      ev(3, 'tool_result', {'toolUseId': 't1', 'isError': false, 'preview': '{"queued":true}'}),
      ev(4, 'text', {'text': 'שלחתי לך הודעת בדיקה.\n\nמה נשאר לפני ההשקה: …', 'messageId': 'n'}),
      ev(5, 'result', {'subtype': 'success', 'isError': false}),
    ];
    for (final e in [...events, ...events]) {
      m.apply(e);
    }
    expect(items.whereType<TextMsg>().map((t) => t.text), ['שלחתי לך הודעת בדיקה.\n\nמה נשאר לפני ההשקה: …']);
  });

  test('his message read together with a teammate\'s, not first in the echo, still opens the turn', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.f);
    m.apply(ev(1, 'user_echo', {'uuid': 'u', 'text': '[הודעה מ-רותם (rotem) · דחיפות: רגילה · r-1]\nתבדקי\n\n[הודעה מ-רן (owner) · דחיפות: רגילה · m-2]\nמה נשאר?'}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'body': 'בדיקה'}}));
    m.apply(ev(3, 'text', {'text': 'מה נשאר: …', 'messageId': 'n'}));
    m.apply(ev(4, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<TextMsg>().map((t) => t.text), ['מה נשאר: …']);
  });

  test('a tell with ref to his message cuts nothing either', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.f);
    m.apply(ev(1, 'user_echo', {'uuid': 'u', 'text': '[הודעה מ-רן (owner) · דחיפות: רגילה · m-1]\nמה נשאר?'}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'ref': 'm-1', 'body': 'בדיקה'}}));
    m.apply(ev(3, 'text', {'text': 'מה נשאר: …', 'messageId': 'n'}));
    m.apply(ev(4, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<TextMsg>().map((t) => t.text), ['מה נשאר: …']);
  });

  test('his message joins a turn after its tell to him: the narration before it drops, the reply after it stays', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'user_echo', {'uuid': 'u', 'text': '[הודעה מ-רותם (rotem) · דחיפות: רגילה · r-1]\nתבדוק'}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'body': 'השרת חזר.'}}));
    m.apply(ev(3, 'text', {'text': 'עדכנתי את רן.', 'messageId': 'a'}));
    m.apply(ev(4, 'user_echo', {'uuid': 'u2', 'text': '[הודעה מ-רן (owner) · דחיפות: רגילה · m-mid]\nמה קרה?'}));
    m.apply(ev(5, 'text', {'text': 'הדיסק התמלא, ניקיתי.', 'messageId': 'b'}));
    m.apply(ev(6, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<TextMsg>().map((t) => t.text), ['הדיסק התמלא, ניקיתי.']);
  });

  test('a tell, then an ask, then his message: the card still cuts everything after the tell, as hq stores nothing', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'user_echo', {'uuid': 'u', 'text': '[הודעה מ-רותם (rotem) · דחיפות: רגילה · r-1]\nתבדוק'}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'body': 'השרת חזר.'}}));
    m.apply(ev(3, 'tool_use', {'toolUseId': 't2', 'name': 'mcp__company__ask', 'input': {'question': 'לפרוס?'}}));
    m.apply(ev(4, 'user_echo', {'uuid': 'u2', 'text': '[הודעה מ-רן (owner) · דחיפות: רגילה · m-mid]\nמה קרה?'}));
    m.apply(ev(5, 'text', {'text': 'שאלתי אותך.', 'messageId': 'b'}));
    m.apply(ev(6, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<TextMsg>(), isEmpty);
  });

  test('in a turn he did not open, the narration after a tell to him is dropped: the tell is what he gets', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'user_echo', {'uuid': 'u', 'text': '[הודעה מ-רותם (rotem) · דחיפות: רגילה · r-1]\nתבדוק'}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'body': 'השרת חזר.'}}));
    m.apply(ev(3, 'tool_result', {'toolUseId': 't1', 'isError': false}));
    m.apply(ev(4, 'text', {'text': 'עדכנתי את רן.', 'messageId': 'n'}));
    m.apply(ev(5, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<TextMsg>(), isEmpty);
    // The next turn (a plain text reply) is not affected.
    m.apply(ev(6, 'text', {'text': 'בטח.', 'messageId': 'o'}));
    m.apply(ev(7, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<TextMsg>().map((t) => t.text), ['בטח.']);
  });

  // 21/10, shachar: the answer he watched stream vanished when the worker called tools after it.
  test('text he saw before a tool that reached him stays; only the narration after it is dropped', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'text', {'text': 'התשובה הארוכה.', 'messageId': 'a'}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'mcp__company__request_go', 'input': {}}));
    m.apply(ev(3, 'text', {'text': 'ביקשתי GO.', 'messageId': 'b'}));
    m.apply(ev(4, 'result', {'subtype': 'success', 'isError': false, 'text': ''}));
    expect(items.whereType<TextMsg>().map((t) => t.text), ['התשובה הארוכה.']);
  });

  test('the stored reply of a multi-block turn moves nothing: the streamed bubbles stay where he read them', () {
    final a = TextMsg(id: 't:msg_a', ts: DateTime(2026), text: 'רגע, בודק');
    final tools = ToolGroup(id: 'g:1', ts: DateTime(2026), summary: '', tools: [], outcome: Outcome.ok, seq: 1);
    final b = TextMsg(id: 't:msg_b', ts: DateTime(2026), text: 'התשובה.');
    final items = <ChatItem>[a, tools, b];
    final s = streamedAs(items, {'text_ref': 'msg_b', 'body': 'רגע, בודק\n\nהתשובה.'});
    expect(identical(s, b), isTrue, reason: 'the stored message is not a second bubble');
    expect(items, [a, tools, b]);
    expect(a.text, 'רגע, בודק');
    expect(b.text, 'התשובה.');
  });

  // QA-LOG item 5: every reply from Yoav had a "השתמש בכלים ✓" row above it, for the tell itself.
  test('a message to the owner leaves no tool row; other company tools say what they did', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'a', 'name': 'ToolSearch', 'input': {'query': 'tell'}}));
    m.apply(ev(2, 'tool_result', {'toolUseId': 'a', 'isError': false}));
    m.apply(ev(3, 'tool_use', {'toolUseId': 'b', 'name': 'mcp__company__tell', 'input': {'to': 'owner', 'body': 'קיבלתי'}}));
    m.apply(ev(4, 'tool_result', {'toolUseId': 'b', 'isError': false}));
    m.apply(ev(5, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<ToolGroup>(), isEmpty);

    m.apply(ev(6, 'tool_use', {'toolUseId': 'c', 'name': 'Read', 'input': {'file_path': '/a/b.md'}}));
    m.apply(ev(7, 'tool_result', {'toolUseId': 'c', 'isError': false}));
    m.apply(ev(8, 'tool_use', {'toolUseId': 'd', 'name': 'mcp__company__tell', 'input': {'to': 'dana', 'body': 'תבדקי'}}));
    m.apply(ev(9, 'tool_result', {'toolUseId': 'd', 'isError': false}));
    m.apply(ev(10, 'tool_use', {'toolUseId': 'e', 'name': 'mcp__company__remember', 'input': {'text': 'x'}}));
    m.apply(ev(11, 'tool_result', {'toolUseId': 'e', 'isError': false}));
    m.apply(ev(12, 'result', {'subtype': 'success', 'isError': false}));
    expect(items.whereType<ToolGroup>().single.summary, 'קרא קובץ · שלח הודעה · רשם לזיכרון');
  });

  test('a reply hq stored from the streamed text (text_ref) is the same bubble, not a second one', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'text', {'text': 'היי רן. PR #17 מוזג.', 'messageId': 'msg_b'}));
    m.apply(ev(2, 'result', {'subtype': 'success', 'isError': false}));
    expect(streamedAlready(items, {'id': 'm-1-reply', 'text_ref': 'msg_b', 'body': 'היי רן. PR #17 מוזג.'}), isTrue);
    expect(streamedAlready(items, {'id': 'm-2-reply', 'text_ref': 'msg_other'}), isFalse, reason: 'stream outside the loaded window: the stored message shows');
    expect(streamedAlready(items, {'id': 'tell-1', 'text_ref': null}), isFalse);
  });

  test('two text blocks of one message (same messageId) both stream', () {
    // The CLI sends one `assistant` event per block, all with the message's id (spikes/bet7-chat/RESULT.md).
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    Map<String, dynamic> delta(String t) => {'seq': 0, 'ts': 1000, 'type': 'engine.delta', 'identity': 'yoav', 'data': {'shift': 'yoav-4', 'kind': 'text_delta', 'text': t, 'messageId': 'msg_a'}};
    m.apply(delta('בודק'));
    m.apply(ev(1, 'text', {'text': 'בודק.', 'messageId': 'msg_a'}));
    m.apply(delta('עוד'));
    expect(items.whereType<TextMsg>().last.streaming, isTrue, reason: 'the second block streams too');
    m.apply(ev(2, 'text', {'text': 'עוד משהו.', 'messageId': 'msg_a'}));
    expect(items.whereType<TextMsg>().map((t) => t.text), ['בודק.', 'עוד משהו.']);
    expect(items.whereType<TextMsg>().any((t) => t.streaming), isFalse);
  });

  test('board status "free" is פנוי, not נח', () {
    expect(mapStatus('free'), WorkerStatus.free);
    expect(mapStatus('resting'), WorkerStatus.resting);
  });

  // #34 (company-engine): "מריץ פקודה" spun for good after shift 4 handed over to shift 5.
  Map<String, dynamic> shift(int seq, String id, String state) =>
      {'seq': seq, 'ts': 5000, 'type': 'shift.state', 'identity': 'ido', 'data': {'shift': id, 'state': state}};

  test('a shift that ends or hands over mid-tool stops the row and the live line', () {
    final items = <ChatItem>[];
    LiveState? live;
    final m = EngineModel(items: items, gender: Gender.m, onLive: (l) => live = l);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'npm test'}}));
    expect(live?.busy, isTrue);
    m.apply(shift(2, 'ido-2', 'ended'));
    final g = items.single as ToolGroup;
    expect(g.outcome, Outcome.interrupted);
    expect(g.tools.single.outcome, Outcome.interrupted);
    expect(g.liveLabel, isNull);
    expect(live?.busy, isFalse);

    // The next shift's `live` with no `ended` before it (hq restarted, the host died): the same.
    final items2 = <ChatItem>[];
    LiveState? live2;
    final m2 = EngineModel(items: items2, gender: Gender.m, onLive: (l) => live2 = l);
    m2.apply(shift(1, 'ido-2', 'live'));
    m2.apply(ev(2, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'ls'}}));
    m2.apply(shift(3, 'ido-3', 'live'));
    expect((items2.firstWhere((i) => i is ToolGroup) as ToolGroup).outcome, Outcome.interrupted);
    expect(live2?.busy, isFalse);
    expect(items2.whereType<ShiftMarker>().single.shift, 3);
  });

  test('the live of the shift whose tool is running does not stop it', () {
    // A run's first frames can reach hq before it marks the shift live.
    final items = <ChatItem>[];
    LiveState? live;
    final m = EngineModel(items: items, gender: Gender.m, onLive: (l) => live = l);
    m.apply(shift(1, 'ido-2', 'starting'));
    m.apply(ev(2, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'ls'}}));
    m.apply(shift(3, 'ido-2', 'live'));
    expect((items.single as ToolGroup).outcome, Outcome.running);
    expect(live?.busy, isTrue);
    m.apply(ev(4, 'tool_result', {'toolUseId': 'b', 'isError': false}));
    m.apply(ev(5, 'result', {'subtype': 'success', 'isError': false}));
    expect((items.single as ToolGroup).outcome, Outcome.ok);
    expect(live?.busy, isFalse);
  });

  test('a turn that ends mid-tool closes the row as stopped, not done', () {
    final items = <ChatItem>[];
    LiveState? live;
    final m = EngineModel(items: items, gender: Gender.m, onLive: (l) => live = l);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'sleep 100'}}));
    m.apply(ev(2, 'result', {'subtype': 'success', 'isError': false}));
    final g = items.single as ToolGroup;
    expect(g.tools.single.outcome, Outcome.interrupted);
    expect(g.liveLabel, isNull);
    expect(live?.busy, isFalse);
  });

  test('browser_ask_user is a card he acts on, not a "השתמש בכלי" row (31/10)', () {
    final items = <ChatItem>[];
    LiveState? live;
    final m = EngineModel(items: items, gender: Gender.m, onLive: (l) => live = l);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'a1', 'name': 'mcp__browser__browser_ask_user', 'input': {'need': 'login', 'what': 'להיכנס ל-Contabo\n'}}));
    final card = items.single as HandoffCard;
    expect(card.what, 'להיכנס ל-Contabo');
    expect(card.ended, isFalse);
    expect(live?.label, 'מחכה לך בדפדפן');
    m.apply(ev(2, 'tool_result', {'toolUseId': 'a1', 'isError': false, 'preview': 'The user has done it'}));
    expect(items, hasLength(1), reason: 'no tool row next to it');
    expect(card.ended, isTrue);
    expect(card.failed, isFalse);

    // hq refused the link: the worker got an error, and the card says he was never asked.
    m.apply(ev(3, 'tool_use', {'toolUseId': 'a2', 'name': 'mcp__browser__browser_ask_user', 'input': {'need': 'other', 'what': 'x'}}));
    m.apply(ev(4, 'tool_result', {'toolUseId': 'a2', 'isError': true, 'preview': 'the user was NOT asked — hq could not open the phone link: tab is blank'}));
    expect((items.last as HandoffCard).failed, isTrue);

    // A call the client cancelled (a message arrived) is not a failure: the link may still be on his phone.
    m.apply(ev(5, 'tool_use', {'toolUseId': 'a3', 'name': 'mcp__browser__browser_ask_user', 'input': {'need': 'other', 'what': 'y'}}));
    m.apply(ev(6, 'tool_result', {'toolUseId': 'a3', 'isError': true, 'preview': "The user doesn't want to proceed with this tool use."}));
    expect((items.last as HandoffCard).failed, isFalse);
    expect(items.whereType<ToolGroup>(), isEmpty);
  });

  test('a result that comes after text closed its group marks its own row, not the next group (RangeError, 31/10)', () {
    // Codex runs tools side by side: t1's result arrives after a text and a new group of fewer tools.
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'tool_use', {'toolUseId': 't0', 'name': 'Bash', 'input': {'command': 'ls'}}));
    m.apply(ev(2, 'tool_use', {'toolUseId': 't1', 'name': 'Bash', 'input': {'command': 'sleep 1'}}));
    m.apply(ev(3, 'text', {'text': 'ממשיך.', 'messageId': 'a'}));
    m.apply(ev(4, 'tool_use', {'toolUseId': 't2', 'name': 'Read', 'input': {'file_path': 'a.dart'}}));
    m.apply(ev(5, 'tool_result', {'toolUseId': 't1', 'isError': false, 'preview': ''}));
    final groups = items.whereType<ToolGroup>().toList();
    expect(groups[0].tools[1].outcome, Outcome.ok);
    expect(groups[1].tools.single.outcome, Outcome.running);
  });

  test('a late result after the turn ended or a failed one after text: each lands where it should', () {
    final items = <ChatItem>[];
    final m = EngineModel(items: items, gender: Gender.m);
    m.apply(ev(1, 'tool_use', {'toolUseId': 'b', 'name': 'Bash', 'input': {'command': 'sleep 100'}}));
    m.apply(ev(2, 'result', {'subtype': 'success', 'isError': false}));
    m.apply(ev(3, 'tool_result', {'toolUseId': 'b', 'isError': false}));
    expect((items.single as ToolGroup).tools.single.outcome, Outcome.interrupted, reason: 'the turn ended on it');

    m.apply(ev(4, 'tool_use', {'toolUseId': 'c', 'name': 'Bash', 'input': {'command': 'false'}}));
    m.apply(ev(5, 'text', {'text': 'ממשיך.', 'messageId': 'x'}));
    m.apply(ev(6, 'tool_use', {'toolUseId': 'd', 'name': 'Bash', 'input': {'command': 'ls', 'description': 'מריץ ls'}}));
    m.apply(ev(7, 'tool_result', {'toolUseId': 'c', 'isError': true}));
    final groups = items.whereType<ToolGroup>().toList();
    expect(groups[1].outcome, Outcome.error);
    expect(groups[1].tools.single.outcome, Outcome.error);
    expect(groups[2].liveLabel, 'מריץ ls');
    expect(groups[2].outcome, Outcome.running);
  });
}
