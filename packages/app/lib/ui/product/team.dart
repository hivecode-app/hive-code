import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'chats.dart' show productStatus;
import 'product_theme.dart';
import 'shell.dart' show ProductDirectory, standingTeams;

/// Who is in the team now (maturity §4, mockup a-he-team; app-gap §2): by project, then the standing teams, each
/// with its lead first and then whoever waits, works or is free; a task worker whose task is done is not in the
/// team any more. Each row says what that one does now. Who finished today is folded at the end. On a wide screen
/// the same groups are a table (name, role, state, current task, chat).
class ProductTeam extends StatelessWidget {
  const ProductTeam({super.key});

  static const _rank = {
    WorkerStatus.waiting: 0,
    WorkerStatus.blocked: 1,
    WorkerStatus.stuck: 1,
    WorkerStatus.working: 2,
    WorkerStatus.restarting: 2,
    WorkerStatus.free: 3,
    WorkerStatus.resting: 4,
    WorkerStatus.done: 5,
  };

  /// In the team now: everyone standing, and a task worker while its task is open (or while it is busy, for an
  /// errand hq has no task row for). A task worker resting after its task closed is not in the team any more.
  static bool current(CompanyData d, String id) {
    if (!d.canChat(id)) return false;
    if (!d.who(id).temp) return true;
    if (d.openTasks.any((t) => t.worker == id)) return true;
    return switch (d.presence[id]?.status) {
      WorkerStatus.working || WorkerStatus.waiting || WorkerStatus.blocked || WorkerStatus.stuck || WorkerStatus.restarting => true,
      _ => false,
    };
  }

  /// The groups as shown: the directory's groups (everyone once), only who is in the team now, the lead first.
  static List<(String, List<Identity>)> groups(CompanyData d) {
    final leads = {for (final t in d.teams.values) if (t.leadId != null) t.leadId!};
    int rank(Identity who) => leads.contains(who.id) ? -1 : _rank[shownStatus(d, who.id)]!;
    // By rank, and within a rank in the directory's order (Dart's sort is not stable past 32 rows).
    List<Identity> sorted(List<Identity> people) {
      final index = {for (final (i, who) in people.indexed) who.id: i};
      return people..sort((a, b) => rank(a) != rank(b) ? rank(a).compareTo(rank(b)) : index[a.id]!.compareTo(index[b.id]!));
    }
    return [
      for (final g in ProductDirectory.teamGroups(d, standingTeams(d)))
        (g.$1, sorted([for (final who in g.$2) if (current(d, who.id)) who])),
    ].where((g) => g.$2.isNotEmpty).toList();
  }

  /// "1 מחכה לך · 4 בעבודה · 1 פנוי · 2 במנוחה", only the states someone is in. Who waits on him comes first, so a
  /// big resting count does not bury it.
  static List<String> summaryParts(AppLocalizations l, CompanyData d, Iterable<Identity> shown) {
    WorkerStatus st(Identity who) => shownStatus(d, who.id);
    int count(bool Function(WorkerStatus) f) => shown.where((who) => f(st(who))).length;
    return [
      (count((s) => s == WorkerStatus.waiting), l.teamSumWaiting),
      (count((s) => s == WorkerStatus.blocked), l.teamSumBlocked),
      (count((s) => s == WorkerStatus.stuck), l.teamSumStuck),
      (count((s) => s == WorkerStatus.working || s == WorkerStatus.restarting), l.teamSumWorking),
      (count((s) => s == WorkerStatus.free), l.teamSumFree),
      (count((s) => s == WorkerStatus.resting), l.teamSumResting),
    ].where((x) => x.$1 > 0).map((x) => x.$2(x.$1)).toList();
  }

  static String summary(AppLocalizations l, CompanyData d, Iterable<Identity> shown) => summaryParts(l, d, shown).join(' · ');

  /// Task workers who finished a task today and so left the team, each with the task it finished.
  static Map<String, Ticket> finishedToday(CompanyData d, [DateTime? now]) {
    final today = dayStart(now ?? CompanyTime.now());
    final out = <String, Ticket>{};
    for (final t in d.tickets) {
      final who = t.assigneeId;
      if (t.doneAt == null || t.doneAt!.isBefore(today) || who == null || !d.identities.containsKey(who)) continue;
      if (!d.who(who).temp || current(d, who)) continue;
      final seen = out[who];
      if (seen == null || seen.doneAt!.isBefore(t.doneAt!)) out[who] = t;
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, l = AppLocalizations.of(context), p = context.p;
    final shown = groups(d), finished = finishedToday(d);
    final all = [for (final g in shown) ...g.$2];
    final parts = summaryParts(l, d, all);
    final waits = all.any((who) => shownStatus(d, who.id) == WorkerStatus.waiting);
    // Who waits on him leads the line in medium weight, as in the mockup.
    final line = Text.rich(
      TextSpan(
        style: T.small.copyWith(color: p.text2),
        children: [
          for (final (i, part) in parts.indexed) ...[
            if (i > 0) const TextSpan(text: ' · '),
            TextSpan(text: part, style: i == 0 && waits ? TextStyle(color: p.text, fontWeight: FontWeight.w500) : null),
          ],
        ],
      ),
    );
    return LayoutBuilder(
      builder: (context, box) {
        final wide = box.maxWidth >= 760;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: EdgeInsetsDirectional.fromSTEB(wide ? 24 : 20, 20, wide ? 24 : 20, wide ? 12 : 4),
              child: wide
                  ? Row(
                      children: [
                        Text(l.team, style: T.bar),
                        const SizedBox(width: 16),
                        Expanded(child: line),
                      ],
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(l.team, style: T.big),
                        if (parts.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 6), child: line),
                      ],
                    ),
            ),
            if (wide) Divider(height: 1, color: p.line),
            Expanded(
              child: ListView(
                key: const PageStorageKey('product-team'),
                padding: wide ? const EdgeInsets.symmetric(horizontal: 24) : EdgeInsets.zero,
                children: [
                  if (wide) const _TableHead(),
                  for (final g in shown) ...[
                    _GroupHead(g.$1, wide: wide, onTap: _open(context, d, g.$2.first)),
                    for (final who in g.$2) wide ? ProductPersonTableRow(id: who.id) : ProductPersonRow(id: who.id),
                  ],
                  if (finished.isNotEmpty)
                    Theme(
                      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                      child: FoldTile(
                        key: const PageStorageKey('team-finished'),
                        tilePadding: const EdgeInsetsDirectional.symmetric(horizontal: 20),
                        color: p.text2,
                        title: Text(l.finishedToday(finished.length), style: T.section.copyWith(color: p.text2)),
                        children: [
                          for (final e in finished.entries)
                            wide ? ProductPersonTableRow(id: e.key, line: plainTitle(e.value.title)) : ProductPersonRow(id: e.key, line: plainTitle(e.value.title)),
                        ],
                      ),
                    ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}

/// The page of the group a person is in: its project, else its standing team. The groups are built the same way
/// (`ProductDirectory.teamGroups`), so the first person tells which page the heading opens.
VoidCallback? _open(BuildContext context, CompanyData d, Identity who) {
  final project = d.projectOf(who.id), team = who.host ?? who.teamId;
  if (project != null) return () => Nav.project(context, project);
  // A team org.yaml does not know has no page to open.
  return d.teams[team] == null ? null : () => Nav.team(context, team);
}

/// Its state as the team shows it. "מחכה לך" comes from what asks him (`needsYou`), the same source as the chats' chip
/// and card. A presence that says waiting with nothing of his open (the ask went back to the manager, it was just
/// answered, or he put it off) is blocked, never shown as at work.
WorkerStatus shownStatus(CompanyData d, String id) {
  final status = d.presence[id]?.status ?? WorkerStatus.free;
  if (d.needsYou.any((w) => w.from == id)) return WorkerStatus.waiting;
  return status == WorkerStatus.waiting ? WorkerStatus.blocked : status;
}

class _GroupHead extends StatelessWidget {
  const _GroupHead(this.title, {required this.wide, this.onTap});
  final String title;
  final bool wide;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    // A grey band across the whole width, on the phone and in the table alike; it opens the group's page.
    return Padding(
      padding: EdgeInsets.only(top: wide ? 8 : 0),
      child: Material(
        color: wide ? p.surface2 : p.bg,
        child: InkWell(
          onTap: onTap,
          child: Container(
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
            padding: EdgeInsetsDirectional.fromSTEB(20, wide ? 10 : 18, 12, wide ? 10 : 8),
            child: Row(
              children: [
                Expanded(child: Text(title, style: T.section.copyWith(color: p.text2))),
                if (onTap != null) Ic(chevronIcon(context), size: 18, color: p.text3),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TableHead extends StatelessWidget {
  const _TableHead();
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final style = T.section.copyWith(color: p.text2);
    return Padding(
      padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 20, 8),
      child: Row(
        children: [
          Expanded(flex: 3, child: Text(l.teamColName, style: style)),
          Expanded(flex: 3, child: Text(l.teamColRole, style: style)),
          Expanded(flex: 3, child: Text(l.teamColState, style: style)),
          Expanded(flex: 8, child: Text(l.teamColTask, style: style)),
          const SizedBox(width: 120),
        ],
      ),
    );
  }
}

/// What it does now, in words: the task its shift is on, else its open task (the latest started), else its last
/// activity.
String? _now(CompanyData d, String id, String? line) {
  final presence = d.presence[id];
  final open = d.openTasks.where((t) => t.worker == id).toList()
    ..sort((a, b) => (b.since ?? DateTime(0)).compareTo(a.since ?? DateTime(0)));
  final now = line ?? presence?.currentTask ?? open.firstOrNull?.title ?? presence?.activity;
  return now == null || now.trim().isEmpty ? null : plainTitle(now);
}

/// Its state as an icon and a word; waiting on him reads "מחכה לך".
class _State extends StatelessWidget {
  const _State(this.id);
  final String id;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, p = context.p;
    final status = shownStatus(d, id);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Ic(statusIcon(status), size: 18, color: p.text, fill: status == WorkerStatus.waiting),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            status == WorkerStatus.waiting ? AppLocalizations.of(context).needsYou : productStatus(context, status),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: T.small.copyWith(color: p.text),
          ),
        ),
      ],
    );
  }
}

/// A person in the team: name and role, what it does now under them, its state at the end.
class ProductPersonRow extends StatelessWidget {
  const ProductPersonRow({super.key, required this.id, this.line});
  final String id;

  /// In place of what it does now (a finished one: the task it finished).
  final String? line;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, p = context.p;
    final who = d.who(id), now = _now(d, id, line);
    return Material(
      color: p.surface,
      child: InkWell(
        key: ValueKey('team-row-$id'),
        onTap: () => Nav.chat(context, id),
        child: Container(
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line, width: 0.5))),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          child: Row(
            children: [
              ProjectMonogram.person(d, id),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(text: who.name, style: T.name.copyWith(color: p.text)),
                          const TextSpan(text: '  '),
                          TextSpan(text: who.title, style: T.small.copyWith(color: p.text2)),
                        ],
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (now != null) ProductContentText(now, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text2)),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              _State(id),
            ],
          ),
        ),
      ),
    );
  }
}

/// The same person as a table row on a wide screen, with a chat button at the end.
class ProductPersonTableRow extends StatelessWidget {
  const ProductPersonTableRow({super.key, required this.id, this.line});
  final String id;
  final String? line;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, l = AppLocalizations.of(context), p = context.p;
    final who = d.who(id), now = _now(d, id, line);
    return Container(
      key: ValueKey('team-row-$id'),
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line, width: 0.5))),
      padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 20, 12),
      child: Row(
        children: [
          Expanded(
            flex: 3,
            child: Row(
              children: [
                ProjectMonogram.person(d, id, size: 32),
                const SizedBox(width: 10),
                Flexible(child: Text(who.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.name.copyWith(color: p.text))),
              ],
            ),
          ),
          Expanded(flex: 3, child: Text(who.short, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(color: p.text2))),
          Expanded(flex: 3, child: Align(alignment: AlignmentDirectional.centerStart, child: _State(id))),
          Expanded(
            flex: 8,
            child: now == null
                ? Text(l.openTasksCount(0), maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(color: p.text3))
                // A task in the other language keeps its own direction but sits at the interface's start, like the rest.
                : Align(
                    alignment: AlignmentDirectional.centerStart,
                    child: ProductContentText(now, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(color: p.text)),
                  ),
          ),
          SizedBox(
            width: 120,
            child: Align(
              alignment: AlignmentDirectional.centerEnd,
              // A screen reader hears whose chat it opens, not "צ'אט" on every row.
              child: OutlinedButton.icon(
                onPressed: () => Nav.chat(context, id),
                icon: const Ic('chat', size: 18),
                label: Text(l.teamChat, semanticsLabel: l.teamChatWith(who.name)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
