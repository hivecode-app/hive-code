// Desktop (APP-SPEC §8, mockup screen 10): rail 72 · list 360 · main · context 330 (from 1280px),
// a hint bar of shortcuts, and the keyboard map of §8.2 on physical keys (works with a Hebrew layout).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/backend.dart' show CompanyData;
import '../data/store.dart';
import '../model/models.dart';
import '../theme/tokens.dart';
import 'chat/chat_screen.dart';
import 'chat/items.dart' show shortcutAsk, shortcutOptions;
import 'chat/tool_details.dart';
import 'common.dart';
import 'convs/conversations_screen.dart';
import 'decisions/decisions_strip.dart';
import 'decisions/decisions_screen.dart';
import 'nav.dart';
import 'projects/projects_screen.dart';
import 'settings/settings_screen.dart';
import 'status/status_screen.dart';
import 'shell.dart';

class DesktopFrame extends StatefulWidget {
  const DesktopFrame({super.key, required this.width});
  final double width;
  @override
  State<DesktopFrame> createState() => _DesktopFrameState();
}

class _DesktopFrameState extends State<DesktopFrame> {
  final focus = FocusNode(debugLabel: 'desktop-shortcuts');
  final tools = ToolPanel(); // a tool's details, in the side column (tool_details.dart)

  @override
  void initState() {
    super.initState();
    tools.addListener(_rebuild);
  }

  void _rebuild() => setState(() {});
  bool gPrefix = false;

  @override
  void dispose() {
    focus.dispose();
    tools.dispose();
    super.dispose();
  }

  bool get _typing {
    final f = FocusManager.instance.primaryFocus;
    return f != null && f != focus && f.context?.findAncestorWidgetOfExactType<EditableText>() != null;
  }

  /// The main column shows a conversation (not the home).
  static bool _chatShown(AppNav nav, AppStore store) => !(nav.tab == AppTab.chats && store.homeOpen);

  /// The conversation on the screen has a decision of his open in its card: the line above the keys would say it twice.
  static bool _decisionShown(AppNav nav, AppStore store, CompanyData d) =>
      _chatShown(nav, store) && d.waiting.any((w) => w.from == store.currentConversation && (w.state == WaitState.open || w.state == WaitState.pending) && !d.superseded(w));

  KeyEventResult _onKey(FocusNode _, KeyEvent e) {
    if (e is! KeyDownEvent) return KeyEventResult.ignored;
    final nav = NavScope.read(context);
    final store = StoreScope.read(context);
    final k = e.physicalKey;
    final ctrl = HardwareKeyboard.instance.isControlPressed || HardwareKeyboard.instance.isMetaPressed;
    // With the home open no conversation is on the screen: what acts on one (stop, answer) does nothing.
    final chatShown = _chatShown(nav, store);
    if (ctrl && k == PhysicalKeyboardKey.keyK) {
      _quickSwitch();
      return KeyEventResult.handled;
    }
    if (ctrl && k == PhysicalKeyboardKey.period) {
      if (chatShown) store.stop(store.currentConversation);
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.escape) {
      tools.close();
      FocusManager.instance.primaryFocus?.unfocus();
      focus.requestFocus();
      return KeyEventResult.handled;
    }
    // Single-letter shortcuts are off while a text field has focus (§8.2).
    if (_typing || ctrl) return KeyEventResult.ignored;
    if (nav.tab == AppTab.decisions && !gPrefix && decisionKey(context, k)) return KeyEventResult.handled;
    if (gPrefix) {
      gPrefix = false;
      final t = {
        PhysicalKeyboardKey.keyD: AppTab.decisions,
        PhysicalKeyboardKey.keyC: AppTab.chats,
        PhysicalKeyboardKey.keyS: AppTab.status,
        PhysicalKeyboardKey.keyP: AppTab.projects,
      }[k];
      if (t != null) nav.go(t);
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.keyG) {
      gPrefix = true;
      return KeyEventResult.handled;
    }
    if (k == PhysicalKeyboardKey.keyJ || k == PhysicalKeyboardKey.keyK) {
      final list = store.data?.conversations.map((c) => c.identityId).toList() ?? [];
      final i = list.indexOf(store.currentConversation);
      final n = (i + (k == PhysicalKeyboardKey.keyJ ? 1 : -1)).clamp(0, list.length - 1);
      if (list.isNotEmpty) {
        store.selectedConversation = list[n];
        store.homeOpen = false;
        store.touch();
      }
      return KeyEventResult.handled;
    }
    // 1-4: pick an option of the open question in the current conversation.
    const digits = [PhysicalKeyboardKey.digit1, PhysicalKeyboardKey.digit2, PhysicalKeyboardKey.digit3, PhysicalKeyboardKey.digit4];
    final di = digits.indexOf(k);
    if (di >= 0) {
      if (!chatShown) return KeyEventResult.handled;
      final chat = store.data?.chats[store.currentConversation];
      final ask = shortcutAsk(chat);
      final opts = ask == null ? const <AskOption>[] : shortcutOptions(ask);
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
    final selected = store.currentConversation;

    Widget list;
    Widget main;
    Widget? side;
    switch (nav.tab) {
      case AppTab.status:
        list = const StatusScreen();
        main = ChatScreen(identityId: selected, embedded: true);
        side = _ContextColumn(identityId: selected);
      case AppTab.chats:
        list = const ConversationsScreen(compact: true);
        // v2: the home is a place of its own in the main column, as wide as a chat (home_v2.dart).
        main = store.homeOpen ? const HomeV2Page() : ChatScreen(identityId: selected, embedded: true);
        side = store.homeOpen ? null : _ContextColumn(identityId: selected);
      case AppTab.settings:
        list = const SettingsScreen(tab: true);
        main = ChatScreen(identityId: selected, embedded: true);
        side = null;
      case AppTab.projects:
        list = const ProjectsScreen();
        main = ChatScreen(identityId: selected, embedded: true);
        side = _ContextColumn(identityId: selected);
      case AppTab.decisions:
        // Its own list and the decision, across the whole width (decisions_screen.dart).
        list = const SizedBox.shrink();
        main = const SizedBox.shrink();
        side = null;
    }

    // A tool's details take the side column while its conversation is open; Esc or the X give it back.
    final shown = tools.shown;
    final toolSide = ctxCol && shown != null && shown.chat == selected && nav.tab != AppTab.settings && !(nav.tab == AppTab.chats && store.homeOpen);
    if (toolSide) side = ToolDetails(key: ValueKey(shown.call), identityId: shown.identityId, call: shown.call, onClose: tools.close);
    final frame = Focus(
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
                      child: NavItem(dest: dest, on: nav.tab == dest.tab, count: navCount(dest.tab, d), pillWidth: 52, fontSize: 11.5, onTap: () => nav.go(dest.tab)),
                    ),
                  ),
              ]),
            ),
            if (nav.tab == AppTab.decisions) const Expanded(child: DecisionsDesktop()) else ...[
            Container(
              // The chats column holds the home over the phone's two-line rows (convs_v2.dart), 360 wide.
              width: nav.tab == AppTab.chats ? 360 : 380,
              decoration: BoxDecoration(color: p.bg, border: BorderDirectional(end: BorderSide(color: p.line))),
              child: list,
            ),
            Expanded(
              child: Container(
                decoration: BoxDecoration(border: BorderDirectional(end: BorderSide(color: side != null && ctxCol ? p.line : Colors.transparent))),
                child: main,
              ),
            ),
            if (side != null && ctxCol) SizedBox(width: toolSide ? 420 : 330, child: Container(color: p.surface, child: side)),
            ],
          ]),
        ),
        // The line says how many decisions wait; not on the tab itself, and not in a conversation whose decision is
        // open right there in its card.
        DecisionsStrip(hidden: nav.tab == AppTab.decisions || (nav.tab == AppTab.chats && store.homeOpen) || (d != null && _decisionShown(nav, store, d))),
        _KeyBar(chat: _chatShown(nav, store)),
      ]),
    );
    return ctxCol ? ToolPanelScope(panel: tools, child: frame) : frame;
  }
}

const kShortcuts = [
  ('Ctrl K', 'מעבר מהיר'),
  ('Ctrl F', 'חיפוש בשיחה'),
  ('G  H / C / B / O', 'בית, שיחות, לוח, ארגון'),
  ('G  D', 'החלטות'),
  ('J / K', 'הבא, הקודם'),
  ('Enter', 'שליחה אחרי הצעד הנוכחי'),
  ('Ctrl Enter', 'שליחה עכשיו'),
  ('Ctrl .', 'עצירת העובד'),
  ('Esc', 'סגירה בלבד'),
  ('?', 'כל הקיצורים'),
];

class _KeyBar extends StatelessWidget {
  const _KeyBar({required this.chat});

  /// A conversation is on the screen: its keys (answer, stop) are listed too.
  final bool chat;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    Widget item(List<String> keys, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
          for (final k in keys) ...[Kbd(k), const SizedBox(width: 4)],
          Text(label, style: T.meta.copyWith(color: p.text2)),
        ]);
    return ListenableBuilder(listenable: decisionQueue, builder: (context, _) => Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(color: p.surface, border: Border(top: BorderSide(color: p.line))),
      child: Wrap(spacing: 18, runSpacing: 6, children: [
        if (NavScope.of(context).tab == AppTab.decisions) ...[
          // Keys that do nothing are not listed: with nothing to decide, 1-4 and J K have no effect.
          if (decisionQueue.remaining > 0) ...[
            item(['1', '4'], 'תשובה'),
            item(['J', 'K'], 'הבאה, הקודמת'),
          ],
          item(['G', 'C'], 'שיחות'),
          item(['?'], 'כל הקיצורים'),
        ] else ...[
          item(['Ctrl K'], 'מעבר מהיר'),
          item(['Ctrl F'], 'חיפוש בשיחה'),
          item(['G', 'D'], 'החלטות'),
          if (chat) ...[
            item(['1', '3'], 'תשובה לשאלה'),
            item(['Ctrl .'], 'עצירת העובד'),
          ],
          item(['?'], 'כל הקיצורים'),
        ],
      ]),
    ));
  }
}

/// Context column: task, PR and files (mockup `.ctx`).
class _ContextColumn extends StatelessWidget {
  const _ContextColumn({required this.identityId});
  final String identityId;

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
        if (presence?.shift != null) kv('משמרת', '${presence!.shift}${presence.shiftSince != null ? ' · מ-${presence.shiftSince}' : ''}'),
        if (presence?.contextPct != null) kv('הקשר', '${presence!.contextPct}%'),
        if (presence?.machine != null) kv('מחשב', '`${presence!.machine}`'),
      ]),
      if (pr != null) ...[
        h('PR #${pr.number}'),
        block([
          kv('CI', pr.ci == Check.ok ? 'עבר' : (pr.ci == Check.running ? 'רץ' : '—')),
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
    ]);
  }
}
