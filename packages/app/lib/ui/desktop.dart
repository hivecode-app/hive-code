// Desktop (APP-SPEC §8, mockup screen 10): rail 72 · list 300 · main · context 330 (from 1280px),
// a hint bar of shortcuts, and the keyboard map of §8.2 on physical keys (works with a Hebrew layout).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/store.dart';
import '../model/models.dart';
import '../theme/tokens.dart';
import 'board/board_screen.dart';
import 'board/ticket_screen.dart';
import 'chat/chat_screen.dart';
import 'common.dart';
import 'convs/conversations_screen.dart';
import 'home/home_screen.dart';
import 'nav.dart';
import 'org/org_screen.dart';
import 'shell.dart';

class DesktopFrame extends StatefulWidget {
  const DesktopFrame({super.key, required this.width});
  final double width;
  @override
  State<DesktopFrame> createState() => _DesktopFrameState();
}

class _DesktopFrameState extends State<DesktopFrame> {
  final focus = FocusNode(debugLabel: 'desktop-shortcuts');
  bool gPrefix = false;
  bool peekWaiting = false;

  @override
  void dispose() {
    focus.dispose();
    super.dispose();
  }

  bool get _typing {
    final f = FocusManager.instance.primaryFocus;
    return f != null && f != focus && f.context?.findAncestorWidgetOfExactType<EditableText>() != null;
  }

  KeyEventResult _onKey(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent) return KeyEventResult.ignored;
    final nav = NavScope.read(context);
    final store = StoreScope.read(context);
    final k = e.physicalKey;
    final ctrl = HardwareKeyboard.instance.isControlPressed || HardwareKeyboard.instance.isMetaPressed;
    if (ctrl && k == PhysicalKeyboardKey.keyK) {
      _quickSwitch();
      return KeyEventResult.handled;
    }
    if (ctrl && k == PhysicalKeyboardKey.period) {
      final id = store.selectedConversation;
      if (id != null) store.stop(id);
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.escape) {
      FocusManager.instance.primaryFocus?.unfocus();
      focus.requestFocus();
      setState(() => peekWaiting = false);
      return KeyEventResult.handled;
    }
    // Single-letter shortcuts are off while a text field has focus (§8.2).
    if (_typing || ctrl) return KeyEventResult.ignored;
    if (gPrefix) {
      gPrefix = false;
      final t = {
        PhysicalKeyboardKey.keyH: AppTab.home,
        PhysicalKeyboardKey.keyC: AppTab.convs,
        PhysicalKeyboardKey.keyB: AppTab.board,
        PhysicalKeyboardKey.keyO: AppTab.org,
      }[k];
      if (t != null) nav.go(t);
      if (k == PhysicalKeyboardKey.keyI) setState(() => peekWaiting = !peekWaiting);
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.keyG) {
      gPrefix = true;
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.keyJ || k == PhysicalKeyboardKey.keyK) {
      final list = store.data?.conversations.map((c) => c.identityId).toList() ?? [];
      final i = list.indexOf(store.selectedConversation ?? '');
      final n = (i + (k == PhysicalKeyboardKey.keyJ ? 1 : -1)).clamp(0, list.length - 1);
      if (list.isNotEmpty) {
        store.selectedConversation = list[n];
        store.touch();
      }
      return KeyEventResult.handled;
    }
    // 1-4: pick an option of the open question in the current conversation.
    const digits = [PhysicalKeyboardKey.digit1, PhysicalKeyboardKey.digit2, PhysicalKeyboardKey.digit3, PhysicalKeyboardKey.digit4];
    final di = digits.indexOf(k);
    if (di >= 0) {
      final chat = store.data?.chats[store.selectedConversation];
      final ask = chat?.items.whereType<AskCard>().where((a) => a.state == AskState.open && a is! GoCard).lastOrNull;
      final opts = ask?.options.where((o) => o.id != 'q').toList() ?? [];
      if (ask != null && di < opts.length) store.answerCard(ask, opts[di]);
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.slash && HardwareKeyboard.instance.isShiftPressed) {
      _help();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  void _quickSwitch() {
    final store = StoreScope.read(context);
    final d = store.data;
    if (d == null) return;
    final p = context.p;
    showDialog(
      context: context,
      builder: (ctx) {
        var q = '';
        return StatefulBuilder(builder: (ctx, set) {
          final ids = d.identities.values.where((w) => q.isEmpty || '${w.name} ${w.title}'.contains(q)).toList();
          return Dialog(
            backgroundColor: p.surface,
            alignment: const Alignment(0, -0.5),
            child: SizedBox(
              width: 460,
              height: 420,
              child: Column(children: [
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: TextField(
                    autofocus: true,
                    onChanged: (v) => set(() => q = v),
                    onSubmitted: (_) {
                      if (ids.isEmpty) return;
                      Navigator.pop(ctx);
                      Nav.chat(context, ids.first.id);
                    },
                    style: T.body.copyWith(color: p.text),
                    decoration: InputDecoration(hintText: 'מעבר מהיר: עובד, שיחה או טיקט', hintStyle: T.body.copyWith(color: p.text3), border: InputBorder.none),
                  ),
                ),
                Divider(height: 1, color: p.line),
                Expanded(
                  child: ListView(children: [
                    for (final w in ids)
                      ListTile(
                        leading: Monogram.of(d, w.id, size: AvSize.sm),
                        title: Text('${w.name} · ${w.title}', style: T.row2.copyWith(color: p.text)),
                        onTap: () {
                          Navigator.pop(ctx);
                          Nav.chat(context, w.id);
                        },
                      ),
                  ]),
                ),
              ]),
            ),
          );
        });
      },
    );
  }

  void _help() {
    final p = context.p;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: p.surface,
        title: Text('קיצורי מקלדת', style: T.name.copyWith(color: p.text)),
        content: SizedBox(
          width: 420,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final (k, v) in kShortcuts)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(children: [SizedBox(width: 150, child: Kbd(k)), Expanded(child: Text(v, style: T.row2.copyWith(color: p.text)))]),
              ),
          ]),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: Text('סגירה', style: T.button.copyWith(color: p.accent)))],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final nav = NavScope.of(context);
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    final ctxCol = widget.width >= 1280;
    final selected = store.selectedConversation ?? 'ido';

    Widget list;
    Widget main;
    Widget? side;
    switch (nav.tab) {
      case AppTab.home:
        list = const HomeScreen();
        main = ChatScreen(identityId: selected, embedded: true);
        side = _ContextColumn(identityId: selected, showWaiting: false);
      case AppTab.convs:
        list = const ConversationsScreen(compact: true);
        main = ChatScreen(identityId: selected, embedded: true);
        side = peekWaiting ? const _WaitingPeek() : _ContextColumn(identityId: selected);
      case AppTab.board:
        list = const BoardScreen();
        main = TicketScreen(number: nav.ticket ?? '#3711', embedded: true);
        side = null;
      case AppTab.org:
        list = const OrgScreen();
        main = ChatScreen(identityId: selected, embedded: true);
        side = _ContextColumn(identityId: selected, showWaiting: false);
    }

    return Focus(
      focusNode: focus,
      autofocus: true,
      onKeyEvent: _onKey,
      child: Column(children: [
        Expanded(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(
              width: 72,
              decoration: BoxDecoration(color: p.surface, border: BorderDirectional(end: BorderSide(color: p.line))),
              padding: const EdgeInsets.only(top: 12),
              child: Column(children: [
                for (final dest in kDests)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: SizedBox(
                      width: 64,
                      height: 56,
                      child: NavItem(dest: dest, on: nav.tab == dest.tab, count: dest.tab == AppTab.home ? d?.waitingCount : null, pillWidth: 52, fontSize: 11.5, onTap: () => nav.go(dest.tab)),
                    ),
                  ),
              ]),
            ),
            Container(
              width: nav.tab == AppTab.home || nav.tab == AppTab.org ? 380 : 300,
              decoration: BoxDecoration(color: p.bg, border: BorderDirectional(end: BorderSide(color: p.line))),
              child: list,
            ),
            Expanded(
              child: Container(
                decoration: BoxDecoration(border: BorderDirectional(end: BorderSide(color: side != null && ctxCol ? p.line : Colors.transparent))),
                child: main,
              ),
            ),
            if (side != null && ctxCol) SizedBox(width: 330, child: Container(color: p.surface, child: side)),
          ]),
        ),
        const _KeyBar(),
      ]),
    );
  }
}

const kShortcuts = [
  ('Ctrl K', 'מעבר מהיר'),
  ('Ctrl F', 'חיפוש בשיחה'),
  ('G  H / C / B / O', 'בית, שיחות, לוח, ארגון'),
  ('G  I', 'מחכה לך'),
  ('J / K', 'הבא, הקודם'),
  ('Enter', 'שליחה אחרי הצעד הנוכחי'),
  ('Ctrl Enter', 'שליחה עכשיו'),
  ('Ctrl .', 'עצירת העובד'),
  ('Esc', 'סגירה בלבד'),
  ('?', 'כל הקיצורים'),
];

class _KeyBar extends StatelessWidget {
  const _KeyBar();
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    Widget item(List<String> keys, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
          for (final k in keys) ...[Kbd(k), const SizedBox(width: 4)],
          Text(label, style: T.meta.copyWith(color: p.text2)),
        ]);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
      child: Wrap(spacing: 18, runSpacing: 6, children: [
        item(['Ctrl K'], 'מעבר מהיר'),
        item(['Ctrl F'], 'חיפוש בשיחה'),
        item(['G', 'I'], 'מחכה לך'),
        item(['1', '3'], 'תשובה לשאלה'),
        item(['Ctrl .'], 'עצירת העובד'),
        item(['?'], 'כל הקיצורים'),
      ]),
    );
  }
}

/// Context column: task, PR, files, and a peek at what else waits (mockup `.ctx`).
class _ContextColumn extends StatelessWidget {
  const _ContextColumn({required this.identityId, this.showWaiting = true});
  final String identityId;
  final bool showWaiting;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data!;
    final p = context.p;
    final chat = d.chats[identityId];
    final pr = chat?.items.whereType<PrCard>().lastOrNull;
    final diffs = chat?.items.whereType<DiffCard>().toList() ?? [];
    final presence = d.presence[identityId];
    final who = d.who(identityId);
    final ticket = d.tickets.where((t) => t.assignee == who.name).firstOrNull;
    final others = d.waiting.where((w) => w.from != identityId && w.state == WaitState.open).toList();

    Widget h(String t) => Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 6), child: Text(t, style: TextStyle(fontFamily: kFont, fontSize: 13, fontWeight: FontWeight.w700, color: p.text2)));
    Widget kv(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(children: [
            Text(k, style: T.secondary.copyWith(color: p.text2)),
            const SizedBox(width: 12),
            Expanded(child: Rich(v, align: TextAlign.end, style: T.secondary.copyWith(color: p.text))),
          ]),
        );
    Widget block(List<Widget> rows) => Column(children: [
          for (final (i, r) in rows.indexed) ...[
            if (i > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 16), child: Container(height: 1, color: p.line)),
            r,
          ],
        ]);

    final files = pr != null && pr.fileList.isNotEmpty ? pr.fileList : <DiffFile>[for (final dc in diffs) ...dc.files];
    return ListView(padding: EdgeInsets.zero, children: [
      h('משימה'),
      block([
        if (ticket != null) kv('טיקט', '${ticket.number} ${ticket.title.split(' ').take(2).join(' ')}'),
        if (who.taskRef != null) kv('ענף', '`${who.taskRef}-renew-retry`'),
        if (presence?.shift != null) kv('משמרת', '${presence!.shift}${presence.shiftSince != null ? ' · מ-${presence.shiftSince}' : ''}'),
        if (presence?.contextPct != null) kv('הקשר', '${presence!.contextPct}%'),
        kv('מחשב', '`hq-host`'),
      ]),
      if (pr != null) ...[
        h('PR #${pr.number}'),
        block([
          kv('CI', pr.ci == Check.ok ? "עבר · 4 דק'" : (pr.ci == Check.running ? 'רץ' : '—')),
          kv('סקירה', pr.review == Check.ok ? 'עברה' : (pr.review == Check.running ? 'רצה' : '—')),
          kv('מיזוג', '${who.name} ממזג כשהכול עובר'),
        ]),
      ],
      if (files.isNotEmpty) ...[
        h('קבצים'),
        for (final f in files)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
            child: Directionality(
              textDirection: TextDirection.ltr,
              child: Row(children: [
                Expanded(child: Text(f.path, style: T.mono(12).copyWith(color: p.text), overflow: TextOverflow.ellipsis)),
                DiffStat('+${f.add} −${f.del}'),
              ]),
            ),
          ),
        const Padding(padding: EdgeInsets.fromLTRB(16, 10, 16, 10), child: Align(alignment: AlignmentDirectional.centerStart, child: Btn('VS Code', icon: 'open_in_new', height: 34, fontSize: 13))),
      ],
      if (showWaiting && others.isNotEmpty) ...[
        h('מחכה לך · עוד ${others.length}'),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final w in others)
              InkWell(
                onTap: () => Nav.chat(context, w.from),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 3),
                  child: Rich('${d.who(w.from).name} · ${w.kicker.split(' · ').first}', style: TextStyle(fontFamily: kFont, fontSize: 13.5, height: 1.8, color: p.text)),
                ),
              ),
            const SizedBox(height: 4),
            Row(children: [const Kbd('J'), const SizedBox(width: 4), const Kbd('K'), const SizedBox(width: 6), Text('מעבר בין הפריטים', style: T.meta.copyWith(color: p.text2))]),
          ]),
        ),
      ],
    ]);
  }
}

/// G then I: "waiting for you" in the context column without leaving the conversation.
class _WaitingPeek extends StatelessWidget {
  const _WaitingPeek();
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    return ListView(padding: EdgeInsets.zero, children: [
      Section('מחכה לך', count: '${d.waitingCount}'),
      ListBlock(children: [for (final w in d.waiting) WaitRow(item: w)]),
    ]);
  }
}
