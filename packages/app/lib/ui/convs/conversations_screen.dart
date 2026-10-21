// Conversations (APP-SPEC §4.3, mockup screen 2): WhatsApp-like list, one name per worker,
// Yoav pinned first, status as icon + word, open code changes as +N −M.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'convs_v2.dart';
import 'home_v2.dart';
import 'kbd.dart';

export 'convs_v2.dart';
export 'head.dart';
export 'home_blocks.dart';
export 'home_v2.dart';
export 'kbd.dart';

class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key, this.compact = false});

  /// Desktop list column (mockup screen 10): smaller rows, quick-switch field.
  final bool compact;

  /// Builds since the last reset, counted in debug and test builds only (test/perf_bench_test.dart).
  static int debugBuilds = 0;

  @override
  State<ConversationsScreen> createState() => _ConversationsScreenState();
}

class _ConversationsScreenState extends State<ConversationsScreen> {
  String q = '';

  bool _match(CompanyData d, ConversationSummary c) {
    if (q.isEmpty) return true;
    final who = d.who(c.identityId);
    return '${who.name} ${who.title} ${d.teamOf(c.identityId)?.name ?? ''} ${c.lastLine} ${d.isDone(c.identityId) ? d.presence[c.identityId]?.activity ?? '' : ''}'.contains(q);
  }

  @override
  Widget build(BuildContext context) {
    // The phone: one list by latest activity, the home its first item (convs_v2.dart, task 205).
    if (!widget.compact) return const ConversationsV2();
    assert(() {
      ConversationsScreen.debugBuilds++;
      return true;
    }());
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final now = CompanyTime.now();
    final ordered = sortConversations(d, d.conversations, store.convSort).where((c) => _match(d, c));
    // Finished task workers go below every live conversation, whatever order the list came in (#40):
    // the order above is the data's, and this split is the last step, so any sort keeps them at the end.
    final list = [...ordered.where((c) => !d.isDone(c.identityId)), ...ordered.where((c) => d.isDone(c.identityId))];
    return Container(
      color: p.surface,
      child: Column(children: [
        TopBar(title: 'שיחות', actions: [IBtn('sort', tip: 'מיון', onTap: () => pickConvSort(context))]),
        _QuickSwitch(onChanged: (v) => setState(() => q = v)),
        Expanded(
          child: ListView(padding: EdgeInsets.zero, children: [
            // The home is the first row; it opens in the main column (desktop.dart).
            if (q.isEmpty) ...[HomeEntryRow(selected: store.homeOpen), Container(height: 1, color: p.line)],
            for (final (i, c) in list.indexed) ...[
              if (i > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 72), child: Container(height: 1, color: p.line)),
              // The phone's row (convs_v2.dart): the same two lines, the same ticks, the same spacing.
              ConversationRowV2(c: c, now: now, pinned: c.identityId == d.managerId, selected: !store.homeOpen && store.currentConversation == c.identityId),
            ],
          ]),
        ),
      ]),
    );
  }
}

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
          Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 10), child: Text('עובד או צוות. בצוות, ההודעה הולכת לראש הצוות.', style: T.small.copyWith(color: p.text2))),
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

const kConvSortLabels = {
  ConvSort.recent: 'אחרון',
  ConvSort.working: 'עובדים עכשיו למעלה',
  ConvSort.waiting: 'מחכה לך למעלה',
  ConvSort.name: 'לפי שם',
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
          child: Text(muted ? 'השיחה עם $name מושתקת' : 'השתקת ההתראות מ$name', style: T.name.copyWith(color: p.text)),
        ),
        if (!muted)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text('ההודעות ממשיכות להגיע לשיחה, בלי התראה.', style: T.small.copyWith(color: p.text2)),
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
        Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 8), child: Text('מיון השיחות', style: T.name.copyWith(color: p.text))),
        for (final s in ConvSort.values)
          ListTile(
            title: Text(kConvSortLabels[s]!, style: T.body.copyWith(color: p.text)),
            trailing: s == store.convSort ? Ic('check', color: p.text, semantic: 'נבחר') : null,
            onTap: () {
              Navigator.pop(ctx);
              store.setConvSort(s);
            },
          ),
      ]),
    ),
  );
}

class _QuickSwitch extends StatelessWidget {
  const _QuickSwitch({required this.onChanged});
  final ValueChanged<String> onChanged;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      height: 38,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(color: p.surface2, borderRadius: BorderRadius.circular(19)),
      child: Row(children: [
        Ic('search', size: 20, color: p.text3),
        const SizedBox(width: 8),
        Expanded(
          child: TextField(
            onChanged: onChanged,
            style: T.secondary.copyWith(color: p.text, fontSize: 14),
            decoration: InputDecoration(isCollapsed: true, border: InputBorder.none, hintText: 'מעבר מהיר', hintStyle: T.secondary.copyWith(color: p.text3, fontSize: 14)),
          ),
        ),
        const Kbd('Ctrl K'),
      ]),
    );
  }
}

/// `.fab`: extended, quiet surface button (not a coloured blob).
class Fab extends StatelessWidget {
  const Fab({super.key, required this.icon, required this.label, this.onTap});
  final String icon;
  final String label;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(16), boxShadow: const [BoxShadow(color: Color(0x1A000000), offset: Offset(0, 1), blurRadius: 3)]),
      child: Material(
      // The one primary action carries the brand (M3 FAB on primary container, language-v2 §2).
      color: p.accentSoft,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap ?? () {},
        child: SizedBox(
          height: 52,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Ic(icon, size: 22, color: p.dark ? p.text : p.accent),
              const SizedBox(width: 8),
              Text(label, style: TextStyle(fontFamily: kFont, fontSize: 14.5, fontWeight: FontWeight.w700, color: p.text)),
            ]),
          ),
        ),
      ),
    ),
    );
  }
}

/// The unread count on a row: dark on light like the count on "בית"; a muted conversation's is quieter.
class UnreadPill extends StatelessWidget {
  const UnreadPill(this.count, {super.key, this.muted = false});
  final int count;
  final bool muted;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return ExcludeSemantics(
      child: Container(
        constraints: const BoxConstraints(minWidth: 20),
        height: 20,
        padding: const EdgeInsets.symmetric(horizontal: 6),
        decoration: BoxDecoration(color: muted ? p.surface2 : p.text, borderRadius: BorderRadius.circular(10)),
        alignment: Alignment.center,
        child: Text(count > 99 ? '99+' : '$count',
            style: TextStyle(fontFamily: kFont, fontSize: 11.5, height: 1, fontWeight: FontWeight.w700, color: muted ? p.text2 : p.surface)),
      ),
    );
  }
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
