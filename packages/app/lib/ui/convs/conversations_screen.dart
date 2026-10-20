// Conversations (APP-SPEC §4.3, mockup screen 2): WhatsApp-like list, one name per worker,
// Yoav pinned first, status as icon + word, open code changes as +N −M.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import '../system_bar.dart';
import 'head.dart';
import 'home_blocks.dart';
import 'kbd.dart';

export 'head.dart';
export 'home_blocks.dart';
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
  bool searching = false;
  String q = '';

  // Android back closes the search before it leaves the tab (Shell asks NavScope for this).
  void _openSearch() {
    setState(() => searching = true);
    NavScope.read(context).setBackHandler(_closeSearch);
  }

  AppNav? _nav;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _nav = NavScope.read(context);
  }

  @override
  void dispose() {
    final nav = _nav;
    if (nav != null && nav.backHandler == _closeSearch) nav.backHandler = null;
    super.dispose();
  }

  void _closeSearch() {
    setState(() {
      searching = false;
      q = '';
    });
    NavScope.read(context).setBackHandler(null);
  }

  bool _match(CompanyData d, ConversationSummary c) {
    if (q.isEmpty) return true;
    final who = d.who(c.identityId);
    return '${who.name} ${who.title} ${d.teamOf(c.identityId)?.name ?? ''} ${c.lastLine} ${d.isDone(c.identityId) ? d.presence[c.identityId]?.activity ?? '' : ''}'.contains(q);
  }

  @override
  Widget build(BuildContext context) {
    assert(() {
      ConversationsScreen.debugBuilds++;
      return true;
    }());
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final ordered = sortConversations(d, d.conversations, store.convSort).where((c) => _match(d, c));
    // Finished task workers go below every live conversation, whatever order the list came in (#40):
    // the order above is the data's, and this split is the last step, so any sort keeps them at the end.
    final all = [...ordered.where((c) => !d.isDone(c.identityId)), ...ordered.where((c) => d.isDone(c.identityId))];
    // Of those, the read ones fold (APP-SPEC §4.3); a search shows everything.
    // Not folded: unread, the selected one, or anything in the desktop sidebar (no room for a toggle).
    bool closed(ConversationSummary c) => d.isDone(c.identityId) && c.unread == 0 && c.identityId != store.selectedConversation;
    final fold = q.isEmpty && !widget.compact;
    final list = fold ? all.where((c) => !closed(c)).toList() : all;
    final done = fold ? all.where(closed).toList() : const <ConversationSummary>[];

    if (widget.compact) {
      return Container(
        color: p.surface,
        child: Column(children: [
          TopBar(title: 'שיחות', actions: [IBtn('sort', tip: 'מיון', onTap: () => pickConvSort(context))]),
          _QuickSwitch(onChanged: (v) => setState(() => q = v)),
          Expanded(
            child: ListView(padding: EdgeInsets.zero, children: [
              for (final (i, c) in list.indexed) ...[
                if (i > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 62), child: Container(height: 1, color: p.line)),
                ConversationRow(c: c, compact: true, selected: store.currentConversation == c.identityId),
              ],
            ]),
          ),
        ]),
      );
    }

    return Stack(children: [
      Column(children: [
        searching
            ? SizedBox(
                height: 56,
                child: Row(children: [
                  IBtn('arrow_forward', tip: 'סגירת החיפוש', onTap: _closeSearch),
                  Expanded(
                    child: TextField(
                      autofocus: true,
                      onChanged: (v) => setState(() => q = v),
                      style: T.body.copyWith(color: p.text),
                      decoration: InputDecoration(border: InputBorder.none, hintText: 'חיפוש לפי שם, תואר, צוות או תוכן', hintStyle: T.body.copyWith(color: p.text3)),
                    ),
                  ),
                ]),
              )
            : TopBar(title: 'שיחות', showLink: true, actions: [
                IBtn('search', tip: 'חיפוש', onTap: _openSearch),
              ]),
        const SystemBar(),
        Expanded(child: q.isNotEmpty ? _searchList(d, list, done) : _mainList(context, d, store)),
      ]),
      PositionedDirectional(
        end: 16,
        bottom: 16,
        child: Fab(icon: 'edit_square', label: 'שיחה חדשה', onTap: () => _newChat(context, d)),
      ),
    ]);
  }

  /// A search shows every conversation that matches, task workers too.
  Widget _searchList(CompanyData d, List<ConversationSummary> list, List<ConversationSummary> done) => ListView(padding: EdgeInsets.zero, children: [
        ListBlock(top: false, children: [for (final c in [...list, ...done]) ConversationRow(c: c)]),
        const SizedBox(height: 80),
      ]);

  /// The main screen: the card of what needs him (head.dart), Yoav pinned, then one list by latest; who
  /// works now is marked in his own row. Task workers live in their project's screen; one with an unread
  /// message still shows here, so nothing he hasn't read hides behind a count.
  Widget _mainList(BuildContext context, CompanyData d, AppStore store) {
    final shown = [for (final c in d.conversations) if (!d.who(c.identityId).temp || c.unread > 0) c];
    final yoav = shown.where((c) => c.identityId == d.managerId).firstOrNull;
    final working = nowWorking(d);
    final others = [
      for (final c in shown)
        if (c.identityId != d.managerId && (working.containsKey(c.identityId) || c.lastLine.isNotEmpty || c.unread > 0)) c,
    ];
    // A finished task worker with unread lines goes below every live conversation (#40).
    final rest = [...others.where((c) => !d.isDone(c.identityId)), ...others.where((c) => d.isDone(c.identityId))];
    ConversationSummary conv(String id) => d.conversations.where((c) => c.identityId == id).firstOrNull ?? ConversationSummary(identityId: id, lastLine: '', time: '');
    final now = CompanyTime.now();
    final since = store.chatsSeenAt ?? dayStart(now);
    final head = HeadData.of(d, since: since);
    final listed = {for (final c in rest) c.identityId};
    final rows = <Widget>[
      if (yoav != null) ConversationRow(c: yoav, pinned: true, quiet: true),
      for (final id in working.keys)
        if (!listed.contains(id)) WorkingRow(c: conv(id), lines: working[id]!),
      for (final c in rest) working.containsKey(c.identityId) ? WorkingRow(c: c, lines: working[c.identityId]!) : ConversationRow(c: c, quiet: true),
    ];
    return ListView(padding: EdgeInsets.zero, children: [
      // hq's recipe when it has one (home_blocks.dart); an older hq: the card alone, as before.
      if (d.home case final recipe?) HomeBlocks(recipe: recipe, data: d, now: now, since: since) else ChatsHead(data: head, since: since, now: now),
      if (rows.isNotEmpty) ListBlock(top: false, children: rows),
      const SizedBox(height: 80),
    ]);
  }

  void _newChat(BuildContext context, CompanyData d) {
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
      color: p.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: BorderSide(color: p.line)),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onTap ?? () {},
        child: SizedBox(
          height: 52,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Ic(icon, size: 22, color: p.text),
              const SizedBox(width: 8),
              Text(label, style: TextStyle(fontFamily: kFont, fontSize: 14.5, fontWeight: FontWeight.w500, color: p.text)),
            ]),
          ),
        ),
      ),
    ),
    );
  }
}

class ConversationRow extends StatelessWidget {
  const ConversationRow({super.key, required this.c, this.compact = false, this.selected = false, this.pinned = false, this.quiet = false});
  final ConversationSummary c;
  final bool compact;
  final bool selected;

  /// Pinned at the top of the main screen (Yoav): a pin before the time, as in WhatsApp.
  final bool pinned;

  /// Two lines, as in WhatsApp (the main screen, #53): the status line only when it needs him
  /// (מחכה לך, חסום, תקוע). "פנוי" and "נח" under every name said nothing.
  final bool quiet;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data!;
    final p = context.p;
    final who = d.who(c.identityId);
    final pr = d.presence[c.identityId] ?? const Presence(status: WorkerStatus.free);
    final title = d.roleLine(c.identityId, short: compact);
    // A finished task worker: the task it did is the second line, under "הושלם" (#40).
    final done = d.isDone(c.identityId);
    final task = done ? pr.activity : null;
    final statusLine = Row(children: [
      Flexible(child: StatusWord.of(pr, who.gender, withActivity: pr.status == WorkerStatus.working && !compact)),
      if (c.diffStat != null) ...[const SizedBox(width: 6), DiffStat(c.diffStat!)],
      if (c.extra != null && !compact) ...[const SizedBox(width: 6), Text(c.extra!, style: T.small.copyWith(color: p.text2))],
    ]);
    final draft = (d.chats[c.identityId]?.draft ?? '').trim();
    final unread = c.unread > 0;
    final pill = unread ? UnreadPill(c.unread, muted: c.muted) : null;
    // The pill sits at the end of the last line, as in WhatsApp; rows without one carry it on the status line.
    final lineShown = !compact && (task == null || task.isEmpty) && draft.isEmpty && c.lastLine.isNotEmpty;
    final status = Row(children: [
      Expanded(child: statusLine),
      if (pill != null && !lineShown) ...[const SizedBox(width: 6), pill],
    ]);
    return Semantics(
      button: true,
      label: [
        who.name, title, statusWord(pr.status, who.gender),
        if (unread) c.unread == 1 ? 'הודעה אחת שלא נקראה' : '${c.unread} הודעות שלא נקראו',
        if (c.muted) 'מושתקת',
      ].join(', '),
      child: Material(
        color: selected ? p.surface2 : p.surface,
        child: InkWell(
          onTap: () => Nav.chat(context, c.identityId),
          onLongPress: () => pickMute(context, c.identityId),
          child: Padding(
            padding: compact ? const EdgeInsets.symmetric(horizontal: 14, vertical: 10) : const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Monogram.of(d, c.identityId, size: compact ? AvSize.sm : AvSize.md),
              SizedBox(width: compact ? 12 : 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Text(who.name, style: T.name.copyWith(color: p.text)),
                    if (c.muted) ...[const SizedBox(width: 4), Ic('notifications_off', size: 16, color: p.text3, semantic: 'מושתקת')],
                    const SizedBox(width: 6),
                    Expanded(child: Rich(title, maxLines: 1, style: T.secondary.copyWith(color: p.text2))),
                    const SizedBox(width: 6),
                    if (pinned) ...[Ic('push_pin', size: 15, color: p.text3, semantic: 'מוצמד'), const SizedBox(width: 4)],
                    Text(c.time, style: T.meta.copyWith(color: unread && !c.muted ? p.text : p.text3, fontWeight: unread && !c.muted ? FontWeight.w700 : null)),
                  ]),
                  // A draft left in the chat shows instead of the last line, as in WhatsApp.
                  if (!compact && task != null && task.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Rich(task, auto: true, maxLines: 1, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text2)),
                    )
                  else if (!compact && draft.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text.rich(
                        TextSpan(children: [
                          TextSpan(text: 'טיוטה: ', style: TextStyle(color: p.accent, fontWeight: FontWeight.w700)),
                          // Isolated, so an English draft keeps its own punctuation where it belongs.
                          const TextSpan(text: kFSI),
                          ...Rich.spans(context, draft.split('\n').first, TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text2), links: false),
                          const TextSpan(text: kPDI),
                        ]),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text2),
                      ),
                    )
                  else if (!compact && c.lastLine.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Row(children: [
                        Expanded(
                          child: Rich(c.lastLine,
                              auto: true,
                              maxLines: 1,
                              // Unread: the line stands out, the way WhatsApp makes the row bold.
                              style: TextStyle(
                                  fontFamily: kFont,
                                  fontSize: 14.5,
                                  height: 1.45,
                                  fontWeight: unread ? FontWeight.w500 : null,
                                  color: c.lastIsMine || unread ? p.text : p.text2)),
                        ),
                        if (pill != null) ...[const SizedBox(width: 8), pill],
                      ]),
                    ),
                  if (!quiet || statusLoud(pr.status) || (pill != null && !lineShown)) Padding(padding: const EdgeInsets.only(top: 4), child: status),
                ]),
              ),
            ]),
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

/// Who is in the middle of a task, and what (#53): a standing worker with a task in hand, and each project
/// lead whose task workers are running, with their tasks (most work runs on task workers, who are not on
/// this screen; without this the section was empty most of the day).
Map<String, List<String>> nowWorking(CompanyData d) {
  final out = <String, List<String>>{};
  for (final who in d.identities.values) {
    if (who.temp || who.id == d.managerId) continue;
    final pr = d.presence[who.id];
    if (pr == null || pr.status == WorkerStatus.resting || pr.status == WorkerStatus.done || pr.status == WorkerStatus.free) continue;
    final task = pr.currentTask ?? pr.activity;
    if (task != null && task.isNotEmpty) out[who.id] = [plainTitle(task)];
  }
  // A task worker's task goes under its project's lead; a task without a project (an errand for the
  // personal team, monitoring, improvement) under whoever opened it.
  final leadOf = {for (final proj in d.projects) proj.id: d.teams[proj.teamId]?.leadId};
  for (final t in d.tickets) {
    final id = t.assigneeId;
    if (t.group == TicketGroup.queued || t.doneAt != null || id == null || !d.who(id).temp) continue;
    var lead = leadOf[t.project];
    if (lead == null) {
      final opener = t.openedBy == null ? null : d.identities[t.openedBy];
      if (opener != null && !opener.temp) lead = opener.id;
    }
    if (lead == null) continue;
    out[lead] = [...?out[lead], '${t.assignee}: ${plainTitle(t.title)}'];
  }
  return out;
}

/// A conversation under "עכשיו בעבודה": the name and team, then the task with `play_arrow`.
class WorkingRow extends StatelessWidget {
  const WorkingRow({super.key, required this.c, required this.lines});
  final ConversationSummary c;
  final List<String> lines;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final who = d.who(c.identityId);
    final unread = c.unread > 0;
    return Material(
      color: p.surface,
      child: InkWell(
        onTap: () => Nav.chat(context, c.identityId),
        onLongPress: () => pickMute(context, c.identityId),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Monogram.of(d, c.identityId),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                  Text(who.name, style: T.name.copyWith(color: p.text)),
                  if (c.muted) ...[const SizedBox(width: 4), Ic('notifications_off', size: 16, color: p.text3, semantic: 'מושתקת')],
                  const SizedBox(width: 6),
                  Expanded(child: Rich(d.roleLine(c.identityId), maxLines: 1, style: T.secondary.copyWith(color: p.text2))),
                  const SizedBox(width: 6),
                  Text(c.time, style: T.meta.copyWith(color: unread && !c.muted ? p.text : p.text3, fontWeight: unread && !c.muted ? FontWeight.w700 : null)),
                ]),
                for (final (i, l) in lines.take(3).indexed)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Row(children: [
                      Ic('play_arrow', size: 18, fill: true, color: p.text),
                      const SizedBox(width: 4),
                      Expanded(child: Rich(l, auto: true, maxLines: 1, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text))),
                      if (i == 0 && unread) ...[const SizedBox(width: 8), UnreadPill(c.unread, muted: c.muted)],
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
