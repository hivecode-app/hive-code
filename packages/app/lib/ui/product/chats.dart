import '../../l10n/ui_copy.dart';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../convs/conversations_screen.dart' show newChat, pickMute, pickConvSort, sortConversations, whenV2;
import '../nav.dart';
import '../system_bar.dart';
import 'approval.dart';
import 'product_theme.dart';
import 'search_screen.dart';

String productStatus(BuildContext context, WorkerStatus status) {
  final l = AppLocalizations.of(context);
  return switch (status) {
    WorkerStatus.free => l.available,
    WorkerStatus.working => l.working,
    WorkerStatus.waiting => l.waiting,
    WorkerStatus.blocked => l.blocked,
    WorkerStatus.stuck => l.stuck,
    WorkerStatus.restarting => l.restarting,
    WorkerStatus.resting => l.resting,
    WorkerStatus.done => l.done,
  };
}

Future<void> openRequests(BuildContext context) => showModalBottomSheet<void>(
  context: context,
  useSafeArea: true,
  isScrollControlled: true,
  constraints: const BoxConstraints(maxWidth: 600),
  builder: (_) => const RequestsSheet(),
);

class RequestsSheet extends StatelessWidget {
  const RequestsSheet({super.key});
  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), l = AppLocalizations.of(context), p = context.p;
    final d = store.data!;
    final list = d.waiting.where((w) => w.state != WaitState.answered && !d.superseded(w)).toList();
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * .8,
      child: Column(
        children: [
          Row(
            children: [
              const SizedBox(width: 20),
              Expanded(child: Text(l.needsYou, style: T.bar)),
              IBtn('close', tip: l.close, onTap: () => Navigator.pop(context)),
            ],
          ),
          Expanded(
            child: list.isEmpty
                ? Center(child: Text(l.noRequests))
                : ListView(
                    children: [
                      for (final w in list)
                        ListTile(
                          leading: Ic(w.kind == WaitKind.go ? 'front_hand' : 'help', color: p.text2),
                          title: Text(w.headline ?? w.short),
                          subtitle: Text('${d.who(w.from).name} · ${d.roleLine(w.from)}'),
                          onTap: () {
                            final navigator = Navigator.of(context);
                            navigator.pop();
                            if (w.kind == WaitKind.go) {
                              showApproval(navigator.context, w);
                            } else {
                              Nav.waitItem(navigator.context, w);
                            }
                          },
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class ProductChats extends StatefulWidget {
  const ProductChats({super.key, this.compact = false, this.project, this.onSettings});
  final bool compact;
  final String? project;
  final VoidCallback? onSettings;
  @override
  State<ProductChats> createState() => _ProductChatsState();
}

class _ProductChatsState extends State<ProductChats> {
  String? filter;
  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), l = AppLocalizations.of(context), p = context.p;
    final d = store.data;
    if (d == null) {
      return Center(
        child: Semantics(label: l.loading, child: const CircularProgressIndicator()),
      );
    }
    final project = widget.project ?? filter;
    final ordered = sortConversations(
      d,
      d.conversations,
      store.convSort,
    ).where((c) => d.canChat(c.identityId) && (project == null || d.projectOf(c.identityId) == project));
    final list = [...ordered.where((c) => !d.isDone(c.identityId)), ...ordered.where((c) => d.isDone(c.identityId))];
    return ColoredBox(
      color: widget.compact ? p.surface : p.bg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!widget.compact)
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                IBtn('edit_square', tip: l.newChat, onTap: () => newChat(context, d)),
                IBtn('sort', tip: UiCopy.copy.ui472, onTap: () => pickConvSort(context)),
                const SizedBox(width: 8),
              ],
            ),
          Padding(
            padding: EdgeInsetsDirectional.fromSTEB(widget.compact ? 16 : 20, widget.compact ? 16 : 2, 12, 10),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    l.chats,
                    style: TextStyle(fontFamily: kFont, fontSize: widget.compact ? 18 : 30, fontWeight: FontWeight.w600, height: 1.2, color: p.text),
                  ),
                ),
                if (widget.compact) ...[IBtn('sort', tip: UiCopy.copy.ui472, onTap: () => pickConvSort(context)), IBtn('edit_square', tip: l.newChat, onTap: () => newChat(context, d)), IBtn('settings', tip: l.settings, onTap: widget.onSettings ?? () => Nav.settings(context))],
              ],
            ),
          ),
          if (!widget.compact) const SystemBar(),
          Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 0, 16, 10),
            child: Material(
              color: p.surface2,
              borderRadius: BorderRadius.circular(10),
              child: InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () => openProductSearch(context),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  child: Row(
                    children: [
                      Ic('search', size: 20, color: p.text3),
                      const SizedBox(width: 8),
                      Text(l.search, style: T.small.copyWith(color: p.text3)),
                    ],
                  ),
                ),
              ),
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsetsDirectional.fromSTEB(16, 0, 16, 14),
            child: Row(
              children: [
                _chip(context, l.all, selected: project == null, onTap: () => setState(() => filter = null)),
                if (d.waitingCount > 0) _chip(context, l.needsYouCount(d.waitingCount), icon: 'front_hand', onTap: () => openRequests(context)),
                for (final x in d.activeProjects.where((x) => d.conversations.any((c) => d.projectOf(c.identityId) == x.id)))
                  _chip(context, x.name, selected: project == x.id, onTap: () => setState(() => filter = x.id)),
              ],
            ),
          ),
          if (d.waitingCount == 0)
            Container(
              margin: const EdgeInsetsDirectional.fromSTEB(16, 0, 16, 12),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(10)),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Ic('check_circle', size: 20, color: p.text2),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      '${l.noRequests} ${l.inProgress(d.openTasks.where((t) => t.state == OpenTaskState.running).length)}',
                      style: T.small.copyWith(color: p.text2),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: list.isEmpty
                ? Center(
                    child: Text(l.noChats, style: T.secondary.copyWith(color: p.text2)),
                  )
                : ListView.separated(
                    padding: EdgeInsets.zero,
                    itemCount: list.length,
                    separatorBuilder: (_, _) => Padding(
                      padding: const EdgeInsetsDirectional.only(start: 68),
                      child: Divider(height: 1, color: p.line),
                    ),
                    itemBuilder: (context, i) => ProductChatRow(conversation: list[i]),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _chip(BuildContext c, String text, {bool selected = false, String? icon, required VoidCallback onTap}) {
    final p = c.p;
    return Padding(
      padding: const EdgeInsetsDirectional.only(end: 8),
      child: Material(
        color: selected ? p.accentSoft : p.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(8),
          side: BorderSide(color: selected ? Colors.transparent : p.line),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                if (icon != null) ...[Ic(icon, size: 18, color: p.text2), const SizedBox(width: 4)],
                Text(
                  text,
                  style: T.small.copyWith(color: p.text, fontWeight: selected ? FontWeight.w500 : FontWeight.w400),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ProductChatRow extends StatelessWidget {
  const ProductChatRow({super.key, required this.conversation});
  final ConversationSummary conversation;
  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), p = context.p;
    final d = store.data!, c = conversation;
    final who = d.who(c.identityId), presence = d.presence[c.identityId];
    final selected = NavScope.of(context).wide && !store.homeOpen && store.currentConversation == who.id;
    return Material(
      color: selected ? p.accentSoft : p.surface,
      child: InkWell(
        onTap: () => Nav.chat(context, who.id),
        onLongPress: () => pickMute(context, who.id),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              ProjectMonogram.person(d, who.id),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: Wrap(
                            crossAxisAlignment: WrapCrossAlignment.center,
                            spacing: 6,
                            children: [
                              ProductContentText(
                                who.name,
                                style: T.name.copyWith(fontWeight: FontWeight.w600, color: p.text),
                              ),
                              ProductContentText(d.roleLine(who.id), style: T.small.copyWith(color: p.text2)),
                            ],
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(c.at == null ? c.time : whenV2(c.at!, CompanyTime.now()), style: T.meta.copyWith(color: p.text3)),
                      ],
                    ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: ProductContentText(
                            c.text ?? c.lastLine,
                            maxLines: MediaQuery.textScalerOf(context).scale(1) > 1 ? 2 : 1,
                            overflow: TextOverflow.ellipsis,
                            style: T.small.copyWith(color: p.text2),
                          ),
                        ),
                        if (c.muted)
                          Padding(
                            padding: const EdgeInsetsDirectional.only(start: 6),
                            child: Ic('notifications_off', size: 16, color: p.text3),
                          ),
                        if (c.unread > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 8), child: ProductUnreadBadge(c.unread)),
                      ],
                    ),
                    if (presence != null && presence.status != WorkerStatus.resting && presence.status != WorkerStatus.free)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Ic(statusIcon(presence.status), size: 16, color: p.text2),
                            const SizedBox(width: 4),
                            Expanded(
                              child: Text(
                                [productStatus(context, presence.status), if (presence.activity?.isNotEmpty == true) presence.activity!].join(' · '),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: T.meta.copyWith(color: p.text),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
