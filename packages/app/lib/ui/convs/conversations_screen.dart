import 'package:agent_company/l10n/ui_copy.dart';
// The conversation list's actions that outlived the old list screen: a new chat, its order, muting, and the open
// tasks under whoever opened them. The list itself is product/chats.dart.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';

export 'convs_v2.dart';
export 'head.dart';
export 'home_blocks.dart';
export 'home_v2.dart';
export 'kbd.dart';

/// "שיחה חדשה": every worker and team, as a sheet.
void newChat(BuildContext context, CompanyData d) {
    final p = context.p;
    showModalBottomSheet(
      context: context,
      backgroundColor: p.bg,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        builder: (_, sc) => ListView(controller: sc, children: [
          Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 10), child: Text(UiCopy.text(473), style: T.small.copyWith(color: p.text2))),
          ListBlock(children: [
            for (final who in d.identities.values)
              InkWell(
                onTap: () {
                  Navigator.pop(ctx);
                  Nav.chat(context, who.id, focus: true);
                },
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Row(children: [
                    Monogram.of(d, who.id, size: AvSize.sm),
                    const SizedBox(width: 12),
                    Text(who.name, style: T.name.copyWith(color: p.text)),
                    const SizedBox(width: 6),
                    Expanded(child: Text(d.roleLine(who.id), style: T.secondary.copyWith(color: p.text2), maxLines: 1, overflow: TextOverflow.ellipsis)),
                  ]),
                ),
              ),
          ]),
        ]),
      ),
    );
}

/// The list's order: pinned first, then by [sort]; ties keep the data's order (newest message first).
/// Finished task workers still go last, after this (the split in the list widget).
List<ConversationSummary> sortConversations(CompanyData d, List<ConversationSummary> convs, ConvSort sort) {
  final at = {for (final (i, c) in convs.indexed) c.identityId: i};
  WorkerStatus st(ConversationSummary c) => d.presence[c.identityId]?.status ?? WorkerStatus.free;
  int key(ConversationSummary c) => switch (sort) {
        ConvSort.working => st(c) == WorkerStatus.working ? 0 : 1,
        ConvSort.waiting => st(c) == WorkerStatus.waiting ? 0 : 1,
        _ => 0,
      };
  int cmp(ConversationSummary a, ConversationSummary b) {
    if (a.pinned != b.pinned) return a.pinned ? -1 : 1;
    var r = key(a).compareTo(key(b));
    if (r == 0 && sort == ConvSort.name) r = d.who(a.identityId).name.compareTo(d.who(b.identityId).name);
    return r != 0 ? r : at[a.identityId]!.compareTo(at[b.identityId]!);
  }

  return [...convs]..sort(cmp);
}

Map<ConvSort, String> get kConvSortLabels => {
  ConvSort.recent: UiCopy.text(474),
  ConvSort.working: UiCopy.text(475),
  ConvSort.waiting: UiCopy.text(476),
  ConvSort.name: UiCopy.text(477),
};

/// "השתקה" (8 hours, a week, always) or its undo, from a long press on the row or the chat menu.
/// Muted: no notification, and its count stays out of the total (as in WhatsApp).
void pickMute(BuildContext context, String identityId) {
  final store = StoreScope.read(context);
  final p = context.p;
  final muted = store.data?.conversation(identityId)?.muted ?? false;
  final name = store.nameOf(identityId);
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: p.surface,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text(muted ? UiCopy.text(478, [name]) : UiCopy.text(479, [name]), style: T.name.copyWith(color: p.text)),
        ),
        if (!muted)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(UiCopy.text(480), style: T.small.copyWith(color: p.text2)),
          ),
        for (final f in muted ? const [MuteFor.off] : const [MuteFor.hours8, MuteFor.week, MuteFor.always])
          ListTile(
            leading: Ic(f == MuteFor.off ? 'notifications' : 'notifications_off', color: p.text2),
            title: Text(f.label, style: T.body.copyWith(color: p.text)),
            onTap: () {
              Navigator.pop(ctx);
              store.mute(identityId, f);
            },
          ),
      ]),
    ),
  );
}

/// The sort choice, as a sheet: the current one is marked with a check, not a colour.
void pickConvSort(BuildContext context) {
  final store = StoreScope.read(context);
  final p = context.p;
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: p.surface,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text(UiCopy.text(481), style: T.name.copyWith(color: p.text))),
        for (final s in ConvSort.values)
          ListTile(
            title: Text(kConvSortLabels[s]!, style: T.body.copyWith(color: p.text)),
            trailing: s == store.convSort ? Ic('check', color: p.text, semantic: UiCopy.text(482)) : null,
            onTap: () {
              Navigator.pop(ctx);
              store.setConvSort(s);
            },
          ),
      ]),
    ),
  );
}

/// "מה פתוח אצלי" (#128): the open tasks under each one who opened them (a lead, Yoav, a standing worker), queued
/// ones too. A task worker that opened one is not a conversation here: its tasks go under its own opener's row.
Map<String, List<OpenTask>> openedTasks(CompanyData d) {
  // A task worker's own opener: whoever opened the task it is on (open tasks first, then finished ones).
  final openerOf = <String, String?>{
    for (final t in d.tickets) if (t.assigneeId != null) t.assigneeId!: t.openedBy,
    for (final t in d.openTasks) if (t.worker != null) t.worker!: t.openedBy,
  };
  String? owner(String? id) {
    for (var hops = 0; id != null && hops < 5; hops++) {
      if (!d.identities.containsKey(id)) return null;
      if (!d.who(id).temp) return id;
      id = openerOf[id];
    }
    return null;
  }

  final out = <String, List<OpenTask>>{};
  for (final t in d.openTasks) {
    final id = owner(t.openedBy);
    if (id != null) (out[id] ??= []).add(t);
  }
  return out;
}
