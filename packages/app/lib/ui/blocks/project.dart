// A project in two lines: its name (and how many wait for him), then what runs now and who, or when
// nothing does, "שקט" and the last thing that finished. A tap opens the project.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'data.dart';
import 'parts.dart';

class ProjectBlock extends StatelessWidget {
  const ProjectBlock({super.key, required this.data, this.now});
  final ProjectLine data;

  /// For "אתמול" on the last one; now when null.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    final l = data;
    String name(String id) => d?.who(id).name ?? id;
    final who = l.who.isEmpty ? '' : (l.who.length == 1 ? name(l.who.first) : '${name(l.who.first)} ועוד ${l.who.length - 1}');
    final second = T.small.copyWith(color: p.text2);
    final today = now ?? DateTime.now();
    String when(DateTime t) {
      final ago = daysAgo(t, today);
      if (ago == 0) return hm(t);
      if (ago == 1) return 'אתמול';
      return dm(t);
    }
    final TextSpan line;
    String end = '';
    String spoken;
    if (l.now != null) {
      line = TextSpan(children: [
        const TextSpan(text: 'עכשיו: ', style: TextStyle(fontWeight: FontWeight.w700)),
        TextSpan(text: l.now),
        if (who.isNotEmpty) TextSpan(text: ' · $who'),
      ]);
      spoken = 'עכשיו ${l.now}${who.isEmpty ? '' : ', $who'}';
    } else if (l.queued > 0) {
      line = TextSpan(text: l.queued == 1 ? 'משימה אחת בתור' : '${l.queued} משימות בתור');
      spoken = line.text!;
    } else {
      line = TextSpan(children: [
        const TextSpan(text: 'שקט', style: TextStyle(fontWeight: FontWeight.w700)),
        if (l.last != null) TextSpan(text: ' · אחרון: ${l.last}'),
      ]);
      if (l.lastAt != null) end = when(l.lastAt!);
      spoken = 'שקט${l.last == null ? '' : ', אחרון: ${l.last}${end.isEmpty ? '' : ', $end'}'}';
    }
    return Semantics(
      button: true,
      label: [l.name, if (l.waiting > 0) l.waiting == 1 ? 'דבר אחד מחכה לך' : '${l.waiting} דברים מחכים לך', spoken, if (l.note != null) l.note!].join('. '),
      hint: 'פתיחת הפרויקט',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => Nav.project(context, l.id),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(children: [
              BlockSymbol(l.symbol),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Row(children: [
                    Expanded(child: Text(l.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5))),
                    if (l.waiting > 0) ...[
                      const SizedBox(width: 8),
                      Ic('pause_circle', size: 16, fill: true, color: p.text),
                      const SizedBox(width: 3),
                      Text('${l.waiting}', style: second.copyWith(color: p.text, fontWeight: FontWeight.w700, fontFeatures: kTabular)),
                    ],
                  ]),
                  const SizedBox(height: 2),
                  Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Expanded(child: Text.rich(line, maxLines: 1, overflow: TextOverflow.ellipsis, style: second)),
                    if (end.isNotEmpty) ...[const SizedBox(width: 8), Text(end, style: second.copyWith(fontFeatures: kTabular))],
                  ]),
                  if (l.note != null) ...[
                    const SizedBox(height: 4),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 2), child: Ic('lightbulb', size: 14, color: p.text)),
                      const SizedBox(width: 4),
                      Expanded(child: Rich(l.note!, auto: true, maxLines: 2, style: second.copyWith(color: p.text))),
                    ]),
                  ],
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
