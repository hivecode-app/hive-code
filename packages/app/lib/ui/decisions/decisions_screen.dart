import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// "מחכות לך" (task 986, «המסך הזה של החלטות אני לא סובל אותו… אולי שאפשר להחליק»): only what is blocked on him, a
// question or a GO, and no tab. A row pinned on top of the conversations says how many ("3 מחכות לך") and is not there
// when nothing waits. A tap opens a pile of cards, one at a time: who asks and the one line of what they ask, the
// details under it. Swipe right is yes (GO, or the "כן" of a yes-or-no), left is no, down is later (to the end of the
// pile, nothing sent). The same answers are buttons at the foot, for whoever doesn't swipe, and the keyboard's arrows
// on a desktop. A decision folds to its line at the foot with "ביטול" for 5 seconds, and the next card comes up.
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
import '../blocks/parts.dart' show kTabular;
import '../chat/chat_screen.dart';
import '../chat/markdown.dart' show Markdown;
import '../common.dart';
import '../convs/convs_v2.dart' show whenV2;
import '../decision.dart';
import '../home/home_screen.dart' show openWait;
import '../nav.dart';
import '../selection.dart';

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

  /// Taken back with "ביטול" a moment ago. hq's answer to the "לא עכשיו" can still be on its way and say "put off", and
  /// that must not take the item out of its place (22/10: it came back at the end of the queue, not on the screen).
  final Map<String, DateTime> _takenBack = {};
  static const _takenBackFor = Duration(seconds: 30);

  /// The way the next one comes in: forward after a decision or a skip, back after "ביטול" or K.
  bool forward = true;

  static bool open(CompanyData d, WaitItem w) => (w.state == WaitState.open || w.state == WaitState.pending) && !d.superseded(w);

  /// Brings the order up to the data: new items at the end (most urgent first among them), items closed
  /// elsewhere out. Called on every build; changes nothing that is on screen.
  List<WaitItem> sync(CompanyData d) {
    final byId = {for (final w in d.waiting) w.id: w};
    final now = DateTime.now();
    // Held for the time hq's answer can take, also after it looked open again (the build after "ביטול"); gone when the item is.
    _takenBack.removeWhere((id, at) => now.difference(at) > _takenBackFor || byId[id] == null);
    order.removeWhere((id) => !done.containsKey(id) && !_takenBack.containsKey(id) && !(byId[id] != null && open(d, byId[id]!)));
    final fresh = [for (final w in d.waiting) if (open(d, w) && !order.contains(w.id)) w]..sort((a, b) => _rank(a).compareTo(_rank(b)));
    order.addAll(fresh.map((w) => w.id));
    if (current != null && (!order.contains(current) || (done.containsKey(current) && lastId != current))) current = null;
    // Opened at one (a notification's tap): that one on top, once. Kept until it is here: the tap can come before the
    // data that has it.
    final f = _focus;
    if (f != null && order.contains(f) && !done.containsKey(f)) {
      current = f;
      _focus = null;
    }
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

  String? _focus;

  /// The next sync puts [id] on top (`inbox:<n>`), when it is open.
  void focus(String id, {bool now = false}) {
    _focus = id;
    if (now) notifyListeners();
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
    _takenBack[id] = DateTime.now();
    lastId = null;
    _undo = null;
    forward = false;
    current = id;
    notifyListeners();
  }

  /// The pile closed: what he decided leaves it, so the next visit counts from one ("1 מתוך 2", not "4 מתוך 5"). The
  /// last one stays while its "ביטול" lasts.
  void close() {
    _focus = null;
    final gone = [for (final id in done.keys) if (id != lastId) id];
    order.removeWhere(gone.contains);
    done.removeWhere((id, _) => gone.contains(id));
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

  factory DecisionText.of(WaitItem w) {
    final t = decisionTrailer(w.body);
    final prUrl = t.pr, risk = riskWords(t.risk);
    var details = t.text;
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

/// Opens the pile, on [at] (`inbox:<n>`) when given: a notification's item comes up first.
void openDecisions(BuildContext context, {String? at}) {
  // Already open (a second tap on a notification): the new one comes up on top of it.
  if (at != null) decisionQueue.focus(at, now: DecisionStack.shown);
  if (DecisionStack.shown) return;
  final nav = Navigator.of(context);
  nav.push(MaterialPageRoute(fullscreenDialog: true, settings: const RouteSettings(name: '/decisions'), builder: (_) => const DecisionStack()));
}

// ───────────────────────────── the pile ─────────────────────────────

/// One answer of a card: what the swipe or the button says, and what it does.
class StackAct {
  StackAct(this.label, this.icon, this.run, {this.primary = false});
  final String label;
  final String icon;
  final VoidCallback run;
  final bool primary;
}

/// A card's answers: [yes] (swipe right), [no] (swipe left), and the rest as buttons only.
typedef StackActs = ({StackAct? yes, StackAct? no, List<StackAct> more});

/// What each kind answers with. A swipe is only ever yes or no (noa on #376: a swipe left must never pick "ביטול
/// המנוי מיד"): a GO, and a question whose two answers are just "כן" and "לא". Any other question, and a sign-in, has
/// buttons only. Each tells the queue, so the next card comes up.
StackActs actsOf(BuildContext context, WaitItem item) {
  final store = StoreScope.read(context);
  void answer(AskOption o) {
    store.answerWait(item, o);
    final key = AppStore.decisionKey(item.askId, item.id);
    decisionQueue.decided(item, AppStore.decidedLine(o), undo: () => store.cancelUndo(key));
  }

  StackAct opt(AskOption o, {String icon = 'check_circle', bool? primary}) => StackAct(o.label, icon, () => answer(o), primary: primary ?? o.primary);
  void other() {
    final nav = Navigator.of(context);
    if (nav.canPop()) nav.pop();
    if (!(store.data?.canChat(item.from) ?? false)) return Nav.waitItem(context, item);
    if (item.askId != null) ChatScreen.pendingTarget[item.from] = item.askId!;
    Nav.chat(context, item.from, quote: Quote(author: store.nameOf(item.from), text: (item.headline ?? item.body).split('\n').first, askId: item.askId), focus: true);
  }

  switch (item.kind) {
    case WaitKind.go:
      return (
        yes: opt(item.options.first, primary: true),
        no: StackAct(UiCopy.copy.no, 'close', () {
          store.dismiss(item);
          decisionQueue.decided(item, UiCopy.copy.deferred3, icon: 'do_not_disturb_on', undo: () => store.cancelUndo(item.id));
        }),
        more: const [],
      );
    case WaitKind.blockingAsk || WaitKind.softAsk when item.askId != null:
      final opts = item.options.where((o) => o.id != 'q' && o.id != 'not_now').toList();
      final words = [if (!isCaughtFault(item.from, item.askId)) StackAct(opts.isEmpty ? UiCopy.copy.answer3 : UiCopy.copy.otherAnswer, 'reply', other)];
      if (yesNo(opts) case (final y, final n)) return (yes: opt(y, primary: true), no: opt(n, icon: 'close', primary: false), more: words);
      return (yes: null, no: null, more: [for (final o in opts) opt(o, primary: opts.length == 1 ? true : null), ...words]);
    default:
      return (yes: null, no: null, more: [StackAct(UiCopy.copy.open2, 'open_in_new', () => openWait(context, item), primary: true)]);
  }
}

/// The two answers of a yes-or-no question, yes first: one is "כן" and the other "לא", and nothing more (noa on #376:
/// "לא, לבטל מיד" is an act, not a no, and acts are buttons). Null otherwise.
(AskOption, AskOption)? yesNo(List<AskOption> opts) {
  if (opts.length != 2) return null;
  String bare(AskOption o) => o.label.trim().replaceAll(RegExp(r'[\s.!\u200e\u200f]+$'), '');
  bool yes(AskOption o) => bare(o) == InputCopy.v11;
  bool no(AskOption o) => bare(o) == InputCopy.v12;
  if (yes(opts[0]) && no(opts[1])) return (opts[0], opts[1]);
  if (no(opts[0]) && yes(opts[1])) return (opts[1], opts[0]);
  return null;
}

/// The pile: on top where he is ("2 מתוך 5") and a way out; the card; its answers at the foot.
class DecisionStack extends StatefulWidget {
  const DecisionStack({super.key});

  /// On the screen now (a notification's tap brings its item up instead of opening a second one).
  static bool shown = false;

  @override
  State<DecisionStack> createState() => _DecisionStackState();
}

class _DecisionStackState extends State<DecisionStack> {
  final _pile = GlobalKey<_PileState>();

  /// He decided something on this visit: once the last one's "ביטול" is over and nothing is left, the pile closes.
  bool _decided = false;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    DecisionStack.shown = true;
  }

  @override
  void dispose() {
    DecisionStack.shown = false;
    decisionQueue.close();
    super.dispose();
  }

  /// A button or an arrow key: the card goes the way its swipe would, then the answer.
  void _act(StackAct? a, AxisDirection dir) {
    if (a == null) return;
    final pile = _pile.currentState;
    if (pile == null) return a.run();
    pile.fling(dir, a.run);
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data;
    // Built again when it is back on top, for an auto-close that had to wait.
    ModalRoute.of(context)?.isCurrent;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: d == null
            ? const SizedBox.shrink()
            : ListenableBuilder(
                listenable: decisionQueue,
                builder: (context, _) {
                  final items = decisionQueue.sync(d);
                  final item = items.where((w) => w.id == decisionQueue.current).firstOrNull;
                  final i = item == null ? -1 : decisionQueue.order.indexOf(item.id);
                  WaitItem? next;
                  for (var k = 1; item != null && k < decisionQueue.order.length; k++) {
                    final id = decisionQueue.order[(i + k) % decisionQueue.order.length];
                    if (!decisionQueue.done.containsKey(id)) {
                      next = items.where((w) => w.id == id).firstOrNull;
                      break;
                    }
                  }
                  final acts = item == null ? null : actsOf(context, item);
                  if (decisionQueue.lastId != null) _decided = true;
                  if (item == null && _decided && decisionQueue.lastId == null && !_closing) {
                    _closing = true;
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      // Only the pile itself: not a page he opened from it (an item's "פתיחה") and still reads.
                      if (!mounted) return;
                      // A page he opened from the pile is on top: not now. The pile builds again when it is back on top
                      // (it depends on its route, below), and tries then. No setState here: it would try every frame.
                      if (!(ModalRoute.of(context)?.isCurrent ?? true)) {
                        _closing = false;
                        return;
                      }
                      Navigator.of(context).maybePop();
                    });
                  }
                  final keys = <ShortcutActivator, VoidCallback>{
                    const SingleActivator(LogicalKeyboardKey.escape): () => Navigator.of(context).maybePop(),
                    if (acts != null) ...{
                      const SingleActivator(LogicalKeyboardKey.arrowRight): () => _act(acts.yes, AxisDirection.right),
                      const SingleActivator(LogicalKeyboardKey.arrowLeft): () => _act(acts.no, AxisDirection.left),
                      const SingleActivator(LogicalKeyboardKey.arrowDown): () => _act(StackAct(UiCopy.copy.later, 'schedule', decisionQueue.later), AxisDirection.down),
                    },
                  };
                  return CallbackShortcuts(
                    bindings: keys,
                    child: Focus(
                      autofocus: true,
                      child: Center(
                        // A card, not a page: on a big screen the pile keeps a phone's size, in the middle.
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 560, maxHeight: 760),
                          child: Column(children: [
                            _Top(pos: decisionQueue.position),
                            Expanded(
                              child: item == null
                                  ? const _Empty()
                                  : Padding(
                                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                                      child: _Pile(key: _pile, item: item, next: next, acts: acts!),
                                    ),
                            ),
                            if (item != null) _Foot(acts: acts!, onAct: _act),
                            const _LastLine(),
                          ]),
                        ),
                      ),
                    ),
                  );
                },
              ),
      ),
    );
  }
}

/// The top: the way out, the title, and "2 מתוך 5" in figures that keep their width.
class _Top extends StatelessWidget {
  const _Top({required this.pos});
  final (int, int)? pos;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final pos = this.pos;
    return SizedBox(
      height: 56,
      child: Row(children: [
        const SizedBox(width: 4),
        IBtn('close', tip: UiCopy.copy.close2, onTap: () => Navigator.of(context).maybePop()),
        const SizedBox(width: 4),
        Expanded(child: Semantics(header: true, child: Text(UiCopy.copy.needYou3, style: T.name.copyWith(color: p.text)))),
        if (pos != null)
          Semantics(
            label: UiCopy.copy.of2(pos.$1, pos.$2),
            excludeSemantics: true,
            child: Text(UiCopy.copy.of2(pos.$1, pos.$2), style: T.secondary.copyWith(color: p.text2, fontFeatures: kTabular)),
          ),
        const SizedBox(width: 16),
      ]),
    );
  }
}

/// Nothing waits: one sentence and one icon.
class _Empty extends StatelessWidget {
  const _Empty();
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Center(
      child: Semantics(
        liveRegion: true,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Ic('check_circle', size: 32, color: p.text2),
          const SizedBox(height: 12),
          Text(UiCopy.copy.nothingNeedsYou3, style: T.body.copyWith(color: p.text2)),
          const SizedBox(height: 16),
          Btn(UiCopy.copy.backChats, onTap: () => Navigator.of(context).maybePop()),
        ]),
      ),
    );
  }
}

/// The card on top follows the finger; the next one waits under it, a little smaller. Let go past a third of the
/// width (or fast), it leaves that way and its answer goes; otherwise it comes back. A way with no answer (only a
/// yes-or-no has a right and a left) doesn't go: the card comes back. "הסר אנימציות": no flight, the answer at once.
class _Pile extends StatefulWidget {
  const _Pile({super.key, required this.item, required this.next, required this.acts});
  final WaitItem item;
  final WaitItem? next;
  final StackActs acts;

  @override
  State<_Pile> createState() => _PileState();
}

class _PileState extends State<_Pile> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: Mo.md);
  Offset _drag = Offset.zero;
  Offset _from = Offset.zero, _to = Offset.zero;
  Size _size = Size.zero;
  VoidCallback? _then;

  @override
  void initState() {
    super.initState();
    _c.addListener(() => setState(() => _drag = Offset.lerp(_from, _to, Mo.standard.transform(_c.value))!));
    _c.addStatusListener((s) {
      if (s != AnimationStatus.completed) return;
      final then = _then;
      _then = null;
      if (then != null) {
        then();
        // The same card can stay on top ("אחר כך" on the only one left): it comes back to the middle.
        if (mounted) setState(() => _drag = Offset.zero);
      }
    });
  }

  @override
  void didUpdateWidget(_Pile old) {
    super.didUpdateWidget(old);
    // The next card is on top now: it starts in the middle.
    if (old.item.id != widget.item.id) {
      _c.stop();
      _then = null;
      _drag = Offset.zero;
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// Which way the finger is going, when it is far enough to say: right, left or down.
  AxisDirection? get _way {
    if (_drag.dy > 24 && _drag.dy > _drag.dx.abs()) return AxisDirection.down;
    if (_drag.dx > 24) return AxisDirection.right;
    if (_drag.dx < -24) return AxisDirection.left;
    return null;
  }

  StackAct? _actFor(AxisDirection? w) => switch (w) {
        AxisDirection.right => widget.acts.yes,
        AxisDirection.left => widget.acts.no,
        AxisDirection.down => StackAct(UiCopy.copy.later, 'schedule', decisionQueue.later),
        _ => null,
      };

  /// How far toward deciding, 0 to 1: the hint's strength.
  double get _progress {
    final w = _size.width <= 0 ? 1.0 : _size.width;
    return _way == AxisDirection.down ? (_drag.dy / (_size.height * 0.25)).clamp(0.0, 1.0) : (_drag.dx.abs() / (w * 0.33)).clamp(0.0, 1.0);
  }

  void _animate(Offset to, {VoidCallback? then}) {
    _from = _drag;
    _to = to;
    _then = then;
    _c.forward(from: 0);
  }

  /// Off the screen that way, then [run]. From a button or a key too.
  void fling(AxisDirection dir, VoidCallback run) {
    // One flight at a time: a second key or tap while the card is leaving would answer the next one blind.
    if (_then != null) return;
    if (Mo.off(context)) {
      run();
      // No flight: the card that stays on top ("אחר כך" on the only one) is back in the middle at once.
      if (mounted) setState(() => _drag = Offset.zero);
      return;
    }
    final w = _size.width, h = _size.height;
    final to = switch (dir) {
      AxisDirection.right => Offset(w * 1.4, _drag.dy),
      AxisDirection.left => Offset(-w * 1.4, _drag.dy),
      _ => Offset(_drag.dx, h * 1.2),
    };
    HapticFeedback.selectionClick();
    _animate(to, then: run);
  }

  void _end(DragEndDetails e) {
    final v = e.velocity.pixelsPerSecond;
    final fast = v.distance > 900;
    AxisDirection? w;
    if (_drag.dy > _size.height * 0.2 || (fast && v.dy > v.dx.abs() && v.dy > 0)) {
      w = AxisDirection.down;
    } else if (_drag.dx > _size.width * 0.33 || (fast && v.dx > 0 && v.dx.abs() > v.dy.abs())) {
      w = AxisDirection.right;
    } else if (_drag.dx < -_size.width * 0.33 || (fast && v.dx < 0 && v.dx.abs() > v.dy.abs())) {
      w = AxisDirection.left;
    }
    final a = _actFor(w);
    if (a == null) {
      if (Mo.off(context)) return setState(() => _drag = Offset.zero);
      return _animate(Offset.zero);
    }
    fling(w!, a.run);
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return LayoutBuilder(builder: (context, c) {
      _size = c.biggest;
      final hint = _actFor(_way);
      final tilt = _size.width <= 0 ? 0.0 : (_drag.dx / _size.width) * 0.10;
      final next = widget.next;
      // The whole place of the pile takes the finger, also the background under a short card. While a card is
      // leaving, nothing does: its answer is on its way.
      return GestureDetector(
        behavior: HitTestBehavior.opaque,
        onPanStart: (_) {
          if (_then == null) _c.stop();
        },
        onPanUpdate: (d) {
          if (_then == null) setState(() => _drag += d.delta);
        },
        onPanEnd: (e) {
          if (_then == null) _end(e);
        },
        child: Stack(clipBehavior: Clip.none, children: [
          // The card is as tall as what it says, up to the place it has (and scrolls inside past that); the
          // background shows between it and the answers.
          Align(
            alignment: Alignment.topCenter,
            child: Stack(clipBehavior: Clip.none, children: [
              if (next != null)
                Positioned.fill(
                  child: IgnorePointer(
                    child: ExcludeSemantics(
                      child: Transform.translate(
                        offset: Offset(0, 10 * (1 - _progress)),
                        child: Transform.scale(scale: 0.95 + 0.05 * _progress, alignment: Alignment.bottomCenter, child: _Card(item: next, under: true)),
                      ),
                    ),
                  ),
                ),
              Transform.translate(
                offset: _drag,
                child: Transform.rotate(angle: Mo.off(context) ? 0 : tilt, child: _Card(item: widget.item)),
              ),
            ]),
          ),
          // What letting go will do, in the middle on top, where it stays while the card moves (noa on #376: on the
          // card it was cut at the screen's edge).
          if (hint != null && _progress > 0)
            Positioned(
              top: 12,
              left: 0,
              right: 0,
              child: IgnorePointer(
                child: Center(
                  child: Opacity(
                    opacity: _progress,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      decoration: BoxDecoration(color: p.bg, borderRadius: BorderRadius.circular(22), border: Border.all(color: p.text, width: 1.5)),
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        Ic(hint.icon, size: 20, fill: true, color: p.text),
                        const SizedBox(width: 8),
                        Text(hint.label, style: T.button.copyWith(color: p.text, fontWeight: FontWeight.w700)),
                      ]),
                    ),
                  ),
                ),
              ),
            ),
        ]),
      );
    });
  }
}

/// One card: who asks, from where and when; the one line of what they ask; the details under it, and "כל הפרטים"
/// right after them. As tall as that, up to the place it has; past it the details scroll inside.
class _Card extends StatelessWidget {
  const _Card({required this.item, this.under = false});
  final WaitItem item;

  /// The next one, under the top card: who and what only, cut to the top card's size.
  final bool under;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final who = d.who(item.from);
    final team = d.teamOf(item.from)?.name;
    final t = DecisionText.of(item);
    final when = item.createdAt == null ? item.time : whenV2(item.createdAt!, CompanyTime.now());
    final caught = isCaughtFault(item.from, item.askId);
    final top = <Widget>[
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
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: T.secondary.copyWith(color: p.text2),
            ),
            Text([caught ? UiCopy.copy.issue2 : item.kicker, when, ?t.risk].join(' · '), style: T.small.copyWith(color: p.text2, fontFeatures: kTabular)),
          ]),
        ),
      ]),
      const SizedBox(height: 18),
      // What is asked of him: the card's one large line.
      Semantics(
        header: true,
        child: Rich(t.headline, auto: true, maxLines: 4, overflow: TextOverflow.ellipsis,
            style: TextStyle(fontFamily: kFont, fontSize: 22, height: 30 / 22, fontWeight: FontWeight.w700, color: p.text)),
      ),
    ];
    final box = BoxDecoration(
      color: p.surface,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: p.line),
      boxShadow: under ? null : [BoxShadow(color: Colors.black.withValues(alpha: p.dark ? 0.35 : 0.08), blurRadius: 18, offset: const Offset(0, 6))],
    );
    const pad = EdgeInsets.fromLTRB(20, 18, 20, 10);
    if (under) {
      return Container(
        decoration: box,
        clipBehavior: Clip.antiAlias,
        padding: pad,
        child: OverflowBox(alignment: Alignment.topCenter, maxHeight: double.infinity, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: top)),
      );
    }
    return Container(
      decoration: box,
      clipBehavior: Clip.antiAlias,
      padding: pad,
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        ...top,
        if (t.details.isNotEmpty) ...[
          const SizedBox(height: 12),
          // The worker's markdown, its lists and sections as written (#1499).
          Flexible(child: SingleChildScrollView(child: Markdown(t.details))),
        ],
        if (item.managerNote case final note?) ...[
          const SizedBox(height: 10),
          _ManagerNote(by: d.who(item.managerNoteBy ?? '').name, note: note),
        ],
        const SizedBox(height: 4),
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton.icon(
            onPressed: () => _details(context, item),
            style: TextButton.styleFrom(minimumSize: const Size(64, 44), padding: const EdgeInsets.symmetric(horizontal: 8)),
            icon: Ic('description', size: 18, color: p.accent),
            label: Text(UiCopy.copy.allDetails, style: T.button.copyWith(color: p.accent)),
          ),
        ),
      ]),
    );
  }
}

/// All of it, in a sheet: the details in full, the links ("הדוח המלא", "ה-PR") and the conversation.
void _details(BuildContext context, WaitItem item) {
  final store = StoreScope.read(context);
  final d = store.data!;
  final p = context.p;
  final t = DecisionText.of(item);
  String? urlOf(WaitLinkKind k) => item.links.where((l) => l.kind == k).firstOrNull?.url;
  final report = urlOf(WaitLinkKind.report);
  final pr = urlOf(WaitLinkKind.pr) ?? t.prUrl;
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: p.surface,
    showDragHandle: true,
    builder: (sheet) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.95,
      builder: (_, scroll) => ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(20, 0, 20, 24), children: [
        Rich(t.headline, auto: true, style: TextStyle(fontFamily: kFont, fontSize: 20, height: 28 / 20, fontWeight: FontWeight.w700, color: p.text)),
        if (t.details.isNotEmpty) ...[const SizedBox(height: 12), CopySelectionArea(child: Markdown(t.details))],
        const SizedBox(height: 20),
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (report != null) Btn(UiCopy.copy.fullReport, icon: 'description', height: 40, fontSize: 13.5, hpad: 14, onTap: () => openExternalUrl(report)),
          if (pr != null) Btn(UiCopy.copy.pullRequest, icon: 'call_merge', height: 40, fontSize: 13.5, hpad: 14, onTap: () => openExternalUrl(pr)),
          if (d.canChat(item.from))
            Btn(UiCopy.copy.chat3(d.who(item.from).name), icon: 'chat', height: 40, fontSize: 13.5, hpad: 14, onTap: () {
              Navigator.of(sheet).pop();
              final nav = Navigator.of(context);
              if (nav.canPop()) nav.pop();
              Nav.chat(context, item.from);
            }),
        ]),
      ]),
    ),
  );
}

/// The answers at the foot, as buttons: no on the left, yes on the right (as the swipe goes), the rest above them,
/// and "אחר כך" under them.
class _Foot extends StatelessWidget {
  const _Foot({required this.acts, required this.onAct});
  final StackActs acts;
  final void Function(StackAct?, AxisDirection) onAct;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    const h = 56.0;
    DecisionButton b(StackAct a, AxisDirection dir) => DecisionButton(a.label, primary: a.primary, height: h, onTap: () => onAct(a, dir));
    final yes = acts.yes, no = acts.no;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final a in acts.more) ...[DecisionButton(a.label, primary: a.primary && yes == null, height: 48, onTap: a.run), const SizedBox(height: 8)],
        if (yes != null || no != null)
          // Physical sides, whatever the reading direction: the buttons sit where the swipe goes.
          Directionality(
            textDirection: TextDirection.ltr,
            child: Row(children: [
              Expanded(child: no == null ? const SizedBox.shrink() : Directionality(textDirection: Directionality.of(context), child: b(no, AxisDirection.left))),
              const SizedBox(width: 10),
              Expanded(child: yes == null ? const SizedBox.shrink() : Directionality(textDirection: Directionality.of(context), child: b(yes, AxisDirection.right))),
            ]),
          ),
        const SizedBox(height: 2),
        Row(children: [
          TextButton.icon(
            onPressed: () => onAct(StackAct(UiCopy.copy.later, 'schedule', decisionQueue.later), AxisDirection.down),
            style: TextButton.styleFrom(minimumSize: const Size(64, 44), foregroundColor: p.text2),
            icon: Ic('schedule', size: 18, color: p.text2),
            label: Text(UiCopy.copy.later, style: T.button.copyWith(color: p.text2)),
          ),
          const Spacer(),
          if (decisionQueue.remaining > 1)
            Text(UiCopy.copy.moreAfterThis(decisionQueue.remaining - 1), style: T.meta.copyWith(color: p.text3, fontFeatures: kTabular)),
        ]),
      ]),
    );
  }
}

/// The manager's note on an escalated ask: a small line of its own, under the details. The card stays the asker's.
class _ManagerNote extends StatelessWidget {
  const _ManagerNote({required this.by, required this.note});
  final String by;
  final String note;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(padding: const EdgeInsets.only(top: 2), child: Ic('forward_to_inbox', size: 18, color: p.text2)),
      const SizedBox(width: 8),
      Expanded(
        child: Text.rich(
          TextSpan(children: [
            TextSpan(text: '$by: ', style: const TextStyle(fontWeight: FontWeight.w700)),
            TextSpan(text: note),
          ]),
          style: T.secondary.copyWith(color: p.text2),
        ),
      ),
    ]);
  }
}

/// The foot line after a decision, for 5 seconds: what was done, and "ביטול" that brings it back.
class _LastLine extends StatelessWidget {
  const _LastLine();

  // Its own listener: it is const under the screen's builder, which does not rebuild it, and after "לא עכשיו" no
  // change in the store comes when the 5 seconds end (22/10: the line stayed, with a "ביטול" that did nothing).
  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return ListenableBuilder(listenable: decisionQueue, builder: (context, _) => _line(context)); }

  Widget _line(BuildContext context) {
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

