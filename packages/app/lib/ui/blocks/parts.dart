// What the home blocks share: one motion, tabular figures, the circle where a face goes, and the card frame.
import 'package:flutter/material.dart';

import '../../theme/tokens.dart';
import '../common.dart';

const kBlockMotion = Duration(milliseconds: 200);
const kBlockCurve = Curves.easeOutCubic;
const kTabular = [FontFeature.tabularFigures()];

/// Where a face goes when there is no one: the same 36px circle, with a symbol.
class BlockSymbol extends StatelessWidget {
  const BlockSymbol(this.name, {super.key});
  final String name;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return SizedBox(
      width: 40,
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: Container(
          width: 36,
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface3),
          child: Ic(name, size: 20, color: p.text),
        ),
      ),
    );
  }
}

/// The frame a block sits in on the list: 16 from the edges, corners 16, a 1px outline, no shadow.
class BlockCard extends StatelessWidget {
  const BlockCard({super.key, required this.child, this.label});
  final Widget child;

  /// What a screen reader calls the card.
  final String? label;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      // The card sits on the paper itself, no band of white around it (v2).
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Semantics(
        container: true,
        label: label,
        explicitChildNodes: true,
        child: Container(
          // Dark: a card is a step up in tone, without a line (v2, audit #32).
          decoration: BoxDecoration(
            color: p.dark ? p.surface2 : p.surface,
            borderRadius: BorderRadius.circular(16),
            border: p.dark ? null : Border.all(color: p.line),
          ),
          clipBehavior: Clip.antiAlias,
          child: Material(type: MaterialType.transparency, child: child),
        ),
      ),
    );
  }
}

/// A hairline between parts of a card.
class BlockHairline extends StatelessWidget {
  const BlockHairline({super.key});
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Container(height: 1, color: context.p.line));
}
