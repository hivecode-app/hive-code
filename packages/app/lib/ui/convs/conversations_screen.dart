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
import 'kbd.dart';

export 'kbd.dart';

class ConversationsScreen extends StatefulWidget {
  const ConversationsScreen({super.key, this.compact = false});

  /// Desktop list column (mockup screen 10): smaller rows, quick-switch field.
  final bool compact;

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
  bool showClosed = false;

  bool _match(CompanyData d, ConversationSummary c) {
    if (q.isEmpty) return true;
    final who = d.who(c.identityId);
    return '${who.name} ${who.title} ${d.teamOf(c.identityId)?.name ?? ''} ${c.lastLine} ${d.isDone(c.identityId) ? d.presence[c.identityId]?.activity ?? '' : ''}'.contains(q);
  }

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final ordered = [
      ...d.conversations.where((c) => c.pinned),
      ...d.conversations.where((c) => !c.pinned),
    ].where((c) => _match(d, c));
    // Finished task workers go below every live conversation, whatever order the list came in (#40):
    // the order above is the data's, and this split is the last step, so any sort keeps them at the end.
    final all = [...ordered.where((c) => !d.isDone(c.identityId)), ...ordered.where((c) => d.isDone(c.identityId))];
    // Of those, the read ones fold (APP-SPEC §4.3); a search shows everything.
    // Not folded: unread, the selected one, or anything in the desktop sidebar (no room for a toggle).
    bool closed(ConversationSummary c) => d.isDone(c.identityId) && c.unread == 0 && c.identityId != store.selectedConversation;
    final fold = q.isEmpty && !widget.compact;
    final list = fold ? all.where((c) => !closed(c)).toList() : all;
    final done = fold ? all.where(closed).toList() : const <ConversationSummary>[];
    final doneTeams = {for (final c in done) d.who(c.identityId).teamId}.length;

    if (widget.compact) {
      return Container(
        color: p.surface,
        child: Column(children: [
          const TopBar(title: 'שיחות'),
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
                IBtn('more_vert', tip: 'עוד', onTap: () => Nav.settings(context)),
              ]),
        const SystemBar(),
        Expanded(
          child: ListView(padding: EdgeInsets.zero, children: [
            ListBlock(top: false, children: [for (final c in list) ConversationRow(c: c)]),
            if (done.isNotEmpty) ...[
              MoreRow(
                icon: showClosed ? 'expand_less' : 'history',
                bold: '',
                rest: 'נסגרו · ${doneTeams == 1 ? 'צוות משימה אחד' : '$doneTeams צוותי משימה'}',
                onTap: () => setState(() => showClosed = !showClosed),
              ),
              if (showClosed) ListBlock(top: false, children: [for (final c in done) ConversationRow(c: c)]),
            ],
            const SizedBox(height: 80),
          ]),
        ),
      ]),
      PositionedDirectional(
        end: 16,
        bottom: 16,
        child: Fab(icon: 'edit_square', label: 'שיחה חדשה', onTap: () => _newChat(context, d)),
      ),
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
  const ConversationRow({super.key, required this.c, this.compact = false, this.selected = false});
  final ConversationSummary c;
  final bool compact;
  final bool selected;

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
    final status = Row(children: [
      Flexible(child: StatusWord.of(pr, who.gender, withActivity: pr.status == WorkerStatus.working && !compact)),
      if (c.diffStat != null) ...[const SizedBox(width: 6), DiffStat(c.diffStat!)],
      if (c.extra != null && !compact) ...[const SizedBox(width: 6), Text(c.extra!, style: T.small.copyWith(color: p.text2))],
    ]);
    final draft = (d.chats[c.identityId]?.draft ?? '').trim();
    return Semantics(
      button: true,
      label: '${who.name}, $title, ${statusWord(pr.status, who.gender)}',
      child: Material(
        color: selected ? p.surface2 : p.surface,
        child: InkWell(
          onTap: () => Nav.chat(context, c.identityId),
          child: Padding(
            padding: compact ? const EdgeInsets.symmetric(horizontal: 14, vertical: 10) : const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Monogram.of(d, c.identityId, size: compact ? AvSize.sm : AvSize.md),
              SizedBox(width: compact ? 12 : 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                    Text(who.name, style: T.name.copyWith(color: p.text)),
                    const SizedBox(width: 6),
                    Expanded(child: Rich(title, maxLines: 1, style: T.secondary.copyWith(color: p.text2))),
                    const SizedBox(width: 6),
                    Text(c.time, style: T.meta.copyWith(color: p.text3)),
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
                              style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: c.lastIsMine ? p.text : p.text2)),
                        ),
                      ]),
                    ),
                  Padding(padding: const EdgeInsets.only(top: 4), child: status),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
