// "פסי היום": a lane per project on one time axis, Tufte-style: ink on paper, no color as a sign.
// The project is the row, the people are the faces, the tasks are the marks:
// · a running task: a thick bar from its start to now on a track of its own under the dots, the face of whoever
//   is on it inside its now end, breathing;
// · a finished task: a small filled dot where it finished; dots on the same few pixels are one, with a count;
// · something waiting for him: a hollow ring with `pause` just past now;
// · tasks waiting their turn (#128): a hollow ring with `schedule` just past now, on a track of its own;
// · a production failure: `warning` where it happened.
// RTL: time flows right to left, now is at the left edge. A tap picks the nearest mark and tells its story under
// the axis (where the legend is); a tap on the name opens the project.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../entity_link.dart';
import '../nav.dart';
import 'data.dart';
import 'parts.dart';

const _kRow = 30.0;
const _kBar = 18.0;
const _kBarGap = 4.0;

/// Room past the now line for the "waiting" ring.
const _kGutter = 26.0;

/// Marks closer than this (a merged mark is 15px wide) are one mark with a count.
const _kMerge = 16.0;

class LanesBlock extends StatefulWidget {
  const LanesBlock({super.key, required this.data, this.legend = true});
  final LanesData data;
  final bool legend;

  @override
  State<LanesBlock> createState() => _LanesBlockState();
}

/// The picked mark: its lane, its place, what it says.
typedef _Pick = ({int lane, double x, double y, String text, String meta, String? to});

class _LanesBlockState extends State<LanesBlock> {
  _Pick? _pick;

  void _toggle(_Pick p) => setState(() => _pick = _pick != null && _pick!.lane == p.lane && _pick!.x == p.x && _pick!.y == p.y ? null : p);

  @override
  Widget build(BuildContext context) {
    final data = widget.data;
    final span = data.now.difference(data.from).inMilliseconds.clamp(1, 1 << 52);
    final scaler = MediaQuery.textScalerOf(context).clamp(maxScaleFactor: 1.15);
    final nameStyle = T.meta.copyWith(fontWeight: FontWeight.w500);
    return Semantics(
      container: true,
      label: 'פסי היום, ${hm(data.from)} עד ${hm(data.now)}',
      explicitChildNodes: true,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: LayoutBuilder(builder: (context, c) {
          // The names column fits the longest name, up to 40% of the width.
          var longest = 0.0;
          for (final l in data.lanes) {
            final tp = TextPainter(text: TextSpan(text: l.name, style: nameStyle), textDirection: TextDirection.rtl, textScaler: scaler, maxLines: 1)..layout();
            longest = math.max(longest, tp.width);
          }
          final label = math.min(math.max(longest + 16 + 6 + 10, 64.0), c.maxWidth * 0.4);
          final w = c.maxWidth - label;
          // From the lane's far end (the past, right in RTL) to now, which sits _kGutter from its near end.
          double x(DateTime t) {
            final f = (t.difference(data.from).inMilliseconds / span).clamp(0.0, 1.0);
            return (w - _kGutter) * (1 - f) + _kGutter;
          }

          final pick = _pick;
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (final (i, l) in data.lanes.indexed)
              _LaneRow(
                lane: l,
                data: data,
                x: x,
                label: label,
                width: w,
                nameStyle: nameStyle,
                scaler: scaler,
                picked: pick?.lane == i ? Offset(pick!.x, pick.y) : null,
                onPick: (dx, dy, text, meta, to) => _toggle((lane: i, x: dx, y: dy, text: text, meta: meta, to: to)),
              ),
            _Axis(data: data, x: x, label: label, width: w),
            const SizedBox(height: 10),
            // The picked mark's story where the legend is, so nothing covers the lanes; a tap puts the legend back.
            AnimatedSwitcher(
              duration: kBlockMotion,
              child: pick == null
                  ? (widget.legend ? const _Legend() : const SizedBox.shrink())
                  : _Detail(key: ValueKey(pick), pick: pick, onTap: () => setState(() => _pick = null)),
            ),
          ]);
        }),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({super.key, required this.pick, required this.onTap});
  final _Pick pick;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final story = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Rich(pick.text, auto: true, maxLines: 4, style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w500)),
      if (pick.meta.isNotEmpty) Text(pick.meta, style: T.meta.copyWith(color: p.text2, fontFeatures: kTabular)),
    ]);
    // A mark a worker stands behind opens their conversation; `close` puts the legend back.
    if (pick.to != null) {
      return Semantics(
        liveRegion: true,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: EntityLink(identity: pick.to, label: [pick.text, pick.meta].where((s) => s.isNotEmpty).join('. '), borderRadius: BorderRadius.circular(8), child: story)),
          const SizedBox(width: 4),
          IBtn('close', tip: 'סגירה', onTap: onTap),
        ]),
      );
    }
    return Semantics(
      liveRegion: true,
      button: true,
      hint: 'סגירה',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: story),
          const SizedBox(width: 8),
          Ic('close', size: 18, color: p.text2),
        ]),
      ),
    );
  }
}

/// Hour lines behind a lane (stronger on the labeled hours), its faint baseline, and the now line.
class _Grid extends CustomPainter {
  _Grid({required this.data, required this.x, required this.every, required this.line, required this.now, required this.base, required this.mid});
  final LanesData data;
  final double Function(DateTime) x;
  final int every;
  final Color line, now, base;
  final double mid;

  @override
  void paint(Canvas canvas, Size size) {
    final soft = Paint()
      ..color = line.withValues(alpha: 0.45)
      ..strokeWidth = 1;
    final hard = Paint()
      ..color = line
      ..strokeWidth = 1;
    var h = hourStart(data.from, 1);
    while (h.isBefore(data.now)) {
      final dx = x(h);
      canvas.drawLine(Offset(dx, 0), Offset(dx, size.height), wall(h).hour % every == 0 ? hard : soft);
      h = h.add(const Duration(hours: 1));
    }
    canvas.drawLine(Offset(_kGutter, mid), Offset(size.width, mid), Paint()
      ..color = base
      ..strokeWidth = 1);
    canvas.drawLine(Offset(x(data.now), 0), Offset(x(data.now), size.height), Paint()
      ..color = now
      ..strokeWidth = 1);
  }

  @override
  bool shouldRepaint(_Grid old) => old.data != data || old.line != line || old.every != every;
}

/// Labeled hours every 1, 2, 3, 4 or 6, whichever first leaves room for the figures.
int _every(LanesData data, double width) {
  final hours = data.now.difference(data.from).inMinutes / 60;
  final perHour = (width - _kGutter) / (hours <= 0 ? 1 : hours);
  for (final e in [1, 2, 3, 4, 6]) {
    if (perHour * e >= 28) return e;
  }
  return 8;
}

/// One or more finished tasks on the same few pixels.
class _Cluster {
  _Cluster(this.first);
  final LaneDone first;
  final items = <LaneDone>[];
}

class _LaneRow extends StatelessWidget {
  const _LaneRow({
    required this.lane,
    required this.data,
    required this.x,
    required this.label,
    required this.width,
    required this.nameStyle,
    required this.scaler,
    required this.onPick,
    this.picked,
  });
  final Lane lane;
  final LanesData data;
  final double Function(DateTime) x;
  final double label;
  final double width;
  final TextStyle nameStyle;
  final TextScaler scaler;
  final void Function(double x, double y, String text, String meta, String? to) onPick;

  /// Where the picked mark is on this lane: a ring around it.
  final Offset? picked;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    String name(String? id) => id == null || d == null ? '' : d.who(id).name;
    String works(String? id) => id != null && d?.who(id).gender == Gender.f ? 'עובדת' : 'עובד';
    // A date when it is not today (an incident from yesterday sits at the axis' edge).
    String when(DateTime t) => daysAgo(t, data.now) == 0 ? hm(t) : '${dm(t)} ${hm(t)}';
    final runs = lane.running.length;
    // The dots' track, then a track per running task under it (bars never hide what finished), then the queue's.
    final height = _kRow + (runs + (lane.queued.isEmpty ? 0 : 1)) * (_kBar + _kBarGap);
    final mid = _kRow / 2;
    final marks = <Widget>[];
    // Each mark's span on the lane and its story: a tap picks the one nearest the finger.
    final targets = <({double from, double to, double top, double bottom, VoidCallback pick})>[];
    VoidCallback target(double from, double to, double top, double bottom, double px, double py, String text, String meta, [String? chat]) {
      void pick() => onPick(px, py, text, meta, chat);
      targets.add((from: from, to: to, top: top, bottom: bottom, pick: pick));
      return pick;
    }

    // Running: a thick bar each, stacked when more than one, the face inside the now end.
    final nowX = x(data.now);
    for (final (i, r) in lane.running.indexed) {
      final top = _kRow - _kBarGap + i * (_kBar + _kBarGap);
      final len = math.max(x(r.from) - nowX, _kBar + 8);
      final story = [name(r.who), 'מ-${hm(r.from)}'].where((s) => s.isNotEmpty).join(' · ');
      final pick = target(nowX, nowX + len, top, top + _kBar, nowX + _kBar / 2, top + _kBar / 2, r.text, story, d == null ? null : chatTargetOf(d, worker: r.who));
      marks.add(Positioned(
        left: nowX,
        top: top,
        width: len,
        height: _kBar,
        child: _Mark(
          spoken: '${name(r.who).isEmpty ? 'רצה' : '${name(r.who)} ${works(r.who)} על זה'} מ-${hm(r.from)}',
          text: r.text,
          onTap: pick,
          child: DecoratedBox(
            decoration: BoxDecoration(color: p.text, borderRadius: BorderRadius.circular(_kBar / 2)),
            child: Align(alignment: Alignment.centerLeft, child: Padding(padding: const EdgeInsets.all(2), child: _Breathing(child: _Face(id: r.who, size: _kBar - 4)))),
          ),
        ),
      ));
    }
    // Finished: dots, merged when they fall on the same few pixels.
    final clusters = <_Cluster>[];
    for (final dn in [...lane.done]..sort((a, b) => a.at.compareTo(b.at))) {
      final at = x(dn.at);
      final last = clusters.isEmpty ? null : clusters.last;
      if (last == null || (x(last.first.at) - at).abs() > _kMerge) clusters.add(_Cluster(dn));
      clusters.last.items.add(dn);
    }
    for (final c in clusters) {
      // Drawn where its first one is: clusters start _kMerge apart, so they never overlap.
      final at = x(c.first.at);
      final n = c.items.length;
      final newest = c.items.last;
      final text = n == 1 ? newest.text : [for (final x in c.items.reversed.take(3)) x.text, if (n > 3) 'ועוד ${n - 3}'].join('\n');
      final meta = n == 1
          ? [name(newest.who), hm(newest.at)].where((s) => s.isNotEmpty).join(' · ')
          : '$n הסתיימו · מ-${hm(c.items.first.at)} עד ${hm(newest.at)}';
      final size = n == 1 ? 7.0 : 15.0;
      final pick = target(at - size / 2, at + size / 2, mid - 8, mid + 8, at, mid, text, meta,
          n == 1 && d != null ? chatTargetOf(d, worker: newest.who, openedBy: newest.opener, done: true) : null);
      marks.add(Positioned(
        left: at - size / 2,
        top: mid - size / 2,
        width: size,
        height: size,
        child: _Mark(
          spoken: n == 1 ? 'הסתיימה ב-${hm(newest.at)}' : '$n הסתיימו, ${hm(c.items.first.at)} עד ${hm(newest.at)}',
          text: text,
          onTap: pick,
          child: Container(
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: p.text, border: Border.all(color: p.surface, width: 1)),
            child: n == 1
                ? null
                : Text('$n', textScaler: TextScaler.noScaling, style: TextStyle(fontFamily: kFont, fontSize: 9, height: 1, fontWeight: FontWeight.w700, color: p.surface, fontFeatures: kTabular)),
          ),
        ),
      ));
    }
    for (final al in lane.alerts) {
      final at = x(al.at);
      final pick = target(at - 8, at + 8, mid - 8, mid + 8, at, mid, al.text, when(al.at));
      marks.add(Positioned(
        left: at - 9,
        top: mid - 9,
        width: 18,
        height: 18,
        child: _Mark(spoken: 'תקלה ב-${when(al.at)}', text: al.text, onTap: pick, child: Center(child: Ic('warning', size: 16, fill: true, color: p.text))),
      ));
    }
    if (lane.waiting > 0) {
      final text = lane.waiting == 1 ? 'דבר אחד מחכה לך' : '${lane.waiting} דברים מחכים לך';
      final pick = target(2, 18, mid - 8, mid + 8, 10, mid, text, '');
      marks.add(Positioned(
        left: 2,
        top: mid - 8,
        width: 16,
        height: 16,
        child: _Mark(
          spoken: 'מחכה לך',
          text: text,
          onTap: pick,
          child: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface, border: Border.all(color: p.text, width: 1.5)),
            alignment: Alignment.center,
            child: Ic('pause', size: 11, fill: true, color: p.text),
          ),
        ),
      ));
    }
    if (lane.queued.isNotEmpty) {
      final n = lane.queued.length;
      final top = _kRow - _kBarGap + runs * (_kBar + _kBarGap) + (_kBar - 16) / 2;
      final text = [for (final q in lane.queued.take(3)) q, if (n > 3) 'ועוד ${n - 3}'].join('\n');
      final meta = n == 1 ? 'בתור' : '$n בתור';
      final pick = target(2, 18, top, top + 16, 10, top + 8, text, meta);
      marks.add(Positioned(
        left: 2,
        top: top,
        width: 16,
        height: 16,
        child: _Mark(
          spoken: n == 1 ? 'משימה אחת בתור' : '$n משימות בתור',
          text: text,
          onTap: pick,
          child: Container(
            decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface, border: Border.all(color: p.text, width: 1.5)),
            alignment: Alignment.center,
            child: Ic('schedule', size: 11, color: p.text),
          ),
        ),
      ));
    }
    if (picked != null) {
      marks.add(Positioned(
        left: picked!.dx - 11,
        top: picked!.dy - 11,
        width: 22,
        height: 22,
        child: IgnorePointer(child: DecoratedBox(decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: p.text, width: 1.5)))),
      ));
    }
    final spoken = [
      lane.name,
      if (runs > 0) runs == 1 ? 'משימה אחת רצה' : '$runs רצות',
      '${lane.done.length} הסתיימו היום',
      if (lane.waiting > 0) lane.waiting == 1 ? 'דבר אחד מחכה לך' : '${lane.waiting} דברים מחכים לך',
      if (lane.queued.isNotEmpty) lane.queued.length == 1 ? 'משימה אחת בתור' : '${lane.queued.length} משימות בתור',
      if (lane.alerts.isNotEmpty) 'תקלה',
    ].join(', ');
    return Semantics(
      label: spoken,
      child: SizedBox(
        height: height,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          // The name opens the project.
          Semantics(
            button: true,
            label: 'פתיחת ${lane.name}',
            excludeSemantics: true,
            child: InkWell(
              onTap: () => Nav.project(context, lane.id),
              child: SizedBox(
                width: label,
                height: _kRow,
                child: Row(children: [
                  Ic(lane.symbol, size: 16, color: p.text2),
                  const SizedBox(width: 6),
                  Expanded(child: Text(lane.name, maxLines: 1, overflow: TextOverflow.ellipsis, textScaler: scaler, style: nameStyle.copyWith(color: p.text))),
                ]),
              ),
            ),
          ),
          // Painted left to right whatever the reading direction: the axis is drawn, not laid out.
          SizedBox(
            width: width,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapUp: (e) {
                final at = e.localPosition;
                ({double from, double to, double top, double bottom, VoidCallback pick})? best;
                var bestD = double.infinity;
                for (final t in targets) {
                  final dx = at.dx < t.from ? t.from - at.dx : (at.dx > t.to ? at.dx - t.to : 0.0);
                  final dy = at.dy < t.top ? t.top - at.dy : (at.dy > t.bottom ? at.dy - t.bottom : 0.0);
                  final dist = dx + dy;
                  if (dist <= 12 && dist < bestD) {
                    best = t;
                    bestD = dist;
                  }
                }
                best == null ? Nav.project(context, lane.id) : best.pick();
              },
              child: Directionality(
                textDirection: TextDirection.ltr,
                child: CustomPaint(
                  painter: _Grid(data: data, x: x, every: _every(data, width), line: p.line, now: p.text2, base: p.surface3, mid: mid),
                  child: Stack(clipBehavior: Clip.none, children: marks),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }
}

/// A mark as a screen reader meets it; a finger is served by the lane, which picks the nearest one.
class _Mark extends StatelessWidget {
  const _Mark({required this.spoken, required this.text, required this.onTap, required this.child});
  final String spoken;
  final String text;
  final VoidCallback onTap;
  final Widget child;

  @override
  Widget build(BuildContext context) => Semantics(button: true, label: '$spoken. $text', onTap: onTap, excludeSemantics: true, child: IgnorePointer(child: child));
}

/// The face inside a running bar's now end: the worker's initial, ink on paper.
class _Face extends StatelessWidget {
  const _Face({required this.id, required this.size});
  final String? id;
  final double size;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final letter = id == null ? '' : (d?.who(id!).initial ?? id!.characters.first);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface),
      alignment: Alignment.center,
      child: id == null
          ? Ic('play_arrow', size: size - 4, fill: true, color: p.text)
          : Text(letter, textScaler: TextScaler.noScaling, style: TextStyle(fontFamily: kFont, fontSize: size * 0.62, height: 1, fontWeight: FontWeight.w700, color: p.text)),
    );
  }
}

/// A slow breath (2.4s) on whoever is working now; still under "reduce motion" and in tests.
class _Breathing extends StatefulWidget {
  const _Breathing({required this.child});
  final Widget child;
  @override
  State<_Breathing> createState() => _BreathingState();
}

class _BreathingState extends State<_Breathing> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 2400));
  late final _curve = CurvedAnimation(parent: _c, curve: Curves.easeInOut);
  late final _opacity = Tween(begin: 1.0, end: 0.72).animate(_curve);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final still = Motion.frozen || MediaQuery.disableAnimationsOf(context);
    if (still) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _curve.dispose();
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(opacity: _opacity, child: widget.child);
}

/// The hours under the lanes, small and evenly spaced, and "עכשיו" at its line.
class _Axis extends StatelessWidget {
  const _Axis({required this.data, required this.x, required this.label, required this.width});
  final LanesData data;
  final double Function(DateTime) x;
  final double label;
  final double width;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final style = T.meta.copyWith(fontSize: 10.5, color: p.text3, fontFeatures: kTabular);
    final every = _every(data, width);
    final labels = <Widget>[];
    var h = hourStart(data.from, 1);
    final nowX = x(data.now);
    while (h.isBefore(data.now)) {
      final dx = x(h), hour = wall(h).hour;
      if (hour % every == 0 && dx - nowX > 34 && dx < width - 8) {
        labels.add(Positioned(left: dx - 14, width: 28, top: 0, child: Text(hour.toString().padLeft(2, '0'), textAlign: TextAlign.center, style: style, textScaler: TextScaler.noScaling)));
      }
      h = h.add(const Duration(hours: 1));
    }
    labels.add(Positioned(left: nowX - 22, width: 44, top: 0, child: Text('עכשיו', textAlign: TextAlign.center, style: style.copyWith(color: p.text2), textScaler: TextScaler.noScaling)));
    return ExcludeSemantics(
      child: Row(children: [
        SizedBox(width: label),
        SizedBox(width: width, height: 18, child: Directionality(textDirection: TextDirection.ltr, child: Stack(clipBehavior: Clip.none, children: labels))),
      ]),
    );
  }
}

/// One small legend: the kinds of things on the lanes.
class _Legend extends StatelessWidget {
  const _Legend();
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final style = T.meta.copyWith(fontSize: 11.5, color: p.text2);
    Widget item(Widget mark, String text) => Row(mainAxisSize: MainAxisSize.min, children: [mark, const SizedBox(width: 5), Text(text, style: style)]);
    return ExcludeSemantics(
      child: Wrap(spacing: 14, runSpacing: 6, children: [
        item(Container(width: 18, height: 9, decoration: BoxDecoration(color: p.text, borderRadius: BorderRadius.circular(4.5))), 'רצה'),
        item(Container(width: 7, height: 7, decoration: BoxDecoration(shape: BoxShape.circle, color: p.text)), 'הסתיימה'),
        item(
          Container(
            width: 13,
            height: 13,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, color: p.text),
            child: Text('3', textScaler: TextScaler.noScaling, style: TextStyle(fontFamily: kFont, fontSize: 8, height: 1, fontWeight: FontWeight.w700, color: p.surface)),
          ),
          'כמה יחד',
        ),
        item(Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: p.text, width: 1.5))), 'מחכה לך'),
        item(
          Container(
            width: 13,
            height: 13,
            alignment: Alignment.center,
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: p.text, width: 1.5)),
            child: Ic('schedule', size: 9, color: p.text),
          ),
          'בתור',
        ),
        item(Ic('warning', size: 13, fill: true, color: p.text), 'תקלה'),
      ]),
    );
  }
}
