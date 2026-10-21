// Projects (#53), in place of "לוח" and "ארגון": every project by his name for it, its team lead and
// how many tasks are open; then the standing teams. A project opens its own screen.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import '../system_bar.dart';
import 'project_screen.dart';

export 'project_screen.dart';

class ProjectsScreen extends StatelessWidget {
  const ProjectsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data;
    if (d == null) return const SizedBox.shrink();
    final projectTeams = {for (final x in d.projects) x.teamId};
    final standing = [for (final t in d.teams.values) if (t.permanent && !projectTeams.contains(t.id)) t];
    return Column(children: [
      const TopBar(title: 'פרויקטים', showLink: true),
      const SystemBar(),
      Expanded(
        child: ListView(padding: EdgeInsets.zero, children: [
          ListBlock(top: false, children: [for (final x in d.projects) ProjectRow(project: x)]),
          if (standing.isNotEmpty) ...[
            const Section('צוותים קבועים'),
            ListBlock(children: [for (final t in standing) TeamRow(team: t)]),
          ],
          const SizedBox(height: 24),
        ]),
      ),
    ]);
  }
}

/// The team's mark as the row's face: its symbol in the monogram circle.
class TeamMark extends StatelessWidget {
  const TeamMark(this.symbol, {super.key, this.tone});
  final String symbol;

  /// The team's identity tone (v2).
  final String? tone;
  @override
  Widget build(BuildContext context) => Monogram(letter: '', symbol: symbol, tone: tone, toned: true);
}

class ProjectRow extends StatelessWidget {
  const ProjectRow({super.key, required this.project});
  final ProjectInfo project;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final team = d.teams[project.teamId];
    final leadId = team?.leadId;
    final open = d.tickets.where((t) => t.project == project.id && t.group != TicketGroup.doneToday).length;
    return _Row(
      face: TeamMark(team?.symbol ?? 'folder', tone: team?.tone),
      title: project.name,
      leadId: leadId,
      line: openTasksLineShort(open),
      strong: open > 0,
      onTap: () => Nav.project(context, project.id),
      d: d,
      p: p,
    );
  }
}

class TeamRow extends StatelessWidget {
  const TeamRow({super.key, required this.team});
  final Team team;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final n = d.identities.values.where((i) => i.teamId == team.id).length;
    return _Row(
      face: TeamMark(team.symbol, tone: team.tone),
      title: team.name,
      // A team without a lead (management: Yoav is resident) shows its first member.
      leadId: team.leadId ?? d.identities.values.where((i) => i.teamId == team.id).firstOrNull?.id,
      line: n == 1 ? 'עובד אחד' : '$n עובדים',
      onTap: () => Nav.team(context, team.id),
      d: d,
      p: context.p,
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.face, required this.title, required this.leadId, required this.line, required this.onTap, required this.d, required this.p, this.strong = false});
  final Widget face;
  final String title;
  final String? leadId;
  final String line;
  final bool strong;
  final VoidCallback onTap;
  final CompanyData d;
  final Palette p;
  @override
  Widget build(BuildContext context) {
    final lead = leadId == null ? null : d.who(leadId!);
    final pr = leadId == null ? null : d.presence[leadId];
    return Material(
      color: p.surface,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            face,
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                  Flexible(child: Rich(title, maxLines: 1, style: T.name.copyWith(color: p.text))),
                  const SizedBox(width: 8),
                  Text(line, style: T.small.copyWith(color: strong ? p.text : p.text2, fontWeight: strong ? FontWeight.w700 : null)),
                ]),
                if (lead != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Row(children: [
                      Monogram.of(d, lead.id, size: AvSize.xs),
                      const SizedBox(width: 6),
                      Text(lead.name, style: T.secondary.copyWith(color: p.text)),
                      const SizedBox(width: 4),
                      Text(d.teams[d.who(leadId!).teamId]?.leadId == leadId ? 'ראש צוות' : lead.title, style: T.secondary.copyWith(color: p.text2)),
                      const SizedBox(width: 8),
                      if (pr != null) Flexible(child: StatusWord.of(pr, lead.gender)),
                    ]),
                  ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
