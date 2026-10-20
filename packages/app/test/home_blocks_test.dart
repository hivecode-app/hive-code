// The head of the chats screen drawn from hq's recipe (ui/convs/home_blocks.dart), on the real hq of
// 20/10/2026 23:10 (test/fixtures/hq-2310: /api/board, /api/inbox, /api/asks, /api/toggles and
// /api/messages?identity=owner; no token inside, bodies cut to one line). Three recipes the way עדי would
// compose them on that day ("בוקר שקט", "יש תקלה", "יום עמוס"), and hq's own default. The two GOs of
// "יום עמוס" are the real ones of 19:57 (hq-1957/inbox-earlier); the incident of "יש תקלה" is made up, and so is
// "מה לבדוק" (#108 was not deployed at 23:10): two real tasks of the day, marked the way their workers would.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/fake_backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/data/store.dart';
import 'package:agent_company/main.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/blocks/blocks.dart';
import 'package:agent_company/ui/common.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:agent_company/ui/status/status_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

const _dir = 'test/fixtures/hq-2310';
final _at = DateTime(2026, 10, 20, 23, 10);
final _seen = DateTime(2026, 10, 20, 20, 0);

Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
List<Map<String, dynamic>> _list(String name, String key) => (_json('$_dir/$name.json')[key] as List).cast<Map<String, dynamic>>();

final _incident = <String, dynamic>{
  'id': 90,
  'kind': 'incident',
  'title': 'האתר של לומו לא עונה',
  'body': 'example.app/healthz מחזיר 502 כבר 4 דקות.',
  'from_identity': 'rotem',
  'urgency': 'urgent',
  'blocking': true,
  'ref': 'rotem-1:mock',
  'state': 'open',
  'created_at': DateTime(2026, 10, 20, 23, 6).millisecondsSinceEpoch,
  'link': null,
  'headline': 'האתר של לומו לא עונה',
  'snoozed_at': null,
};

List<Map<String, dynamic>> get _gos => (_json('test/fixtures/hq-1957/inbox-earlier.json')['items'] as List).cast<Map<String, dynamic>>();

class _Snapshot extends FakeBackend {
  _Snapshot(this.snapshot) : super(simulate: false);
  final CompanyData snapshot;
  @override
  CompanyData? get data => snapshot;
  @override
  SystemStatus get status => const SystemStatus(LinkState.online);
  @override
  Future<void> start() async => notifyListeners();
}

final _awaiting = [
  AwaitingTask(id: 49, kind: AwaitingKind.deploy, title: 'מיזוג מה שמשה הכניס בוורקר 2.6.9, והכנה לפריסה', summary: 'ורקר 2.6.10 מוכן לפריסה',
      note: 'מחכה ל-GO שלך', identity: 'yonatan', project: 'lumo-bot', at: DateTime(2026, 10, 20, 19, 37)),
  AwaitingTask(id: 62, kind: AwaitingKind.check, title: 'אפליקציה: ראש מסך השיחות, תוכן מוגדר ושלושה כיווני עיצוב',
      summary: 'יש שלוש הצעות לראש מסך השיחות, מצולמות מהאפליקציה', note: 'לבחור כיוון', identity: 'agent-company-t62', project: 'agent-company', at: DateTime(2026, 10, 20, 22, 20)),
];

CompanyData _data({List<Map<String, dynamic>> inbox = const []}) {
  final board = _json('$_dir/board.json');
  return mapSnapshot(manager: 'yoav', 
    board: (board['identities'] as List).cast<Map<String, dynamic>>(),
    inbox: inbox,
    asks: _list('asks', 'asks'),
    toggles: _list('toggles', 'toggles'),
    tasks: (board['tasks'] as List).cast<Map<String, dynamic>>(),
    projects: (board['projects'] as List).cast<Map<String, dynamic>>(),
    now: _at,
  )..awaiting = [..._awaiting];
}

HomeRecipe _recipe(List<Map<String, dynamic>> blocks, {String by = 'adi', DateTime? at, int version = 7}) =>
    HomeRecipe.fromJson({'version': version, 'composed_by': by, 'composed_at': (at ?? DateTime(2026, 10, 20, 23, 8)).millisecondsSinceEpoch, 'source': 'agent', 'blocks': blocks});

// ── the recipes, as עדי would compose them on the day ──

/// Nothing waits, three tasks run in the company: a line, who is at work, the day, what finished.
final _quiet = _recipe([
  {'type': 'headline', 'text': 'שקט. שלוש משימות רצות בחברה, ושום דבר לא מחכה לך'},
  {'type': 'people', 'identities': ['agent-company-t63', 'agent-company-t64', 'agent-company-t65'], 'caption': 'בונים את ראש המסך החדש'},
  {'type': 'since', 'items': ['יש שלוש הצעות לראש מסך השיחות, מצולמות מהאפליקציה', 'הבוט הקולי מבין לאן הלקוח נוסע לפי "מ-" ו"ל-"', 'הפרויקט "מה חדש בעיר" עבר לחברה, עם מתן כראש צוות']},
  {'type': 'lanes', 'projects': ['agent-company', 'voice-bot', 'lumo-bot'], 'emphasis': 'quiet'},
  {'type': 'note', 'text': 'בלומו בוט שתי משימות של רון והילה מחכות למשבצת פנויה', 'icon': 'schedule', 'emphasis': 'quiet'},
]);

/// Lumo's site is down: that first and heavy, what Rotem knows, the project it stops.
final _incidentRecipe = _recipe([
  {'type': 'headline', 'text': 'האתר של לומו לא עונה כבר 4 דקות', 'emphasis': 'strong'},
  {'type': 'alert', 'inbox': 90, 'emphasis': 'strong'},
  {'type': 'note', 'text': 'רותם בודקת. בפעם הקודמת זה היה ה-ingress, וחזר אחרי הפעלה מחדש', 'icon': 'monitor_heart'},
  {'type': 'project', 'project': 'lumo-bot', 'note': 'הפריסה של 2.6.10 מחכה עד שהאתר יחזור'},
  {'type': 'lanes', 'projects': ['lumo-bot', 'lumo', 'agent-company']},
]);

/// Two GOs wait, three tasks run, a lot finished: the decisions first, then the day.
List<Map<String, dynamic>> get _busyBlocks => [
      {'type': 'headline', 'text': 'יום עמוס: שני GO מחכים לך, ושלוש משימות רצות'},
      {'type': 'waiting', 'inbox': [36, 34]},
      {'type': 'awaiting', 'tasks': [49, 62]},
      {'type': 'lanes', 'projects': ['agent-company', 'voice-bot', 'lumo-bot', 'nws']},
      {'type': 'project', 'project': 'agent-company', 'note': 'ראש המסך החדש בשלושה צוותים, מוכן לראות הלילה'},
      {'type': 'project', 'project': 'voice-bot'},
      {'type': 'since', 'items': ['הבוט הקולי מבין לאן הלקוח נוסע לפי "מ-" ו"ל-"', 'תמונות בהודעה של עובד אליך מוצגות', 'הפרויקט "מה חדש בעיר" עבר לחברה']},
      {'type': 'note', 'text': 'שווה לאשר את 2.6.10 לפני הלילה, כדי שהקנרי ירוץ עד הבוקר', 'icon': 'rocket_launch'},
    ];

/// hq's own (home.ts defaultRecipe): alert, waiting, the lanes, a line per active project, since.
HomeRecipe _default(CompanyData d) => HomeRecipe.fromJson({
      'version': 0,
      'composed_by': 'hq',
      'composed_at': _at.millisecondsSinceEpoch,
      'source': 'default',
      'fallback': 'none',
      'blocks': [
        {'type': 'awaiting', 'tasks': [for (final t in d.awaiting) t.id]},
        {'type': 'lanes', 'projects': [for (final p in d.projects) if (p.active) p.id]},
        for (final p in d.projects)
          if (p.active) {'type': 'project', 'project': p.id},
        {'type': 'since', 'items': ['x']},
      ],
    });

Future<AppStore> _pump(WidgetTester tester, CompanyData d, HomeRecipe? recipe, {Size size = const Size(342, 1500), bool dark = false}) async {
  await loadFonts();
  Motion.frozen = true;
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = size * 2;
  tester.view.devicePixelRatio = 2;
  StatusScreen.clock = () => _at;
  ConversationsScreen.clock = () => _at;
  addTearDown(() {
    StatusScreen.clock = DateTime.now;
    ConversationsScreen.clock = DateTime.now;
  });
  addTearDown(tester.view.reset);
  d.home = recipe;
  final store = AppStore(_Snapshot(d));
  await store.start();
  store.markChatsSeen(_seen);
  await tester.pumpWidget(CompanyApp(store: store, themeMode: dark ? ThemeMode.dark : ThemeMode.light));
  await tester.pumpAndSettle();
  return store;
}

Future<void> _shot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
  await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/home/$name.png'));
}

/// The blocks on screen, top to bottom, by the card's label or the block's own widget.
List<String> _order(WidgetTester tester) {
  final out = <(double, String)>[];
  void add(Finder f, String name) {
    for (final e in f.evaluate()) {
      final box = e.renderObject as RenderBox?;
      if (box == null || !box.hasSize || box.size.height < 1) continue;
      out.add((box.localToGlobal(Offset.zero).dy, name));
    }
  }

  add(find.byType(Headline), 'headline');
  add(find.byType(AlertBlock), 'alert');
  add(find.byType(WaitingBlock), 'waiting');
  add(find.byType(AwaitingBlock), 'awaiting');
  add(find.byType(LanesBlock), 'lanes');
  add(find.byType(ProjectBlock), 'project');
  add(find.byType(PeopleBlock), 'people');
  add(find.byType(SinceBlock), 'since');
  add(find.byType(NoteBlock), 'note');
  out.sort((a, b) => a.$1.compareTo(b.$1));
  return [for (final x in out) x.$2];
}

void main() {
  testWidgets('"בוקר שקט": a line, who is at work, what finished, the day, a quiet note; who arranged it', (tester) async {
    await _pump(tester, _data(), _quiet);
    expect(_order(tester), ['headline', 'people', 'since', 'lanes', 'note']);
    expect(findShown('שקט. שלוש משימות רצות בחברה'), findsOneWidget);
    expect(findShown('בונים את ראש המסך החדש'), findsOneWidget);
    expect(findShown('סודר ע״י עדי · 23:08'), findsOneWidget);
    await _shot(tester, '1-quiet');
  });

  testWidgets('"יש תקלה": the incident first and heavy, then what is known and what it stops', (tester) async {
    await _pump(tester, _data(inbox: [_incident]), _incidentRecipe);
    expect(_order(tester), ['headline', 'alert', 'note', 'project', 'lanes']);
    expect(findShown('תקלה בפרודקשן · רותם'), findsOneWidget);
    expect(findShown('הפריסה של 2.6.10 מחכה עד שהאתר יחזור'), findsOneWidget);
    await _shot(tester, '2-incident');
  });

  testWidgets('"יום עמוס": the decisions, the day, two projects in one card, what finished, a nudge', (tester) async {
    await _pump(tester, _data(inbox: _gos), _recipe(_busyBlocks), size: const Size(342, 1900));
    expect(_order(tester), ['headline', 'waiting', 'awaiting', 'lanes', 'project', 'project', 'since', 'note']);
    expect(findShown('עדי · GO לפרודקשן'), findsOneWidget);
    expect(findShown('בועז · GO לפרודקשן'), findsOneWidget);
    await _shot(tester, '3-busy');
  });

  testWidgets('the default: hq\'s own shape, said quietly under it', (tester) async {
    final d = _data();
    await _pump(tester, d, _default(d), size: const Size(342, 1900));
    expect(_order(tester).take(2), ['awaiting', 'lanes']);
    expect(find.byType(ProjectBlock), findsNWidgets(d.projects.where((p) => p.active).length));
    expect(findShown('סדר קבוע'), findsOneWidget);
    // hq's "since" is live: what finished after his last visit (20:00), not the recipe's words.
    expect(findShown('מאז 20:00'), findsOneWidget);
    await _shot(tester, '0-default');
  });

  testWidgets('a new recipe moves: what stays keeps its place, what goes folds up, what comes opens', (tester) async {
    final d = _data(inbox: _gos);
    final store = await _pump(tester, d, _quiet, size: const Size(342, 1900));
    expect(_order(tester), ['headline', 'people', 'since', 'lanes', 'note']);
    d.home = _recipe(_busyBlocks, at: DateTime(2026, 10, 20, 23, 12), version: 8);
    store.touch();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    // Mid-way: the people strip is leaving, what waits is coming in, both on screen at part height.
    final people = tester.getSize(find.byType(PeopleBlock)).height;
    expect(people, greaterThan(0));
    expect(find.byType(WaitingBlock), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.byType(PeopleBlock), findsNothing);
    expect(_order(tester), ['headline', 'waiting', 'awaiting', 'lanes', 'project', 'project', 'since', 'note']);
    expect(findShown('סודר ע״י עדי · 23:12'), findsOneWidget);
    expect(findShown('יום עמוס'), findsOneWidget, reason: 'the headline stayed and took its new words');
  });

  testWidgets('live data wins: an item that closed leaves the block at once; the block goes with its last item', (tester) async {
    final d = _data(inbox: _gos);
    final store = await _pump(tester, d, _recipe(_busyBlocks), size: const Size(342, 1900));
    final adi = d.waiting.firstWhere((w) => w.from == 'adi');
    final boaz = d.waiting.firstWhere((w) => w.from == 'boaz');
    adi.state = WaitState.answered;
    store.touch();
    await tester.pumpAndSettle();
    expect(findShown('עדי · GO לפרודקשן'), findsNothing);
    expect(findShown('בועז · GO לפרודקשן'), findsOneWidget);
    boaz.state = WaitState.answered;
    store.touch();
    await tester.pumpAndSettle();
    expect(find.byType(WaitingBlock), findsNothing);
    expect(_order(tester).take(2), ['headline', 'awaiting']);
  });

  testWidgets('two blocks of one kind are two rows, and a new recipe moves them like any other', (tester) async {
    final d = _data();
    final store = await _pump(tester, d, _recipe([
      {'type': 'note', 'text': 'הערה ראשונה', 'icon': 'info'},
      {'type': 'note', 'text': 'הערה שנייה', 'icon': 'info'},
    ]));
    expect(find.byType(NoteBlock), findsNWidgets(2));
    expect(findShown('הערה ראשונה'), findsOneWidget);
    d.home = _recipe([
      {'type': 'note', 'text': 'הערה שנייה', 'icon': 'info'},
      {'type': 'headline', 'text': 'כותרת'},
      {'type': 'note', 'text': 'הערה שלישית', 'icon': 'info'},
    ], version: 9);
    store.touch();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(_order(tester), ['note', 'headline', 'note']);
    expect(findShown('הערה שלישית'), findsOneWidget);
  });

  testWidgets('no recipe (an hq from before): the card alone, as before', (tester) async {
    await _pump(tester, _data(inbox: _gos), null);
    expect(find.byType(HomeBlocks), findsNothing);
    expect(find.byType(ChatsHead), findsOneWidget);
  });

  testWidgets('dark', (tester) async {
    await _pump(tester, _data(inbox: [_incident]), _incidentRecipe, dark: true);
    await _shot(tester, '2-incident-dark');
  });

  test('recipe: JSON round trip; a block this app doesn\'t know is left out; emphasis and keys', () {
    final r = HomeRecipe.fromJson({
      'version': 3, 'composed_by': 'adi', 'composed_at': 1, 'source': 'agent',
      'blocks': [
        {'type': 'headline', 'text': 'א', 'emphasis': 'strong'},
        {'type': 'chart', 'data': []},
        {'type': 'alert', 'inbox': 4},
        {'type': 'alert', 'shift': 'keren-2'},
        {'type': 'project', 'project': 'lumo', 'note': 'ב'},
        {'type': 'awaiting', 'tasks': [12]},
      ],
    });
    expect(r.blocks.map((b) => b.type), ['headline', 'alert', 'alert', 'project', 'awaiting']);
    expect(r.blocks.first.emphasis, Emphasis.strong);
    expect(r.blocks.map((b) => b.key), ['headline', 'alert:4', 'alert:keren-2', 'project:lumo', 'awaiting']);
    expect(HomeRecipe.fromJson(r.toJson()).toJson(), r.toJson());
    expect(shiftIdentity('agent-company-t65-1'), 'agent-company-t65');
  });

  test('live blocks: closed inbox items, gone projects and a stuck worker who came back are dropped', () {
    final d = _data(inbox: _gos);
    final r = _recipe([
      {'type': 'alert', 'inbox': 99},
      {'type': 'alert', 'shift': 'keren-1'},
      {'type': 'waiting', 'inbox': [36, 99]},
      {'type': 'lanes', 'projects': ['agent-company', 'gone']},
      {'type': 'project', 'project': 'gone'},
      {'type': 'people', 'identities': ['ghost']},
      {'type': 'note', 'text': 'נשאר', 'icon': 'info'},
    ]);
    final live = liveBlocks(r, d);
    expect(live.map((b) => b.type), ['waiting', 'lanes', 'note']);
    expect(live[0].inbox, [36]);
    expect(live[1].projects, ['agent-company']);
    d.presence['keren'] = Presence(status: WorkerStatus.stuck);
    expect(liveBlocks(r, d).first.shift, 'keren-1');
  });

  test('titles without PR or ticket numbers: what project lines and "since" fall back to without a summary', () {
    expect(plainTitle('סיום PR #43: health probes לוורקרים'), 'health probes לוורקרים');
    expect(plainTitle('hq: הודעת סגירה מעירה עובד (#99)'), 'הודעת סגירה מעירה עובד');
    expect(plainTitle('#23 passkey ו-token לכל מכשיר'), 'passkey ו-token לכל מכשיר');
    expect(plainTitle('תיקון ב-ingest #12 ומיזוג'), 'תיקון ב-ingest ומיזוג');
  });
}
