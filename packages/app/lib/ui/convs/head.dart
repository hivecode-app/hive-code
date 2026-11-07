import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// What needs him, as rows for the home (home_v2.dart): "בוער" (a production failure, a message that did not get
// through, a stuck worker; first, and heavier) and "מחכה לך" (a face per item, its headline, who and what kind;
// a tap opens the card in the chat (#79), a swipe is "לא עכשיו" (#74), a decision is taken right on the row).
// Hierarchy is type and space only: no color, no fills (design-taste).
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../data/backend.dart';
import '../../data/error_report.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../decision.dart';
import '../chat/chat_screen.dart';
import '../home/home_screen.dart';
import '../blocks/blocks.dart';
import '../nav.dart';
import 'convs_v2.dart' show WordFit;

/// One row of "בוער" or "מחכה לך".
class HeadLine {
  const HeadLine({required this.key, required this.from, required this.text, required this.word, this.at, this.item, this.hot = false, this.timed = true});

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

  /// "4 דק'" at its end. Not for a fault the system caught: its [word] says how many times and since when.
  final bool timed;
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
    // The system's card for a fault (error-watch.ts): "תפסתי תקלה · 3 פעמים מ-13:40", whole, in place of the time.
    final caught = isCaughtFault(w.from, w.askId);
    final kicker = caught ? w.kicker : w.kicker.split(' · ').first;
    final h = hot(w);
    return HeadLine(
      key: w.id,
      from: w.from,
      text: (w.headline ?? w.body).split('\n').first.trim(),
      word: h && (w.kind == WaitKind.urgentProd || w.sourceKind == 'incident' || (w.sourceKind == null && kicker.contains(InputCopy.v6))) ? UiCopy.copy.productionIssue : kicker,
      at: w.createdAt,
      item: w,
      hot: h,
      timed: !caught,
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
      if (d.superseded(w)) continue;
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
    if (m < 1) return UiCopy.copy.now;
    if (m < 60) return UiCopy.copy.min3(m);
    final h = m ~/ 60;
    if (h == 1) return UiCopy.copy.hour;
    if (h == 2) return UiCopy.copy.twoHours;
    if (h < 24) return UiCopy.copy.h2(h);
    return h < 48 ? UiCopy.copy.day : UiCopy.copy.days(h ~/ 24);
  }

  /// The same, read aloud: "לפני 4 דקות".
  static String agoSpoken(DateTime? at, DateTime now) {
    if (at == null) return '';
    final m = now.difference(at).inMinutes;
    if (m < 1) return UiCopy.copy.now;
    if (m == 1) return UiCopy.copy.minuteAgo;
    if (m < 60) return UiCopy.copy.minutesAgo(m);
    final h = m ~/ 60;
    if (h == 1) return UiCopy.copy.hourAgo;
    if (h == 2) return UiCopy.copy.twoHoursAgo;
    if (h < 24) return UiCopy.copy.hoursAgo(h);
    return h < 48 ? UiCopy.copy.yesterday2 : UiCopy.copy.daysAgo(h ~/ 24);
  }
}

const _kMotion = Duration(milliseconds: 200);
const _kCurve = Curves.easeOutCubic;
final _tabular = [const FontFeature.tabularFigures()];

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
    UiCopy.watch(context);
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
  Widget build(BuildContext context) { UiCopy.watch(context); return _Lines(lines: [for (final w in items) if ((w.state == WaitState.open || w.state == WaitState.pending) && !(StoreScope.of(context).data?.superseded(w) ?? false)) HeadData.lineOf(w)], now: now ?? CompanyTime.now()); }
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
  Widget build(BuildContext context) { UiCopy.watch(context); return _Animated(rows: [for (final l in widget.lines) (l.key, _LineRow(l: l, now: widget.now, onSwiped: () => _swiped.add(l.key)))], skip: _swiped); }
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
  Widget build(BuildContext context) { UiCopy.watch(context); return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [for (final e in _entries) KeyedSubtree(key: ValueKey(e.key), child: SizeTransition(sizeFactor: e.curve, alignment: AlignmentDirectional.topCenter, child: FadeTransition(opacity: e.c, child: ExcludeSemantics(excluding: e.leaving, child: e.child))))]); }
}

/// A face: the worker's monogram, and on it a small badge with the kind of thing.
class _Face extends StatelessWidget {
  const _Face({required this.id, required this.badge, required this.hot});
  final String id;
  final String badge;
  final bool hot;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final who = d.who(id);
    final textScale = MediaQuery.textScalerOf(context).scale(1).clamp(1.0, 1.3);
    final dim = 36.0 * textScale;
    // The face in its project's tone (language-v2 §3); the badge stays the state, the name is beside it.
    final (bg, fg) = id != kSystemId ? p.identity(d.teamOf(id)?.tone) : (p.surface3, p.text);
    // The ring is the card's own surface (dark: the card is a step up).
    final ring = p.dark ? p.surface2 : p.surface;
    return SizedBox(
      width: dim + 4,
      height: dim + 2,
      child: Stack(clipBehavior: Clip.none, children: [
        Container(
          width: dim,
          height: dim,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
          child: id == kSystemId
              ? Ic('dns', size: 18 * textScale, color: fg)
              : Text(who.initial, textScaler: TextScaler.noScaling, style: TextStyle(fontFamily: kFont, fontWeight: FontWeight.w700, fontSize: 15 * textScale, height: 1, color: fg)),
        ),
        PositionedDirectional(
          bottom: -2,
          end: 0,
          child: Container(
            width: 18,
            height: 18,
            alignment: Alignment.center,
            // The ring is the card's own surface: the badge sits cut into the face.
            decoration: BoxDecoration(shape: BoxShape.circle, color: ring, boxShadow: [BoxShadow(color: ring, spreadRadius: 1.5)]),
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
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final name = d.who(l.from).name;
    final time = l.timed ? HeadData.ago(l.at, now) : '';
    final second = T.small.copyWith(color: p.text2);
    void open() {
      final item = l.item;
      if (item != null) return openWait(context, item);
      Nav.chat(context, l.from);
    }

    final spoken = [l.hot ? UiCopy.copy.urgent : UiCopy.copy.needsYou2, l.word, name, HeadData.agoSpoken(l.at, now)].where((s) => s.isNotEmpty).join(', ');
    final item = l.item;
    final pending = item == null ? null : store.decision(item.askId, item.id);
    final keys = item == null || pending != null ? null : decisionKeysOf(context, item);
    final canSnooze = item != null && item.inboxId != null && pending == null;
    Widget row = Semantics(
      button: true,
      label: '$spoken. ${l.text}',
      hint: UiCopy.copy.open2,
      excludeSemantics: true,
      customSemanticsActions: canSnooze ? { CustomSemanticsAction(label: UiCopy.copy.notNow2): () => store.notNow(item)} : null,
      child: InkWell(
        onTap: open,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(children: [
              _Face(id: l.from, badge: l.hot ? 'warning' : 'front_hand', hot: l.hot),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Rich(l.text, auto: true, maxLines: 2, style: T.body.copyWith(fontWeight: l.hot ? FontWeight.w700 : FontWeight.w500, color: p.text, height: 21 / 15.5)),
                  const SizedBox(height: 2),
                  Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Expanded(
                      child: l.hot
                          ? WordFit(lead: '${l.word} ', leadStyle: const TextStyle(fontWeight: FontWeight.w700), text: '· $name', style: second)
                          : !l.timed
                              ? WordFit(lead: '', text: l.word, style: second) // a fault: the system's face says who
                              : WordFit(lead: '$name ', text: l.word.isEmpty ? ' ' : '· ${l.word}', style: second),
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
    // A decision is taken right here (#258): its buttons under the row, or its folded line with "ביטול".
    // The row itself still opens the conversation at the card.
    if (pending != null || keys != null) {
      row = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        if (pending == null) row,
        Padding(
          padding: EdgeInsetsDirectional.fromSTEB(pending == null ? 68 : 16, pending == null ? 0 : 6, 16, pending == null ? 12 : 6),
          child: pending != null
              ? DecisionLine(icon: pendingIcon(pending), text: pendingLine(pending), subject: l.text, onUndo: () => store.cancelUndo(AppStore.decisionKey(item!.askId, item.id)))
              : DecisionKeys(keys: keys!),
        ),
      ]);
    }
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
    UiCopy.watch(context);
    final p = context.p;
    return Container(
      color: p.surface2,
      padding: const EdgeInsets.symmetric(horizontal: 20),
      alignment: start ? AlignmentDirectional.centerStart : AlignmentDirectional.centerEnd,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Ic('schedule', size: 18, color: p.text),
        const SizedBox(width: 6),
        Text(UiCopy.copy.notNow2, style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w500)),
      ]),
    );
  }
}

/// The one-tap answers of a waiting item, or null when it is not a decision (a login, a failure, a note).
/// GO: "אישור" and "לא עכשיו". A question: its options and "תשובה אחרת", which opens the conversation at
/// the card with the answer started (#258).
List<DecisionButton>? decisionKeysOf(BuildContext context, WaitItem item) {
  final store = StoreScope.read(context);
  switch (item.kind) {
    case WaitKind.go:
      return DecisionKeys.go(onGo: () => store.answerWait(item, item.options.first), onNotNow: () => store.notNow(item));
    case WaitKind.blockingAsk:
    case WaitKind.softAsk:
      if (item.askId == null) return null;
      return DecisionKeys.ask(item.options, other: !isCaughtFault(item.from, item.askId), onPick: (o) => store.answerWait(item, o), onOther: () {
        if (!(store.data?.canChat(item.from) ?? false)) return Nav.waitItem(context, item);
        ChatScreen.pendingTarget[item.from] = item.askId!;
        Nav.chat(context, item.from, quote: Quote(author: store.nameOf(item.from), text: (item.headline ?? item.body).split('\n').first, askId: item.askId), focus: true);
      });
    case WaitKind.awaiting:
      // A finished task to check (#219): "עובד" or "לא עובד", one tap each.
      return [for (final o in item.options) DecisionButton(o.label, primary: o.primary, onTap: () => store.answerWait(item, o))];
    default:
      return null;
  }
}
