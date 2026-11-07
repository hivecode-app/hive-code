import '../tasks/organization.dart';
import '../../l10n/app_localizations.dart';
import '../product/product_theme.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// The conversation screen (chat.md, mockup screens 3 and 4). One conversation per worker;
// shifts are a divider, not a new chat.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/error_report.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../selection.dart';
import '../convs/conversations_screen.dart';
import 'chat_scroll.dart';
import 'composer.dart';
import 'items.dart';
import '../media/files_screen.dart';
import 'markdown.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.identityId, this.embedded = false});
  final String identityId;

  /// Desktop main column: no back arrow, no system chrome.
  final bool embedded;

  /// A quote (or just "focus the composer") handed over by home/notifications before opening.
  static final Map<String, Quote?> pendingQuote = {};

  /// What to show when the conversation opens: a question or GO by its askId ("מחכה לך" leads to its message),
  /// or a message by its id ("ביקשת" leads to the answer).
  static final Map<String, String> pendingTarget = {};

  /// The start of that message, for when it is on screen under another id (an answer that streamed in).
  static final Map<String, String> pendingTargetText = {};

  /// Conversations whose target is lit for a moment once it is on screen (a message reached from a tool's details).
  static final Set<String> pendingFlash = {};
  static final Set<String> pendingSource = {};

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final controller = TextEditingController();
  final focus = FocusNode();
  final scroll = ChatScrollController();
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
    scroll.addListener(_updateJump);
  }

  /// "למטה" when he is well above the end: on his scroll, and when messages pile up below him.
  void _updateJump() {
    if (!mounted) return;
    final up = !scroll.atEnd && scroll.fromEnd > 240;
    if (up != showJump) setState(() => showJump = up);
  }

  bool _opened = false;
  Backend? _backend;
  AppStore? _store;
  Conversation? _seenChat;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final store = StoreScope.read(context);
    // This runs on every store change. Opening the conversation (a fetch that replaces it) belongs
    // to the first time only: doing it here every time refetched in a loop, dropped messages just
    // sent and kept the CPU busy.
    _backend = store.backend;
    _store = store;
    if (!_opened) {
      _opened = true;
      final chat = store.data?.chats[widget.identityId];
      if (chat != null && controller.text.isEmpty && chat.draft.isNotEmpty) controller.text = chat.draft;
      seenCount = chat?.items.length ?? 0;
      store.backend.showConversation(widget.identityId);
      store.backend.openConversation(widget.identityId);
    }
    if (ChatScreen.pendingQuote.containsKey(widget.identityId)) {
      quote = ChatScreen.pendingQuote.remove(widget.identityId);
      WidgetsBinding.instance.addPostFrameCallback((_) => focus.requestFocus());
    }
    final target = ChatScreen.pendingTarget.remove(widget.identityId);
    final targetText = ChatScreen.pendingTargetText.remove(widget.identityId);
    if (target != null) {
      _target = target;
      _targetText = targetText;
      _targetSince = DateTime.now();
      _flashNext = ChatScreen.pendingFlash.remove(widget.identityId);
      if (ChatScreen.pendingSource.remove(widget.identityId)) {
        _sourceLoading = true;
        WidgetsBinding.instance.addPostFrameCallback((_) async {
          try {
            await store.backend.openConversation(widget.identityId);
            final found = await store.backend.revealMessage(widget.identityId, target);
            if (mounted) setState(() { _sourceMissing = !found; _sourceLoading = false; _target = found ? target : null; _targetSince = DateTime.now(); _flashNext = found; });
          } catch (_) { if (mounted) setState(() { _sourceMissing = true; _sourceLoading = false; _target = null; }); }
        });
      }
    }
  }

  /// The card or message to bring into view (an askId or a message id), until it is on screen.
  bool _sourceMissing = false, _sourceLoading = false;
  String? _target;
  String? _targetText;

  /// The id of the item [_target] found, as of the last build.
  String? _targetId;

  /// When the target was asked for: one the history never brings is dropped after a while, so it can't pull
  /// the view away later, in the middle of his reading.
  DateTime _targetSince = DateTime.now();

  /// The item [_target] names in the conversation now; the last one, when the text matches more than one.
  String? _targetItem(Conversation chat) {
    final t = _target;
    if (t == null) return null;
    final start = _targetText == null ? null : _snippet(_targetText!);
    bool hit(ChatItem i) => switch (i) {
          AskCard() => i.askId == t || i.id == t,
          UserMsg() || TextMsg() || InternalMsg() => i.id == t || i.id == 'msg:$t',
          _ => false,
        };
    bool byText(ChatItem i) => start != null && start.isNotEmpty && (i is TextMsg || i is UserMsg || i is InternalMsg) && _snippet(_textOf(i)).startsWith(start);
    return (chat.items.where(hit).lastOrNull ?? (_sourceLoading ? null : chat.items.where(byText).lastOrNull))?.id;
  }

  /// A message's start, spaces folded and an ellipsis dropped: what a cut copy (hq's 300) and the whole share.
  static String _snippet(String s) {
    final t = s.replaceAll(RegExp(r'\s+'), ' ').replaceAll(RegExp(r'…$'), '').trim();
    return t.length > 60 ? t.substring(0, 60) : t;
  }
  /// The newest row above the anchor (chat_scroll.dart): the history grows up from it, and what is newer
  /// grows down below it. Null: not placed yet, at the end.
  String? _centerLast;

  /// The anchor just above the rows still changing at the end (the live line, a reply streaming in, a tool
  /// running): from here on they grow below it, and what he reads stays put.
  String _endAnchor(List<_Entry> rows) {
    var i = rows.length - 1;
    while (i > 0 && _changing(rows[i - 1])) {
      i--;
    }
    return i == 0 ? _kTop : rows[i - 1].key;
  }

  static bool _changing(_Entry e) => switch (e.item) {
        TextMsg(streaming: true) => true,
        ToolGroup(outcome: Outcome.running) => true,
        _ => false,
      };

  /// How many rows are above the anchor.
  int _split(List<_Entry> rows) {
    final k = _centerLast;
    if (k == _kTop) return 0;
    // A single line between workers that became a folded run is the run now.
    final i = k == null ? null : _entryIndex[k] ?? _entryIndex['\u0000run:$k'];
    if (i != null) return i + 1;
    _centerLast = _endAnchor(rows);
    return _split(rows);
  }

  final _rowKeys = <String, GlobalKey>{};

  /// What each card showed at the last build: open, answered, replaced, a decision on its way.
  Map<String, Object> _cardLooks = const {};

  /// A card on screen above the anchor that changed since the last build (answered, here or elsewhere).
  bool _holdChangedCard(List<_Entry> rows, Map<String, Object> looks) {
    for (final MapEntry(:key, :value) in looks.entries) {
      final before = _cardLooks[key];
      if (before != null && before != value && _holdCard(rows, key)) return true;
    }
    return false;
  }

  /// The anchor goes right above a card on screen, at the place its top is now, so it folds or opens in place
  /// and nothing above it moves. Below the anchor a card keeps its top anyway; at the end the view follows
  /// the end, as everywhere.
  bool _holdCard(List<_Entry> rows, String key) {
    if (!scroll.hasClients || scroll.atEnd) return false;
    final t = _entryIndex[key];
    if (t == null || t >= _split(rows)) return false;
    final box = _rowKeys[key]?.currentContext?.findRenderObject();
    final view = scroll.position.context.notificationContext?.findRenderObject();
    if (box is! RenderBox || view is! RenderBox || !box.attached || !box.hasSize || !view.hasSize) return false;
    final top = box.localToGlobal(Offset.zero, ancestor: view).dy;
    final h = view.size.height;
    if (top < 0 || top >= h || h <= 0) return false;
    _centerLast = t == 0 ? _kTop : rows[t - 1].key;
    scroll.showAnchor(pixels: h - top, relayout: false);
    WidgetsBinding.instance.addPostFrameCallback((_) => scroll.settle());
    return true;
  }

  /// Brings the sought row into view in one jump: the anchor goes right above it, and the view puts it a
  /// fifth of the screen from the top (chat_scroll.dart). It is built at once, however far up it is.
  void _showTarget(List<_Entry> rows) {
    final id = _targetId!;
    final t = _entryIndex[_groupOf[id] ?? id];
    if (t == null) return;
    _centerLast = t == 0 ? _kTop : rows[t - 1].key;
    scroll.showAnchor(fraction: 0.8, relayout: false);
    final lit = _flashNext ? id : null;
    _target = null;
    _flashNext = false;
    WidgetsBinding.instance.addPostFrameCallback((_) => scroll.settle());
    if (lit != null) {
      // Lit for a moment, so the eye finds the card it was brought to (#258).
      _flash = lit;
      Future.delayed(const Duration(milliseconds: 1200), () {
        if (mounted && _flash == lit) setState(() => _flash = null);
      });
    }
  }

  @override
  void didUpdateWidget(covariant ChatScreen old) {
    super.didUpdateWidget(old);
    if (old.identityId != widget.identityId) {
      final store = StoreScope.read(context);
      store.backend.closeConversation(old.identityId);
      store.backend.showConversation(widget.identityId);
      final chat = store.data?.chats[widget.identityId];
      seenCount = chat?.items.length ?? 0;
      store.backend.openConversation(widget.identityId);
      controller.text = chat?.draft ?? '';
      quote = ChatScreen.pendingQuote.remove(widget.identityId);
      selected = null;
      searching = false;
      _scrolledToHit = null;
      _rowCache.clear();
      _rowKeys.clear();
      _cardLooks = const {};
      _centerLast = null;
      scroll.showEnd();
    }
  }

  @override
  void dispose() {
    _backend?.closeConversation(widget.identityId);
    // Typing doesn't notify the store; leaving the chat does, so the list shows the draft.
    final store = _store;
    if (store != null) Future.microtask(store.touch);
    controller.dispose();
    focus.dispose();
    scroll.dispose();
    super.dispose();
  }

  /// To the end: a short way glides there; from far up it is one jump, with the anchor back at the end.
  void _toBottom() {
    if (!scroll.hasClients) return;
    if (scroll.fromEnd < scroll.position.viewportDimension * 2) {
      // Text that grew on the way moved the end: from where the glide stops, the rest is one step.
      // Stopped by his finger on the way, it stays where he stopped it.
      scroll.animateTo(scroll.position.minScrollExtent, duration: const Duration(milliseconds: 200), curve: Curves.easeOut).then((_) {
        if (mounted && scroll.hasClients && scroll.fromEnd < 120 && !scroll.held) scroll.showEnd();
      });
      return;
    }
    setState(() => _centerLast = null);
    scroll.showEnd();
  }

  /// The card the banner names, wherever it is in the history: the list is lazy, so a card far up is not
  /// built yet and has no context to scroll to. Seek it like a target from "מחכה לך", and light it (#258).
  void _toAsk(AskCard card) {
    setState(() {
      _target = card.id;
      _targetText = null;
      _targetSince = DateTime.now();
      _flashNext = true;
    });
  }

  /// The card lit for a moment after the banner brought it into view.
  String? _flash;
  bool _flashNext = false;

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
          content: Rich(UiCopy.text(143, [cmd]), style: T.body.copyWith(color: p.text)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(UiCopy.text(144), style: T.button.copyWith(color: p.text2))),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: Text(UiCopy.text(145), style: T.button.copyWith(color: p.urgent, fontWeight: FontWeight.w700))),
          ],
        ),
      );
      if (ok != true) return;
    }
    await store.stop(widget.identityId);
  }

  void _quoteItem(ChatItem it, CompanyData d) {
    final (author, text) = switch (it) {
      UserMsg() => (UiCopy.text(146), it.text),
      TextMsg() => (d.who(widget.identityId).name, it.text),
      AskCard() => (d.who(it.from).name, it.question),
      _ => (d.who(widget.identityId).name, ''),
    };
    // Quoting an open question answers it (#55).
    final askId = it is AskCard && it.state == AskState.open ? it.askId : null;
    setState(() {
      quote = Quote(author: author, text: (it is AskCard ? it.headline ?? text : text).split('\n').first, itemId: it.id, askId: askId, go: it is GoCard);
      selected = null;
    });
    focus.requestFocus();
  }

  /// Part of a message: the long press on a bubble is the message's own (select, quote), so its text
  /// opens in a sheet where a long press selects words, with handles and the copy/select-all menu.
  void _selectText(ChatItem it) {
    final text = _textOf(it);
    setState(() => selected = null);
    final p = context.p;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: p.surface,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.8),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: CopySelectionArea(child: Markdown(text)),
          ),
        ),
      ),
    );
  }

  String _textOf(ChatItem it) => switch (it) { UserMsg() => it.text, TextMsg() => it.text, AskCard() => it.question, InternalMsg() => it.body, _ => '' };

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
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
    final superseded = supersededGos(chat.items);
    final open = chatDecisions(d, chat, superseded: superseded, pending: (a) => store.decision(a.askId, a.id) != null);
    _targetId = _targetItem(chat);
    if (_targetId == null && _target != null && DateTime.now().difference(_targetSince) > const Duration(seconds: 15)) _target = null;

    // Search: local over loaded items (hq FTS replaces this when it ships, chat.md §6).
    final hits = query.isEmpty ? <String>[] : [for (final it in chat.items) if (_textOf(it).contains(query)) it.id];
    if (match >= hits.length) match = hits.isEmpty ? 0 : hits.length - 1;

    final hitId = hits.isEmpty ? null : hits[hits.length - 1 - match];
    if (hitId == null) _scrolledToHit = null;
    // Rows are built lazily: only what is on screen. With thousands of items, building every row
    // on each store change (every streaming token) was the main cost of a frame.
    final rows = _entries(chat);
    // A message inside a folded run (the target of a tap, or a search hit) opens its run.
    for (final id in [_targetId, hitId]) {
      if (id != null && _groupOf[id] != null) _openGroups.add(_groupOf[id]!);
    }
    final looks = {
      for (final a in chat.items.whereType<AskCard>()) a.id: (a.state, a.answer, superseded.contains(a.id), store.decision(a.askId, a.id) != null),
    };
    if (_targetId != null && _target != null) {
      _showTarget(rows);
    } else if (_holdChangedCard(rows, looks)) {
      // A card that folds (an answer, here or elsewhere) keeps its top where it was.
    } else if (scroll.atEnd && !scroll.held && rows.length - _split(rows) > 40) {
      // At the end, a long run below the anchor goes back above it: nothing moves, the view follows the end.
      _centerLast = _endAnchor(rows);
    }
    _cardLooks = looks;
    final split = _split(rows);
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateJump());
    _checkRowDeps([Theme.of(context), MediaQuery.textScalerOf(context), chat, d, openAllTools, _targetId, Localizations.localeOf(context)]);
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
              controller.text = UiCopy.text(147);
            },
            onSelectText: widget.embedded ? null : () => _selectText(selectedItem),
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
                    case 'mute':
                      pickMute(context, widget.identityId);
                    default:
                      break;
                  }
                },
              );

    // Desktop keeps lines readable: messages in a 780px column (mockup `.dmain .msgs`).
    Widget rowAt(int index) {
      final e = rows[index];
      final row = _row(context, e, chat, d, superseded, hitId);
      // Desktop: text selects with the mouse like a page (APP-SPEC §3, #55). The phone
      // selects a whole message with a long press and copies it from the top bar, or
      // picks part of it in "בחירת טקסט" (_selectText).
      Widget w = Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 780), child: widget.embedded ? CopySelectionArea(child: row) : row));
      // A row keeps its state (an open tool group, a card's details) when the anchor moves past it and it
      // goes over to the other sliver.
      w = KeyedSubtree(key: _rowKeys.putIfAbsent(e.key, GlobalKey.new), child: w);
      // A touch on a card (its details open, an answer) puts the anchor above it first: whatever it does to
      // its height, it does it below its top.
      if (e.item is AskCard) {
        w = Listener(
          onPointerDown: (_) {
            if (_holdCard(rows, e.key)) setState(() {});
          },
          child: w,
        );
      }
      return KeyedSubtree(key: ValueKey(e.key), child: w);
    }

    Widget body({bool teamLink = true}) => Column(children: [
      header,
      if (store.preferences.newInterface && teamLink) ConversationHierarchy(key: ValueKey('team-${widget.identityId}'), identity: widget.identityId),
      if (_sourceMissing) Semantics(liveRegion: true, child: Padding(padding: const EdgeInsets.all(12), child: Text(AppLocalizations.of(context).progressSourceMissing))),
      if (open.isNotEmpty && selectedItem == null) _PinBar(open: open, onTap: () => _toAsk(open.first)),
      Expanded(
        child: Container(
          color: p.chatBg,
          child: Stack(children: [
            CustomScrollView(
              controller: scroll,
              reverse: true,
              center: _kCenter,
              slivers: [
                const SliverToBoxAdapter(child: SizedBox(height: 12)),
                // Below the anchor: what came after it, oldest first, growing down.
                SliverList(
                  delegate: SliverChildBuilderDelegate(
                    (context, i) => rowAt(split + i),
                    childCount: rows.length - split,
                    findChildIndexCallback: (key) {
                      final i = _entryIndex[(key as ValueKey<String>).value];
                      return i == null || i < split ? null : i - split;
                    },
                  ),
                ),
                // The anchor and the history above it, newest first, growing up.
                SliverList(
                  key: _kCenter,
                  delegate: SliverChildBuilderDelegate(
                    (context, i) => rowAt(split - 1 - i),
                    childCount: split,
                    // Rows keep their element (and state, like an open tool group) when new ones arrive.
                    findChildIndexCallback: (key) {
                      final i = _entryIndex[(key as ValueKey<String>).value];
                      return i == null || i >= split ? null : split - 1 - i;
                    },
                  ),
                ),
                const SliverToBoxAdapter(child: SizedBox(height: 6)),
              ],
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
        onClearQuote: quote == null ? null : () => setState(() => quote = null),
        onSent: () {
          seenCount = chat.items.length;
          if (scroll.hasClients) _toBottom();
        },
      ),
    ]);

    Widget layout() => LayoutBuilder(builder: (context, c) {
      if (!store.preferences.newInterface || c.maxWidth < 650 || (c.maxHeight < 560 && c.maxWidth < 1100) || MediaQuery.textScalerOf(context).scale(1) >= 1.5) return body();
      return Row(children: [Expanded(child: body(teamLink: false)), SizedBox(width: 230, child: ConversationHierarchy(key: ValueKey('sidebar-${widget.identityId}'), identity: widget.identityId, sidebar: true))]);
    });
    if (widget.embedded) return layout();
    return Scaffold(backgroundColor: p.surface, body: SafeArea(child: layout()));
  }

  // Day separators, items, then the live line at the bottom. Cheap: no widgets, and recomputed only
  // when the list itself changes (not when a streaming bubble grows).
  List<_Entry> _entries(Conversation chat) {
    final items = chat.items;
    // The zone too: day separators follow org.yaml's `timezone` once hq sends it (#121).
    final sig = (items.length, items.firstOrNull?.id, items.lastOrNull?.id, CompanyTime.offset, StoreScope.read(context).preferences.newInterface);
    if (identical(items, _entryItems) && _entrySig == sig && _entryCache != null) return _entryCache!;
    final out = <_Entry>[];
    // Row keys of our own start with \u0000, so they can never equal an item id.
    if (items.isEmpty) out.add(const _Entry('\u0000empty'));
    DateTime? day;
    for (final it in items) {
      final dd = dayStart(it.ts);
      if (day != dd) {
        day = dd;
        // Unique even when items arrive out of order and a day shows up twice.
        out.add(_Entry('\u0000day:${dd.millisecondsSinceEpoch}:${it.id}', day: dd));
      }
      if (StoreScope.read(context).preferences.newInterface && (it is ShiftMarker || it is EventLine && !it.strong)) {
        final run = out.lastOrNull;
        if (run?.system != null) { run!.system!.add(it); continue; }
        out.add(_Entry('\u0000system:${it.id}', system: [it]));
        continue;
      }
      if (it is InternalMsg) {
        // A run of them folds into one line; a single one stays a line of its own.
        final run = out.isEmpty ? null : out.last;
        if (run != null && run.group != null) {
          run.group!.add(it);
          continue;
        }
        if (run != null && run.item is InternalMsg) {
          out.removeLast();
          out.add(_Entry('\u0000run:${run.item!.id}', group: [run.item as InternalMsg, it]));
          continue;
        }
      }
      out.add(_Entry(it.id, item: it));
    }
    _groupOf = {
      for (final e in out)
        if (e.group != null) for (final m in e.group!) m.id: e.key,
      for (final e in out)
        if (e.system != null) for (final m in e.system!) m.id: e.key,
    };
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

  /// The folded run each message between workers is in, and the runs that are open.
  Map<String, String> _groupOf = const {};
  final _openGroups = <String>{};
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
        TextMsg() => (it.text, it.streaming, it.author, it.attachments.length, selected == it.id, hitId == it.id, _flash == it.id),
        UserMsg() => (it.text, it.delivery, it.priority, it.waitingOn, it.replyTo?.text, selected == it.id, hitId == it.id, _flash == it.id),
        _ => null,
      };

  Widget _row(BuildContext context, _Entry e, Conversation chat, CompanyData d, Set<String> superseded, String? hitId) {
    final p = context.p;
    final it0 = e.item;
    final sig = it0 == null ? null : _rowSig(it0, hitId);
    if (sig != null) {
      final hit = _rowCache[e.key];
      if (hit != null && hit.$1 == sig) return hit.$2;
      if (_rowCache.length > 400) _rowCache.clear();
      final w = _buildRow(context, e, chat, d, superseded, hitId, p);
      _rowCache[e.key] = (sig, w);
      return w;
    }
    return _buildRow(context, e, chat, d, superseded, hitId, p);
  }

  Widget _buildRow(BuildContext context, _Entry e, Conversation chat, CompanyData d, Set<String> superseded, String? hitId, Palette p) {
    if (e.key == '\u0000empty') {
      final who = d.who(widget.identityId);
      return ServiceLine(text: '${who.name} · ${who.title}');
    }
    if (e.key == _kLive) {
      final who = d.who(widget.identityId);
      return LiveIndicator(live: chat.live, name: who.name, gender: who.gender);
    }
    if (e.day != null) return ServiceLine(text: _dayLabel(e.day!));
    if (e.system != null) {
      final l = AppLocalizations.of(context);
      final open = _openGroups.contains(e.key);
      return Column(mainAxisSize: MainAxisSize.min, children: [
        ServiceLine(text: l.systemUpdates(e.system!.length), icon: 'info', onTap: () => setState(() => open ? _openGroups.remove(e.key) : _openGroups.add(e.key)), tapHint: l.more),
        if (open) for (final m in e.system!)
          ServiceLine(text: m is EventLine ? cleanSystemText(m.text, l) : l.systemUpdates(1), icon: 'info'),
      ]);
    }
    if (e.group != null) {
      return InternalGroupRow(
        count: e.group!.length,
        open: _openGroups.contains(e.key),
        onToggle: () => setState(() => _openGroups.contains(e.key) ? _openGroups.remove(e.key) : _openGroups.add(e.key)),
        children: [for (final m in e.group!) _decorate(m, InternalMsgRow(msg: m, inGroup: true), hitId, p)],
      );
    }
    final it = e.item!;
    Widget w = _item(context, it, chat, d, superseded);
    // A card quotes the same way as a message: a long press or a swipe, never a tap (#258).
    if (it is UserMsg || it is TextMsg || it is AskCard) {
      w = _Selectable(
        selected: selected == it.id,
        onLongPress: () => setState(() => selected = it.id),
        onSwipe: () => _quoteItem(it, d),
        child: w,
      );
    }
    return _decorate(it, w, hitId, p);
  }

  /// What marks a row as the one sought: the key the list scrolls to, the moment it is lit, a search hit.
  Widget _decorate(ChatItem it, Widget w, String? hitId, Palette p) {
    // Cards light themselves (flash:); a message, or a line between workers, is lit here.
    if (_flash == it.id && it is! AskCard) w = Container(color: p.accentSoft, child: w);
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

  Widget _item(BuildContext context, ChatItem it, Conversation chat, CompanyData d, Set<String> superseded) {
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
          onStopNow: () => _stop(chat, d.who(widget.identityId)),
          onRetry: () => store.resend(widget.identityId, it),
        ),
      TextMsg() => TextBubble(msg: it),
      ToolGroup() => ToolGroupRow(group: it, forceOpen: openAllTools, identityId: widget.identityId),
      DiffCard() => DiffCardView(card: it),
      TestResultCard() => TestCardView(card: it),
      TerminalCard() => TerminalCardView(card: it),
      PrCard() => PrCardView(card: it),
      AskCard() => AskCardView(
          card: it,
          superseded: superseded.contains(it.id),
          flash: _flash == it.id,
          onOther: () {
            setState(() => quote = Quote(author: d.who(it.from).name, text: (it.headline ?? it.question).split('\n').first, itemId: it.id, askId: it.askId, go: it is GoCard));
            focus.requestFocus();
          },
        ),
      DecidedCard() => DecidedCardView(card: it),
      PermissionCard() => PermissionCardView(card: it),
      FileMsg() => FileBubble(msg: it),
      ShiftMarker() => ServiceLine(
          icon: 'autorenew',
          text: store.preferences.newInterface ? AppLocalizations.of(context).systemUpdates(1) : UiCopy.text(148, [it.shift, it.from, hm(it.ts)]),
        ),
      EventLine() => ServiceLine(text: it.text, icon: it.icon, strong: it.strong),
      InternalMsg() => InternalMsgRow(msg: it),
      HandoffCard() => HandoffCardView(card: it, from: widget.identityId),
      // A turn that ended in an error: hq caught it itself (turn.error, error-watch.ts).
      ErrorLine() => ServiceLine(text: ErrorReports.instance.active ? '${it.text} ${SentNote.text}.' : it.text, icon: 'error', iconColor: context.p.urgent),
      UnknownItem() => ServiceLine(text: UiCopy.text(149, [it.kind])),
    };
  }

  static String _dayLabel(DateTime d) {
    final ago = daysAgo(d, CompanyTime.now());
    if (ago == 0) return UiCopy.text(150);
    if (ago == 1) return UiCopy.text(34);
    final days = [UiCopy.text(151), UiCopy.text(152), UiCopy.text(153), UiCopy.text(154), UiCopy.text(155), UiCopy.text(156), UiCopy.text(157)];
    return '${days[wall(d).weekday - 1]} ${dm(d)}';
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
    UiCopy.watch(context);
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
      status = StatusWord(icon: 'cloud_off', word: UiCopy.text(158, [statusWord(presence.status, who.gender)]), size: 12);
    } else if (stopped) {
      status = StatusWord(icon: 'stop_circle', word: '${f ? UiCopy.text(159) : UiCopy.text(160)} · ${chat.live.stoppedAt}', size: 12);
    } else if (busy) {
      status = StatusWord(
        icon: statusIcon(WorkerStatus.working),
        word: '${statusWord(WorkerStatus.working, who.gender)}${presence.activity != null ? ' · ${presence.activity}' : ''} · ',
        size: 12,
        trailing: Semantics(button: true, label: UiCopy.text(145), child: GestureDetector(onTap: onStop, child: Text(UiCopy.text(145), style: TextStyle(fontFamily: kFont, fontSize: 12, height: 1.4, fontWeight: FontWeight.w700, color: p.accent)))),
      );
    } else {
      status = StatusWord.of(presence, who.gender, size: 12);
    }

    if (store.preferences.newInterface) {
      final l = AppLocalizations.of(context);
      return Container(decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
        padding: EdgeInsetsDirectional.fromSTEB(embedded ? 20 : 4, 6, 8, 6), child: Row(children: [
          if (!embedded) IBtn(backIcon(context), tip: l.back, onTap: () => Navigator.maybePop(context)),
          ProjectMonogram.person(d, who.id, size: 28), const SizedBox(width: 10),
          Expanded(child: InkWell(onTap: () => _workerSheet(context, d), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            ProductContentText(who.name, style: T.name.copyWith(color: p.text, fontSize: 16)),
            ProductContentText(d.roleLine(who.id), style: T.meta.copyWith(color: p.text2)),
            status,
          ]))),
          IBtn('folder', tip: l.mediaFiles, onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => FilesScreen(chat: who.id)))),
            IBtn('search', tip: l.searchChat, onTap: onSearch),
          IBtn('info', tip: l.role, onTap: () => _workerSheet(context, d)),
          PopupMenuButton<String>(tooltip: l.more, onSelected: onMenu, icon: Ic('more_vert', color: p.text2), itemBuilder: (_) => [
            PopupMenuItem(value: 'stop', child: Text(l.stop)),
            PopupMenuItem(value: 'mute', child: Text(d.conversation(who.id)?.muted == true ? l.unmute : l.mute)),
          ]),
        ]));
    }
    return Container(
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: EdgeInsetsDirectional.fromSTEB(embedded ? 16 : 6, 4, 4, 4),
      child: Row(children: [
        if (!embedded) IBtn(backIcon(context), tip: UiCopy.text(161), onTap: () => Navigator.of(context).maybePop()),
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
                        text: ' · ${d.roleLine(who.id)}',
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
        IBtn('search', tip: UiCopy.text(162), onTap: onSearch),
        PopupMenuButton<String>(
          tooltip: UiCopy.text(163),
          color: p.surface,
          icon: Ic('more_vert', color: p.text2),
          onSelected: onMenu,
          itemBuilder: (_) => [
            for (final (v, t) in [
              ('search', UiCopy.text(162)),
              ('stop', UiCopy.text(145)),
              ('tools', UiCopy.text(164)),
              ('mute', d.conversation(who.id)?.muted ?? false ? UiCopy.text(165) : UiCopy.text(166)),
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
      (UiCopy.text(167), team?.name ?? '—'),
      (UiCopy.text(168), team?.leadId != null && team!.leadId != who.id ? d.who(team!.leadId!).name : companyNames.manager),
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
          if (!StoreScope.read(context).preferences.newInterface) Padding(
            padding: const EdgeInsets.all(16),
            child: Wrap(spacing: 8, children:  [Btn('VS Code', icon: 'open_in_new'), Btn(UiCopy.text(174))]),
          ),
        ]),
      ),
    );
  }
}

/// The ids of GO cards with a newer one open from the same worker: only the newest asks him (#258).
Set<String> supersededGos(List<ChatItem> items) {
  final open = items.whereType<GoCard>().where((g) => g.state == AskState.open).toList();
  final newest = <String, GoCard>{};
  for (final g in open) {
    if (!(newest[g.from]?.ts.isAfter(g.ts) ?? false)) newest[g.from] = g;
  }
  return {for (final g in open) if (!identical(newest[g.from], g)) g.id};
}

/// "מחכה לך" strip: what is open for him here can never scroll away unseen. A tap anywhere on it brings the
/// card into view and lights it; with more than one, the first. With nothing open, there is no strip (#258).
class _PinBar extends StatelessWidget {
  const _PinBar({required this.open, required this.onTap});
  final List<AskCard> open;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final ask = open.first;
    final many = open.length > 1;
    final (what, link) = many
        ? (UiCopy.text(175, [open.length]), UiCopy.text(176))
        : ask is GoCard
            ? (StoreScope.read(context).preferences.newInterface ? AppLocalizations.of(context).approve : UiCopy.text(177, [ltr('GO')]), UiCopy.text(178))
            : (ask.blocking ? UiCopy.text(179) : UiCopy.text(180), UiCopy.text(181));
    return Semantics(
      button: true,
      label: many ? what : UiCopy.text(89, [what, hm(ask.ts)]),
      hint: link,
      excludeSemantics: true,
      child: Material(
        color: p.surface,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Row(children: [
              Ic('front_hand', size: 18, fill: true, color: p.text),
              const SizedBox(width: 8),
              Expanded(
                child: Text.rich(
                  TextSpan(children: [
                    TextSpan(text: what, style: const TextStyle(fontWeight: FontWeight.w700)),
                    if (!many) TextSpan(text: ' · ${hm(ask.ts)}'),
                  ]),
                  style: TextStyle(fontFamily: kFont, fontSize: 13.5, height: 1.4, color: p.text),
                ),
              ),
              Text(link, style: TextStyle(fontFamily: kFont, fontSize: 13.5, fontWeight: FontWeight.w700, color: p.accent)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _SelectionBar extends StatelessWidget {
  const _SelectionBar({required this.onClose, required this.onQuote, required this.onCopy, required this.onWhy, this.onSelectText});
  final VoidCallback onClose, onQuote, onCopy, onWhy;
  final VoidCallback? onSelectText;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Container(
      height: 57,
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(children: [
        IBtn('close', tip: UiCopy.text(84), onTap: onClose),
        const Spacer(),
        IBtn('reply', tip: UiCopy.text(182), onTap: onQuote),
        IBtn('content_copy', tip: UiCopy.text(183), onTap: onCopy),
        if (onSelectText != null) IBtn('select_all', tip: UiCopy.text(184), onTap: onSelectText!),
        IBtn('help', tip: UiCopy.text(147), onTap: onWhy),
        IBtn('share', tip: UiCopy.text(185), onTap: onCopy),
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
    UiCopy.watch(context);
    final p = context.p;
    return Container(
      height: 57,
      decoration: BoxDecoration(color: p.surface, border: Border(bottom: BorderSide(color: p.line))),
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Row(children: [
        IBtn('close', tip: UiCopy.text(186), onTap: onClose),
        Expanded(
          child: TextField(
            autofocus: true,
            onChanged: onChanged,
            style: T.body.copyWith(color: p.text),
            decoration: InputDecoration(border: InputBorder.none, hintText: UiCopy.text(162), hintStyle: T.body.copyWith(color: p.text3)),
          ),
        ),
        if (count > 0) Text(UiCopy.text(187, [index + 1, count]), style: T.meta.copyWith(color: p.text2)),
        IBtn('keyboard_arrow_down', tip: UiCopy.text(188), onTap: onUp),
        Transform.flip(flipY: true, child: IBtn('keyboard_arrow_down', tip: UiCopy.text(189), onTap: onDown)),
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
    UiCopy.watch(context);
    final p = context.p;
    return Tooltip(
      message: UiCopy.text(190),
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
    UiCopy.watch(context);
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

/// The anchor key when every row is below the anchor.
const _kTop = '\u0000top';
const _kCenter = ValueKey('\u0000center');

/// What is his to decide in this conversation, oldest first (#258): the questions and the newest GO that hq
/// still has open for him. hq is the source: a card the history shows as open, but that was closed, replaced
/// or handed back to the manager, is not counted, and a task to check is not a decision. Writing in the
/// composer is a message, never an answer by itself: answering is a button, or a quote he chose.
List<AskCard> chatDecisions(CompanyData d, Conversation chat, {required Set<String> superseded, required bool Function(AskCard) pending}) {
  final his = {
    for (final w in d.waiting)
      if (w.askId != null && w.from == chat.identityId && (w.kind == WaitKind.go || w.kind == WaitKind.blockingAsk || w.kind == WaitKind.softAsk) && (w.state == WaitState.open || w.state == WaitState.pending))
        w.askId!,
  };
  return [
    for (final a in chat.items.whereType<AskCard>())
      if (a is! CheckCard && a.state == AskState.open && his.contains(a.askId) && !superseded.contains(a.id) && !pending(a)) a,
  ];
}

/// One row of the chat list: a day separator, an item, the empty-chat header or the live line.
class _Entry {
  const _Entry(this.key, {this.item, this.day, this.group, this.system});
  final List<ChatItem>? system;
  final String key;

  /// A run of messages between workers, folded into one line.
  final List<InternalMsg>? group;
  final ChatItem? item;
  final DateTime? day;
}

/// System transport details are not product copy. Task and message IDs remain available in advanced tools.
String cleanSystemText(String text, AppLocalizations l) {
  final cleaned = text.replaceAll(RegExp(r'\b(?:[a-z][a-z0-9-]*-t\d+(?:-[a-z0-9:.-]+)?|t\d+|msg_id|hq-host|ci-host|hq|lease-\d+)\b', caseSensitive: false), '').replaceAll('``', '').replaceAll(RegExp(r'\s+'), ' ').trim();
  return cleaned.isEmpty ? l.systemUpdates(1) : cleaned;
}
