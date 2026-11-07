import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/task_progress.dart';
import '../../theme/tokens.dart';
import '../chat/chat_screen.dart';
import '../common.dart';
import '../product/product_theme.dart';
import 'task_screen.dart';

/// The phone opens the whole team in one tap. Wide conversations show the same tree beside them.
class ConversationHierarchy extends StatefulWidget {
  const ConversationHierarchy({
    super.key,
    required this.identity,
    this.sidebar = false,
  });
  final String identity;
  final bool sidebar;
  @override
  State<ConversationHierarchy> createState() => _ConversationHierarchyState();
}

class _ConversationHierarchyState extends State<ConversationHierarchy>
    with WidgetsBindingObserver {
  List<OrgPerson>? people;
  bool pending = false, failed = false, initialized = false;
  Timer? timer;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    timer = Timer.periodic(const Duration(seconds: 30), (_) => refresh());
  }

  @override
  void dispose() {
    timer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState s) {
    if (s == AppLifecycleState.resumed) refresh();
  }

  Future<void> refresh() async {
    if (!mounted || pending || ModalRoute.of(context)?.isCurrent == false) {
      return;
    }
    setState(() {
      pending = true;
      failed = false;
    });
    try {
      final value = await StoreScope.read(context).backend.organization();
      if (mounted) setState(() => people = value);
    } catch (_) {
      if (mounted) setState(() => failed = true);
    } finally {
      if (mounted) setState(() => pending = false);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!initialized) {
      initialized = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) refresh();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    final content = Builder(
      builder: (context) {
        final list = people;
        final explanation = people == null
            ? l.progressTeamFailed
            : l.progressTeamStale;
        final Widget? notice = !failed
            ? null
            : widget.sidebar
            ? TextButton(onPressed: refresh, child: Text(explanation))
            : Tooltip(
                message: explanation,
                child: TextButton.icon(
                  icon: const Ic('warning'),
                  label: Text(l.progressTeamRetry),
                  onPressed: refresh,
                ),
              );
        if (list == null) return notice ?? const SizedBox.shrink();
        Widget withStatus(Widget child) {
          if (notice == null) return child;
          if (!widget.sidebar) {
            return Row(
              children: [
                Expanded(child: child),
                IBtn('warning', tip: explanation, onTap: refresh),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              notice,
              Expanded(child: child),
            ],
          );
        }

        final root = list.where((x) => x.id == widget.identity).firstOrNull;
        final children = list
            .where(
              (x) => x.manager == widget.identity && x.id != widget.identity,
            )
            .toList();
        final manager = list
            .where((p) => p.id == root?.manager && p.id != widget.identity)
            .firstOrNull;
        final contextRoot = children.isEmpty && manager != null
            ? manager
            : root;
        if (widget.sidebar) {
          final heading = contextRoot;
          if (heading == null) {
            return Padding(
              padding: const EdgeInsets.all(16),
              child: Text(l.progressNoTeam),
            );
          }
          final members = list
              .where((x) => x.manager == heading.id && x.id != heading.id)
              .toList();
          // A few who finished (every task done, or gone) stay in place, in the order hq gave, two taps from the chat.
          // Past five they fold at the end, so the ones working now are not lost under them.
          // The one in the chat never folds, so it stays in the tree beside its own conversation.
          bool done(OrgPerson x) =>
              x.id != widget.identity && (!x.active || (x.tasks.isNotEmpty && x.tasks.every((t) => t.state == 'done')));
          final fold = members.where(done).length > 5;
          final live = [for (final x in members) if (!fold || !done(x)) x];
          final finished = [if (fold) ...members.where(done)];
          final supervisor = list
              .where((x) => x.id == heading.manager && x.id != heading.id)
              .firstOrNull;
          return withStatus(
            Material(
              color: p.surface,
              child: ListView(
                key: PageStorageKey('hierarchy-${widget.identity}'),
                children: [
                  if (supervisor != null)
                    Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: TextButton.icon(
                        icon: const Ic('person', size: 20),
                        label: Text(l.reportsTo(supervisor.name)),
                        onPressed: () => Navigator.push(
                          context,
                          MaterialPageRoute<void>(
                            builder: (_) =>
                                ChatScreen(identityId: supervisor.id),
                          ),
                        ),
                      ),
                    ),
                  _person(context, heading, heading: true),
                  for (final task in heading.tasks)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(start: 24),
                      child: _task(context, task),
                    ),
                  if (members.isEmpty && heading.tasks.isEmpty)
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(l.progressNoTeam),
                    ),
                  for (final person in live)
                    Padding(
                      padding: const EdgeInsetsDirectional.only(start: 24),
                      child: _branch(context, person, list, {heading.id}),
                    ),
                  if (finished.isNotEmpty)
                    FoldTile(
                      key: PageStorageKey('org-finished-${heading.id}'),
                      title: Text(l.finishedFold(finished.length), style: T.section.copyWith(color: p.text2)),
                      children: [
                        for (final person in finished)
                          Padding(
                            padding: const EdgeInsetsDirectional.only(start: 24),
                            child: _branch(context, person, list, {heading.id}),
                          ),
                      ],
                    ),
                ],
              ),
            ),
          );
        }
        if (contextRoot == null || (children.isEmpty && manager == null)) {
          return const SizedBox.shrink();
        }
        return withStatus(
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: TextButton.icon(
              key: const Key('conversation-team'),
              icon: const Ic('account_tree'),
              label: Text(
                l.progressTeamOf(contextRoot.name),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              onPressed: () {
                Navigator.push(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) => Scaffold(
                      backgroundColor: p.bg,
                      appBar: AppBar(
                        leading: IBtn(
                          backIcon(context),
                          tip: l.back,
                          onTap: () => Navigator.maybePop(context),
                        ),
                        title: Text(l.progressTeamOf(contextRoot.name)),
                      ),
                      body: ConversationHierarchy(
                        identity: widget.identity,
                        sidebar: true,
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        );
      },
    );
    if (widget.sidebar) return content;
    final root = people?.where((p) => p.id == widget.identity).firstOrNull;
    final hasContent =
        people == null ||
        people!.any(
          (p) =>
              (p.manager == widget.identity && p.id != widget.identity) ||
              (root?.manager != null && p.id == root!.manager),
        );
    if (!hasContent) return const SizedBox.shrink();
    // Keep the chat's origin fixed while the initial tree and later refreshes are in flight.
    return SizedBox(
      height:
          48 +
          (MediaQuery.textScalerOf(context).scale(14) - 14).clamp(
                0,
                double.infinity,
              ) *
              2,
      child: content,
    );
  }

  Widget _branch(
    BuildContext context,
    OrgPerson person,
    List<OrgPerson> all,
    Set<String> path,
  ) {
    final children = all
        .where(
          (p) =>
              p.manager == person.id &&
              !path.contains(p.id) &&
              p.id != person.id,
        )
        .toList();
    if (children.isEmpty && person.tasks.isEmpty) {
      return _person(context, person);
    }
    return ExpansionTile(
      key: PageStorageKey('org-${person.id}'),
      initiallyExpanded: true,
      expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
      trailing: const Ic('expand_more'),
      title: _person(context, person),
      tilePadding: EdgeInsets.zero,
      children: [
        for (final t in person.tasks)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: 24),
            child: _task(context, t),
          ),
        for (final child in children)
          Padding(
            padding: const EdgeInsetsDirectional.only(start: 24),
            child: _branch(context, child, all, {...path, person.id}),
          ),
      ],
    );
  }

  Widget _task(BuildContext context, ({int id, String title, String state}) t) {
    final l = AppLocalizations.of(context);
    return ListTile(
      key: ValueKey('org-task-${t.id}'),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      minLeadingWidth: 20,
      horizontalTitleGap: 4,
      leading: const Ic('description', size: 20),
      title: _content(context, t.title),
      subtitle: t.state == 'done'
          ? StatusWord(icon: 'check_circle', word: l.progressWorkCompleted)
          : null,
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute<void>(builder: (_) => ProductTaskScreen(id: t.id)),
      ),
    );
  }

  // Paragraph direction belongs to the content; alignment belongs to the interface column.
  Widget _content(BuildContext context, String value, {TextStyle? style}) =>
      Text(
        isolateLtr(value),
        textDirection: paragraphDirection(value),
        textAlign: Directionality.of(context) == TextDirection.rtl
            ? TextAlign.right
            : TextAlign.left,
        style: style,
      );

  Widget _person(
    BuildContext context,
    OrgPerson person, {
    bool heading = false,
  }) {
    final l = AppLocalizations.of(context), d = StoreScope.of(context).data!;
    return ListTile(
      key: ValueKey('org-person-${person.id}'),
      selected: person.id == widget.identity,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      minLeadingWidth: 20,
      horizontalTitleGap: 4,
      leading: ProjectMonogram.person(d, person.id, size: 20),
      title: _content(context, person.name, style: heading ? T.name : null),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _content(
            context,
            person.title,
            style: T.meta.copyWith(color: context.p.text2),
          ),
          if (person.tasks.isNotEmpty &&
              person.tasks.every((t) => t.state == 'done'))
            StatusWord(icon: 'check_circle', word: l.progressCompleted),
        ],
      ),
      onTap: () => Navigator.push(
        context,
        MaterialPageRoute<void>(
          builder: (_) => ChatScreen(identityId: person.id),
        ),
      ),
    );
  }
}
