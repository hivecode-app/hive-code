import 'package:agent_company/l10n/ui_copy.dart';
// The company map: the org as a fixed map, the day's messages as thin lines that light up and fade, a replay of the
// whole day in 20 seconds, and quiet tables under it. Opened from "סטטוס"; the day comes from hq.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../data/store.dart';
import '../../model/map_day.dart';
import '../../theme/motion.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'map_ink.dart';
import 'map_stats.dart';

/// A whole day in 20 seconds.
const kReplay = Duration(seconds: 20);

/// A message's line lives 600ms of the viewer's time: drawn from the sender over the first third, then fading.
const kLineLife = Duration(milliseconds: 600);

/// More lines than this on screen at once, and the lines of one pair become one, thicker.
const kMergeOver = 12;

/// How often today's map asks hq for what happened since.
const kMapRefresh = Duration(seconds: 60);

/// The route: the screen on the app's backend.
class CompanyMapPage extends StatelessWidget {
  const CompanyMapPage({super.key});

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final backend = StoreScope.read(context).backend;
    return CompanyMapScreen(load: backend.companyDay, loadBody: backend.companyMessage, refresh: kMapRefresh);
  }
}

class CompanyMapScreen extends StatefulWidget {
  const CompanyMapScreen({super.key, required this.load, required this.loadBody, this.date, this.refresh, this.at, this.play = false, this.open});

  /// One day from hq (null: could not be had), and the text of one message.
  final Future<MapDay?> Function(String date) load;
  final Future<MapBody?> Function(String id) loadBody;

  /// The day to open ("2026-10-21"); today by default.
  final String? date;

  /// How often today asks hq again; null: never (tests).
  final Duration? refresh;

  /// Where the playhead starts (ms into the day; the end of what happened by default), whether it plays, and a
  /// message to open (its id).
  final int? at;
  final bool play;
  final String? open;

  @override
  State<CompanyMapScreen> createState() => _CompanyMapScreenState();
}

String _ymd(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

class _CompanyMapScreenState extends State<CompanyMapScreen> with SingleTickerProviderStateMixin {
  late String date = widget.date ?? _ymd(CompanyTime.now());
  MapDay? day;
  bool failed = false;
  final now = ValueNotifier<int>(0);
  late final Ticker _ticker = createTicker(_tick);
  Timer? _refresh;
  Duration _last = Duration.zero;
  bool playing = false;
  MapMsg? selected;
  final _bodies = <String, MapBody?>{};
  final _bodyFailed = <String>{};
  int _loadToken = 0;

  static const _speed = kDayMs / 20000; // day-ms per real ms

  String get _today => _ymd(CompanyTime.now());
  bool get _isToday => date == _today;
  int get _end => day?.upTo ?? 0;

  @override
  void initState() {
    super.initState();
    unawaited(_open(date, first: true));
    if (widget.refresh != null) _refresh = Timer.periodic(widget.refresh!, (_) => unawaited(_reload()));
  }

  @override
  void dispose() {
    _refresh?.cancel();
    _ticker.dispose();
    now.dispose();
    super.dispose();
  }

  Future<void> _open(String d, {bool first = false}) async {
    final token = ++_loadToken;
    _pause();
    setState(() {
      date = d;
      failed = false;
      selected = null;
      if (!first) day = null;
    });
    final loaded = await widget.load(d).catchError((_) => null);
    if (!mounted || token != _loadToken) return;
    if (loaded == null) {
      setState(() => failed = true);
      return;
    }
    setState(() {
      day = loaded;
      now.value = first ? (widget.at ?? loaded.upTo).clamp(0, loaded.upTo) : loaded.upTo;
    });
    if (first && widget.open != null) {
      final m = loaded.messages.where((m) => m.id == widget.open).firstOrNull;
      if (m != null) _select(m);
    }
    if (first && widget.play) _play();
  }

  /// Today only: what happened since. The playhead follows the end of the day when it was there.
  Future<void> _reload() async {
    if (!_isToday || day == null || !mounted) return;
    final token = _loadToken;
    final loaded = await widget.load(date).catchError((_) => null);
    if (!mounted || token != _loadToken || loaded == null) return;
    final atEnd = now.value >= _end;
    setState(() {
      day = loaded;
      if (atEnd && !playing) now.value = loaded.upTo;
    });
  }

  void _tick(Duration e) {
    final dt = (e - _last).inMicroseconds / 1000;
    _last = e;
    final t = (now.value + dt * _speed).round();
    if (t >= _end) {
      now.value = _end;
      _pause();
      return;
    }
    now.value = t;
  }

  void _play() {
    if (day == null) return;
    if (now.value >= _end) now.value = 0;
    _last = Duration.zero;
    _ticker.start();
    setState(() => playing = true);
  }

  void _pause() {
    if (_ticker.isActive) _ticker.stop();
    if (mounted && playing) setState(() => playing = false);
  }

  void _seek(int t) => now.value = t.clamp(0, _end);

  void _select(MapMsg? m) {
    if (m != null) _pause();
    setState(() => selected = m);
    if (m != null && !_bodies.containsKey(m.id)) unawaited(_loadBody(m));
  }

  Future<void> _loadBody(MapMsg m) async {
    setState(() => _bodyFailed.remove(m.id));
    final b = await widget.loadBody(m.id).catchError((_) => null);
    if (!mounted) return;
    setState(() {
      if (b == null) {
        _bodyFailed.add(m.id);
      } else {
        _bodies[m.id] = b;
      }
    });
  }

  void _step(int days) {
    final d = DateTime.parse(date).add(Duration(days: days, hours: 12));
    final next = _ymd(d);
    if (next.compareTo(_today) > 0) return;
    unawaited(_open(next));
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final mq = MediaQuery.of(context);
    final h = mq.size.height;
    final phone = h < 500;
    final d = day;
    // The map takes what the screen leaves under the header and above the timeline.
    final mapH = phone ? math.max(240.0, h - 44 - 84) : (h - 220).clamp(380.0, 720.0);
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: SingleChildScrollView(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1320),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                _Header(date: date, day: d, compact: phone, canNext: !_isToday, onPrev: () => _step(-1), onNext: () => _step(1)),
                SizedBox(
                  height: mapH,
                  child: d == null
                      ? _Waiting(failed: failed, onRetry: () => _open(date))
                      : _Map(
                          day: d,
                          now: now,
                          selected: selected,
                          body: selected == null ? null : _bodies[selected!.id],
                          bodyFailed: selected != null && _bodyFailed.contains(selected!.id),
                          onRetryBody: selected == null ? null : () => unawaited(_loadBody(selected!)),
                          onSelect: _select,
                        ),
                ),
                if (d != null) ...[
                  _Timeline(
                    day: d,
                    now: now,
                    playing: playing,
                    compact: phone,
                    today: _isToday,
                    onPlay: () => playing ? _pause() : _play(),
                    onSeek: _seek,
                  ),
                  const SizedBox(height: 40),
                  MapStats(day: d),
                  const SizedBox(height: 48),
                ],
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

class _Waiting extends StatelessWidget {
  const _Waiting({required this.failed, required this.onRetry});
  final bool failed;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Center(
      child: failed
          ? Column(mainAxisSize: MainAxisSize.min, children: [
              Text(UiCopy.copy.thisDayCould, style: T.row2.copyWith(color: p.text)),
              const SizedBox(height: 4),
              InkWell(onTap: onRetry, child: Padding(padding: const EdgeInsets.all(8), child: Text(UiCopy.copy.tryAgain, style: T.row2.copyWith(color: p.accent)))),
            ])
          : Text(UiCopy.copy.loadingDay, style: T.row2.copyWith(color: p.text2)),
    );
  }
}

List<String> get _weekdays => [UiCopy.copy.monday, UiCopy.copy.tuesday, UiCopy.copy.wednesday, UiCopy.copy.thursday, UiCopy.copy.friday, UiCopy.copy.saturday, UiCopy.copy.sunday];

class _Header extends StatelessWidget {
  const _Header({required this.date, required this.day, required this.compact, required this.canNext, required this.onPrev, required this.onNext});
  final String date;
  final MapDay? day;
  final bool compact, canNext;
  final VoidCallback onPrev, onNext;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = DateTime.parse(date);
    final when = UiCopy.copy.text2(_weekdays[d.weekday - 1], d.day, d.month);
    final count = day == null ? null : (day!.messages.isEmpty ? UiCopy.copy.noMessages : plural(day!.messages.length, UiCopy.copy.oneMessage, UiCopy.copy.messages3));
    final sub = count == null ? when : '$when · $count';
    final back = Navigator.of(context).canPop() ? IBtn(backIcon(context), tip: UiCopy.copy.back2, onTap: () => Navigator.of(context).maybePop()) : const SizedBox(width: 12);
    final nav = [
      IBtn('chevron_right', tip: UiCopy.copy.previousDay, onTap: onPrev),
      if (canNext) IBtn('chevron_left', tip: UiCopy.copy.nextDay, onTap: onNext) else const SizedBox(width: 44),
    ];
    final tab = T.secondary.copyWith(color: p.text2, fontFeatures: const [FontFeature.tabularFigures()]);
    if (compact) {
      return SizedBox(
        height: 44,
        child: Row(children: [
          back,
          Expanded(child: Text.rich(TextSpan(children: [TextSpan(text: UiCopy.copy.companyMap2, style: T.name.copyWith(color: p.text)), TextSpan(text: '  $sub', style: tab)]), maxLines: 1, overflow: TextOverflow.ellipsis)),
          ...nav,
        ]),
      );
    }
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(4, 12, 12, 4),
      child: Row(children: [
        back,
        const SizedBox(width: 4),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(UiCopy.copy.companyMap2, style: T.bar.copyWith(color: p.text)),
            const SizedBox(height: 2),
            Text(sub, style: tab),
          ]),
        ),
        ...nav,
      ]),
    );
  }
}

/// "3 הודעות", or [one] for exactly one.
String plural(int n, String one, String many) => n == 1 ? one : '${_num(n)} $many';

String _num(int n) => n < 1000 ? '$n' : '${n ~/ 1000},${(n % 1000).toString().padLeft(3, '0')}';

String hhmm(int t) {
  final m = (t / 60000).floor().clamp(0, 24 * 60);
  return '${(m ~/ 60).toString().padLeft(2, '0')}:${(m % 60).toString().padLeft(2, '0')}';
}

// ───────────────────────────── the map ─────────────────────────────

/// One line on screen: the newest message of a pair (when the lines merge, [n] of them), its age 0..1.
class MapSeg {
  MapSeg(this.m, this.n, this.age);
  final MapMsg m;
  final int n;
  final double age;

  /// His lines are told apart by weight and not by colour (text, 2), everyone's else's are lighter (text3, 1); a
  /// merged line grows by three quarters of a pixel per message and keeps its colour: to 4 at most for his, 3 for the rest.
  double width(bool owner) => math.min(owner ? 4.0 : 3.0, (owner ? 2.0 : 1.0) + (n - 1) * 0.75);
}

/// The lines to draw for [live]: each message its own, until more than [kMergeOver] are on screen; then each
/// unordered pair of people has one, the newest message's, as thick as it has messages.
List<MapSeg> segments(List<(MapMsg, double)> live) {
  if (live.length <= kMergeOver) return [for (final (m, a) in live) MapSeg(m, 1, a)];
  final byPair = <String, MapSeg>{};
  for (final (m, a) in live) {
    final key = m.from.compareTo(m.to) < 0 ? '${m.from}|${m.to}' : '${m.to}|${m.from}';
    final old = byPair[key];
    if (old == null) {
      byPair[key] = MapSeg(m, 1, a);
    } else {
      byPair[key] = MapSeg(m.t >= old.m.t ? m : old.m, old.n + 1, math.min(a, old.age));
    }
  }
  return byPair.values.toList();
}

bool _samePair(MapMsg a, MapMsg b) => (a.from == b.from && a.to == b.to) || (a.from == b.to && a.to == b.from);

bool _ownerLine(MapMsg m) => m.from == 'owner' || m.to == 'owner';

class _Map extends StatefulWidget {
  const _Map({required this.day, required this.now, required this.selected, required this.body, required this.bodyFailed, required this.onRetryBody, required this.onSelect});
  final MapDay day;
  final ValueNotifier<int> now;
  final MapMsg? selected;
  final MapBody? body;
  final bool bodyFailed;
  final VoidCallback? onRetryBody;
  final ValueChanged<MapMsg?> onSelect;

  /// Day-ms a line stays on screen: 600ms of replay.
  static int get life => (kLineLife.inMilliseconds * kDayMs / kReplay.inMilliseconds).round();

  @override
  State<_Map> createState() => _MapState();
}

class _MapState extends State<_Map> {
  MapLayout? _layout;

  double _spread = 1;

  MapLayout _layoutFor(Size canvas, double spread) {
    final l = _layout;
    if (l != null && identical(l.day, widget.day) && l.canvas == canvas && _spread == spread) return l;
    _spread = spread;
    return _layout = MapLayout(widget.day, canvas, spread);
  }

  /// The lines on screen at [t]: messages younger than a line's life, with their age 0..1.
  List<(MapMsg, double)> _live(MapLayout layout, int t) {
    final d = layout.day;
    final out = <(MapMsg, double)>[];
    for (var i = d.msgIndex(t - _Map.life); i < d.messages.length && d.messages[i].t <= t; i++) {
      final m = d.messages[i];
      if (m.from == m.to || !layout.pos.containsKey(m.from) || !layout.pos.containsKey(m.to)) continue;
      out.add((m, (t - m.t) / _Map.life));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final off = Mo.off(context);
    return LayoutBuilder(builder: (context, c) {
      final canvas = mapCanvas(Size(c.maxWidth, c.maxHeight));
      final scale = math.min(c.maxWidth / canvas.width, c.maxHeight / canvas.height);
      // Names and faces keep a size the eye can read when the canvas is shrunk to fit a small screen: text at 12 or
      // more on the screen itself, faces a little bigger (never past 1.4x, the rings around a lead are tight).
      final ui = 1 / math.min(scale, 1.0);
      final g = math.min(1.4, math.sqrt(ui));
      final layout = _layoutFor(canvas, (ui * 0.6).clamp(1.0, 1.6));
      return Stack(children: [
        Positioned.fill(
          child: FittedBox(
            child: SizedBox.fromSize(
              size: canvas,
              child: ValueListenableBuilder<int>(
                valueListenable: widget.now,
                builder: (context, t, _) {
                  final segs = segments(_live(layout, t));
                  return GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTapUp: (e) => widget.onSelect(_hit(layout, segs, e.localPosition, g, 16 / scale)),
                    child: Stack(clipBehavior: Clip.none, children: [
                      Positioned.fill(child: CustomPaint(painter: _Lines(layout, segs, widget.selected, context.p, off, g))),
                      for (final team in layout.day.teams) ..._team(context, layout, team, t, ui, g),
                    ]),
                  );
                },
              ),
            ),
          ),
        ),
        if (widget.selected != null)
          PositionedDirectional(
            top: 8,
            start: 16,
            child: _MessageCard(day: widget.day, m: widget.selected!, body: widget.body, failed: widget.bodyFailed, onRetry: widget.onRetryBody, onClose: () => widget.onSelect(null)),
          ),
      ]);
    });
  }

  MapMsg? _hit(MapLayout layout, List<MapSeg> segs, Offset at, double g, double reach) {
    MapMsg? best;
    var bestD = reach;
    for (final s in segs) {
      final m = s.m;
      final path = _path(layout.pos[m.from]!, layout.pos[m.to]!, _radius(layout.day, m.from, g), _radius(layout.day, m.to, g));
      for (final mtr in path.computeMetrics()) {
        for (var d = 0.0; d <= mtr.length; d += 4) {
          final dist = (mtr.getTangentForOffset(d)!.position - at).distance;
          if (dist < bestD) {
            bestD = dist;
            best = m;
          }
        }
      }
    }
    return best;
  }

  Iterable<Widget> _team(BuildContext context, MapLayout layout, MapTeam team, int t, double ui, double g) sync* {
    final p = context.p;
    final d = layout.day;
    for (final person in d.people.values.where((x) => x.team == team.id)) {
      final at = layout.pos[person.id];
      if (at == null) continue;
      final a = layout.alpha(person.id, t);
      if (a <= 0) continue;
      final on = !person.satellite && person.role == MapRole.lead ? d.present(person.id, t) : true;
      final dim = _dim(person.role) * g * (on ? 1 : 0.8);
      yield Positioned(
        left: at.dx - dim / 2,
        top: at.dy - dim / 2,
        child: Opacity(
          opacity: a,
          child: Tooltip(
            message: person.satellite ? '${person.name} · ${team.name}' : person.name,
            child: _Face(person: person, team: team, dim: dim, g: g),
          ),
        ),
      );
    }
    // A name under each, with the team's symbol: the tone is never alone (language-v2 §3).
    // A halo in the screen's colour keeps the lines that cross a name from cutting it (names on maps).
    final halo = [for (final (dx, dy) in const [(1, 0), (-1, 0), (0, 1), (0, -1), (.7, .7), (-.7, .7), (.7, -.7), (-.7, -.7)]) Shadow(color: p.bg, offset: Offset(dx * 1.6 * ui, dy * 1.6 * ui))];
    final style = T.meta.copyWith(color: p.text2, fontSize: 12.5 * ui, height: 1.2, shadows: halo);
    if (team.id == 'management') {
      for (final (id, name) in [('owner', UiCopy.copy.ran), ('yoav', UiCopy.copy.yoav), ('hq', 'hq')]) {
        final at = layout.pos[id]!;
        yield _label(at + Offset(0, _dim(d.people[id]!.role) * g / 2 + 4), Text(name, style: style), ui);
      }
      return;
    }
    final lead = team.lead == null ? null : d.people[team.lead];
    final c = layout.anchor[team.id]!;
    final drop = layout.ringDrop[team.id] ?? 0;
    // On a small screen the team's name alone: the lead's is in the tooltip, and two names do not fit side by side.
    final text = lead == null || ui > 1.4 ? team.name : '${team.name} · ${lead.name}';
    yield _label(
      c + Offset(0, drop == 0 ? _dim(MapRole.lead) * g / 2 + 10 * g : drop + 18),
      Row(mainAxisSize: MainAxisSize.min, children: [
        Ic(team.symbol, size: 15 * ui, color: p.text2, fill: true),
        SizedBox(width: 4 * ui),
        Text(text, style: lead != null && !d.present(lead.id, t) ? style.copyWith(color: p.text3) : style),
      ]),
      ui,
    );
  }

  Widget _label(Offset at, Widget child, double ui) => Positioned(
        left: at.dx - 120 * ui,
        top: at.dy,
        width: 240 * ui,
        child: Center(child: child),
      );
}

double _dim(MapRole r) => switch (r) { MapRole.owner || MapRole.lead => 42, MapRole.system => 34, _ => 22 };

double _radius(MapDay day, String id, double g) => switch (day.people[id]!.role) { MapRole.owner || MapRole.lead => 23, MapRole.system => 19, _ => 12 } * g;

/// A face: the team's tone at full strength, a thin ring for 3:1 against the background. A worker not on shift
/// right now is smaller (32 for 40), and its name lighter, not see-through.
class _Face extends StatelessWidget {
  const _Face({required this.person, required this.team, required this.dim, required this.g});
  final MapPerson person;
  final MapTeam team;
  final double dim, g;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final neutral = person.role == MapRole.owner || person.role == MapRole.system;
    final tone = neutral ? null : team.tone;
    final (_, letter) = tone == null ? (null, p.text) : p.identity(tone);
    final font = dim * 0.4;
    final circle = Container(
      width: dim,
      height: dim,
      alignment: Alignment.center,
      decoration: BoxDecoration(shape: BoxShape.circle, color: faceFill(p, tone), border: Border.all(color: faceRing(p, tone), width: 1.5)),
      child: person.role == MapRole.system
          ? Ic('dns', size: font + 3, color: letter)
          : Text(person.mono, style: TextStyle(fontFamily: kFont, fontWeight: FontWeight.w700, fontSize: font, height: 1, color: letter)),
    );
    if (person.role != MapRole.lead) return SizedBox(width: dim, height: dim, child: circle);
    final tm = 22.0 * g * dim / (42 * g);
    return SizedBox(
      width: dim,
      height: dim,
      child: Stack(clipBehavior: Clip.none, children: [
        circle,
        PositionedDirectional(
          bottom: -5 * g,
          end: -6 * g,
          child: Container(
            width: tm,
            height: tm,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface, boxShadow: [BoxShadow(color: p.bg, spreadRadius: 1.5)]),
            child: Ic(team.symbol, size: 15 * g * tm / (22 * g), fill: true, weight: 500, color: p.text2),
          ),
        ),
      ]),
    );
  }
}

/// A message's line: from just outside the sender to just outside the receiver, bowed a little to the
/// sender's right, so a reply runs on the other side of the message it answers.
Path _path(Offset a, Offset b, double ra, double rb) {
  final v = b - a;
  final len = v.distance;
  if (len < 1) return Path();
  final u = v / len;
  final n = Offset(-u.dy, u.dx);
  final s = a + u * ra, e = b - u * rb;
  // Between a lead and its own worker the line is short: straight, a bow there reads as a leaf.
  final c = (s + e) / 2 + n * (len < 90 ? 0 : len * 0.12);
  return Path()
    ..moveTo(s.dx, s.dy)
    ..quadraticBezierTo(c.dx, c.dy, e.dx, e.dy);
}

class _Lines extends CustomPainter {
  _Lines(this.layout, this.segs, this.selected, this.p, this.off, this.g);
  final MapLayout layout;
  final List<MapSeg> segs;
  final MapMsg? selected;
  final Palette p;
  final bool off;
  final double g;

  @override
  void paint(Canvas canvas, Size size) {
    for (final s in segs) {
      final m = s.m;
      final path = _path(layout.pos[m.from]!, layout.pos[m.to]!, _radius(layout.day, m.from, g), _radius(layout.day, m.to, g));
      final sel = selected != null && (m.id == selected!.id || (s.n > 1 && _samePair(m, selected!)));
      final owner = _ownerLine(m);
      // Drawn over the first third with M3 standard, then fades with M3 emphasized accelerate; a cut when
      // the system removes animations.
      final draw = off ? 1.0 : Mo.standard.transform((s.age / 0.33).clamp(0.0, 1.0));
      final fade = off ? 1.0 : 1 - Mo.exit.transform(((s.age - 0.33) / 0.67).clamp(0.0, 1.0));
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeWidth = s.width(owner) + (sel ? 1 : 0)
        ..color = sel ? p.accent : (owner ? p.text : p.text3).withValues(alpha: fade);
      if (draw >= 1) {
        canvas.drawPath(path, paint);
      } else {
        for (final mtr in path.computeMetrics()) {
          canvas.drawPath(mtr.extractPath(0, mtr.length * draw), paint);
        }
      }
    }
  }

  @override
  bool shouldRepaint(_Lines old) => true;
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.day, required this.m, required this.body, required this.failed, required this.onRetry, required this.onClose});
  final MapDay day;
  final MapMsg m;
  final MapBody? body;
  final bool failed;
  final VoidCallback? onRetry;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    MapPerson who(String id) => day.people[id]!;
    Widget face(String id) {
      final x = who(id);
      final dim = 22.0;
      return SizedBox(width: dim, height: dim, child: _Face(person: x, team: day.team(x.team), dim: dim, g: 1));
    }

    return Container(
      width: 380,
      constraints: const BoxConstraints(maxHeight: 300),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: p.line)),
      padding: const EdgeInsetsDirectional.fromSTEB(16, 8, 4, 14),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          face(m.from),
          const SizedBox(width: 6),
          Text(who(m.from).name, style: T.chip.copyWith(color: p.text, fontSize: 13.5)),
          Padding(padding: const EdgeInsets.symmetric(horizontal: 6), child: Ic('arrow_back', size: 16, color: p.text3)),
          face(m.to),
          const SizedBox(width: 6),
          Flexible(child: Text(who(m.to).name, style: T.chip.copyWith(color: p.text, fontSize: 13.5))),
          const Spacer(),
          Text(hhmm(m.t), style: T.meta.copyWith(color: p.text3, fontFeatures: const [FontFeature.tabularFigures()])),
          IBtn('close', tip: UiCopy.copy.close2, onTap: onClose),
        ]),
        const SizedBox(height: 4),
        if (body != null)
          Flexible(child: SingleChildScrollView(child: Text(body!.body, style: T.small.copyWith(color: p.text))))
        else if (failed)
          Row(children: [
            Text(UiCopy.copy.thisMessageCould, style: T.small.copyWith(color: p.text2)),
            const SizedBox(width: 8),
            InkWell(onTap: onRetry, child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(UiCopy.copy.tryAgain, style: T.small.copyWith(color: p.accent)))),
          ])
        else
          Text(UiCopy.copy.loading2, style: T.small.copyWith(color: p.text3)),
      ]),
    );
  }
}

// ───────────────────────────── the timeline ─────────────────────────────

/// Flightradar's playback bar. Media controls stay left-to-right in Hebrew too (Material, bidirectionality):
/// midnight on the left, the end of the day on the right.
class _Timeline extends StatefulWidget {
  const _Timeline({required this.day, required this.now, required this.playing, required this.onPlay, required this.onSeek, required this.today, this.compact = false});
  final MapDay day;
  final ValueNotifier<int> now;
  final bool playing, compact, today;
  final VoidCallback onPlay;
  final ValueChanged<int> onSeek;

  @override
  State<_Timeline> createState() => _TimelineState();
}

class _TimelineState extends State<_Timeline> {
  static const bins = 96; // 15 minutes each
  late final counts = () {
    final c = List.filled(bins, 0);
    for (final m in widget.day.messages) {
      c[(m.t * bins ~/ kDayMs).clamp(0, bins - 1)]++;
    }
    return c;
  }();
  int? hover;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final tab = const [FontFeature.tabularFigures()];
    return ValueListenableBuilder<int>(
      valueListenable: widget.now,
      builder: (context, t, _) {
        final (tasks, merges, deploys) = widget.day.countsAt(t);
        final end = t >= widget.day.upTo;
        // A time right before a colon flips sides in RTL: the running line puts the time last.
        final counts = '${plural(tasks, UiCopy.copy.oneTask, UiCopy.copy.tasks3)}, ${plural(merges, UiCopy.copy.oneMerge, UiCopy.copy.merges)}, ${plural(deploys, UiCopy.copy.oneRelease, UiCopy.copy.releases)}';
        final sum = end ? '${widget.today ? UiCopy.copy.today2 : UiCopy.copy.fullDay}: $counts' : UiCopy.copy.until(counts, hhmm(t));
        return Padding(
          padding: EdgeInsets.symmetric(horizontal: widget.compact ? 12 : 24),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Directionality(
              textDirection: TextDirection.ltr,
              child: Row(children: [
                _PlayButton(playing: widget.playing, onTap: widget.onPlay),
                const SizedBox(width: 12),
                SizedBox(width: 58, child: Text(hhmm(t), style: T.name.copyWith(color: p.text, fontFeatures: tab))),
                const SizedBox(width: 8),
                Expanded(child: _track(context, t)),
              ]),
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(top: 6),
              child: Text(sum, style: T.secondary.copyWith(color: end ? p.text : p.text2, fontFeatures: tab)),
            ),
          ]),
        );
      },
    );
  }

  Widget _track(BuildContext context, int t) {
    final p = context.p;
    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth;
      int at(double x) => (x / w * kDayMs).round();
      final h = hover;
      return MouseRegion(
        onHover: (e) => setState(() => hover = (e.localPosition.dx / w * bins).floor().clamp(0, bins - 1)),
        onExit: (_) => setState(() => hover = null),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (e) => widget.onSeek(at(e.localPosition.dx)),
          onHorizontalDragUpdate: (e) => widget.onSeek(at(e.localPosition.dx)),
          child: SizedBox(
            height: 56,
            child: Stack(clipBehavior: Clip.none, children: [
              Positioned.fill(child: CustomPaint(painter: _Histogram(counts, t / kDayMs, h, p))),
              for (var hr = 0; hr <= 24; hr += 3)
                Positioned(
                  left: w * hr / 24 - 20,
                  width: 40,
                  bottom: 0,
                  child: Center(child: Text(hr.toString().padLeft(2, '0'), style: T.meta.copyWith(color: p.text3, fontSize: 11, height: 1))),
                ),
              if (h != null)
                Positioned(
                  left: (w * (h + 0.5) / bins - 70).clamp(0.0, w - 140),
                  width: 140,
                  top: -26,
                  child: Center(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(color: p.text, borderRadius: BorderRadius.circular(6)),
                      child: Directionality(
                        textDirection: TextDirection.rtl,
                        child: Text('${hhmm(h * kDayMs ~/ bins)} · ${plural(counts[h], UiCopy.copy.oneMessage, UiCopy.copy.messages3)}',
                            style: T.meta.copyWith(color: p.bg, fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()])),
                      ),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      );
    });
  }
}

/// Messages per 15 minutes: one series, so one ink and no legend. What was already played is darker.
class _Histogram extends CustomPainter {
  _Histogram(this.counts, this.played, this.hover, this.p);
  final List<int> counts;
  final double played;
  final int? hover;
  final Palette p;

  @override
  void paint(Canvas canvas, Size size) {
    const axis = 16.0; // the hour labels under the bars
    final base = size.height - axis;
    final top = 4.0;
    final maxC = counts.reduce(math.max).clamp(1, 1 << 30);
    final bw = size.width / counts.length;
    canvas.drawLine(Offset(0, base + 0.5), Offset(size.width, base + 0.5), Paint()..color = p.line);
    for (var i = 0; i < counts.length; i++) {
      if (counts[i] == 0) continue;
      final hgt = math.max(2.0, (base - top) * counts[i] / maxC);
      final x = i * bw + 1;
      final r = RRect.fromRectAndCorners(Rect.fromLTWH(x, base - hgt, math.max(1, bw - 2), hgt), topLeft: const Radius.circular(1.5), topRight: const Radius.circular(1.5));
      final on = (i + 1) / counts.length <= played;
      canvas.drawRRect(r, Paint()..color = i == hover ? p.text : (on ? p.text3 : p.text3.withValues(alpha: 0.32)));
    }
    final x = size.width * played;
    canvas.drawRect(Rect.fromLTWH(x - 1, 0, 2, base), Paint()..color = p.accent);
    canvas.drawCircle(Offset(x, 0), 5, Paint()..color = p.accent);
  }

  @override
  bool shouldRepaint(_Histogram old) => old.played != played || old.hover != hover || old.p != p;
}

class _PlayButton extends StatelessWidget {
  const _PlayButton({required this.playing, required this.onTap});
  final bool playing;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Tooltip(
      message: playing ? UiCopy.copy.pause : UiCopy.copy.play,
      child: Material(
        color: p.accent,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          hoverColor: p.onAccent.withValues(alpha: 0.08),
          highlightColor: p.onAccent.withValues(alpha: 0.12),
          splashColor: p.onAccent.withValues(alpha: 0.12),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Center(
              child: AnimatedSwitcher(
                duration: Mo.off(context) ? Duration.zero : Mo.xs,
                child: Ic(playing ? 'pause' : 'play_arrow', key: ValueKey(playing), fill: true, color: p.onAccent, size: 26),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
