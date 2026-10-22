// The line above the navigation on every screen but "החלטות": "3 החלטות מחכות לך", with the hand. A tap goes to the
// tab. It sits in the layout (a row of the screen's column), not over it, so it never covers a button below the
// content ("שיחה חדשה", a card's answers): the content is a little shorter while it shows.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../theme/motion.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../convs/home_v2.dart' show decisionsLead;
import '../nav.dart';

class DecisionsStrip extends StatelessWidget {
  const DecisionsStrip({super.key, this.hidden = false});

  /// The screen says it already: the tab itself, or a conversation whose decision is open in its card.
  final bool hidden;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final n = d?.waitingCount ?? 0;
    final show = !hidden && n > 0;
    final text = (decisionsLead(n) ?? '').replaceFirst(RegExp(r'\.$'), '');
    return AnimatedSize(
      duration: Mo.off(context) ? Duration.zero : Mo.sm,
      curve: Mo.standard,
      alignment: Alignment.bottomCenter,
      child: !show
          ? const SizedBox(width: double.infinity)
          : Semantics(
              button: true,
              label: text,
              hint: 'מעבר להחלטות',
              excludeSemantics: true,
              onTap: () => NavScope.read(context).go(AppTab.decisions),
              child: Material(
                color: p.surface,
                child: InkWell(
                  onTap: () => NavScope.read(context).go(AppTab.decisions),
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 44),
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
                    child: Row(children: [
                      Ic('front_hand', size: 18, fill: true, color: p.text),
                      const SizedBox(width: 10),
                      Expanded(child: Text(text, style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w500))),
                      Ic('chevron_left', size: 20, color: p.text2),
                    ]),
                  ),
                ),
              ),
            ),
    );
  }
}
