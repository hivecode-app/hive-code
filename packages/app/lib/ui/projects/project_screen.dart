// One project (#53): its team, each with what they are doing now; then its open tasks and the ones
// that finished, task workers included. A standing team without a project shows its team only.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../entity_link.dart';
import '../nav.dart';
import '../status/status_screen.dart';

class ProjectScreen extends StatefulWidget {
  const ProjectScreen({super.key, this.projectId, this.teamId});
  final String? projectId;
  final String? teamId;

  /// Finished tasks before "עוד N".
  static const kDoneShown = 8;

  @override
  State<ProjectScreen> createState() => _ProjectScreenState();
}

class _ProjectScreenState extends State<ProjectScreen> {
  bool allDone = false;

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final proj = d.projects.where((x) => x.id == widget.projectId).firstOrNull;
    final team = d.teams[proj?.teamId ?? widget.teamId];
    final leadId = team?.leadId;
    final members = [for (final i in d.identities.values) if (team != null && i.teamId == team.id) i.id];
    int rank(String id) {
      if (id == leadId) return 0;
      final s = d.presence[id]?.status ?? WorkerStatus.resting;
      return s == WorkerStatus.resting ? 2 : 1;
    }
    members.sort((a, b) => rank(a).compareTo(rank(b)));
    final tickets = proj == null ? const <Ticket>[] : d.tickets.where((t) => t.project == proj.id).toList();
    final open = [...runningIn(d, proj?.id ?? ''), ...tickets.where((t) => t.group == TicketGroup.queued)];
    final today = DateUtils.dateOnly(CompanyTime.now());
    final done = [for (final t in tickets) if (t.doneAt != null && t.assigneeId != null && !t.doneAt!.isBefore(today)) t]..sort((a, b) => b.doneAt!.compareTo(a.doneAt!));
    final shownDone = allDone ? done : done.take(ProjectScreen.kDoneShown).toList();
    final lead = leadId == null ? null : d.who(leadId);
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(children: [
          TopBar(title: proj?.name ?? team?.name ?? '', leading: IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop())),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                child: Text(
                  [if (lead != null) 'ראש צוות: ${lead.name}', members.length == 1 ? 'עובד קבוע אחד' : '${members.length} עובדים קבועים', if (proj != null) openTasksLineShort(open.length)].join(' · '),
                  style: T.secondary.copyWith(color: p.text2),
                ),
              ),
              Section('הצוות', count: '${members.length}', top: 10),
              ListBlock(children: [for (final id in members) _MemberRow(id: id, lead: id == leadId)]),
              if (proj != null) ...[
                Section('משימות פתוחות', count: open.isEmpty ? null : '${open.length}'),
                ListBlock(children: [
                  if (open.isEmpty)
                    Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14), child: Text('אין משימות פתוחות', style: T.row2.copyWith(color: p.text2)))
                  else
                    for (final t in open) _TaskRow(t: t),
                ]),
                Section('הסתיימו היום', count: done.isEmpty ? null : '${done.length}'),
                ListBlock(children: [
                  if (done.isEmpty)
                    Padding(padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14), child: Text('עוד לא הסתיימה משימה היום', style: T.row2.copyWith(color: p.text2)))
                  else
                    for (final t in shownDone) _TaskRow(t: t),
                ]),
                if (done.length > shownDone.length)
                  MoreRow(icon: 'expand_more', bold: 'עוד ${done.length - shownDone.length}', rest: '', top: false, onTap: () => setState(() => allDone = true)),
              ],
              const SizedBox(height: 24),
            ]),
          ),
        ]),
      ),
    );
  }
}

String openTasksLineShort(int n) => n == 0 ? 'אין משימות פתוחות' : (n == 1 ? 'משימה פתוחה אחת' : '$n משימות פתוחות');

/// A team member and what they do now: the status word, and the task when there is one.
class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.id, required this.lead});
  final String id;
  final bool lead;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final who = d.who(id);
    final pr = d.presence[id] ?? const Presence(status: WorkerStatus.resting);
    final busy = pr.status != WorkerStatus.resting && pr.status != WorkerStatus.free && pr.status != WorkerStatus.done;
    final task = busy ? (pr.currentTask ?? pr.activity) : null;
    return InkWell(
      onTap: () => Nav.chat(context, id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Monogram.of(d, id),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                Text(who.name, style: T.name.copyWith(color: p.text)),
                const SizedBox(width: 6),
                Expanded(child: Rich(lead ? 'ראש צוות · ${who.title}' : who.title, maxLines: 1, style: T.secondary.copyWith(color: p.text2))),
              ]),
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: task != null
                    ? Row(children: [
                        Ic(statusLoud(pr.status) ? statusIcon(pr.status) : 'play_arrow', size: 17, fill: true, color: p.text),
                        const SizedBox(width: 4),
                        Expanded(child: Rich(plainTitle(task), auto: true, maxLines: 1, style: T.secondary.copyWith(color: p.text))),
                      ])
                    : StatusWord.of(pr, who.gender),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// A task: its title, then who is on it (a task worker too) and where it stands. A tap opens the conversation
/// with the worker on it, or with who opened it while it waits or once a task worker is done.
class _TaskRow extends StatelessWidget {
  const _TaskRow({required this.t});
  final Ticket t;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final id = t.assigneeId;
    final who = id == null ? null : d.who(id);
    final String icon;
    final String state;
    if (t.doneAt != null) {
      icon = 'check_circle';
      state = 'הסתיים ${hm(t.doneAt!)}';
    } else if (t.group == TicketGroup.queued) {
      // Its place in line and why it waits (#128), when hq says.
      final o = d.openTasks.where((x) => 't${x.id}' == t.number).firstOrNull;
      icon = 'schedule';
      state = [o?.position == null ? 'בתור' : 'בתור, מקום ${o!.position}', if (o?.reason?.isNotEmpty == true) o!.reason!].join(' · ');
    } else {
      icon = statusLoud(t.status) ? statusIcon(t.status) : 'play_arrow';
      state = [statusWord(t.status, who?.gender ?? Gender.m), if (t.startedAt != null) 'מ-${hm(t.startedAt!)}'].join(' ');
    }
    return EntityLink(
      identity: chatTargetOfTicket(d, t),
      minHeight: kLinkRow,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (id != null) Monogram.of(d, id) else const SizedBox(width: 42, height: 42),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Rich(t.doneAt != null ? t.doneLine : plainTitle(t.title), auto: true, maxLines: 2, style: T.row2.copyWith(color: p.text)),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Row(children: [
                  Ic(icon, size: 16, fill: true, color: t.doneAt != null ? p.text2 : p.text),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text([if (who != null) '${who.name}${who.temp ? ' (זמני)' : ''}', state].join(' · '),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text2)),
                  ),
                ]),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}
