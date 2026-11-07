// What hq's recipe shows on this device (ui/convs/home_blocks.dart liveBlocks), on a sample hq at 20/10/2026 23:10
// (test/fixtures/samples/hq_night). The home draws it in HomeV2 (home_v2_test.dart); these cover the recipe itself.
import 'dart:convert';
import 'dart:io';

import 'package:agent_company/data/backend.dart';
import 'package:agent_company/data/hq_backend.dart';
import 'package:agent_company/model/home_recipe.dart';
import 'package:agent_company/model/models.dart';
import 'package:agent_company/ui/convs/conversations_screen.dart';
import 'package:flutter_test/flutter_test.dart';

const _dir = 'test/fixtures/samples/hq_night';
final _at = DateTime(2026, 10, 20, 23, 10);

Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
List<Map<String, dynamic>> _list(String name, String key) => (_json('$_dir/$name.json')[key] as List).cast<Map<String, dynamic>>();

List<Map<String, dynamic>> get _gos => (_json('test/fixtures/samples/hq_evening/inbox-earlier.json')['items'] as List).cast<Map<String, dynamic>>();

final _awaiting = [
  AwaitingTask(id: 49, kind: AwaitingKind.deploy, title: 'מיזוג מה שגיל הכניס בשרת 2.6.9, והכנה לפריסה', summary: 'ורקר 2.6.10 מוכן לפריסה',
      note: 'מחכה לאישור שלך', identity: 'yonatan', project: 'shop-bot', at: DateTime(2026, 10, 20, 19, 37)),
  AwaitingTask(id: 62, kind: AwaitingKind.check, title: 'אפליקציה: ראש מסך השיחות, שלושה כיווני עיצוב',
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

void main() {
  test('recipe: JSON round trip; a block this app doesn\'t know is left out; emphasis and keys', () {
    final r = HomeRecipe.fromJson({
      'version': 3, 'composed_by': 'adi', 'composed_at': 1, 'source': 'agent',
      'blocks': [
        {'type': 'headline', 'text': 'א', 'emphasis': 'strong'},
        {'type': 'chart', 'data': []},
        {'type': 'alert', 'inbox': 4},
        {'type': 'alert', 'shift': 'keren-2'},
        {'type': 'project', 'project': 'shop', 'note': 'ב'},
        {'type': 'awaiting', 'tasks': [12]},
      ],
    });
    expect(r.blocks.map((b) => b.type), ['headline', 'alert', 'alert', 'project', 'awaiting']);
    expect(r.blocks.first.emphasis, Emphasis.strong);
    expect(r.blocks.map((b) => b.key), ['headline', 'alert:4', 'alert:keren-2', 'project:shop', 'awaiting']);
    expect(HomeRecipe.fromJson(r.toJson()).toJson(), r.toJson());
    expect(shiftIdentity('agent-company-t65-1'), 'agent-company-t65');
  });

  test('live blocks: closed inbox items, gone projects and a stuck worker who came back are dropped', () {
    final d = _data(inbox: _gos);
    final r = _recipe([
      {'type': 'alert', 'inbox': 99},
      {'type': 'alert', 'shift': 'keren-1'},
      {'type': 'waiting', 'inbox': [36, 99]},
      {'type': 'asked', 'messages': ['m1']},
      {'type': 'awaiting', 'tasks': [12]},
      {'type': 'lanes', 'projects': ['agent-company', 'gone']},
      {'type': 'project', 'project': 'gone'},
      {'type': 'people', 'identities': ['ghost']},
      {'type': 'note', 'text': 'נשאר', 'icon': 'info'},
    ]);
    final live = liveBlocks(r, d);
    // Decisions are the "החלטות" tab's: waiting, asked, awaiting and an alert on an inbox item are skipped.
    expect(live.map((b) => b.type), ['lanes', 'note']);
    expect(live[0].projects, ['agent-company']);
    d.presence['keren'] = Presence(status: WorkerStatus.stuck);
    expect(liveBlocks(r, d).first.shift, 'keren-1');
  });

  test('titles without PR or ticket numbers: what project lines and "since" fall back to without a summary', () {
    expect(plainTitle('סיום PR #43: health probes לוורקרים'), 'health probes לוורקרים');
    expect(plainTitle('hq: הודעת סגירה מעירה עובד (#99)'), 'הודעת סגירה מעירה עובד');
    expect(plainTitle('#23 כניסה לכל מכשיר'), 'כניסה לכל מכשיר');
    expect(plainTitle('תיקון ב-ingest #12 ומיזוג'), 'תיקון ב-ingest ומיזוג');
  });
}
