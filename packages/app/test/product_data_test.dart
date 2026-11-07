import 'package:agent_company/data/auth_client.dart';
import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/dictation.dart';
import 'package:agent_company/data/engine_model.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/ui/decision.dart';
import 'package:agent_company/ui/convs/head.dart';
import 'package:agent_company/l10n/ui_copy.dart';
import 'package:agent_company/model/models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> event(int seq, String kind, Map<String, dynamic> body) => {'seq': seq, 'ts': seq * 1000, 'type': 'engine.$kind', 'identity': 'worker', 'data': {'shift': 'worker-1', 'seq': seq, 'ev': {'kind': kind, ...body}}};
void main() {
  setUp(() => UiCopy.configure('en'));
  tearDown(() { UiCopy.configure('he'); companyNames = CompanyNames.fallback; });
  test('authentication failure is English for a new installation', () async {
    final client = AuthClient('https://server.example', client: MockClient((_) async => http.Response('{"error":"pairing code is wrong, used or expired"}', 400)));
    addTearDown(client.close);
    await expectLater(client.pair('bad', 'Device'), throwsA(isA<AuthFailure>().having((e) => e.message, 'message', startsWith('This code'))));
  });
  test('tool summaries, live labels and errors follow a language change without replay', () {
    final items = <ChatItem>[];
    final model = EngineModel(items: items, gender: Gender.f);
    model.apply(event(1, 'tool_use', {'toolUseId': 'r', 'name': 'Read', 'input': {'file_path': 'file.dart'}}));
    final group = items.single as ToolGroup;
    expect(group.liveLabel, 'Reading');
    UiCopy.configure('he'); expect(group.liveLabel, 'קוראת');
    model.apply(event(2, 'tool_result', {'toolUseId': 'r', 'isError': false}));
    expect(group.summary, contains('קראה'));
    UiCopy.configure('en'); expect(group.summary, contains('Read'));
    model.apply(event(3, 'result', {'subtype': 'error_during_execution', 'isError': true}));
    final error = items.last as ErrorLine;
    expect(error.text, contains('error'));
    UiCopy.configure('he'); expect(error.text, contains('שגיאה'));
  });
  test('command and dictation errors retain their identity and change their copy', () {
    final command = CommandResult.localized(() => UiCopy.copy.noConnectionServerAction);
    final speech = kNoSpeech;
    expect(command.error, startsWith('No connection'));
    expect(speech.message, contains('No speech'));
    UiCopy.configure('he');
    expect(command.error, startsWith('אין חיבור'));
    expect(speech.message, contains('לא נשמע'));
    expect(identical(speech, kNoSpeech), isTrue);
  });
  test('English chrome still parses the existing Hebrew owner envelopes', () {
    companyNames = CompanyNames.fromJson({'owner': {'id': 'ran', 'name': 'רן'}, 'manager': {'id': 'yoav', 'name': 'יואב'}});
    expect(ownLine({'body': 'רן סיים: GO', 'from_identity': 'owner'}).tapped, isTrue);
    expect(answerText('תשובה של רן לבקשת ה-GO "Deploy?": Yes').$1, 'Yes');
    expect(answerText('רן סגר את השאלה בלי תשובה: obsolete').$2, isTrue);
  });
  test('manager failures are identified by server kind in both languages', () {
    for (final language in ['en', 'he']) {
      UiCopy.configure(language);
      final d = mapSnapshot(board: [], asks: [], toggles: [], manager: 'yoav', inbox: [
        for (final (id, kind) in ['delivery_failure', 'shift_failure', 'escalation_note'].indexed)
          {'id': id, 'kind': kind, 'state': 'open', 'from_identity': 'yoav', 'created_at': 1000, 'title': 'Fault'},
      ]);
      expect(d.waiting.map((w) => w.sourceKind), ['delivery_failure', 'shift_failure']);
      expect(d.waiting.every((w) => isHis(w, manager: 'yoav')), isTrue);
    }
  });
  test('tool recognition, agent details and incident status use stable data', () {
    for (final language in ['en', 'he']) {
      UiCopy.configure(language);
      expect(toolKnown('Read'), isTrue);
      expect(toolKnown('unknown'), isFalse);
      expect(toolHasAgentDescription(ToolLine(icon: 'person', label: toolDetail('Agent', {}), name: 'Agent')), isFalse);
      final described = ToolLine(icon: 'person', label: 'Inspect', name: 'Agent', call: ToolCall(name: 'Agent', started: DateTime(2026), input: {'description': 'Inspect / בדיקה'}));
      expect(toolHasAgentDescription(described), isTrue);
      final incident = WaitItem(id: 'incident', kind: WaitKind.failure, sourceKind: 'incident', from: 'yoav', time: '', kicker: 'Incident', body: 'fault');
      expect(HeadData.lineOf(incident).word, UiCopy.copy.productionIssue);
    }
  });
  testWidgets('pending check icons and saved answer lines survive language changes', (tester) async {
    SharedPreferences.setMockInitialValues({'language': 'en'});
    final store = AppStore(FakeBackend(simulate: false));
    await store.start();
    addTearDown(store.dispose);
    final waiting = WaitItem(id: 'check', kind: WaitKind.awaiting, from: 'yoav', time: '', kicker: '', body: '', askId: 'check');
    store.answerWait(waiting, kAwaitingOptions.firstWhere((o) => o.id == 'failed'));
    final pending = store.decision(waiting.askId, waiting.id)!;
    expect(pendingIcon(pending), 'close');
    expect(pending.line, 'Not working');
    await store.preferences.setLanguage('he');
    expect(pendingIcon(pending), 'close');
    expect(pending.line, 'לא עובד');
    store.cancelUndo(pending.key);
    final question = WaitItem(id: 'question', kind: WaitKind.softAsk, from: 'yoav', time: '', kicker: '', body: '', askId: 'question');
    await store.answerText(question, 'Yes');
    expect(question.answerLine, contains('ענית'));
    await store.preferences.setLanguage('en');
    expect(question.answerLine, 'Answered: Yes');
    store.answerWait(waiting, kAwaitingOptions.firstWhere((o) => o.id == 'irrelevant'));
    expect(pendingIcon(store.decision(waiting.askId, waiting.id)!), 'do_not_disturb_on');
    await tester.pump(const Duration(seconds: 5));
    await store.preferences.setLanguage('he');
    expect(waiting.answerLine, 'לא רלוונטי');
    await store.preferences.setLanguage('en');
    expect(waiting.answerLine, 'No longer relevant');
    await store.backend.dismiss(question);
    final closed = question.answerLine;
    await store.preferences.setLanguage('he');
    expect(question.answerLine, isNot(closed));
  });
}
