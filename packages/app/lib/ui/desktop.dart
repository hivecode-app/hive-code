// Desktop (APP-SPEC §8, mockup screen 10): rail · list · main · context.
import 'package:flutter/material.dart';

import '../data/store.dart';
import '../theme/tokens.dart';
import 'home/home_screen.dart';
import 'nav.dart';
import 'shell.dart';

class DesktopFrame extends StatelessWidget {
  const DesktopFrame({super.key, required this.width});
  final double width;

  @override
  Widget build(BuildContext context) {
    final nav = NavScope.of(context);
    final d = StoreScope.of(context).data;
    final p = context.p;
    return Row(children: [
      Container(
        width: 72,
        decoration: BoxDecoration(color: p.surface, border: BorderDirectional(end: BorderSide(color: p.line))),
        padding: const EdgeInsets.only(top: 12),
        child: Column(children: [
          for (final dest in kDests)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: SizedBox(
                width: 64,
                height: 56,
                child: NavItem(dest: dest, on: nav.tab == dest.tab, count: dest.tab == AppTab.home ? d?.waitingCount : null, pillWidth: 52, fontSize: 11.5, onTap: () => nav.go(dest.tab)),
              ),
            ),
        ]),
      ),
      const Expanded(child: HomeScreen()),
    ]);
  }
}
