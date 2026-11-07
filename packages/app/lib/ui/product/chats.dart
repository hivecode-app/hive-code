import '../../l10n/ui_copy.dart';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../blocks/since.dart' show SinceBlock;
import '../blocks/data.dart' show SinceData;
import '../tasks/task_copy.dart' show stageIcon, stageLabel;
import '../../model/task_progress.dart';
import '../../data/backend.dart';
import '../../l10n/app_localizations.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../convs/conversations_screen.dart' show newChat, pickMute, pickConvSort, sortConversations, whenV2;
import '../nav.dart';
import '../system_bar.dart';
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

class ProductChats extends StatefulWidget {
  const ProductChats({super.key, this.compact = false, this.project});
  final bool compact;
  final String? project;
  @override
  State<ProductChats> createState() => _ProductChatsState();
}

/// The "מחכה לך" chip's filter: only the chats of who asks him something.
const _kNeedsYou = '\u0000needs-you';

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
    final asking = {for (final w in d.needsYou) w.from};
    // Nothing asks him: no chips, the card says so (mockup a-he-empty-phone), and a filter left from before is off.
    final quiet = asking.isEmpty && widget.project == null;
    // Nothing asks him: the "מחכה לך" filter is over, and does not come back by itself with the next ask.
    if (asking.isEmpty && filter == _kNeedsYou) filter = null;
    final chosen = filter;
    final project = widget.project ?? (chosen == _kNeedsYou ? null : chosen);
    final ordered = sortConversations(d, d.conversations, store.convSort).where(
      (c) =>
          d.canChat(c.identityId) &&
          (project == null || d.projectOf(c.identityId) == project) &&
          (chosen != _kNeedsYou || asking.contains(c.identityId)),
    );
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
                // Two icons, as in the mockup (a-he-home-phone): settings and the sort sit behind his account.
                const _AccountMenu(),
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
                if (widget.compact) ...[IBtn('sort', tip: UiCopy.copy.sort, onTap: () => pickConvSort(context)), IBtn('edit_square', tip: l.newChat, onTap: () => newChat(context, d))],
              ],
            ),
          ),
          if (!widget.compact) const OfflineCard(),
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
          if (quiet)
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
          // The project chips stay when nothing asks him (a deviation from a-he-empty: most of the time nothing does,
          // and the phone would lose its project filter); only "מחכה לך" goes.
          if (widget.project == null)
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsetsDirectional.fromSTEB(16, 0, 16, 14),
              child: Row(
                children: [
                  _chip(context, l.all, selected: chosen == null, onTap: () => setState(() => filter = null)),
                  if (!quiet)
                    _chip(
                    context,
                    l.needsYouCount(d.waitingCount),
                    icon: 'front_hand',
                    selected: chosen == _kNeedsYou,
                    onTap: () => setState(() => filter = chosen == _kNeedsYou ? null : _kNeedsYou),
                  ),
                  for (final x in d.activeProjects.where((x) => d.conversations.any((c) => d.projectOf(c.identityId) == x.id)))
                    _chip(context, x.name, selected: chosen == x.id, onTap: () => setState(() => filter = x.id)),
                ],
              ),
            ),
          if (!widget.compact) _SinceHere(d: d),
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
    final who = d.who(c.identityId);
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
                            previewLine(c.text ?? c.lastLine),
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
                    if (chatLine(context, d, store, who.id) case (final icon, final text, final fill))
                      // The icon goes with the line's own direction: a Hebrew activity in the English app starts at the
                      // right, and its icon has to stand next to it, not alone at the left.
                      Directionality(
                        textDirection: paragraphDirection(text),
                        child: Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Ic(icon, size: 16, fill: fill, color: p.text),
                              const SizedBox(width: 4),
                              Expanded(
                                child: ProductContentText(text, maxLines: 2, overflow: TextOverflow.ellipsis, style: T.meta.copyWith(color: p.text)),
                              ),
                            ],
                          ),
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

/// His account at the top of the chats: a menu with the settings and the chats' sort, as WhatsApp keeps them.
class _AccountMenu extends StatelessWidget {
  const _AccountMenu();
  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context), p = context.p;
    Widget item(String icon, String text) => Row(children: [Ic(icon, size: 20, color: p.text2), const SizedBox(width: 12), Text(text, style: T.body.copyWith(color: p.text))]);
    return PopupMenuButton<String>(
      key: const Key('chats-account'),
      tooltip: l.accountMenu,
      color: p.surface,
      // The same 44 as the IBtn beside it, so the top row keeps its height.
      child: SizedBox(width: 44, height: 44, child: Center(child: Ic('account_circle', color: p.text2))),
      onSelected: (v) => v == 'sort' ? pickConvSort(context) : Nav.settings(context),
      itemBuilder: (_) => [
        PopupMenuItem(value: 'settings', child: item('settings', l.settings)),
        PopupMenuItem(value: 'sort', child: item('sort', UiCopy.copy.sortChats)),
      ],
    );
  }
}

/// He answered "לא עכשיו" to something of its, and it still waits.
bool putOff(CompanyData d, String id) => d.waiting.any((w) => w.from == id && w.state == WaitState.notNow && !d.superseded(w));

/// A chat's third line (mockup a-he-home-phone), the first that holds: what he is asked ("מחכה לך", "שאלה אליך"),
/// stuck, the stage of its task ("בבדיקה: …"), what it works on, "הושלם" (#40). Free and resting have none.
(String, String, bool)? chatLine(BuildContext context, CompanyData d, AppStore store, String id) {
  final l = AppLocalizations.of(context);
  final asks = [for (final w in d.needsYou) if (w.from == id) w];
  if (asks.any((w) => w.kind != WaitKind.blockingAsk && w.kind != WaitKind.softAsk)) return ('front_hand', l.needsYou, true);
  if (asks.isNotEmpty) return ('contact_support', l.questionForYou, false);
  final presence = d.presence[id], task = store.taskOf(id);
  final status = presence?.status;
  if (status == null || status == WorkerStatus.free || status == WorkerStatus.resting) return null;
  final title = task == null ? null : plainTitle(task.title);
  // "מחכה לך" comes only from what asks him (above, the chip's source). Stuck says so first; one he put off says
  // "לא עכשיו", unfilled; a presence that says waiting with nothing of its open (the ask went back to the manager) is
  // blocked on someone.
  if (status == WorkerStatus.stuck) {
    // For how long, as in the mockup ("תקועה 40 דקות · …"), when hq says since when.
    final since = presence?.stuckSince;
    if (since == null) return ('warning', title == null ? l.stuck : l.stuckTask(title), false);
    final minutes = CompanyTime.now().difference(since).inMinutes.clamp(1, 1 << 30);
    final duration = minutes < 60 ? l.minutesCount(minutes) : l.hoursCount(minutes ~/ 60);
    return ('warning', [l.stuckFor(d.who(id).gender.name, duration), ?title].join(' · '), false);
  }
  if (putOff(d, id)) return ('front_hand', l.notNow, false);
  if (status == WorkerStatus.waiting) return ('block', title == null ? l.blocked : '${l.blocked} · $title', false);
  // Approval waits on someone, not done: front_hand and check marks are kept for "מחכה לך" and what finished.
  if (task != null && task.stage != TaskStage.development) return (task.stage == TaskStage.approval ? 'hourglass_top' : stageIcon(task.stage!), l.stageTask(stageLabel(l, task.stage!), title!), false);
  final now = title ?? presence?.currentTask ?? presence?.activity;
  if (status == WorkerStatus.working && now != null && now.trim().isNotEmpty) return ('play_arrow', plainTitle(now), false);
  return (statusIcon(status), [productStatus(context, status), if (now?.trim().isNotEmpty == true) plainTitle(now!)].join(' · '), false);
}

/// "מאז שהיית פה" (notifications-policy): what finished since he last left the chats, one folded line.
class _SinceHere extends StatelessWidget {
  const _SinceHere({required this.d});
  final CompanyData d;
  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context), p = context.p;
    final now = CompanyTime.now();
    final data = SinceData.of(d, since: store.chatsSeenAt ?? dayStart(now));
    if (data.items.isEmpty) return const SizedBox.shrink();
    return Container(
      decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
      child: SinceBlock(data: data, now: now, max: 3),
    );
  }
}
