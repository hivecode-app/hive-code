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

  /// "הושלם היום" and "בתור" start folded (APP-SPEC §4.5); a tap opens them for the session.
  static final unfolded = <TicketGroup>{};

  /// The projects in org.yaml with their charter status (from hq). Without them (the demo), the
  /// projects the tickets name.
  static List<ProjectInfo> projectsOf(CompanyData d) => d.projects.isNotEmpty
      ? d.projects
      : [for (final t in {for (final t in d.tickets) t.project: t}.values) ProjectInfo(id: t.project, name: t.projectName, active: true)];

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    if (d == null) return const SizedBox.shrink();
    final projects = projectsOf(d);
    // A chip for every project that has work: active ones, and any dormant one a task still names.
    final chips = [
      ('all', 'הכול'),
      for (final pr in projects)
        if (pr.active || d.tickets.any((t) => t.project == pr.id)) (pr.id, pr.name),
    ];
    if (!chips.any((c) => c.$1 == filter)) filter = 'all';
    final shown = d.tickets.where((t) => filter == 'all' || t.project == filter).toList();
    List<Ticket> g(TicketGroup x) => shown.where((t) => t.group == x).toList();
    final open = shown.where((t) => t.group != TicketGroup.doneToday).length;
    final p = context.p;

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
            if (open == 0)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Text('אין משימות פתוחות.', style: T.row2.copyWith(color: p.text2)),
              ),
            for (final (grp, title) in [
              (TicketGroup.waiting, 'מחכה לך'),
              (TicketGroup.attention, 'דורש תשומת לב'),
              (TicketGroup.working, 'בעבודה'),
              (TicketGroup.doneToday, 'הושלם היום'),
              (TicketGroup.queued, 'בתור'),
            ])
              if (g(grp).isNotEmpty)
                if ((grp == TicketGroup.queued || grp == TicketGroup.doneToday) && !unfolded.contains(grp)) ...[
                  const SizedBox(height: 16),
                  MoreRow(icon: 'expand_more', bold: title, rest: g(grp).length == 1 ? 'משימה אחת' : '${g(grp).length} משימות', onTap: () => setState(() => unfolded.add(grp))),
                ] else ...[
                  Section(title, count: '${g(grp).length}'),
                  ListBlock(inset: 16, children: [for (final t in g(grp)) TicketRow(t: t, d: d)]),
                ],
            if (filter == 'all' && d.projects.isNotEmpty) ...[
              const Section('פרויקטים'),
              ListBlock(inset: 16, children: [for (final pr in d.projects) _ProjectRow(pr: pr, open: d.tickets.where((t) => t.project == pr.id && t.group != TicketGroup.doneToday).length)]),
            ],
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

/// One project from org.yaml: its name, how many tasks are open in it, and its real state.
class _ProjectRow extends StatelessWidget {
  const _ProjectRow({required this.pr, required this.open});
  final ProjectInfo pr;
  final int open;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final line = !pr.active ? 'עוד לא עבר לחברה' : (open == 0 ? 'אין משימות פתוחות' : (open == 1 ? 'משימה פתוחה אחת' : '$open משימות פתוחות'));
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(ltr(pr.name), style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.4, fontWeight: FontWeight.w500, color: p.text)),
            Text(line, style: T.small.copyWith(color: p.text2)),
          ]),
        ),
        StatusWord(icon: pr.active ? 'play_arrow' : 'bedtime', word: pr.active ? 'פעיל' : 'רדום'),
      ]),
    );
  }
}

/// The word and icon on a ticket: the worker's own state, or where the task stands when no one works on it yet.
(String, String) ticketStatus(Ticket t, Gender g) =>
    t.group == TicketGroup.queued ? ('בתור', 'schedule') : (statusWord(t.status, g), statusIcon(t.status));

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
    final (word, icon) = ticketStatus(t, who?.gender ?? Gender.m);
    final sub = [t.projectName, if (t.assignee.isNotEmpty) t.assignee, if (t.sub != null) t.sub!].join(' · ');
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
            Badge2(label: word, icon: icon, kind: t.status == WorkerStatus.waiting ? BadgeKind.dark : BadgeKind.plain),
            const SizedBox(height: 5),
            if (t.diffStat != null) DiffStat(t.diffStat!) else if (t.endLine != null) Text(t.endLine!, style: T.meta.copyWith(color: p.text3)),
          ]),
        ]),
      ),
    );
  }
}
