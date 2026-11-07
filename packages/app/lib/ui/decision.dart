import 'package:agent_company/l10n/input_copy.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// Decisions in one tap (#258): a GO or a question shows its answers as buttons that are always there, a tap
// decides, and the card folds at once to one line ("אישרת · 02:14") with "ביטול" for 5 seconds, in the card
// itself. The same pieces in the conversation's card and in "מחכה לך" at home, so both look and act the same.
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderProxyBox;

import '../data/store.dart';
import 'chat/markdown.dart' show Markdown;
import '../model/models.dart';
import '../theme/tokens.dart';
import 'common.dart';
import 'convs/convs_v2.dart' show WordFit;
import 'convs/kbd.dart';

/// One answer: [primary] is filled in the brand color, only when the worker marked it; the rest are outlined, all of the same weight. At least 48 high.
class DecisionButton extends StatelessWidget {
  const DecisionButton(this.label, {super.key, required this.onTap, this.primary = false, this.hint, this.height = 48});
  final String label;

  /// The desktop's key for it ("1", "2"), shown before the label.
  final String? hint;
  final VoidCallback onTap;
  final bool primary;

  /// At least this high: 48 in a card, 56 at the foot of a decision on its own screen (task 286).
  final double height;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Semantics(
      button: true,
      excludeSemantics: true,
      label: label,
      child: Material(
        color: primary ? p.accent : Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10), side: BorderSide(color: primary ? p.accent : p.line, width: 1.2)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: BoxConstraints(minHeight: height),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            alignment: Alignment.center,
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              if (hint != null) ...[Kbd(hint!), const SizedBox(width: 6)],
              Flexible(
                child: Rich(label,
                    align: TextAlign.center,
                    style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.35, fontWeight: primary ? FontWeight.w700 : FontWeight.w500, color: primary ? p.onAccent : p.text)),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// The answers of a decision. Two short ones side by side ("אישור" · "לא עכשיו"); otherwise one per line,
/// the whole width, since an option is often a sentence.
class DecisionKeys extends StatelessWidget {
  const DecisionKeys({super.key, required this.keys});
  final List<DecisionButton> keys;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    if (keys.length == 1) return Row(children: [Expanded(child: keys[0]), const SizedBox(width: 8), const Expanded(child: SizedBox.shrink())]);
    final side = keys.length == 2 && keys.every((k) => k.label.length <= 14) && MediaQuery.textScalerOf(context).scale(1) < 1.5;
    if (side) {
      return Row(children: [Expanded(child: keys[0]), const SizedBox(width: 8), Expanded(child: keys[1])]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      for (final (i, k) in keys.indexed) ...[if (i > 0) const SizedBox(height: 8), k],
    ]);
  }

  /// The buttons of a GO: "אישור" and "לא עכשיו".
  /// Without [onNotNow] (no inbox item behind the card to put off), "אישור" alone.
  static List<DecisionButton> go({required VoidCallback onGo, VoidCallback? onNotNow}) => [
        DecisionButton(UiCopy.copy.approve2, primary: true, onTap: onGo),
        if (onNotNow != null) DecisionButton(UiCopy.copy.notNow2, onTap: onNotNow),
      ];

  /// The buttons of a question: one per option, then "תשובה אחרת" ("תשובה" when it has no options).
  /// [keys]: the desktop's number keys before the first four options ("1" to "4"), as its shortcuts answer them.
  /// [other]: false for the system's card for a fault ("לטפל" · "לא עכשיו", like a GO): words go through the card.
  static List<DecisionButton> ask(List<AskOption> options,
      {required void Function(AskOption) onPick, required VoidCallback onOther, bool keys = false, bool other = true}) {
    final opts = options.where((o) => o.id != 'q' && o.id != 'not_now').toList();
    return [
      for (final (i, o) in opts.indexed) DecisionButton(o.label, primary: o.primary, hint: keys && i < 4 ? '${i + 1}' : null, onTap: () => onPick(o)),
      if (other || opts.isEmpty) DecisionButton(options.isEmpty ? UiCopy.copy.answer3 : UiCopy.copy.otherAnswer, onTap: onOther),
    ];
  }
}

/// A decided (or closed) request, folded to one line: the state's icon, what happened and when, then its
/// headline, cut. [onUndo] adds "ביטול" beside it.
class DecisionLine extends StatelessWidget {
  const DecisionLine({super.key, required this.icon, required this.text, this.subject, this.onUndo, this.onTap});
  final String icon;
  final String text;
  final String? subject;
  final VoidCallback? onUndo;
  final VoidCallback? onTap;

  /// "ביטול" is a button of its own, away from the line's tap.
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final style = TextStyle(fontFamily: kFont, fontSize: 14, height: 1.4, color: p.text2);
    final line = Row(children: [
      Ic(icon, size: 18, color: p.text2),
      const SizedBox(width: 6),
      // Cut after the last whole word that fits, never inside one (T2).
      Expanded(
        child: WordFit(
          lead: text,
          leadStyle: TextStyle(color: p.text, fontWeight: FontWeight.w500),
          text: subject == null || subject!.isEmpty ? '' : ' · ${subject!}',
          style: style,
        ),
      ),
    ]);
    return Semantics(
      container: true,
      liveRegion: onUndo != null,
      child: Row(children: [
        Expanded(child: onTap == null ? line : InkWell(onTap: onTap, child: Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: line))),
        if (onUndo != null)
          Semantics(
            button: true,
            child: InkWell(
              onTap: onUndo,
              borderRadius: BorderRadius.circular(8),
              child: Container(
                constraints: const BoxConstraints(minHeight: 48, minWidth: 64),
                alignment: Alignment.center,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: Text(UiCopy.copy.cancel, style: TextStyle(fontFamily: kFont, fontSize: 14, fontWeight: FontWeight.w700, color: p.accent)),
              ),
            ),
          ),
      ]),
    );
  }
}

/// How a request reads once it is no longer open: its icon and words (#258).
({String icon, String text}) closedLine(AskCard card, {required bool superseded, bool notNow = false}) {
  if (superseded) return (icon: 'history', text: UiCopy.copy.replacedNewRequest);
  if (notNow) return (icon: 'schedule', text: UiCopy.copy.notNow2);
  if (card.state == AskState.decidedByManager) {
    final n = companyNames;
    return (icon: 'check_circle', text: UiCopy.copy.yourBehalf(n.manager, n.m(UiCopy.copy.decided, UiCopy.copy.decided2), card.answer ?? ''));
  }
  final at = card.answeredAt == null ? '' : UiCopy.copy.at(hm(card.answeredAt!));
  final a = card.answer;
  if (a == null) return (icon: 'check_circle', text: card is GoCard ? UiCopy.copy.requestClosed : UiCopy.copy.questionClosed);
  if (card is GoCard && a == 'GO') return (icon: 'check_circle', text: UiCopy.copy.approved2(at));
  if (a == InputCopy.v7 || a == 'not_now') return (icon: 'do_not_disturb_on', text: UiCopy.copy.deferred2(at));
  return (icon: 'check_circle', text: UiCopy.copy.answered2(at, a));
}

/// The line while it can still be taken back: "אישרת · 02:14".
String pendingLine(PendingAnswer p) => '${p.line ?? UiCopy.copy.sent} · ${hm(p.at)}';

/// Its icon: `close` for "לא עובד" (#219), `do_not_disturb_on` for "לא רלוונטי" (#297), `check_circle` for the rest.
String pendingIcon(PendingAnswer p) => switch (p.answerId) {
  'failed' => 'close', 'irrelevant' => 'do_not_disturb_on',
  _ => switch (p.line) { InputCopy.v8 => 'close', InputCopy.v9 => 'do_not_disturb_on', _ => 'check_circle' },
};

/// The worker's trailer under a decision ("PR: https://github.com/…/pull/210", "סיכון: medium"), and the text
/// above it. One reading for the pile, the card and the approval (#1499): the trailer is a link and a level, not
/// text; a "PR: #12" with no address says nothing he can open, and goes too.
final _prLine = RegExp(r'^PR:\s*(?:#?\d+|(https://github\.com/\S+/pull/\d+))\s*$');
final _riskLine = RegExp(InputCopy.v10);

({String text, String? pr, String? risk}) decisionTrailer(String body) {
  String? pr, risk;
  final lines = <String>[];
  for (final l in body.split('\n')) {
    final t = l.trim();
    final m = _prLine.firstMatch(t), r = _riskLine.firstMatch(t);
    if (m != null) {
      pr ??= m[1];
    } else if (r != null) {
      risk = r[1];
    } else {
      lines.add(l);
    }
  }
  return (text: lines.join('\n').trim(), pr: pr, risk: risk);
}

/// "low" / "medium" / "high" in his words; hq already writes the level in Hebrew ("סיכון: גבוה").
String? riskWords(String? risk) {
  final i = InputCopy.riskWords.indexOf(risk ?? '');
  return {'low': UiCopy.copy.lowRisk, 'medium': UiCopy.copy.mediumRisk, 'high': UiCopy.copy.highRisk}[i < 0 ? risk : const ['low', 'medium', 'high'][i]];
}

/// A request's whole text, markdown and all (#1499): what the worker wrote is always reachable, here and not
/// only in the notification. Taller than [lines] lines, it shows them with "עוד", which opens the rest in place;
/// the height is measured, not guessed from the length, so a wide panel shows a short text whole.
/// [open] opens it from outside (the banner's "לבקשה").
class DecisionBody extends StatefulWidget {
  const DecisionBody(this.text, {super.key, this.open = false, this.lines = 7});
  final String text;
  final bool open;

  /// How many lines of body text show while it is folded.
  final int lines;

  @override
  State<DecisionBody> createState() => _DecisionBodyState();
}

class _DecisionBodyState extends State<DecisionBody> {
  late bool expanded = widget.open;

  /// The text's whole height, as last laid out; null until then.
  double? natural;

  @override
  void didUpdateWidget(DecisionBody old) {
    super.didUpdateWidget(old);
    if (widget.open && !old.open) expanded = true;
  }

  void measured(Size size) {
    if (size.height != natural && mounted) setState(() => natural = size.height);
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final text = widget.text.trim();
    if (text.isEmpty) return const SizedBox.shrink();
    final line = MediaQuery.textScalerOf(context).scale(T.body.fontSize ?? 15) * (T.body.height ?? 1.5);
    final fold = line * widget.lines;
    final body = _Measure(onSize: measured, child: Markdown(text));
    final long = natural != null && natural! > fold + line / 2;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSize(
          duration: const Duration(milliseconds: 180),
          alignment: Alignment.topCenter,
          child: expanded || natural != null && !long
              ? body
              : ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: fold),
                  child: ShaderMask(
                    shaderCallback: (r) => LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: const [Colors.white, Colors.white, Colors.transparent],
                      stops: [0, r.height <= line ? 0 : (r.height - line) / r.height, 1],
                    ).createShader(r),
                    blendMode: BlendMode.dstIn,
                    child: SingleChildScrollView(physics: const NeverScrollableScrollPhysics(), primary: false, child: body),
                  ),
                ),
        ),
        if (long)
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: Semantics(
              button: true,
              expanded: expanded,
              child: InkWell(
                onTap: () => setState(() => expanded = !expanded),
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  constraints: const BoxConstraints(minHeight: 44),
                  alignment: AlignmentDirectional.centerStart,
                  padding: const EdgeInsetsDirectional.only(end: 12),
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text(expanded ? UiCopy.copy.less : UiCopy.copy.more, style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                    AnimatedRotation(turns: expanded ? 0.5 : 0, duration: const Duration(milliseconds: 180), child: Ic('expand_more', size: 18, color: p.accent)),
                  ]),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Reports its child's laid-out size after the frame.
class _Measure extends SingleChildRenderObjectWidget {
  const _Measure({required this.onSize, super.child});
  final ValueChanged<Size> onSize;
  @override
  RenderObject createRenderObject(BuildContext context) => _RenderMeasure(onSize);
  @override
  void updateRenderObject(BuildContext context, _RenderMeasure r) => r.onSize = onSize;
}

class _RenderMeasure extends RenderProxyBox {
  _RenderMeasure(this.onSize);
  ValueChanged<Size> onSize;
  Size? _last;
  @override
  void performLayout() {
    super.performLayout();
    if (size == _last) return;
    _last = size;
    final s = size;
    WidgetsBinding.instance.addPostFrameCallback((_) => onSize(s));
  }
}
