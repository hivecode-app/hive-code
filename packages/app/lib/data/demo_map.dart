// The demo's day for the company map (FakeBackend, and the goldens): the company's twelve teams, a few task
// workers in each project, and a day of messages that is quiet at night and busy in the evening. Deterministic.
import 'dart:math' as math;

import '../model/map_day.dart';

const _h = 3600000;

// team id, name, symbol, tone, lead id
const _teams = [
  ('management', 'הנהלה', 'account_tree', 'slate', 'yoav'),
  ('monitoring', 'צוות הניטור', 'monitor_heart', 'slate', 'rotem'),
  ('personal', 'הצוות האישי', 'group', 'slate', 'eli'),
  ('improvement', 'מחלקת השיפור', 'tune', 'slate', 'noga'),
  ('design', 'עיצוב', 'palette', 'slate', 'noa'),
  ('agent-company', 'החברה', 'domain', 'blue', 'adi'),
  ('lumo', 'האפליקציה לומו', 'forum', 'teal', 'dana'),
  ('voice-bot', 'הבוט הקולי', 'call', 'sky', 'shachar'),
  ('lumo-bot', 'לומו בוט', 'smart_toy', 'green', 'boaz'),
  ('tiki-bot-go', 'טיקי בוט', 'directions_car', 'clay', 'inbal'),
  ('nws', 'מה חדש בעיר', 'campaign', 'rose', 'matan'),
  ('pinto', 'פינטו', 'local_taxi', 'olive', 'shira'),
];

const _leads = {
  'yoav': ('יואב', 'יו'), 'rotem': ('רותם', 'רו'), 'eli': ('אלי', 'אל'), 'noga': ('נגה', 'נג'), 'noa': ('נועה', 'נו'), 'adi': ('עדי', 'עד'),
  'dana': ('דנה', 'דנ'), 'shachar': ('שחר', 'שח'), 'boaz': ('בועז', 'בו'), 'inbal': ('ענבל', 'ענ'), 'matan': ('מתן', 'מת'), 'shira': ('שירה', 'שי'),
};

const _workers = ['עומר', 'שקד', 'אסף', 'מאיה', 'נועם', 'הילה', 'יובל', 'תמר', 'רון', 'ליאור', 'גל', 'קרן'];

const _lines = [
  'אפשר לראות איפה זה עומד?',
  'סיימתי, יש PR וממתין לסקירה.',
  'הבדיקות ירוקות. ממשיך למיזוג.',
  'מצאתי את הסיבה: הזמן נשמר בשעון של השרת ולא של רן.',
  'צריך GO לפריסה. הסיכון נמוך, וחוזרים אחורה בפקודה אחת.',
  'תודה. עובר למשימה הבאה.',
  'לא הצלחתי להתחבר לשרת השני, ממתין למפתח.',
  'הערכה: 40 דקות.',
];

int _seed(String s) => s.codeUnits.fold(7, (a, c) => (a * 31 + c) & 0x7fffffff);

/// A day of the demo company on [date]; [upTo] cuts it short, as today's is.
MapDay demoMapDay(String date, {int upTo = kDayMs}) {
  final rnd = math.Random(_seed(date));
  final people = <Map<String, dynamic>>[
    {'id': 'owner', 'name': 'רן', 'mono': 'עק', 'team': 'management', 'role': 'owner'},
    {'id': 'hq', 'name': 'hq', 'mono': '', 'team': 'management', 'role': 'system'},
  ];
  for (final t in _teams) {
    final (name, mono) = _leads[t.$5]!;
    people.add({'id': t.$5, 'name': name, 'mono': mono, 'team': t.$1, 'role': 'lead'});
  }
  final presence = <Map<String, dynamic>>[];
  final messages = <Map<String, dynamic>>[];
  var n = 0;
  void say(int t, String f, String to) {
    if (t >= upTo) return;
    messages.add({'id': 'dm-${n++}', 't': t, 'f': f, 'to': to, 'k': 'tell'});
  }

  // The leads talk to him, and to each other, from the morning; the evening is when most happens.
  for (var i = 0; i < 520; i++) {
    final evening = rnd.nextDouble() < 0.55;
    final t = evening ? (20 * _h + rnd.nextInt(4 * _h)) : (7 * _h + rnd.nextInt(13 * _h));
    final lead = _teams[1 + rnd.nextInt(_teams.length - 1)].$5;
    final r = rnd.nextDouble();
    if (r < 0.1) {
      say(t, 'owner', lead);
      say(t + 20000 + rnd.nextInt(240000), lead, 'owner');
    } else if (r < 0.2) {
      say(t, lead, 'owner');
    } else if (r < 0.6) {
      say(t, 'yoav', lead);
      say(t + 60000 + rnd.nextInt(120000), lead, 'yoav');
    } else {
      say(t, 'hq', lead);
    }
  }
  // Task workers come and go inside the projects.
  var w = 0;
  for (final t in _teams.skip(5)) {
    for (var k = 0; k < 3 + rnd.nextInt(5); k++) {
      final id = '${t.$1}-t$w';
      final from = 9 * _h + rnd.nextInt(12 * _h);
      final to = math.min(kDayMs - 1, from + _h ~/ 2 + rnd.nextInt(2 * _h));
      people.add({'id': id, 'name': _workers[w % _workers.length], 'mono': _workers[w % _workers.length].substring(0, 2), 'team': t.$1, 'role': 'task'});
      presence.add({'id': id, 'from': math.min(from, upTo), 'to': math.min(to, upTo)});
      for (var j = 0; j < 4 + rnd.nextInt(6); j++) {
        final at = from + rnd.nextInt(to - from);
        rnd.nextBool() ? say(at, t.$5, id) : say(at, id, t.$5);
      }
      w++;
    }
  }
  for (final t in _teams) {
    presence.add({'id': t.$5, 'from': 0, 'to': upTo});
  }
  messages.sort((a, b) => (a['t'] as int).compareTo(b['t'] as int));

  // Tables: the same arithmetic hq does.
  final stats = <Map<String, dynamic>>[];
  for (final p in people) {
    if (p['id'] == 'hq') continue;
    final id = p['id'] as String;
    final inbox = messages.where((m) => m['to'] == id && m['f'] != 'hq').length;
    final out = messages.where((m) => m['f'] == id).toList();
    final waits = <int>[];
    var asked = 0;
    if (id != 'owner') {
      for (final m in messages.where((m) => m['f'] == 'owner' && m['to'] == id)) {
        asked++;
        final r = out.where((o) => o['to'] == 'owner' && (o['t'] as int) > (m['t'] as int)).firstOrNull;
        if (r != null && (r['t'] as int) - (m['t'] as int) < 6 * _h) waits.add((r['t'] as int) - (m['t'] as int));
      }
    }
    waits.sort();
    final hourly = List<double>.filled(24, 0);
    var workMs = 0;
    for (final s in presence.where((s) => s['id'] == id)) {
      workMs += (s['to'] as int) - (s['from'] as int);
      for (var hr = 0; hr < 24; hr++) {
        hourly[hr] += math.max(0, math.min(s['to'] as int, (hr + 1) * _h) - math.max(s['from'] as int, hr * _h)) / _h;
      }
    }
    if (inbox + out.length + workMs == 0) continue;
    stats.add({'id': id, 'in': inbox, 'out': out.length, 'asked': asked, 'answered': waits.length, 'answerMs': waits.isEmpty ? null : waits[waits.length ~/ 2], 'workMs': workMs, 'hourly': hourly});
  }
  final marks = <Map<String, dynamic>>[];
  for (var i = 0; i < 9; i++) {
    final t = _teams[5 + rnd.nextInt(7)];
    marks.add({'t': 9 * _h + rnd.nextInt(14 * _h), 'k': 'task', 'label': 'משימה ${i + 1}', 'project': t.$1});
    if (i < 6) marks.add({'t': 9 * _h + rnd.nextInt(14 * _h), 'k': 'merge', 'label': 'PR ${200 + i}', 'project': t.$1, 'repo': t.$1});
  }
  marks.add({'t': 21 * _h + 40 * 60000, 'k': 'deploy', 'label': 'agent-company · hq', 'project': 'agent-company'});
  marks.removeWhere((m) => (m['t'] as int) >= upTo);
  marks.sort((a, b) => (a['t'] as int).compareTo(b['t'] as int));
  final projects = [
    for (final t in _teams.skip(5))
      {
        'project': t.$1,
        'opened': marks.where((m) => m['k'] == 'task' && m['project'] == t.$1).length + 1,
        'done': marks.where((m) => m['k'] == 'task' && m['project'] == t.$1).length,
        'open': 1 + rnd.nextInt(3),
      },
  ];
  return MapDay.fromJson({
    'day': date,
    'upTo': upTo,
    'teams': [for (final t in _teams) {'id': t.$1, 'name': t.$2, 'symbol': t.$3, 'tone': t.$4, 'lead': t.$5, 'project': const {'management', 'monitoring', 'personal', 'improvement', 'design'}.contains(t.$1) ? null : t.$1}],
    'people': people,
    'presence': presence,
    'messages': messages,
    'marks': marks,
    'stats': {
      'projects': projects,
      'workers': stats,
      'estimates': [
        {'kind': 'feature', 'n': 14, 'onTime': 9, 'late': 3, 'open': 2, 'ratio': 0.8},
        {'kind': 'small-fix', 'n': 9, 'onTime': 8, 'late': 1, 'open': 0, 'ratio': 0.6},
        {'kind': 'deploy', 'n': 4, 'onTime': 4, 'late': 0, 'open': 0, 'ratio': 0.5},
      ],
    },
  });
}

/// A message's text in the demo: one of a few lines, by its id.
MapBody demoMapBody(String id) => MapBody(id, _lines[_seed(id) % _lines.length]);
