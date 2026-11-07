import '../tasks/tasks_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../theme/tokens.dart';
import '../../model/models.dart';
import '../chat/chat_screen.dart';
import '../common.dart';
import '../nav.dart';
import 'chats.dart';
import 'product_theme.dart';
import 'search_screen.dart';
import 'team.dart';

/// Phase B owns this shell. Phase C can add its Tasks destination here without changing routing.
class ProductShell extends StatelessWidget {
  const ProductShell({super.key});
  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), nav = NavScope.of(context), l = AppLocalizations.of(context), p = context.p;
    nav.onLeaveStatus = store.markStatusSeen;
    nav.onLeaveChats = () => store.markChatsSeen(CompanyTime.now());
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.keyK, control: true): () => openProductSearch(context),
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () => openProductSearch(context),
      },
      child: Focus(
        autofocus: true,
        child: LayoutBuilder(
          builder: (context, constraints) {
            nav.wide = constraints.maxWidth >= 840 && (constraints.maxHeight >= 560 || constraints.maxWidth >= 1100);
            if (nav.wide) store.homeOpen = false;
            final selectedChat = store.selectedConversation ?? (store.data?.conversations.isNotEmpty == true ? store.currentConversation : null);
            Widget chatIcon(bool selected) => SizedBox(
              width: 32,
              height: 28,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Align(alignment: Alignment.center, child: Ic('chat', fill: selected)),
                  if ((store.data?.unreadCount ?? 0) > 0)
                    PositionedDirectional(top: -5, end: -8, child: ProductUnreadBadge(store.data!.unreadCount)),
                ],
              ),
            );
            Widget page() => switch (nav.tab) {
              AppTab.chats => const ProductChats(),
              AppTab.status => const ProductTeam(),
              AppTab.tasks => const ProductTasks(),
            };
            final body = store.data == null
                ? Center(
                    child: Semantics(label: l.loading, child: const CircularProgressIndicator()),
                  )
                : nav.wide
                ? Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(
                        width: constraints.maxWidth >= 1100 ? 248 : 72,
                        child: _Sidebar(expanded: constraints.maxWidth >= 1100),
                      ),
                      if (nav.tab == AppTab.chats) ...[
                        Container(
                          width: constraints.maxWidth >= 1100 ? 340 : 300,
                          decoration: BoxDecoration(
                            border: BorderDirectional(end: BorderSide(color: p.line)),
                          ),
                          child: const ProductChats(compact: true),
                        ),
                        Expanded(
                          child: selectedChat != null && store.data!.identities.containsKey(selectedChat)
                              ? ChatScreen(key: ValueKey(selectedChat), identityId: selectedChat, embedded: true)
                              : Center(
                                  child: Text(l.selectChat, style: T.secondary.copyWith(color: p.text2)),
                                ),
                        ),
                      ] else
                        Expanded(child: page()),
                    ],
                  )
                : Column(
                    children: [
                      Expanded(child: page()),
                      NavigationBar(
                        height: 72,
                        backgroundColor: p.surface,
                        indicatorColor: Colors.transparent,
                        selectedIndex: nav.tab.index,
                        onDestinationSelected: (i) => nav.go(AppTab.values[i]),
                        destinations: [
                          NavigationDestination(icon: chatIcon(false), selectedIcon: chatIcon(true), label: l.chats),
                          NavigationDestination(icon: const Ic('view_kanban'), selectedIcon: const Ic('view_kanban', fill: true), label: l.tasks),
                          NavigationDestination(icon: const Ic('group'), selectedIcon: const Ic('group', fill: true), label: l.team),
                        ],
                      ),
                    ],
                  );
            return PopScope(
              canPop: nav.wide || nav.tab == AppTab.chats,
              onPopInvokedWithResult: (didPop, _) {
                if (!didPop) nav.go(AppTab.chats);
              },
              child: Scaffold(
                backgroundColor: p.bg,
                body: SafeArea(
                  child: Column(
                    children: [
                      if (store.error != null)
                        Material(
                          color: p.surface2,
                          child: Padding(
                            padding: const EdgeInsetsDirectional.only(start: 16),
                            child: Row(
                              children: [
                                Ic('error', size: 20, color: p.text2),
                                const SizedBox(width: 8),
                                // Under an error that went to hq, "נשלח לטיפול" (error_report.dart), as before.
                                Expanded(
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [Text(store.error!), if (store.errorReported) const SentNote()],
                                  ),
                                ),
                                TextButton(onPressed: store.clearError, child: Text(l.acknowledge)),
                              ],
                            ),
                          ),
                        ),
                      Expanded(child: body),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({required this.expanded});
  final bool expanded;
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p, nav = NavScope.of(context), d = StoreScope.of(context).data!;
    Widget item(String icon, String text, VoidCallback onTap, {bool selected = false, String? count}) => Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      child: Material(
        color: selected ? p.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(7),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(7),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 34),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              child: Row(
                children: [
                  Tooltip(
                    message: text,
                    child: Ic(icon, color: p.text2),
                  ),
                  if (expanded) ...[
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(text, style: T.row2.copyWith(color: p.text)),
                    ),
                    if (count != null) Text(count, style: T.meta.copyWith(color: p.text3)),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
    return Material(
      color: p.bg,
      child: Container(
        decoration: BoxDecoration(
          border: BorderDirectional(end: BorderSide(color: p.line)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (expanded)
              Padding(
                padding: const EdgeInsets.all(20),
                child: Text(l.productName, style: T.name),
              ),
            const SizedBox(height: 8),
            item('chat', l.chats, () => nav.go(AppTab.chats), selected: nav.tab == AppTab.chats, count: d.unreadCount > 0 ? '${d.unreadCount}' : null),
            item('view_kanban', l.tasks, () => nav.go(AppTab.tasks), selected: nav.tab == AppTab.tasks, count: d.openTasks.isEmpty ? null : '${d.openTasks.length}'),
            item('group', l.team, () => nav.go(AppTab.status), selected: nav.tab == AppTab.status),
            item('search', l.search, () => openProductSearch(context), count: 'Ctrl K'),
            if (expanded) ...[
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 20, 6),
                child: Text(l.projects, style: T.small.copyWith(color: p.text2)),
              ),
              Expanded(child: _SidebarProjects(d: d)),
            ] else ...[
              // Folded, the projects list does not fit: one item opens it as a page.
              item('folder', l.projects, () => Nav.projects(context)),
              const Spacer(),
            ],
            // His account at the foot, as in the mockup: settings, and his name that opens them too.
            item('settings', l.settings, () => Nav.settings(context)),
            item('account_circle', d.ownerName.isEmpty ? l.account : d.ownerName, () => Nav.settings(context)),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

/// The desktop sidebar's projects (the mockup's `a-he-home-desktop`): each by his name for it, with its dot and how
/// many tasks are open; under the project of the conversation on screen, its lead and who works on it now.
class _SidebarProjects extends StatelessWidget {
  const _SidebarProjects({required this.d});
  final CompanyData d;
  @override
  Widget build(BuildContext context) {
    final p = context.p, store = StoreScope.of(context), nav = NavScope.of(context);
    final current = nav.tab == AppTab.chats ? store.currentConversation : null;
    final here = current == null ? null : d.projectOf(current);
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        for (final x in d.activeProjects) ...[
          InkWell(
            onTap: () => Nav.project(context, x.id),
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(22, 8, 20, 8),
              child: Row(
                children: [
                  ProjectDot(d.projectTone(x.id)),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(x.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.row2.copyWith(color: p.text)),
                  ),
                  Text('${d.openTasks.where((t) => t.project == x.id).length}', style: T.meta.copyWith(color: p.text3)),
                ],
              ),
            ),
          ),
          if (x.id == here)
            for (final id in projectPeople(d, x.id, max: 4))
              InkWell(
                onTap: () => Nav.chat(context, id),
                child: Padding(
                  padding: const EdgeInsetsDirectional.fromSTEB(42, 4, 20, 4),
                  child: Row(
                    children: [
                      ProjectMonogram.person(d, id, size: 24),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text('${d.who(id).name}, ${d.teams[x.teamId ?? x.id]?.leadId == id ? AppLocalizations.of(context).teamLead(d.who(id).gender.name) : d.who(id).short}', maxLines: 1, overflow: TextOverflow.ellipsis, style: T.small.copyWith(color: p.text)),
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ],
    );
  }
}

/// A project's lead, then whoever works on it now (not resting, not done): the faces under its name.
List<String> projectPeople(CompanyData d, String project, {int max = 1 << 20}) {
  final x = d.activeProjects.where((p) => p.id == project).firstOrNull;
  final lead = d.teams[x?.teamId ?? project]?.leadId;
  bool busy(String id) => switch (d.presence[id]?.status) {
    WorkerStatus.working || WorkerStatus.waiting || WorkerStatus.blocked || WorkerStatus.stuck || WorkerStatus.restarting => true,
    _ => false,
  };
  return [
    if (lead != null && d.identities.containsKey(lead)) lead,
    for (final i in d.identities.values)
      if (i.id != lead && d.canChat(i.id) && d.projectOf(i.id) == project && busy(i.id)) i.id,
  ].take(max).toList();
}

class ProjectDot extends StatelessWidget {
  const ProjectDot(this.tone, {super.key, this.size = 8});
  final String? tone;
  final double size;
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: projectColor(context, tone), shape: BoxShape.circle),
  );
}

/// Standing teams outside any project (management, monitoring, personal…): after the projects, by their own names.
List<Team> standingTeams(CompanyData d) => [
  for (final t in d.teams.values)
    if (t.permanent && !d.activeProjects.any((x) => (x.teamId ?? x.id) == t.id)) t,
];

class ProductDirectory extends StatelessWidget {
  const ProductDirectory({super.key});
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, l = AppLocalizations.of(context);
    final standing = standingTeams(d);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(20),
          child: Text(l.projects, style: T.big),
        ),
        Expanded(
          child: ListView(
            children: [
              for (final x in d.activeProjects) _ProjectTile(project: x),
              if (standing.isNotEmpty) ...[
                Section(l.standingTeams),
                for (final t in standing) _TeamTile(team: t),
              ],
            ],
          ),
        ),
      ],
    );
  }

  /// Everyone who can be chatted with, once: by active project, then by standing team (an errand by the team it
  /// was opened from), then whoever is left (a dormant project, or a team org.yaml does not know) under its own name.
  static List<(String, List<Identity>)> teamGroups(CompanyData d, List<Team> standing) {
    final placed = <String>{};
    List<Identity> take(bool Function(Identity who) member) => [
      for (final who in d.identities.values)
        if (d.canChat(who.id) && !placed.contains(who.id) && member(who)) who,
    ]..forEach((who) => placed.add(who.id));
    final groups = <(String, List<Identity>)>[
      for (final x in d.activeProjects) (x.name, take((who) => d.projectOf(who.id) == x.id)),
      for (final t in standing) (t.name, take((who) => d.projectOf(who.id) == null && (who.host ?? who.teamId) == t.id)),
    ];
    // Keyed by id, not by name, so two homes that share a name stay two groups.
    final rest = <String, (String, List<Identity>)>{};
    for (final who in take((_) => true)) {
      final project = d.projectOf(who.id), team = who.host ?? who.teamId;
      rest.putIfAbsent(project ?? team, () => (project != null ? d.projectName(project) : d.teams[team]?.name ?? team, [])).$2.add(who);
    }
    return [...groups, ...rest.values].where((g) => g.$2.isNotEmpty).toList();
  }
}

/// A project as a row: its dot and name, its lead, and how many tasks are open.
class _ProjectTile extends StatelessWidget {
  const _ProjectTile({required this.project});
  final ProjectInfo project;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, l = AppLocalizations.of(context), p = context.p;
    final lead = d.teams[project.teamId ?? project.id]?.leadId;
    final open = d.openTasks.where((t) => t.project == project.id).length;
    return ListTile(
      leading: SizedBox(width: 36, child: Center(child: ProjectDot(d.projectTone(project.id), size: 12))),
      title: Text(project.name, style: T.name.copyWith(color: p.text)),
      subtitle: lead == null ? null : Text(l.projectLead(d.who(lead).gender.name, d.who(lead).name), style: T.small.copyWith(color: p.text2)),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(l.openTasksCount(open), style: T.small.copyWith(color: open > 0 ? p.text : p.text3)),
          const SizedBox(width: 4),
          Ic(chevronIcon(context), size: 20, color: p.text3),
        ],
      ),
      onTap: () => Nav.project(context, project.id),
    );
  }
}

class _TeamTile extends StatelessWidget {
  const _TeamTile({required this.team});
  final Team team;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, l = AppLocalizations.of(context), p = context.p;
    final lead = team.leadId;
    return ListTile(
      leading: SizedBox(width: 36, child: Center(child: ProjectDot(team.tone, size: 12))),
      title: Text(team.name, style: T.name.copyWith(color: p.text)),
      subtitle: lead == null ? null : Text(l.projectLead(d.who(lead).gender.name, d.who(lead).name), style: T.small.copyWith(color: p.text2)),
      trailing: Ic(chevronIcon(context), size: 20, color: p.text3),
      onTap: () => Nav.team(context, team.id),
    );
  }
}
