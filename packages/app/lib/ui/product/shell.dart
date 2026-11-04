import '../tasks/tasks_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
import 'settings.dart';

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
            Widget page() => switch (nav.tab) {
              AppTab.chats => ProductChats(onSettings: () => nav.go(AppTab.settings)),
              AppTab.status => const ProductDirectory(),
              AppTab.projects => const ProductDirectory(projects: true),
              AppTab.settings => const ProductSettings(embedded: true),
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
                          child: ProductChats(compact: true, onSettings: () => nav.go(AppTab.settings)),
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
                          NavigationDestination(
                            icon: SizedBox(
                              width: 32,
                              height: 28,
                              child: Stack(
                                clipBehavior: Clip.none,
                                children: [
                                  const Align(alignment: Alignment.center, child: Ic('chat')),
                                  if ((store.data?.unreadCount ?? 0) > 0)
                                    PositionedDirectional(top: -5, end: -8, child: ProductUnreadBadge(store.data!.unreadCount)),
                                ],
                              ),
                            ),
                            label: l.chats,
                          ),
                          NavigationDestination(icon: const Ic('group'), label: l.team),
                          NavigationDestination(icon: const Ic('folder'), label: l.projects),
                          NavigationDestination(icon: const Ic('settings'), label: l.settings),
                          NavigationDestination(icon: const Ic('task_alt'), label: l.tasks),
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
                                Expanded(child: Text(store.error!)),
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
                child: Text(l.company, style: T.name),
              ),
            const SizedBox(height: 8),
            item('chat', l.chats, () => nav.go(AppTab.chats), selected: nav.tab == AppTab.chats, count: d.unreadCount > 0 ? '${d.unreadCount}' : null),
            item('task_alt', l.tasks, () => nav.go(AppTab.tasks), selected: nav.tab == AppTab.tasks),
            item('group', l.team, () => nav.go(AppTab.status), selected: nav.tab == AppTab.status),
            item('folder', l.projects, () => nav.go(AppTab.projects), selected: nav.tab == AppTab.projects),
            item('search', l.search, () => openProductSearch(context), count: 'Ctrl K'),
            if (expanded) ...[
              Padding(
                padding: const EdgeInsetsDirectional.fromSTEB(20, 18, 20, 6),
                child: Text(l.projects, style: T.small.copyWith(color: p.text2)),
              ),
              Expanded(
                child: ListView(
                  children: [
                    for (final t in d.teams.values.where((t) => !t.permanent))
                      ListTile(
                        dense: true,
                        leading: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(color: projectColor(context, t.tone), shape: BoxShape.circle),
                        ),
                        title: Text(t.name),
                        onTap: () => Nav.project(context, t.id),
                      ),
                  ],
                ),
              ),
            ] else
              const Spacer(),
            item('settings', l.settings, () => nav.go(AppTab.settings), selected: nav.tab == AppTab.settings),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }
}

class ProductDirectory extends StatelessWidget {
  const ProductDirectory({super.key, this.projects = false});
  final bool projects;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!, l = AppLocalizations.of(context), p = context.p;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.all(20),
          child: Text(projects ? l.projects : l.team, style: T.big),
        ),
        Expanded(
          child: ListView(
            children: [
              for (final t in d.teams.values) ...[
                if (projects)
                  ListTile(
                    leading: Ic('folder', color: projectColor(context, t.tone)),
                    title: Text(t.name),
                    onTap: () => Nav.project(context, t.id),
                  )
                else ...[
                  Section(t.name),
                  for (final who in d.identities.values.where((who) => who.teamId == t.id && d.canChat(who.id)))
                    ListTile(
                      leading: ProjectMonogram.person(d, who.id),
                      title: Text(who.name),
                      subtitle: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(d.roleLine(who.id)),
                          Row(
                            children: [
                              Ic(statusIcon(d.presence[who.id]?.status ?? WorkerStatus.free), size: 16, color: p.text2),
                              const SizedBox(width: 4),
                              Expanded(child: Text(productStatus(context, d.presence[who.id]?.status ?? WorkerStatus.free))),
                            ],
                          ),
                        ],
                      ),
                      onTap: () => Nav.chat(context, who.id),
                    ),
                ],
              ],
            ],
          ),
        ),
      ],
    );
  }
}
