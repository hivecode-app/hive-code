// Decisions in one tap (#258): a GO or a question shows its answers as buttons that are always there, a tap
// decides, and the card folds at once to one line ("אישרת · 02:14") with "ביטול" for 5 seconds, in the card
// itself. The same pieces in the conversation's card and in "מחכה לך" at home, so both look and act the same.
import 'package:flutter/material.dart';

import '../data/store.dart';
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
        DecisionButton('אישור', primary: true, onTap: onGo),
        if (onNotNow != null) DecisionButton('לא עכשיו', onTap: onNotNow),
      ];

  /// The buttons of a question: one per option, then "תשובה אחרת" ("תשובה" when it has no options).
  /// [keys]: the desktop's number keys before the first four options ("1" to "4"), as its shortcuts answer them.
  /// [other]: false for the system's card for a fault ("לטפל" · "לא עכשיו", like a GO): words go through the card.
  static List<DecisionButton> ask(List<AskOption> options,
      {required void Function(AskOption) onPick, required VoidCallback onOther, bool keys = false, bool other = true}) {
    final opts = options.where((o) => o.id != 'q' && o.id != 'not_now').toList();
    return [
      for (final (i, o) in opts.indexed) DecisionButton(o.label, primary: o.primary, hint: keys && i < 4 ? '${i + 1}' : null, onTap: () => onPick(o)),
      if (other || opts.isEmpty) DecisionButton(options.isEmpty ? 'תשובה' : 'תשובה אחרת', onTap: onOther),
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
                child: Text('ביטול', style: TextStyle(fontFamily: kFont, fontSize: 14, fontWeight: FontWeight.w700, color: p.accent)),
              ),
            ),
          ),
      ]),
    );
  }
}

/// How a request reads once it is no longer open: its icon and words (#258).
({String icon, String text}) closedLine(AskCard card, {required bool superseded, bool notNow = false}) {
  if (superseded) return (icon: 'history', text: 'הוחלפה בבקשה חדשה');
  if (notNow) return (icon: 'schedule', text: 'לא עכשיו');
  if (card.state == AskState.decidedByManager) {
    final n = companyNames;
    return (icon: 'check_circle', text: '${n.manager} ${n.m('החליט', 'החליטה')} במקומך: ${card.answer}');
  }
  final at = card.answeredAt == null ? '' : ' ב-${hm(card.answeredAt!)}';
  final a = card.answer;
  if (a == null) return (icon: 'check_circle', text: card is GoCard ? 'הבקשה נסגרה' : 'השאלה נסגרה');
  if (card is GoCard && a == 'GO') return (icon: 'check_circle', text: 'אישרת$at');
  if (a == 'לא עכשיו' || a == 'not_now') return (icon: 'do_not_disturb_on', text: 'דחית$at');
  return (icon: 'check_circle', text: 'ענית$at: $a');
}

/// The line while it can still be taken back: "אישרת · 02:14".
String pendingLine(PendingAnswer p) => '${p.line ?? 'נשלח'} · ${hm(p.at)}';

/// Its icon: `close` for "לא עובד" (#219), `check_circle` for the rest.
String pendingIcon(PendingAnswer p) => p.line == 'לא עובד' ? 'close' : 'check_circle';
