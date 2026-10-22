// The "החלטות" tab (task 306, direction C of #228): what waits for him is a work queue, the way Stripe Radar's
// review queue is. One decision at a time, on the whole screen: who and from which project, what is asked (a
// large headline), why and the risk (the details, open), the links, and big answers at the foot. A decision
// sends the next one in (M3 shared axis), "2 מתוך 5" on top says where he is, "אחר כך" puts one at the end.
// Nothing left: "אין החלטות. הכול רץ." The desktop: a narrow list of them at the side, the chosen one in the
// middle, as an inbox. On the other screens a line above the navigation says how many wait (DecisionsStrip).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/error_report.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../native/open_url.dart';
import '../../theme/motion.dart';
import '../../theme/tokens.dart';
import '../chat/chat_screen.dart';
import '../blocks/parts.dart' show kTabular;
import '../common.dart';
import '../convs/convs_v2.dart' show whenV2, WordFit;
import '../decision.dart';
import '../home/home_screen.dart' show openWait;
import '../nav.dart';
import '../selection.dart';
import '../system_bar.dart';

// ───────────────────────────── the queue ─────────────────────────────

/// What he did with one, for its row and its line at the foot: "אישרת", "ענית: כן", "לא עכשיו".
class DecisionDone {
  DecisionDone(this.line, this.icon);
  final String line;
  final String icon;
}

/// The queue of one visit: the order is frozen when an item comes in (so nothing jumps under his finger), what
/// he decided stays in it, folded ("2 מתוך 5" counts it), and what he put off goes to the end.
class DecisionQueue extends ChangeNotifier {
  final List<String> order = [];
  final Map<String, DecisionDone> done = {};
  String? current;

  /// The last decision, with its "ביטול", for 5 seconds.
  String? lastId;
  VoidCallback? _undo;
  Timer? _lastTimer;

  /// The way the next one comes in: forward after a decision or a skip, back after "ביטול" or K.
  bool forward = true;

  static bool open(CompanyData d, WaitItem w) => (w.state == WaitState.open || w.state == WaitState.pending) && !d.superseded(w);

  /// Brings the order up to the data: new items at the end (most urgent first among them), items closed
  /// elsewhere out. Called on every build; changes nothing that is on screen.
  List<WaitItem> sync(CompanyData d) {
    final byId = {for (final w in d.waiting) w.id: w};
    order.removeWhere((id) => !done.containsKey(id) && !(byId[id] != null && open(d, byId[id]!)));
    final fresh = [for (final w in d.waiting) if (open(d, w) && !order.contains(w.id)) w]..sort((a, b) => _rank(a).compareTo(_rank(b)));
    order.addAll(fresh.map((w) => w.id));
    if (current != null && (!order.contains(current) || (done.containsKey(current) && lastId != current))) current = null;
    current ??= _next(from: -1);
    return [for (final id in order) ?byId[id]];
  }

  /// APP-SPEC §4.2's order: urgent prod, a blocking question, GO, a sign-in, a failure, a task to check, a soft question.
  static int _rank(WaitItem w) => w.kind.index;

  String? _next({required int from}) {
    for (var i = 1; i <= order.length; i++) {
      final id = order[(from + i) % order.length];
      if (!done.containsKey(id)) return id;
    }
    return null;
  }

  int get remaining => order.where((id) => !done.containsKey(id)).length;

  /// "2 מתוך 5": the place of the one on screen; after the last, nothing.
  (int, int)? get position {
    final c = current;
    if (c == null || done.containsKey(c)) return null;
    return (done.length + 1, order.length);
  }

  void select(String id) {
    if (id == current) return;
    forward = order.indexOf(id) > order.indexOf(current ?? '');
    current = id;
    notifyListeners();
  }

  /// J and K on the desktop: the next or the previous open one.
  void step(int by) {
    final open = [for (final id in order) if (!done.containsKey(id)) id];
    if (open.isEmpty) return;
    final i = open.indexOf(current ?? '');
    final n = (i + by).clamp(0, open.length - 1);
    if (open[n] == current) return;
    forward = by > 0;
    current = open[n];
    notifyListeners();
  }

  void decided(WaitItem item, String line, {String icon = 'check_circle', VoidCallback? undo}) {
    done[item.id] = DecisionDone(line, icon);
    _lastTimer?.cancel();
    lastId = item.id;
    _undo = undo;
    _lastTimer = Timer(const Duration(seconds: 5), () {
      lastId = null;
      _undo = null;
      notifyListeners();
    });
    forward = true;
    current = _next(from: order.indexOf(item.id));
    notifyListeners();
  }

  void undoLast() {
    final id = lastId;
    if (id == null) return;
    _undo?.call();
    _lastTimer?.cancel();
    done.remove(id);
    lastId = null;
    _undo = null;
    forward = false;
    current = id;
    notifyListeners();
  }

  /// "אחר כך": to the end of the queue, nothing sent.
  void later() {
    final c = current;
    if (c == null) return;
    final from = order.indexOf(c);
    order
      ..remove(c)
      ..add(c);
    forward = true;
    current = _next(from: from - 1);
    notifyListeners();
  }
}

/// One queue for the app: the phone's tab and the desktop's list and pane all show it.
final decisionQueue = DecisionQueue();

// ───────────────────────────── what a decision says ─────────────────────────────

/// A decision as the screen tells it: the headline, the details without hq's trailer lines ("PR: 211",
/// "סיכון: low") and the risk in words. The PR itself is a link under it, from hq's `links`.
class DecisionText {
  DecisionText._(this.headline, this.details, this.risk, this.prUrl);
  final String headline;
  final String details;
  final String? risk;

  /// The PR's own link, when the worker wrote one in the trailer ("PR: https://github.com/…/pull/210").
  final String? prUrl;

  static final _prLine = RegExp(r'^PR:\s*(?:#?\d+|(https://github\.com/\S+/pull/\d+))\s*$');
  static final _riskLine = RegExp(r'^סיכון:\s*(low|medium|high)\s*$');

  factory DecisionText.of(WaitItem w) {
    String? prUrl, risk;
    final lines = <String>[];
    for (final l in w.body.split('\n')) {
      final t = l.trim();
      final m = _prLine.firstMatch(t);
      final r = _riskLine.firstMatch(t);
      if (m != null) {
        prUrl = m.group(1);
      } else if (r != null) {
        risk = const {'low': 'סיכון נמוך', 'medium': 'סיכון בינוני', 'high': 'סיכון גבוה'}[r.group(1)];
      } else {
        lines.add(l);
      }
    }
    var details = lines.join('\n').trim();
    var headline = w.headline;
    if (headline == null) {
      final i = details.indexOf('\n');
      headline = i < 0 ? details : details.substring(0, i);
      details = i < 0 ? '' : details.substring(i + 1).trim();
    } else if (details.startsWith(headline)) {
      details = details.substring(headline.length).trim();
    }
    return DecisionText._(headline.replaceAll('**', ''), details, risk, prUrl);
  }
}

// ───────────────────────────── phone ─────────────────────────────

/// The tab: the queue's title and "2 מתוך 5", the decision on screen, and its answers at the foot.
class DecisionsScreen extends StatelessWidget {
  const DecisionsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: decisionQueue,
      builder: (context, _) {
        final items = decisionQueue.sync(d);
        final item = items.where((w) => w.id == decisionQueue.current).firstOrNull;
        final pos = decisionQueue.position;
        return Container(
          color: p.bg,
          child: Column(children: [
            TopBar(title: 'החלטות', showLink: true, actions: [if (pos != null) _Position(pos), const SizedBox(width: 12)]),
            const SystemBar(),
            Expanded(
              child: _Switch(
                id: item?.id ?? 'empty',
                forward: decisionQueue.forward,
                child: item == null ? const _Empty() : _Decision(item: item),
              ),
            ),
            const _LastLine(),
          ]),
        );
      },
    );
  }
}

/// "2 מתוך 5", in figures that keep their width.
class _Position extends StatelessWidget {
  const _Position(this.pos);
  final (int, int) pos;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      label: 'החלטה ${pos.$1} מתוך ${pos.$2}',
      excludeSemantics: true,
      child: Text('${pos.$1} מתוך ${pos.$2}', style: T.secondary.copyWith(color: p.text2, fontFeatures: kTabular)),
    );
  }
}

/// M3 shared axis X between two decisions (language-v2 §5, `Mo`): the next comes 30dp from the reading end and
/// fades in, the one decided moves 30dp toward the start and fades out. Back ("ביטול") the other way.
/// "הסר אנימציות": a cut.
class _Switch extends StatelessWidget {
  const _Switch({required this.id, required this.forward, required this.child});
  final String id;
  final bool forward;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (Mo.off(context)) return KeyedSubtree(key: ValueKey(id), child: child);
    final rtl = Directionality.of(context) == TextDirection.rtl;
    final dir = (rtl ? -1.0 : 1.0) * (forward ? 1 : -1);
    return AnimatedSwitcher(
      duration: Mo.md,
      reverseDuration: Mo.md,
      layoutBuilder: (current, previous) => Stack(children: [...previous, ?current]),
      transitionBuilder: (child, a) {
        final coming = child.key == ValueKey(id);
        return AnimatedBuilder(
          animation: a,
          child: child,
          builder: (context, child) {
            final double o, dx;
            if (coming) {
              o = const Interval(0.3, 1).transform(a.value);
              dx = 30 * dir * (1 - Mo.enter.transform(a.value));
            } else {
              final s = 1 - a.value;
              o = 1 - const Interval(0, 0.3).transform(s);
              dx = -30 * dir * Mo.exit.transform(s);
            }
            return Opacity(opacity: o.clamp(0.0, 1.0), child: Transform.translate(offset: Offset(dx, 0), child: child));
          },
        );
      },
      child: KeyedSubtree(key: ValueKey(id), child: child),
    );
  }
}

/// The queue empty: one sentence and one icon, nothing drawn.
class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    // What he put off with "לא עכשיו" is not lost: it waits here until he takes it back.
    final later = putOff(d);
    return ListView(padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
      SizedBox(
        height: later.isEmpty ? 400 : 200,
        child: Center(
          child: Semantics(
            liveRegion: true,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Ic('check_circle', size: 32, color: p.text2),
              const SizedBox(height: 12),
              Text('אין החלטות. הכול רץ.', style: T.body.copyWith(color: p.text2)),
            ]),
          ),
        ),
      ),
      if (later.isNotEmpty) _PutOff(items: later),
    ]);
  }
}

/// What he put off with "לא עכשיו", each with its way back. On the empty screen, and in a sheet from the foot of a decision.
class _PutOff extends StatelessWidget {
  const _PutOff({required this.items});
  final List<WaitItem> items;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('נדחו', style: T.section.copyWith(color: p.text2)),
      const SizedBox(height: 8),
      for (final w in items)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Expanded(child: Rich(DecisionText.of(w).headline, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text))),
            const SizedBox(width: 8),
            TextButton(
              onPressed: () {
                StoreScope.read(context).resume(w);
                if (Navigator.of(context).canPop() && ModalRoute.of(context) is PopupRoute) Navigator.of(context).pop();
              },
              style: TextButton.styleFrom(minimumSize: const Size(64, 44)),
              child: Text('החזרה לתור', style: T.button.copyWith(color: p.accent)),
            ),
          ]),
        ),
    ]);
  }
}

/// The ones put off, as one list.
List<WaitItem> putOff(CompanyData? d) => [for (final w in d?.waiting ?? const <WaitItem>[]) if (w.state == WaitState.notNow && !d!.superseded(w)) w];

/// One decision on the whole screen: the details scroll, the answers stay at the foot.
class _Decision extends StatelessWidget {
  const _Decision({required this.item, this.keys = false});
  final WaitItem item;

  /// The desktop: number keys on the answers.
  final bool keys;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return ColoredBox(
      color: p.bg,
      child: Column(children: [
        Expanded(child: _Body(item: item)),
        Container(
          decoration: BoxDecoration(color: p.bg, border: Border(top: BorderSide(color: p.line))),
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: _Answers(item: item, keys: keys),
        ),
      ]),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.item});
  final WaitItem item;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final who = d.who(item.from);
    final team = d.teamOf(item.from)?.name;
    final t = DecisionText.of(item);
    final when = item.createdAt == null ? item.time : whenV2(item.createdAt!, CompanyTime.now());
    final kicker = item.kicker;
    // The same row for every decision: what does not exist is not shown.
    String? urlOf(WaitLinkKind k) => item.links.where((l) => l.kind == k).firstOrNull?.url;
    final report = urlOf(WaitLinkKind.report);
    final pr = urlOf(WaitLinkKind.pr) ?? t.prUrl;
    final links = <Widget>[
      if (report != null) _LinkChip(icon: 'description', label: 'הדוח המלא', onTap: () => openExternalUrl(report)),
      if (pr != null) _LinkChip(icon: 'call_merge', label: 'ה-PR', onTap: () => openExternalUrl(pr)),
      if (d.canChat(item.from)) _LinkChip(icon: 'chat', label: 'השיחה עם ${who.name}', onTap: () => Nav.chat(context, item.from)),
    ];
    return ListView(padding: const EdgeInsets.fromLTRB(20, 12, 20, 24), children: [
      Row(children: [
        Monogram.of(d, item.from, size: AvSize.sm),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text.rich(
              TextSpan(children: [
                TextSpan(text: who.name, style: TextStyle(fontWeight: FontWeight.w700, color: p.text)),
                if (team != null && team.isNotEmpty) TextSpan(text: ' · $team'),
              ]),
              style: T.secondary.copyWith(color: p.text2),
            ),
            Text([kicker, when, ?t.risk].join(' · '), style: T.small.copyWith(color: p.text2, fontFeatures: kTabular)),
          ]),
        ),
      ]),
      const SizedBox(height: 20),
      // The ask itself: the screen's one large line.
      Semantics(header: true, child: Rich(t.headline, auto: true, style: TextStyle(fontFamily: kFont, fontSize: 24, height: 32 / 24, fontWeight: FontWeight.w700, color: p.text))),
      if (t.details.isNotEmpty) ...[
        const SizedBox(height: 14),
        CopySelectionArea(child: Rich(t.details, auto: true, style: T.body.copyWith(color: p.text, height: 25 / 15.5))),
      ],
      if (links.isNotEmpty) ...[
        const SizedBox(height: 20),
        Wrap(spacing: 8, runSpacing: 8, children: links),
      ],
    ]);
  }
}

/// A link under the details: an icon that says where it goes, and its name.
class _LinkChip extends StatelessWidget {
  const _LinkChip({required this.icon, required this.label, this.onTap});
  final String icon;
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Btn(label, icon: icon, height: 40, fontSize: 13.5, hpad: 14, onTap: onTap);
}

/// The answers by kind: a decision (a GO, a fault) "אישור" and "לא עכשיו"; a task he is asked to check "עובד" and
/// "לא עובד"; a question its options, all of one weight unless the asker recommends one; a sign-in opens. Under
/// them, "אחר כך".
class _Answers extends StatelessWidget {
  const _Answers({required this.item, this.keys = false});
  final WaitItem item;
  final bool keys;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final buttons = answersOf(context, item, keys: keys);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      DecisionKeys(keys: buttons),
      const SizedBox(height: 4),
      Row(children: [
        TextButton.icon(
          onPressed: decisionQueue.later,
          style: TextButton.styleFrom(minimumSize: const Size(64, 44), foregroundColor: p.text2),
          icon: Ic('schedule', size: 18, color: p.text2),
          label: Text('אחר כך', style: T.button.copyWith(color: p.text2)),
        ),
        const Spacer(),
        if (decisionQueue.remaining > 1)
          Text('עוד ${decisionQueue.remaining - 1} אחרי זו', style: T.meta.copyWith(color: p.text3, fontFeatures: kTabular)),
        if (putOff(StoreScope.of(context).data).isNotEmpty)
          TextButton.icon(
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              backgroundColor: p.surface,
              showDragHandle: true,
              builder: (_) => Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), child: _PutOff(items: putOff(StoreScope.read(context).data))),
            ),
            style: TextButton.styleFrom(minimumSize: const Size(64, 44), foregroundColor: p.text2),
            icon: Ic('history', size: 18, color: p.text2),
            label: Text('נדחו · ${putOff(StoreScope.of(context).data).length}', style: T.button.copyWith(color: p.text2)),
          ),
      ]),
    ]);
  }
}

/// A decision's answers, each telling the queue, so the next one comes in. The sending is the store's, with its
/// 5 seconds to take back (#258); "ביטול" on the foot line cancels it and brings the decision back.
List<DecisionButton> answersOf(BuildContext context, WaitItem item, {bool keys = false}) {
  final store = StoreScope.read(context);
  const h = 56.0;
  void answer(AskOption o) {
    store.answerWait(item, o);
    final key = AppStore.decisionKey(item.askId, item.id);
    final line = item.kind == WaitKind.awaiting ? o.label : AppStore.decidedLine(o);
    decisionQueue.decided(item, line, icon: o.id == 'failed' ? 'close' : 'check_circle', undo: () => store.cancelUndo(key));
  }

  void notNow() {
    store.notNow(item);
    decisionQueue.decided(item, 'לא עכשיו', icon: 'schedule', undo: () => store.resume(item));
  }

  String? hint(int i) => keys && i < 4 ? '${i + 1}' : null;
  switch (item.kind) {
    case WaitKind.go:
      return [
        DecisionButton('אישור', primary: true, height: h, hint: hint(0), onTap: () => answer(item.options.first)),
        DecisionButton('לא עכשיו', height: h, hint: hint(1), onTap: notNow),
      ];
    case WaitKind.blockingAsk || WaitKind.softAsk when item.askId != null:
      final opts = item.options.where((o) => o.id != 'q' && o.id != 'not_now').toList();
      return [
        for (final (i, o) in opts.indexed) DecisionButton(o.label, primary: o.primary, height: h, hint: hint(i), onTap: () => answer(o)),
        if (!isCaughtFault(item.from, item.askId))
          DecisionButton(opts.isEmpty ? 'תשובה' : 'תשובה אחרת', height: h, onTap: () {
            if (!(store.data?.canChat(item.from) ?? false)) return Nav.waitItem(context, item);
            ChatScreen.pendingTarget[item.from] = item.askId!;
            Nav.chat(context, item.from, quote: Quote(author: store.nameOf(item.from), text: (item.headline ?? item.body).split('\n').first, askId: item.askId), focus: true);
          }),
      ];
    case WaitKind.awaiting:
      return [for (final (i, o) in item.options.indexed) DecisionButton(o.label, primary: o.primary, height: h, hint: hint(i), onTap: () => answer(o))];
    default:
      // A sign-in or a fault with no answer to give: open it, or leave it for later.
      return [
        DecisionButton('פתיחה', primary: true, height: h, hint: hint(0), onTap: () => openWait(context, item)),
        DecisionButton('לא עכשיו', height: h, hint: hint(1), onTap: notNow),
      ];
  }
}

/// The foot line after a decision, for 5 seconds: what was done, and "ביטול" that brings it back.
class _LastLine extends StatelessWidget {
  const _LastLine();
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final id = decisionQueue.lastId;
    final w = id == null ? null : d?.waiting.where((w) => w.id == id).firstOrNull;
    final done = id == null ? null : decisionQueue.done[id];
    return AnimatedSize(
      duration: Mo.off(context) ? Duration.zero : Mo.sm,
      curve: Mo.standard,
      alignment: Alignment.topCenter,
      child: w == null || done == null
          ? const SizedBox(width: double.infinity)
          : Container(
              decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
              padding: const EdgeInsetsDirectional.fromSTEB(16, 0, 4, 0),
              child: DecisionLine(
                icon: done.icon,
                text: '${done.line} · ${hm(CompanyTime.now())}',
                subject: DecisionText.of(w).headline,
                onUndo: decisionQueue.undoLast,
              ),
            ),
    );
  }
}

// ───────────────────────────── desktop ─────────────────────────────

/// The desktop: the list of decisions at the side (the reading start), the chosen one in the middle.
class DecisionsDesktop extends StatelessWidget {
  const DecisionsDesktop({super.key});

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: decisionQueue,
      builder: (context, _) {
        final items = decisionQueue.sync(d);
        final item = items.where((w) => w.id == decisionQueue.current).firstOrNull;
        final pos = decisionQueue.position;
        return Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Container(
            width: 340,
            decoration: BoxDecoration(color: p.surface, border: BorderDirectional(end: BorderSide(color: p.line))),
            child: Column(children: [
              TopBar(title: 'החלטות', showLink: true, actions: [
                if (decisionQueue.remaining > 0)
                  Text(decisionQueue.remaining == 1 ? 'אחת פתוחה' : '${decisionQueue.remaining} פתוחות', style: T.secondary.copyWith(color: p.text2, fontFeatures: kTabular)),
                const SizedBox(width: 12),
              ]),
              Container(height: 1, color: p.line),
              Expanded(
                child: ListView(children: [
                  for (final w in items) _ListRow(item: w, selected: w.id == decisionQueue.current),
                ]),
              ),
            ]),
          ),
          Expanded(
            child: ColoredBox(
              color: p.bg,
              child: Column(children: [
                SizedBox(
                  height: 56,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    // The keys are on the bar at the foot of the window (desktop.dart).
                    child: Row(children: [if (pos != null) _Position(pos)]),
                  ),
                ),
                Expanded(
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 680),
                      child: _Switch(
                        id: item?.id ?? 'empty',
                        forward: decisionQueue.forward,
                        child: item == null ? const _Empty() : _Decision(item: item, keys: true),
                      ),
                    ),
                  ),
                ),
                Align(alignment: Alignment.bottomCenter, child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 680), child: const _LastLine())),
              ]),
            ),
          ),
        ]);
      },
    );
  }
}

/// A decision in the side list: the face, the ask in up to two lines, who and when. Decided ones fold to
/// their line ("אישרת"), muted, and stay where they were.
class _ListRow extends StatelessWidget {
  const _ListRow({required this.item, required this.selected});
  final WaitItem item;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final done = decisionQueue.done[item.id];
    final t = DecisionText.of(item);
    final when = item.createdAt == null ? item.time : whenV2(item.createdAt!, CompanyTime.now());
    return Semantics(
      button: true,
      selected: selected,
      label: [d.who(item.from).name, t.headline, ?done?.line, when].join(', '),
      excludeSemantics: true,
      child: Material(
        color: selected ? p.surface2 : p.surface,
        child: InkWell(
          onTap: done == null ? () => decisionQueue.select(item.id) : null,
          child: Container(
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Opacity(opacity: done == null ? 1 : 0.5, child: Monogram.of(d, item.from, size: AvSize.sm)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (done == null)
                    Rich(t.headline, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w500))
                  else
                    Row(children: [
                      Ic(done.icon, size: 16, color: p.text2),
                      const SizedBox(width: 4),
                      Expanded(child: WordFit(lead: done.line, leadStyle: TextStyle(color: p.text2, fontWeight: FontWeight.w500), text: ' · ${t.headline}', style: T.row2.copyWith(color: p.text3))),
                    ]),
                  const SizedBox(height: 3),
                  Text('${d.who(item.from).name} · ${isCaughtFault(item.from, item.askId) ? 'תקלה' : item.kicker} · $when',
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: T.meta.copyWith(color: p.text2, fontFeatures: kTabular)),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// The desktop's keys on this tab: 1-4 answer, J and K move. Handled: true.
bool decisionKey(BuildContext context, PhysicalKeyboardKey k) {
  final d = StoreScope.read(context).data;
  if (d == null) return false;
  if (k == PhysicalKeyboardKey.keyJ || k == PhysicalKeyboardKey.keyK) {
    decisionQueue.step(k == PhysicalKeyboardKey.keyJ ? 1 : -1);
    return true;
  }
  const digits = [PhysicalKeyboardKey.digit1, PhysicalKeyboardKey.digit2, PhysicalKeyboardKey.digit3, PhysicalKeyboardKey.digit4];
  final i = digits.indexOf(k);
  if (i < 0) return false;
  final item = d.waiting.where((w) => w.id == decisionQueue.current && DecisionQueue.open(d, w)).firstOrNull;
  if (item == null) return true;
  final keys = answersOf(context, item, keys: true);
  if (i < keys.length && keys[i].hint != null) keys[i].onTap();
  return true;
}
