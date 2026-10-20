// The head of the chats screen: one card, like iOS's notification summary, with only what needs him
// or changed since he was here. Each part only when it has something; with none, there is no card.
// 1. בוער: a production failure, a message that did not get through, a stuck worker. First, and heavier.
// 2. מחכה לך: a face per item, its headline, who and what kind; a tap opens the card in the chat (#79),
//    a swipe is "לא עכשיו" (#74).
// 3. מאז שהיית פה: one folded line; a tap opens every sentence inside the card.
// Hierarchy is type and space only: no color, no fills, one hairline between the parts (design-taste).
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../home/home_screen.dart';
import '../blocks/blocks.dart';
import '../nav.dart';

/// One row of "בוער" or "מחכה לך".
class HeadLine {
  const HeadLine({required this.key, required this.from, required this.text, required this.word, this.at, this.item, this.hot = false});

  /// Stable across rebuilds: what the row animates by.
  final String key;
  final String from;

  /// The headline: his words, one line.
  final String text;

  /// What kind: "תקלה בפרודקשן", "תקוע", "שאלה", "GO לפרודקשן".
  final String word;
  final DateTime? at;

  /// The inbox item behind it; null for a stuck worker.
  final WaitItem? item;
  final bool hot;
}

class HeadData {
  const HeadData({this.burning = const [], this.waiting = const [], this.done = const []});
  final List<HeadLine> burning;
  final List<HeadLine> waiting;

  /// Newest first.
  final List<SinceItem> done;
  bool get empty => burning.isEmpty && waiting.isEmpty && done.isEmpty;

  /// incident, delivery_failure and a shift that did not come back burn; the rest waits for him.
  static bool hot(WaitItem w) => w.kind == WaitKind.urgentProd || w.kind == WaitKind.failure;

  /// The row of a waiting item.
  static HeadLine lineOf(WaitItem w) {
    final kicker = w.kicker.split(' · ').first;
    final h = hot(w);
    return HeadLine(
      key: w.id,
      from: w.from,
      text: (w.headline ?? w.body).split('\n').first.trim(),
      word: h && (w.kind == WaitKind.urgentProd || kicker.contains('פרודקשן')) ? 'תקלה בפרודקשן' : kicker,
      at: w.createdAt,
      item: w,
      hot: h,
    );
  }

  /// The row of a stuck worker: the task he is stuck on.
  static HeadLine stuckOf(CompanyData d, String id) {
    final who = d.who(id);
    final pr = d.presence[id];
    final task = plainTitle(pr?.currentTask ?? pr?.activity ?? '');
    return HeadLine(key: 'stuck:$id', from: id, text: task.isEmpty ? who.title : task, word: statusWord(WorkerStatus.stuck, who.gender), hot: true);
  }

  factory HeadData.of(CompanyData d, {required DateTime since}) {
    final burning = <HeadLine>[];
    final waiting = <HeadLine>[];
    for (final w in d.waiting) {
      if (w.state != WaitState.open && w.state != WaitState.pending) continue;
      (hot(w) ? burning : waiting).add(lineOf(w));
    }
    for (final who in d.identities.values) {
      if (d.presence[who.id]?.status == WorkerStatus.stuck) burning.add(stuckOf(d, who.id));
    }
    return HeadData(burning: burning, waiting: waiting, done: SinceData.of(d, since: since).items);
  }

  /// "עכשיו", "4 דק'", "שעה", "3 שע'", "יום".
  static String ago(DateTime? at, DateTime now) {
    if (at == null) return '';
    final m = now.difference(at).inMinutes;
    if (m < 1) return 'עכשיו';
    if (m < 60) return "$m דק'";
    final h = m ~/ 60;
    if (h == 1) return 'שעה';
    if (h == 2) return 'שעתיים';
    if (h < 24) return "$h שע'";
    return h < 48 ? 'יום' : '${h ~/ 24} ימים';
  }

  /// The same, read aloud: "לפני 4 דקות".
  static String agoSpoken(DateTime? at, DateTime now) {
    if (at == null) return '';
    final m = now.difference(at).inMinutes;
    if (m < 1) return 'עכשיו';
    if (m == 1) return 'לפני דקה';
    if (m < 60) return 'לפני $m דקות';
    final h = m ~/ 60;
    if (h == 1) return 'לפני שעה';
    if (h == 2) return 'לפני שעתיים';
    if (h < 24) return 'לפני $h שעות';
    return h < 48 ? 'אתמול' : 'לפני ${h ~/ 24} ימים';
  }
}

const _kMotion = Duration(milliseconds: 200);
const _kCurve = Curves.easeOutCubic;
final _tabular = [const FontFeature.tabularFigures()];

/// The card. Nothing when there is nothing; when it empties it folds away.
class ChatsHead extends StatefulWidget {
  const ChatsHead({super.key, required this.data, required this.since, required this.now});
  final HeadData data;
  final DateTime since;
  final DateTime now;

  @override
  State<ChatsHead> createState() => _ChatsHeadState();
}

class _ChatsHeadState extends State<ChatsHead> with SingleTickerProviderStateMixin {
  late final AnimationController _card = AnimationController(vsync: this, duration: _kMotion, value: widget.data.empty ? 0 : 1);
  late final _cardCurve = CurvedAnimation(parent: _card, curve: _kCurve);

  /// What the card shows: the data, or while it folds away, the last data it had.
  late HeadData _shown = widget.data;

  /// "מאז שהיית פה" opened.
  bool _open = false;

  /// Rows swiped away: their Dismissible already shrank them, they leave without a second animation.
  final _swiped = <String>{};

  @override
  void didUpdateWidget(ChatsHead old) {
    super.didUpdateWidget(old);
    if (!widget.data.empty) {
      _shown = widget.data;
      _card.forward();
    } else if (!_shown.empty) {
      // Folding with the last data it had, minus rows a swipe already took (their Dismissible is gone).
      final h = _shown;
      _shown = HeadData(
        burning: [for (final l in h.burning) if (!_swiped.contains(l.key)) l],
        waiting: [for (final l in h.waiting) if (!_swiped.contains(l.key)) l],
        done: h.done,
      );
      _card.reverse().whenComplete(() {
        if (!mounted || !widget.data.empty) return;
        setState(() => _shown = const HeadData());
        _swiped.clear();
      });
    }
    if (widget.data.done.isEmpty) _open = false;
  }

  @override
  void dispose() {
    _cardCurve.dispose();
    _card.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Empty while folding (the last row swiped away): the frame still folds, it doesn't snap.
    if (_shown.empty && _card.value == 0) return const SizedBox.shrink();
    final p = context.p;
    final h = _shown;
    final rows = <(String, Widget)>[];
    for (final l in h.burning) {
      rows.add((l.key, _LineRow(l: l, now: widget.now, onSwiped: () => _swiped.add(l.key))));
    }
    if (h.burning.isNotEmpty && h.waiting.isNotEmpty) rows.add(('sep:waiting', _Hairline(p.line)));
    for (final l in h.waiting) {
      rows.add((l.key, _LineRow(l: l, now: widget.now, onSwiped: () => _swiped.add(l.key))));
    }
    if (h.done.isNotEmpty) {
      if (h.burning.isNotEmpty || h.waiting.isNotEmpty) rows.add(('sep:since', _Hairline(p.line)));
      rows.add(('since', SinceBlock(data: SinceData(since: widget.since, items: h.done), now: widget.now, open: _open, onToggle: () => setState(() => _open = !_open))));
    }
    return SizeTransition(
      sizeFactor: _cardCurve,
      alignment: AlignmentDirectional.topCenter,
      child: FadeTransition(
        opacity: _card,
        child: Container(
          color: p.surface,
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
          child: Semantics(
            container: true,
            label: 'מה צריך ממך',
            explicitChildNodes: true,
            child: Container(
              decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(16), border: Border.all(color: p.line)),
              clipBehavior: Clip.antiAlias,
              child: Material(
                type: MaterialType.transparency,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: _Animated(rows: rows, skip: _swiped),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "בוער" as a block of its own (the home recipe's `alert`): [items] that burn (production failures, messages that
/// did not get through) and the [stuck] workers, a row each, in the card's look and motion.
class AlertBlock extends StatelessWidget {
  const AlertBlock({super.key, required this.items, this.stuck = const [], this.now});
  final List<WaitItem> items;

  /// Identities of stuck workers.
  final List<String> stuck;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data;
    final lines = [
      for (final w in items)
        if (w.state == WaitState.open || w.state == WaitState.pending) HeadData.lineOf(w),
      if (d != null) for (final id in stuck) HeadData.stuckOf(d, id),
    ];
    return _Lines(lines: lines, now: now ?? CompanyTime.now());
  }
}

/// "מחכה לך" as a block of its own (the home recipe's `waiting`): a face and a line per open item; a tap opens
/// the chat at its card, a swipe is "לא עכשיו".
class WaitingBlock extends StatelessWidget {
  const WaitingBlock({super.key, required this.items, this.now});
  final List<WaitItem> items;
  final DateTime? now;

  @override
  Widget build(BuildContext context) => _Lines(
        lines: [
          for (final w in items)
            if (w.state == WaitState.open || w.state == WaitState.pending) HeadData.lineOf(w),
        ],
        now: now ?? CompanyTime.now(),
      );
}

class _Lines extends StatefulWidget {
  const _Lines({required this.lines, required this.now});
  final List<HeadLine> lines;
  final DateTime now;
  @override
  State<_Lines> createState() => _LinesState();
}

class _LinesState extends State<_Lines> {
  final _swiped = <String>{};
  @override
  Widget build(BuildContext context) => _Animated(
        rows: [for (final l in widget.lines) (l.key, _LineRow(l: l, now: widget.now, onSwiped: () => _swiped.add(l.key)))],
        skip: _swiped,
      );
}

/// A column whose rows come in with a short fade and leave by folding up, by key.
class _Animated extends StatefulWidget {
  const _Animated({required this.rows, required this.skip});
  final List<(String, Widget)> rows;

  /// Keys that leave at once (a Dismissible already took them away).
  final Set<String> skip;

  @override
  State<_Animated> createState() => _AnimatedState();
}

class _Entry {
  _Entry(this.key, this.child, this.c) : curve = CurvedAnimation(parent: c, curve: _kCurve);
  final String key;
  Widget child;
  final AnimationController c;
  final CurvedAnimation curve;
  bool leaving = false;

  void dispose() {
    curve.dispose();
    c.dispose();
  }
}

class _AnimatedState extends State<_Animated> with TickerProviderStateMixin {
  late List<_Entry> _entries = [for (final (k, w) in widget.rows) _Entry(k, w, _controller(1))];

  AnimationController _controller(double value) => AnimationController(vsync: this, duration: _kMotion, value: value);

  @override
  void didUpdateWidget(_Animated old) {
    super.didUpdateWidget(old);
    final byKey = {for (final e in _entries) e.key: e};
    final next = <_Entry>[];
    for (final (k, w) in widget.rows) {
      final e = byKey.remove(k);
      if (e != null) {
        e.child = w;
        if (e.leaving) {
          e.leaving = false;
          e.c.forward();
        }
        next.add(e);
      } else {
        next.add(_Entry(k, w, _controller(0))..c.forward());
      }
    }
    // The rest leave from where they were: after the row that came before them.
    for (final (i, e) in _entries.indexed) {
      if (!byKey.containsKey(e.key)) continue;
      if (widget.skip.remove(e.key)) {
        e.dispose();
        continue;
      }
      // After the nearest earlier row still on the card (the one right before may have been swiped away).
      var at = 0;
      for (var j = i - 1; j >= 0; j--) {
        final k = next.indexOf(_entries[j]);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      next.insert(at, e);
      if (!e.leaving) {
        e.leaving = true;
        e.c.reverse().whenComplete(() {
          if (!mounted || !e.leaving) return;
          setState(() => _entries.remove(e));
          e.dispose();
        });
      }
    }
    _entries = next;
  }

  @override
  void dispose() {
    for (final e in _entries) {
      e.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final e in _entries)
          KeyedSubtree(
            key: ValueKey(e.key),
            child: SizeTransition(
              sizeFactor: e.curve,
              alignment: AlignmentDirectional.topCenter,
              child: FadeTransition(opacity: e.c, child: ExcludeSemantics(excluding: e.leaving, child: e.child)),
            ),
          ),
      ]);
}

class _Hairline extends StatelessWidget {
  const _Hairline(this.color);
  final Color color;
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Container(height: 1, color: color));
}

/// A face: the worker's monogram, and on it a small badge with the kind of thing.
class _Face extends StatelessWidget {
  const _Face({required this.id, required this.badge, required this.hot});
  final String id;
  final String badge;
  final bool hot;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final who = d.who(id);
    final textScale = MediaQuery.textScalerOf(context).scale(1).clamp(1.0, 1.3);
    final dim = 36.0 * textScale;
    return SizedBox(
      width: dim + 4,
      height: dim + 2,
      child: Stack(clipBehavior: Clip.none, children: [
        Container(
          width: dim,
          height: dim,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface3),
          child: id == kSystemId
              ? Ic('dns', size: 18 * textScale, color: p.text)
              : Text(who.initial, textScaler: TextScaler.noScaling, style: TextStyle(fontFamily: kFont, fontWeight: FontWeight.w700, fontSize: 15 * textScale, height: 1, color: p.text)),
        ),
        PositionedDirectional(
          bottom: -2,
          end: 0,
          child: Container(
            width: 18,
            height: 18,
            alignment: Alignment.center,
            // The ring is the card's own surface: the badge sits cut into the face.
            decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface, boxShadow: [BoxShadow(color: p.surface, spreadRadius: 1.5)]),
            child: Ic(badge, size: 15, fill: true, weight: hot ? 600 : 400, color: p.text),
          ),
        ),
      ]),
    );
  }
}

/// "בוער" or "מחכה לך": face, headline, then who and what kind, the time at the end.
class _LineRow extends StatelessWidget {
  const _LineRow({required this.l, required this.now, required this.onSwiped});
  final HeadLine l;
  final DateTime now;
  final VoidCallback onSwiped;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final name = d.who(l.from).name;
    final time = HeadData.ago(l.at, now);
    final second = T.small.copyWith(color: p.text2);
    void open() {
      final item = l.item;
      if (item != null) return openWait(context, item);
      Nav.chat(context, l.from);
    }

    final spoken = [l.hot ? 'בוער' : 'מחכה לך', l.word, name, HeadData.agoSpoken(l.at, now)].where((s) => s.isNotEmpty).join(', ');
    final item = l.item;
    final canSnooze = item != null && item.inboxId != null;
    Widget row = Semantics(
      button: true,
      label: '$spoken. ${l.text}',
      hint: 'פתיחה',
      excludeSemantics: true,
      customSemanticsActions: canSnooze ? {const CustomSemanticsAction(label: 'לא עכשיו'): () => store.notNow(item)} : null,
      child: InkWell(
        onTap: open,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(children: [
              _Face(id: l.from, badge: l.hot ? 'warning' : 'pause_circle', hot: l.hot),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Rich(l.text, auto: true, maxLines: 1, style: T.body.copyWith(fontWeight: l.hot ? FontWeight.w700 : FontWeight.w500, color: p.text, height: 21 / 15.5)),
                  const SizedBox(height: 2),
                  Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Expanded(
                      child: Text.rich(
                        TextSpan(children: l.hot
                            ? [TextSpan(text: l.word, style: const TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: ' · $name')]
                            : [TextSpan(text: name), if (l.word.isNotEmpty) TextSpan(text: ' · ${l.word}')]),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: second,
                      ),
                    ),
                    if (time.isNotEmpty) ...[const SizedBox(width: 8), Text(time, style: second.copyWith(fontFeatures: _tabular))],
                  ]),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
    if (!canSnooze) return row;
    // A swipe either way is "לא עכשיו": the item stays open, below the rest, in "סטטוס" and in the chat (#74).
    return Dismissible(
      key: ValueKey('head-swipe-${l.key}'),
      direction: DismissDirection.horizontal,
      dismissThresholds: const {DismissDirection.startToEnd: 0.35, DismissDirection.endToStart: 0.35},
      resizeDuration: _kMotion,
      onDismissed: (_) {
        onSwiped();
        store.notNow(item);
      },
      background: _SwipeLabel(start: true),
      secondaryBackground: _SwipeLabel(start: false),
      child: row,
    );
  }
}

class _SwipeLabel extends StatelessWidget {
  const _SwipeLabel({required this.start});
  final bool start;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      color: p.surface2,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      alignment: start ? AlignmentDirectional.centerStart : AlignmentDirectional.centerEnd,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Ic('schedule', size: 18, color: p.text),
        const SizedBox(width: 6),
        Text('לא עכשיו', style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w500)),
      ]),
    );
  }
}
