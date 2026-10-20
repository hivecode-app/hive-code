// Board (APP-SPEC §4.5, mockup screen 5), Stripe-style: big title, filter chips, rows with the
// status at the end. Tickets stay in GitHub; this reads state from hq.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../convs/conversations_screen.dart';
import '../nav.dart';
import '../system_bar.dart';

class BoardScreen extends StatefulWidget {
  const BoardScreen({super.key});
  @override
  State<BoardScreen> createState() => _BoardScreenState();
}

class _BoardScreenState extends State<BoardScreen> {
  /// The choice is kept for the session (APP-SPEC §4.5).
  static String filter = 'all';

  static const chips = [('all', 'הכול'), ('lumo', 'לומו'), ('easy', 'טיקיבוט'), ('voice', 'voice-bot'), ('co', 'החברה')];

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    if (d == null) return const SizedBox.shrink();
    final shown = d.tickets.where((t) => filter == 'all' || t.project == filter).toList();
    List<Ticket> g(TicketGroup x) => shown.where((t) => t.group == x).toList();

    return Stack(children: [
      Column(children: [
        TopBar(showLink: true, actions: [const IBtn('search', tip: 'חיפוש'), IBtn('more_vert', tip: 'עוד', onTap: () => Nav.settings(context))]),
        const SystemBar(),
        Expanded(
          child: ListView(padding: EdgeInsets.zero, children: [
            BigTitle('לוח', sub: d.boardSubtitle),
            SizedBox(
              height: 44,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                children: [
                  for (final (id, label) in chips)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(end: 8),
                      child: FilterChipX(label: label, on: filter == id, onTap: () => setState(() => filter = id)),
                    ),
                ],
              ),
            ),
            for (final (grp, title) in [(TicketGroup.waiting, 'מחכה לך'), (TicketGroup.attention, 'דורש תשומת לב'), (TicketGroup.working, 'בעבודה')])
              if (g(grp).isNotEmpty) ...[
                Section(title, count: '${g(grp).length}'),
                ListBlock(inset: 16, children: [for (final t in g(grp)) TicketRow(t: t, d: d)]),
              ],
            const SizedBox(height: 14),
            const MoreRow(icon: 'check', bold: 'הושלמו היום', rest: '6'),
            const MoreRow(icon: 'schedule', bold: 'בתור', rest: '7, מתוכם 3 מוכנים ללילה', top: false),
            const SizedBox(height: 84),
          ]),
        ),
      ]),
      PositionedDirectional(
        end: 16,
        bottom: 16,
        child: Fab(icon: 'add', label: 'טיקט חדש', onTap: () => Nav.chat(context, 'yoav', quote: const Quote(author: 'יואב', text: 'תפתח טיקט: '), focus: true)),
      ),
    ]);
  }
}

class FilterChipX extends StatelessWidget {
  const FilterChipX({super.key, required this.label, required this.on, required this.onTap});
  final String label;
  final bool on;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      selected: on,
      button: true,
      child: Material(
        color: on ? p.text : p.surface,
        shape: StadiumBorder(side: BorderSide(color: on ? p.text : p.line)),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: onTap,
          child: Container(
            height: 32,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            alignment: Alignment.center,
            child: Text(label, style: TextStyle(fontFamily: kFont, fontSize: 13.5, fontWeight: FontWeight.w500, color: on ? p.surface : p.text2)),
          ),
        ),
      ),
    );
  }
}

class TicketRow extends StatelessWidget {
  const TicketRow({super.key, required this.t, required this.d});
  final Ticket t;
  final CompanyData d;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final who = d.identities.values.where((i) => i.name == t.assignee).firstOrNull;
    final word = statusWord(t.status, who?.gender ?? Gender.m);
    final sub = [t.projectName, t.assignee, if (t.sub != null) t.sub!].join(' · ');
    return InkWell(
      onTap: () => Nav.ticket(context, t.number),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Rich(t.title, style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.4, fontWeight: FontWeight.w500, color: p.text)),
              const SizedBox(height: 2),
              Text.rich(
                TextSpan(children: [
                  TextSpan(text: ltr(t.number), style: T.mono(12.5).copyWith(color: p.text2)),
                  TextSpan(text: ' · $sub'),
                ]),
                style: T.small.copyWith(color: p.text2),
              ),
            ]),
          ),
          const SizedBox(width: 12),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Badge2(label: word, icon: statusIcon(t.status), kind: t.status == WorkerStatus.waiting ? BadgeKind.dark : BadgeKind.plain),
            const SizedBox(height: 5),
            if (t.diffStat != null) DiffStat(t.diffStat!) else if (t.endLine != null) Text(t.endLine!, style: T.meta.copyWith(color: p.text3)),
          ]),
        ]),
      ),
    );
  }
}
