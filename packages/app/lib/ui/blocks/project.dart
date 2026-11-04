import 'package:agent_company/l10n/ui_copy.dart';
// A project in two lines: its name (and how many wait for him), then what runs now and who, or when
// nothing does, "שקט" and the last thing that finished. A tap opens the project; on the second line, the
// conversation with the worker behind it (docs/app/links.md).
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../entity_link.dart';
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
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data;
    final l = data;
    String name(String id) => d?.who(id).name ?? id;
    final who = l.who.isEmpty ? '' : (l.who.length == 1 ? name(l.who.first) : UiCopy.text(112, [name(l.who.first), l.who.length - 1]));
    final second = T.small.copyWith(color: p.text2);
    final today = now ?? CompanyTime.now();
    String when(DateTime t) {
      final ago = daysAgo(t, today);
      if (ago == 0) return hm(t);
      if (ago == 1) return UiCopy.text(34);
      return dm(t);
    }
    final TextSpan line;
    String end = '';
    String spoken;
    String? to;
    if (l.now != null) {
      to = d == null ? null : chatTargetOf(d, worker: l.who.firstOrNull);
      line = TextSpan(children: [
         TextSpan(text: UiCopy.text(113), style: TextStyle(fontWeight: FontWeight.w700)),
        TextSpan(text: l.now),
        if (who.isNotEmpty) TextSpan(text: ' · $who'),
      ]);
      spoken = UiCopy.text(114, [l.now, who.isEmpty ? '' : ', $who']);
    } else if (l.queued > 0) {
      line = TextSpan(text: l.queued == 1 ? UiCopy.text(100) : UiCopy.text(101, [l.queued]));
      spoken = line.text!;
    } else {
      line = TextSpan(children: [
         TextSpan(text: UiCopy.text(115), style: TextStyle(fontWeight: FontWeight.w700)),
        if (l.last != null) TextSpan(text: UiCopy.text(116, [l.last])),
      ]);
      if (l.lastAt != null) end = when(l.lastAt!);
      if (l.last != null && d != null) to = chatTargetOf(d, worker: l.lastWho, openedBy: l.lastOpener, done: true);
      spoken = UiCopy.text(118, [l.last == null ? '' : UiCopy.text(117, [l.last, end.isEmpty ? '' : ', $end'])]);
    }
    return Semantics(
      button: true,
      label: [l.name, if (l.waiting > 0) l.waiting == 1 ? UiCopy.text(95) : UiCopy.text(96, [l.waiting]), if (to == null) spoken, if (l.note != null) l.note!].join('. '),
      hint: UiCopy.text(119),
      // With a line that leads to a worker, that line is a node of its own; the rest is read from the label.
      excludeSemantics: to == null,
      child: InkWell(
        onTap: () => Nav.project(context, l.id),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 60),
          child: Padding(
            padding: EdgeInsets.fromLTRB(16, 10, 16, l.note == null && to != null ? 0 : 10),
            child: Row(children: [
              BlockSymbol(l.symbol),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  ExcludeSemantics(child: Row(children: [
                    Expanded(child: Text(l.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5))),
                    if (l.waiting > 0) ...[
                      const SizedBox(width: 8),
                      Ic('front_hand', size: 16, fill: true, color: p.text),
                      const SizedBox(width: 3),
                      Text('${l.waiting}', style: second.copyWith(color: p.text, fontWeight: FontWeight.w700, fontFeatures: kTabular)),
                    ],
                  ])),
                  // The line takes the card's bottom padding into its own target.
                  EntityLink(
                    identity: to,
                    minHeight: kLinkLine,
                    label: to == null ? null : spoken,
                    borderRadius: BorderRadius.circular(8),
                    child: Padding(
                      padding: EdgeInsets.only(top: 2, bottom: l.note == null && to != null ? 10 : 0),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                        Expanded(child: Text.rich(line, maxLines: 1, overflow: TextOverflow.ellipsis, style: second)),
                        if (end.isNotEmpty) ...[const SizedBox(width: 8), Text(end, style: second.copyWith(fontFeatures: kTabular))],
                      ]),
                    ),
                  ),
                  if (l.note != null) ...[
                    const SizedBox(height: 4),
                    ExcludeSemantics(child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Padding(padding: const EdgeInsets.only(top: 2), child: Ic('lightbulb', size: 14, color: p.text)),
                      const SizedBox(width: 4),
                      Expanded(child: Rich(l.note!, auto: true, maxLines: 2, style: second.copyWith(color: p.text))),
                    ])),
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
