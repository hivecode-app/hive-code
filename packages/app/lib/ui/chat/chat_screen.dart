// The conversation screen (chat.md, mockup screens 3 and 4). One conversation per worker;
// shifts are a divider, not a new chat.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'composer.dart';
import 'items.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.identityId, this.embedded = false});
  final String identityId;

  /// Desktop main column: no back arrow, no system chrome.
  final bool embedded;

  /// A quote (or just "focus the composer") handed over by home/notifications before opening.
  static final Map<String, Quote?> pendingQuote = {};

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final controller = TextEditingController();
  final focus = FocusNode();
  final scroll = ScrollController();
  final askKey = GlobalKey();
  Quote? quote;
  String? selected;
  bool searching = false;
  String query = '';
  int match = 0;
  bool openAllTools = false;
  bool showJump = false;
  int seenCount = 0;

  @override
  void initState() {
    super.initState();
    scroll.addListener(() {
      final up = scroll.hasClients && scroll.offset > 240;
      if (up != showJump) setState(() => showJump = up);
    });
  }

  bool _opened = false;
  Conversation? _seenChat;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final store = StoreScope.read(context);
    // This runs on every store change. Opening the conversation (a fetch that replaces it) belongs
    // to the first time only: doing it here every time refetched in a loop, dropped messages just
    // sent and kept the CPU busy.
    if (!_opened) {
      _opened = true;
      final chat = store.data?.chats[widget.identityId];
      if (chat != null && controller.text.isEmpty && chat.draft.isNotEmpty) controller.text = chat.draft;
      seenCount = chat?.items.length ?? 0;
      store.backend.openConversation(widget.identityId);
    }
    if (ChatScreen.pendingQuote.containsKey(widget.identityId)) {
      quote = ChatScreen.pendingQuote.remove(widget.identityId);
      WidgetsBinding.instance.addPostFrameCallback((_) => focus.requestFocus());
    }
  }

  @override
  void didUpdateWidget(covariant ChatScreen old) {
    super.didUpdateWidget(old);
    if (old.identityId != widget.identityId) {
      final store = StoreScope.read(context);
      final chat = store.data?.chats[widget.identityId];
      seenCount = chat?.items.length ?? 0;
      store.backend.openConversation(widget.identityId);
      controller.text = chat?.draft ?? '';
      quote = ChatScreen.pendingQuote.remove(widget.identityId);
      selected = null;
      searching = false;
      _scrolledToHit = null;
      _rowCache.clear();
    }
  }

  @override
  void dispose() {
    controller.dispose();
    focus.dispose();
    scroll.dispose();
    super.dispose();
  }

  void _toBottom() => scroll.animateTo(0, duration: const Duration(milliseconds: 200), curve: Curves.easeOut);

  void _toAsk() {
    final c = askKey.currentContext;
    if (c != null) Scrollable.ensureVisible(c, duration: const Duration(milliseconds: 250), alignment: 0.1);
  }

  Future<void> _stop(Conversation chat, Identity who) async {
    final store = StoreScope.read(context);
    final cmd = chat.live.runningCommand;
    if (cmd != null) {
      // Stopping mid deploy.sh or a migration cannot be undone: ask first (chat.md §3).
      final p = context.p;
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: p.surface,
          content: Rich('לעצור באמצע `$cmd`?', style: T.body.copyWith(color: p.text)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text('המשך', style: T.button.copyWith(color: p.text2))),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text('עצירה', style: T.button.copyWith(color: p.urgent, fontWeight: FontWeight.w700))),
          ],
        ),
      );
      if (ok != true) return;
    }
    await store.stop(widget.identityId);
  }

  void _quoteItem(ChatItem it, CompanyData d) {
    final (author, text) = switch (it) {
      UserMsg() => ('את/ה', it.text),
      TextMsg() => (d.who(widget.identityId).name, it.text),
      AskCard() => (d.who(it.from).name, it.question),
      _ => (d.who(widget.identityId).name, ''),
    };
    setState(() {
      quote = Quote(author: author, text: text.split('\n').first, itemId: it.id);
      selected = null;
    });
    focus.requestFocus();
  }

  String _textOf(ChatItem it) => switch (it) { UserMsg() => it.text, TextMsg() => it.text, AskCard() => it.question, _ => '' };

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final chat = d.chats[widget.identityId] ?? Conversation(identityId: widget.identityId, items: []);
    // A freshly loaded history is not "new": count from the copy on screen now.
    if (!identical(chat, _seenChat)) {
      _seenChat = chat;
      seenCount = chat.items.length;
    }
    final who = d.who(widget.identityId);
    final presence = d.presence[widget.identityId] ?? const Presence(status: WorkerStatus.free);
    final openAsk = chat.items.whereType<AskCard>().where((a) => a.state == AskState.open && (a.blocking || a is GoCard)).lastOrNull;

    // Search: local over loaded items (hq FTS replaces this when it ships, chat.md §6).
    final hits = query.isEmpty ? <String>[] : [for (final it in chat.items) if (_textOf(it).contains(query)) it.id];
    if (match >= hits.length) match = hits.isEmpty ? 0 : hits.length - 1;

    final hitId = hits.isEmpty ? null : hits[hits.length - 1 - match];
    if (hitId == null) _scrolledToHit = null;
    // Rows are built lazily: only what is on screen. With thousands of items, building every row
    // on each store change (every streaming token) was the main cost of a frame.
    final rows = _entries(chat);
    _checkRowDeps([Theme.of(context), MediaQuery.textScalerOf(context), chat, d, openAsk, openAllTools]);
    final selectedItem = selected == null ? null : chat.items.where((i) => i.id == selected).firstOrNull;

    final header = selectedItem != null
        ? _SelectionBar(
            onClose: () => setState(() => selected = null),
            onQuote: () => _quoteItem(selectedItem, d),
            onCopy: () {
              Clipboard.setData(ClipboardData(text: _textOf(selectedItem)));
              setState(() => selected = null);
            },
            onWhy: () {
              _quoteItem(selectedItem, d);
              controller.text = 'למה?';
            },
          )
        : searching
            ? _SearchBar(
                count: hits.length,
                index: match,
                onChanged: (q) => setState(() {
                  query = q;
                  match = 0;
                }),
                onUp: () => setState(() => match = (match + 1).clamp(0, hits.isEmpty ? 0 : hits.length - 1)),
                onDown: () => setState(() => match = (match - 1).clamp(0, hits.isEmpty ? 0 : hits.length - 1)),
                onClose: () => setState(() {
                  searching = false;
                  query = '';
                }),
              )
            : _ChatBar(
                who: who,
                presence: presence,
                chat: chat,
                team: d.teamOf(widget.identityId),
                embedded: widget.embedded,
                onStop: () => _stop(chat, who),
                onSearch: () => setState(() => searching = true),
                onMenu: (v) {
                  switch (v) {
                    case 'search':
                      setState(() => searching = true);
                    case 'stop':
                      _stop(chat, who);
                    case 'tools':
                      setState(() => openAllTools = true);
                    default:
                      break;
                  }
                },
              );

    final body = Column(children: [
      header,
      if (openAsk != null && selectedItem == null) _PinBar(ask: openAsk, onTap: _toAsk),
      Expanded(
        child: Container(
          color: p.chatBg,
          child: Stack(children: [
            ListView.builder(
              controller: scroll,
              reverse: true,
              padding: const EdgeInsets.only(top: 6, bottom: 12),
              itemCount: rows.length,
              // Rows keep their element (and state, like an open tool group) when new ones arrive.
              findChildIndexCallback: (key) {
                final i = _entryIndex[(key as ValueKey<String>).value];
                return i == null ? null : rows.length - 1 - i;
              },
              // Desktop keeps lines readable: messages in a 780px column (mockup `.dmain .msgs`).
              itemBuilder: (context, i) {
                final e = rows[rows.length - 1 - i];
                return KeyedSubtree(
                  key: ValueKey(e.key),
                  child: Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 780), child: _row(context, e, chat, d, openAsk, hitId))),
                );
              },
            ),
            if (showJump)
              PositionedDirectional(
                start: 12,
                bottom: 10,
                child: _JumpButton(count: (chat.items.length - seenCount).clamp(0, 99), onTap: () {
                  seenCount = chat.items.length;
                  _toBottom();
                }),
              ),
          ]),
        ),
      ),
      Composer(
        identityId: widget.identityId,
        controller: controller,
        focus: focus,
        quote: quote,
        onClearQuote: () => setState(() => quote = null),
        onSent: () {
          seenCount = chat.items.length;
          if (scroll.hasClients) _toBottom();
        },
      ),
    ]);

    if (widget.embedded) return body;
    return Scaffold(backgroundColor: p.surface, body: SafeArea(child: body));
  }

  // Day separators, items, then the live line at the bottom. Cheap: no widgets, and recomputed only
  // when the list itself changes (not when a streaming bubble grows).
  List<_Entry> _entries(Conversation chat) {
    final items = chat.items;
    final sig = (items.length, items.firstOrNull?.id, items.lastOrNull?.id);
    if (identical(items, _entryItems) && _entrySig == sig && _entryCache != null) return _entryCache!;
    final out = <_Entry>[];
    // Row keys of our own start with \u0000, so they can never equal an item id.
    if (items.isEmpty) out.add(const _Entry('\u0000empty'));
    DateTime? day;
    for (final it in items) {
      final dd = DateTime(it.ts.year, it.ts.month, it.ts.day);
      if (day != dd) {
        day = dd;
        // Unique even when items arrive out of order and a day shows up twice.
        out.add(_Entry('\u0000day:${dd.millisecondsSinceEpoch}:${it.id}', day: dd));
      }
      out.add(_Entry(it.id, item: it));
    }
    out.add(const _Entry(_kLive));
    _entryItems = items;
    _entrySig = sig;
    _entryIndex = {for (final (i, e) in out.indexed) e.key: i};
    return _entryCache = out;
  }

  List<ChatItem>? _entryItems;
  Object? _entrySig;
  List<_Entry>? _entryCache;
  Map<String, int> _entryIndex = const {};
  String? _scrolledToHit;

  // The last widget built for each text row, with what it was built from. A row whose message did
  // not change returns the same widget object, and Flutter skips it: a streaming token rebuilds the
  // bubble that grew and nothing else on screen.
  final _rowCache = <String, (Object, Widget)>{};
  List<Object?> _rowDeps = const [];

  /// Anything the cached rows close over (theme, text size, the conversation and data objects):
  /// drop them all when one of these is replaced.
  void _checkRowDeps(List<Object?> deps) {
    if (deps.length == _rowDeps.length && Iterable<int>.generate(deps.length).every((i) => identical(deps[i], _rowDeps[i]))) return;
    _rowDeps = deps;
    _rowCache.clear();
  }

  Object? _rowSig(ChatItem it, String? hitId) => switch (it) {
        TextMsg() => (it.text, it.streaming, it.author, selected == it.id, hitId == it.id),
        UserMsg() => (it.text, it.delivery, it.priority, it.replyTo?.text, selected == it.id, hitId == it.id),
        _ => null,
      };

  Widget _row(BuildContext context, _Entry e, Conversation chat, CompanyData d, AskCard? openAsk, String? hitId) {
    final p = context.p;
    final it0 = e.item;
    final sig = it0 == null ? null : _rowSig(it0, hitId);
    if (sig != null) {
      final hit = _rowCache[e.key];
      if (hit != null && hit.$1 == sig) return hit.$2;
      if (_rowCache.length > 400) _rowCache.clear();
      final w = _buildRow(context, e, chat, d, openAsk, hitId, p);
      _rowCache[e.key] = (sig, w);
      return w;
    }
    return _buildRow(context, e, chat, d, openAsk, hitId, p);
  }

  Widget _buildRow(BuildContext context, _Entry e, Conversation chat, CompanyData d, AskCard? openAsk, String? hitId, Palette p) {
    if (e.key == '\u0000empty') {
      final who = d.who(widget.identityId);
      return ServiceLine(text: '${who.name} · ${who.title}');
    }
    if (e.key == _kLive) {
      final who = d.who(widget.identityId);
      return LiveIndicator(live: chat.live, name: who.name, gender: who.gender);
    }
    if (e.day != null) return ServiceLine(text: _dayLabel(e.day!));
    final it = e.item!;
    Widget w = _item(context, it, chat, d, openAsk);
    if (it is UserMsg || it is TextMsg) {
      w = _Selectable(
        selected: selected == it.id,
        onLongPress: () => setState(() => selected = it.id),
        onSwipe: () => _quoteItem(it, d),
        child: w,
      );
    }
    if (it.id == hitId) {
      final k = GlobalKey();
      w = Container(key: k, color: p.accentSoft, child: w);
      // Scroll to a match once, when it becomes the match; not again on every rebuild (a
      // streaming reply while searching used to yank the list back to the match each token).
      if (_scrolledToHit != hitId) {
        _scrolledToHit = hitId;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          final c = k.currentContext;
          if (c != null) Scrollable.ensureVisible(c, alignment: 0.3);
        });
      }
    }
    return w;
  }

  Widget _item(BuildContext context, ChatItem it, Conversation chat, CompanyData d, AskCard? openAsk) {
    final store = StoreScope.read(context);
    return switch (it) {
      UserMsg() => UserBubble(
          msg: it,
          identityId: widget.identityId,
          onRetract: () async {
            final t = await store.retract(widget.identityId, it);
            if (t != null) {
              controller.text = t;
              focus.requestFocus();
            }
          },
          onRetry: () {
            chat.items.remove(it);
            store.send(widget.identityId, it.text, it.priority);
          },
        ),
      TextMsg() => TextBubble(msg: it),
      ToolGroup() => ToolGroupRow(group: it, forceOpen: openAllTools),
      DiffCard() => DiffCardView(card: it),
      TestResultCard() => TestCardView(card: it),
      TerminalCard() => TerminalCardView(card: it),
      PrCard() => PrCardView(card: it),
      AskCard() => KeyedSubtree(
          key: identical(it, openAsk) ? askKey : null,
          child: AskCardView(
            card: it,
            onOther: () {
              setState(() => quote = Quote(author: d.who(it.from).name, text: it.question, itemId: it.id));
              focus.requestFocus();
            },
          ),
        ),
      DecidedCard() => DecidedCardView(card: it),
      PermissionCard() => PermissionCardView(card: it),
      FileMsg() => FileBubble(msg: it),
      ShiftMarker() => ServiceLine(
          icon: 'autorenew',
          text: 'משמרת ${it.shift} · קיבלה העברה ממשמרת ${it.from} · ${hm(it.ts)}',
          onTap: () => _showHandoff(context, it),
        ),
      EventLine() => ServiceLine(text: it.text, icon: it.icon, strong: it.strong),
      HandoffCard() => HandoffCardView(card: it, from: widget.identityId),
      ErrorLine() => ServiceLine(text: it.text, icon: 'error', iconColor: context.p.urgent),
      UnknownItem() => ServiceLine(text: 'אירוע: ${it.kind}'),
    };
  }

  void _showHandoff(BuildContext context, ShiftMarker m) {
    final p = context.p;
    showModalBottomSheet(
      context: context,
      backgroundColor: p.surface,
      showDragHandle: true,
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('העברה ממשמרת ${m.from} למשמרת ${m.shift}', style: T.name.copyWith(color: p.text)),
          const SizedBox(height: 10),
          for (final (k, v) in [
            ('מה נעשה', 'נמצא שהניסיון החוזר מיידי. אין חיוב כפול.'),
            ('מה הוחלט', 'ניסיון שני אחרי 24 שעות.'),
            ('הצעד הבא', 'לשנות את renew.go ולעדכן בדיקות.'),
            ('מה פתוח', 'מה עושים עם מנויים שנדחו פעמיים.'),
          ])
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text.rich(TextSpan(children: [TextSpan(text: '$k: ', style: const TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: v)]),
                  style: T.row2.copyWith(color: p.text)),
            ),
        ]),
      ),
    );
  }

  static String _dayLabel(DateTime d) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    if (d == today) return 'היום';
    if (d == today.subtract(const Duration(days: 1))) return 'אתמול';
    const days = ['ב\'', 'ג\'', 'ד\'', 'ה\'', 'ו\'', 'ש\'', 'א\''];
    return '${days[d.weekday - 1]} ${d.day}/${d.month}';
  }
}

// ───────────────────────────── bars ─────────────────────────────

class _ChatBar extends StatelessWidget {
  const _ChatBar({
    required this.who,
    required this.presence,
    required this.chat,
    required this.team,
    required this.embedded,
    required this.onStop,
    required this.onSearch,
    required this.onMenu,
  });
  final Identity who;
  final Presence presence;
  final Conversation chat;
  final Team? team;
  final bool embedded;
  final VoidCallback onStop;
  final VoidCallback onSearch;
  final void Function(String) onMenu;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final busy = chat.live.busy;
    final stopped = chat.live.phase == LivePhase.stopped;
    final f = who.gender == Gender.f;
    final linkDown = store.status.state == LinkState.offline || store.status.state == LinkState.connecting;

    // The live status line is always true (chat.md §1): offline says so instead of "working".
    Widget status;
    if (linkDown) {
      status = StatusWord(icon: 'cloud_off', word: 'לא מחובר · המצב האחרון: ${statusWord(presence.status, who.gender)}', size: 12);
    } else if (stopped) {
      status = StatusWord(icon: 'stop_circle', word: '${f ? 'נעצרה' : 'נעצר'} · ${chat.live.stoppedAt}', size: 12);
    } else if (busy) {
      status = StatusWord(
        icon: 'progress_activity',
        word: '${statusWord(WorkerStatus.working, who.gender)}${presence.activity != null ? ' · ${presence.activity}' : ''} · ',
        size: 12,
        trailing: Semantics(button: true, label: 'עצירה', child: GestureDetector(onTap: onStop, child: Text('עצירה', style: TextStyle(fontFamily: kFont, fontSize: 12, height: 1.4, fontWeight: FontWeight.w700, color: p.accent)))),
      );
    } else {
      status = StatusWord.of(presence, who.gender, size: 12, suffix: team?.name);
    }

    return Container(
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: EdgeInsetsDirectional.fromSTEB(embedded ? 16 : 6, 4, 4, 4),
      child: Row(children: [
        if (!embedded) IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop()),
        Expanded(
          child: InkWell(
            onTap: () => _workerSheet(context, d),
            child: Row(children: [
              Monogram.of(d, who.id, size: AvSize.sm),
              const SizedBox(width: 10),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text.rich(
                    TextSpan(children: [
                      TextSpan(text: who.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                      TextSpan(
                        text: ' · ${who.title}${who.taskRef != null ? ' · ${ltr(who.taskRef!)}' : ''}${embedded && team != null ? ' · ${team!.name}' : ''}',
                        style: TextStyle(fontWeight: FontWeight.w400, color: p.text2, fontSize: 13.5),
                      ),
                    ]),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontFamily: kFont, fontSize: 16, height: 1.25, color: p.text),
                  ),
                  status,
                ]),
              ),
            ]),
          ),
        ),
        IBtn('search', tip: 'חיפוש בשיחה', onTap: onSearch),
        PopupMenuButton<String>(
          tooltip: 'עוד',
          color: p.surface,
          icon: Ic('more_vert', color: p.text2),
          onSelected: onMenu,
          itemBuilder: (_) => [
            for (final (v, t) in [
              ('search', 'חיפוש בשיחה'),
              ('shift', 'משמרת חדשה'),
              ('stop', 'עצירה'),
              ('mute', 'השתקה'),
              ('page', 'תצוגת דף'),
              ('yoav', 'העברה ליואב'),
              ('tools', 'פתיחת כל הכלים'),
            ])
              PopupMenuItem(value: v, child: Text(t, style: T.body.copyWith(color: p.text))),
          ],
        ),
      ]),
    );
  }

  void _workerSheet(BuildContext context, CompanyData d) {
    final p = context.p;
    final pr = presence;
    final rows = <(String, String)>[
      ('צוות', team?.name ?? '—'),
      ('ממונה', team?.leadId != null && team!.leadId != who.id ? d.who(team!.leadId!).name : 'יואב'),
      if (who.taskRef != null) ('משימה', '`${who.taskRef}`'),
      if (pr.shift != null) ('משמרת', '${pr.shift}${pr.shiftSince != null ? ' · מ-${pr.shiftSince}' : ''}'),
      ('מודל', '`claude-opus-5-5`'),
      if (pr.contextPct != null) ('הקשר', '${pr.contextPct}%'),
      ('מחשב', '`hq-host`'),
    ];
    showModalBottomSheet(
      context: context,
      backgroundColor: p.bg,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Row(children: [
              Monogram.of(d, who.id),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('${who.name} · ${who.title}', style: T.name.copyWith(color: p.text)),
                  StatusWord.of(pr, who.gender, withActivity: true),
                ]),
              ),
            ]),
          ),
          ListBlock(inset: 16, children: [
            for (final (k, v) in rows)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                child: Row(children: [
                  Text(k, style: T.row2.copyWith(color: p.text2)),
                  const Spacer(),
                  Rich(v, style: T.row2.copyWith(color: p.text)),
                ]),
              ),
          ]),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Wrap(spacing: 8, children: const [Btn('VS Code', icon: 'open_in_new'), Btn('פרטים טכניים')]),
          ),
        ]),
      ),
    );
  }
}

/// "מחכה לך" strip: an open question or GO from this worker can never scroll away unseen.
class _PinBar extends StatelessWidget {
  const _PinBar({required this.ask, required this.onTap});
  final AskCard ask;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(children: [
        Ic('front_hand', size: 18, fill: true, color: p.text),
        const SizedBox(width: 8),
        Expanded(
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: ask is GoCard ? 'בקשת ${ltr('GO')}' : (ask.blocking ? 'שאלה חוסמת' : 'שאלה'), style: const TextStyle(fontWeight: FontWeight.w700)),
              TextSpan(text: ' · ${hm(ask.ts)}'),
            ]),
            style: TextStyle(fontFamily: kFont, fontSize: 13.5, height: 1.4, color: p.text),
          ),
        ),
        GestureDetector(
          onTap: onTap,
          child: Text(ask is GoCard ? 'לבקשה' : 'לשאלה', style: TextStyle(fontFamily: kFont, fontSize: 13.5, fontWeight: FontWeight.w700, color: p.accent)),
        ),
      ]),
    );
  }
}

class _SelectionBar extends StatelessWidget {
  const _SelectionBar({required this.onClose, required this.onQuote, required this.onCopy, required this.onWhy});
  final VoidCallback onClose, onQuote, onCopy, onWhy;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      height: 57,
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(children: [
        IBtn('close', tip: 'סגירה', onTap: onClose),
        const Spacer(),
        IBtn('reply', tip: 'ציטוט', onTap: onQuote),
        IBtn('content_copy', tip: 'העתקה', onTap: onCopy),
        IBtn('help', tip: 'למה?', onTap: onWhy),
        IBtn('share', tip: 'שיתוף', onTap: onCopy),
      ]),
    );
  }
}

class _SearchBar extends StatelessWidget {
  const _SearchBar({required this.count, required this.index, required this.onChanged, required this.onUp, required this.onDown, required this.onClose});
  final int count;
  final int index;
  final ValueChanged<String> onChanged;
  final VoidCallback onUp, onDown, onClose;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      height: 57,
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(children: [
        IBtn('close', tip: 'סגירת החיפוש', onTap: onClose),
        Expanded(
          child: TextField(
            autofocus: true,
            onChanged: onChanged,
            style: T.body.copyWith(color: p.text),
            decoration: InputDecoration(border: InputBorder.none, hintText: 'חיפוש בשיחה', hintStyle: T.body.copyWith(color: p.text3)),
          ),
        ),
        if (count > 0) Text('${index + 1} מתוך $count', style: T.meta.copyWith(color: p.text2)),
        IBtn('keyboard_arrow_down', tip: 'הקודמת', onTap: onUp),
        Transform.flip(flipY: true, child: IBtn('keyboard_arrow_down', tip: 'הבאה', onTap: onDown)),
      ]),
    );
  }
}

class _JumpButton extends StatelessWidget {
  const _JumpButton({required this.count, required this.onTap});
  final int count;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Tooltip(
      message: 'למטה',
      child: GestureDetector(
        onTap: onTap,
        child: Stack(clipBehavior: Clip.none, children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: p.surface, shape: BoxShape.circle, boxShadow: const [BoxShadow(color: Color(0x2E000000), blurRadius: 4, offset: Offset(0, 1))]),
            child: Center(child: Ic('keyboard_arrow_down', color: p.text2)),
          ),
          if (count > 0)
            PositionedDirectional(
              top: -6,
              end: -4,
              child: Container(
                constraints: const BoxConstraints(minWidth: 18),
                height: 18,
                padding: const EdgeInsets.symmetric(horizontal: 4),
                decoration: BoxDecoration(color: p.text, borderRadius: BorderRadius.circular(9)),
                alignment: Alignment.center,
                child: Text('$count', style: TextStyle(fontFamily: kFont, fontSize: 11, fontWeight: FontWeight.w700, color: p.surface)),
              ),
            ),
        ]),
      ),
    );
  }
}

/// Long press selects (WhatsApp), swipe toward the middle quotes (chat.md §4).
class _Selectable extends StatefulWidget {
  const _Selectable({required this.child, required this.selected, required this.onLongPress, required this.onSwipe});
  final Widget child;
  final bool selected;
  final VoidCallback onLongPress;
  final VoidCallback onSwipe;
  @override
  State<_Selectable> createState() => _SelectableState();
}

class _SelectableState extends State<_Selectable> {
  double dx = 0;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return GestureDetector(
      onLongPress: widget.onLongPress,
      onHorizontalDragUpdate: (e) => setState(() => dx = (dx + e.delta.dx).clamp(-72, 72)),
      onHorizontalDragEnd: (_) {
        if (dx.abs() > 48) widget.onSwipe();
        setState(() => dx = 0);
      },
      child: Container(
        color: widget.selected ? p.accentSoft.withValues(alpha: 0.6) : null,
        child: Transform.translate(offset: Offset(dx, 0), child: widget.child),
      ),
    );
  }
}

const _kLive = '\u0000live';

/// One row of the chat list: a day separator, an item, the empty-chat header or the live line.
class _Entry {
  const _Entry(this.key, {this.item, this.day});
  final String key;
  final ChatItem? item;
  final DateTime? day;
}
