// The projects nothing moved in today, folded into one line at the end of the home: "שקט גם ב: טיקי בוט,
// לומו". No card, text2 on the screen. Each name (with its symbol) opens the project: lines of 32 to the eye,
// a 48dp target each that reaches into the gap around it, as chips do.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';

class QuietBlock extends StatelessWidget {
  const QuietBlock({super.key, required this.projects, required this.data, this.color});
  final List<String> projects;
  final CompanyData data;

  /// The ground it sits on: the card's surface, or (v2) the screen's paper.
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final style = T.row2.copyWith(color: p.text2);
    final known = {for (final x in data.projects) x.id: x};
    // Material, not a coloured Container: the names' ripple is drawn on it.
    return Material(
      color: color ?? p.surface,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        // Each item is 48 high; -16 between runs puts the lines 32 apart.
        child: Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          runSpacing: -16,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.only(start: 4, end: 4),
              child: Text('שקט גם ב:', style: style),
            ),
            for (final (i, id) in projects.indexed)
              Semantics(
                button: true,
                label: 'פתיחת ${known[id]?.name ?? id}',
                excludeSemantics: true,
                child: InkWell(
                  onTap: () => Nav.project(context, id),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 48),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Ic(data.teams[known[id]?.teamId ?? id]?.symbol ?? 'folder', size: 16, color: p.text2),
                          const SizedBox(width: 4),
                          Text('${known[id]?.name ?? id}${i < projects.length - 1 ? ',' : ''}', style: style),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
