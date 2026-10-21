// The company map's day: one day of the company as hq's `GET /api/company-day` sends it (every message of the day as a
// line with no text, the marks, the tables), and the map's fixed layout. Times are milliseconds from the day's
// start in the company's time zone.
import 'dart:math' as math;
import 'dart:ui';

class MapTeam {
  MapTeam(this.id, this.name, this.symbol, this.tone, this.lead, this.project);
  final String id, name, symbol, tone;
  final String? lead, project;
}

enum MapRole { owner, system, lead, member, task }

class MapPerson {
  MapPerson(this.id, this.name, this.mono, this.team, this.role);
  final String id, name, mono, team;
  final MapRole role;
  bool get satellite => role == MapRole.member || role == MapRole.task;
}

/// One line: who wrote to whom and when. The text is not here; [MapBody] is loaded when he touches the line.
class MapMsg {
  MapMsg(this.id, this.t, this.from, this.to, this.kind);
  final String id;
  final int t;
  final String from, to, kind;
}

/// The text of one message, loaded on its own (`GET /api/company-day/messages/:id`).
class MapBody {
  const MapBody(this.id, this.body);
  final String id, body;
}

class MapMark {
  MapMark(this.t, this.kind, this.label, this.project, this.repo);
  final int t;
  final String kind, label; // task | merge | deploy
  final String? project, repo;
}

/// One worker's day. [answerMs]: how long it took to answer HIM, from his message to the worker's next one back
/// (median); [asked] his messages to it, [answered] those it answered.
class WorkerStat {
  WorkerStat(this.id, this.inbox, this.out, this.workMs, this.hourly, {this.answerMs, this.asked = 0, this.answered = 0});
  final String id;
  final int inbox, out, workMs, asked, answered;
  final int? answerMs;
  final List<double> hourly;
}

class ProjectStat {
  ProjectStat(this.project, this.opened, this.done, this.open);
  final String project;
  final int opened, done, open;
}

class EstimateStat {
  EstimateStat(this.kind, this.n, this.onTime, this.late, this.open, this.ratio);
  final String kind;
  final int n, onTime, late, open;
  final double? ratio;
}

const kDayMs = 86400000;

class MapDay {
  MapDay._(this.day, this.upTo, this.teams, this.people, this.presence, this.messages, this.marks, this.workers, this.projects, this.estimates);

  /// "2026-10-21".
  final String day;

  /// How much of the day has happened: all of it, or for today how far it got.
  final int upTo;
  final List<MapTeam> teams;
  final Map<String, MapPerson> people;
  final Map<String, List<(int, int)>> presence;
  final List<MapMsg> messages; // by time
  final List<MapMark> marks; // by time
  final List<WorkerStat> workers;
  final List<ProjectStat> projects;
  final List<EstimateStat> estimates;

  factory MapDay.fromJson(Map<String, dynamic> j) {
    final teams = [
      for (final t in j['teams'] as List) MapTeam(t['id'], t['name'], t['symbol'], t['tone'] ?? 'slate', t['lead'], t['project']),
    ];
    final people = <String, MapPerson>{
      for (final p in j['people'] as List) p['id'] as String: MapPerson(p['id'], p['name'], p['mono'] ?? '', p['team'], MapRole.values.byName(p['role'])),
    };
    final presence = <String, List<(int, int)>>{};
    for (final s in j['presence'] as List) {
      presence.putIfAbsent(s['id'], () => []).add(((s['from'] as num).toInt(), (s['to'] as num).toInt()));
    }
    final s = j['stats'] as Map<String, dynamic>;
    return MapDay._(
      j['day'],
      ((j['upTo'] as num?) ?? kDayMs).toInt().clamp(0, kDayMs),
      teams,
      people,
      presence,
      [for (final m in j['messages'] as List) MapMsg(m['id'], (m['t'] as num).toInt(), m['f'], m['to'], m['k'] ?? 'tell')],
      [for (final m in j['marks'] as List) MapMark((m['t'] as num).toInt(), m['k'], m['label'], m['project'], m['repo'])],
      [
        for (final w in s['workers'] as List)
          WorkerStat(w['id'], w['in'], w['out'], (w['workMs'] as num).toInt(), [for (final h in w['hourly'] as List) (h as num).toDouble()],
              answerMs: (w['answerMs'] as num?)?.toInt(), asked: (w['asked'] as num?)?.toInt() ?? 0, answered: (w['answered'] as num?)?.toInt() ?? 0),
      ],
      [for (final p in s['projects'] as List) ProjectStat(p['project'], p['opened'], p['done'], p['open'])],
      [
        for (final e in s['estimates'] as List) EstimateStat(e['kind'], e['n'], e['onTime'], e['late'], e['open'], (e['ratio'] as num?)?.toDouble()),
      ],
    );
  }

  MapTeam team(String id) => teams.firstWhere((t) => t.id == id);

  bool present(String id, int t) => presence[id]?.any((s) => s.$1 <= t && t < s.$2) ?? false;

  /// The first message at or after [t] (binary search).
  int msgIndex(int t) {
    var lo = 0, hi = messages.length;
    while (lo < hi) {
      final mid = (lo + hi) >> 1;
      if (messages[mid].t < t) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /// Counts of the day's marks up to [t]: tasks done, merges, deploys.
  (int, int, int) countsAt(int t) {
    var a = 0, b = 0, c = 0;
    for (final m in marks) {
      if (m.t > t) break;
      switch (m.kind) {
        case 'task':
          a++;
        case 'merge':
          b++;
        case 'deploy':
          c++;
      }
    }
    return (a, b, c);
  }
}

/// The map's canvas at rest, in logical pixels before it is scaled to the screen.
const kMapSize = Size(1200, 660);

/// The canvas for a box of [avail]: the rest canvas, stretched along the axis the box has more of, so a wide
/// short screen (a phone on its side) spreads the teams out and keeps the circles and the text round and big
/// enough, instead of leaving the sides empty.
Size mapCanvas(Size avail) {
  if (avail.width <= 0 || avail.height <= 0) return kMapSize;
  final a = avail.width / avail.height;
  final rest = kMapSize.width / kMapSize.height;
  return a >= rest ? Size(kMapSize.height * math.min(a, rest * 2.2), kMapSize.height) : Size(kMapSize.width, math.min(kMapSize.width / a, kMapSize.height * 1.6));
}

/// Where each team sits, on the rest canvas. Fixed and hand-placed (never a force graph): the owner in the middle,
/// the standing teams along the top, the projects around, the two busiest on the sides.
const kTeamAnchors = <String, Offset>{
  'management': Offset(600, 330),
  'personal': Offset(905, 92),
  'monitoring': Offset(720, 84),
  'improvement': Offset(480, 84),
  'design': Offset(295, 92),
  'agent-company': Offset(985, 270),
  'voice-bot': Offset(215, 270),
  'lumo': Offset(1010, 520),
  'pinto': Offset(190, 520),
  'lumo-bot': Offset(800, 545),
  'tiki-bot-go': Offset(400, 545),
  'nws': Offset(600, 560),
};

/// Places for a team org.yaml has and the map doesn't know yet, in order of arrival.
const _spare = [Offset(600, 190), Offset(110, 400), Offset(1100, 400), Offset(600, 640)];

/// Rings of slots around a lead: radius and how many.
const _rings = [(54.0, 8), (80.0, 14), (106.0, 20)];

/// The map's fixed layout for one day on one canvas: a place for everyone, and when a satellite (a task worker,
/// a dormant member who woke) is on the map. A satellite gets a slot when it first appears and keeps it; a slot is
/// reused only after its last holder left, so nobody moves while the day plays.
class MapLayout {
  /// [spread] pushes the owner, Yoav and hq apart when their names are drawn big (a small screen).
  MapLayout(this.day, [this.canvas = kMapSize, double spread = 1]) {
    final sx = canvas.width / kMapSize.width, sy = canvas.height / kMapSize.height;
    var spare = 0;
    for (final t in day.teams) {
      final base = kTeamAnchors[t.id] ?? _spare[spare++ % _spare.length];
      final c = Offset(base.dx * sx, base.dy * sy);
      anchor[t.id] = c;
      if (t.id == 'management') {
        pos['owner'] = c;
        pos['yoav'] = c + Offset(84 * spread, 0);
        pos['hq'] = c + Offset(-84 * spread, 0);
        continue;
      }
      if (t.lead != null) pos[t.lead!] = c;
      final sats = day.people.values.where((p) => p.team == t.id && p.satellite).map((p) => (p, _span(p.id))).where((s) => s.$2 != null).toList()
        ..sort((a, b) => a.$2!.$1.compareTo(b.$2!.$1));
      final freeAt = <int>[]; // per slot: when its last holder left
      for (final (p, span) in sats) {
        var slot = freeAt.indexWhere((end) => end + _gap <= span!.$1);
        if (slot < 0) {
          slot = freeAt.length;
          freeAt.add(0);
        }
        freeAt[slot] = span!.$2;
        pos[p.id] = c + _slot(slot);
        life[p.id] = span;
      }
      // Up to three slots fill the top and the start side, and the name fits right under the lead.
      ringDrop[t.id] = freeAt.length <= 3 ? 0 : _rings[_ringOf(freeAt.length - 1)].$1;
    }
  }

  final MapDay day;
  final Size canvas;
  final anchor = <String, Offset>{};
  final pos = <String, Offset>{};
  final life = <String, (int, int)>{};

  /// Radius of the outermost ring a team uses, 0 when its few satellites leave the space under the lead free.
  final ringDrop = <String, double>{};
  static const fade = 6 * 60000; // a satellite comes and goes over 6 minutes of the day (~80ms of replay)
  static const _gap = 2 * fade + 2 * 60000;

  (int, int)? _span(String id) {
    int? a, b;
    for (final s in day.presence[id] ?? const <(int, int)>[]) {
      a = a == null ? s.$1 : math.min(a, s.$1);
      b = b == null ? s.$2 : math.max(b, s.$2);
    }
    for (final m in day.messages) {
      if (m.from != id && m.to != id) continue;
      a = a == null ? m.t : math.min(a, m.t);
      b = b == null ? m.t : math.max(b, m.t);
    }
    if (a == null) return null;
    return (math.max(0, a - 2 * 60000), math.min(kDayMs, b! + 2 * 60000));
  }

  static int _ringOf(int slot) {
    var n = 0;
    for (var r = 0; r < _rings.length; r++) {
      n += _rings[r].$2;
      if (slot < n) return r;
    }
    return _rings.length - 1;
  }

  static Offset _slot(int slot) {
    var i = slot;
    for (var r = 0; r < _rings.length; r++) {
      final (radius, n) = _rings[r];
      if (i < n) {
        // From the top, going the reading way (counter-clockwise on screen is toward the start in RTL);
        // odd rings are offset half a step so they stagger.
        final a = -math.pi / 2 - (i + (r.isOdd ? 0.5 : 0)) * 2 * math.pi / n;
        return Offset(math.cos(a) * radius, math.sin(a) * radius);
      }
      i -= n;
    }
    return Offset.zero;
  }

  /// How visible [id] is at [t]: the owner, hq and the leads are always there, satellites come and go.
  double alpha(String id, int t) {
    final p = day.people[id]!;
    if (!p.satellite) return 1;
    final l = life[id];
    if (l == null) return 0;
    // Fully there for its whole span: it fades in just before its first message and out just after its last.
    return ((t - l.$1 + fade) / fade).clamp(0.0, 1.0) * ((l.$2 + fade - t) / fade).clamp(0.0, 1.0);
  }
}
