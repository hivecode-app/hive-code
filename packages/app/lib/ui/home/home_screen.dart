// Home: "מחכה לך" (APP-SPEC §4.2, mockup screen 1).
// Only what blocks on the owner, sorted by urgency, one-tap answers with a 3s in-place undo.
// Rows never move while the screen is open: answered rows collapse in place.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../chat/chat_screen.dart';
import '../nav.dart';
import '../system_bar.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, this.embedded = false});

  /// Desktop list column: smaller title, no top-bar actions.
  final bool embedded;

  /// Builds since the last reset, counted in debug and test builds only (test/perf_bench_test.dart).
  static int debugBuilds = 0;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  /// Order frozen at first build so nothing moves under the finger (APP-SPEC §4.2).
  List<String>? _order;

  static int _rank(WaitItem w) => w.state == WaitState.notNow ? 99 : w.kind.index;

  List<WaitItem> _sorted(CompanyData d) {
    _order ??= ([...d.waiting]..sort((a, b) => _rank(a).compareTo(_rank(b)))).map((w) => w.id).toList();
    final byId = {for (final w in d.waiting) w.id: w};
    final out = [for (final id in _order!) if (byId[id] != null) byId[id]!];
    for (final w in d.waiting) {
      if (!_order!.contains(w.id)) out.add(w); // new arrivals go to the end, never above the finger
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    assert(() {
      HomeScreen.debugBuilds++;
      return true;
    }());
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final items = _sorted(d);
    return Column(children: [
      TopBar(title: 'החברה', showLink: true, actions: [
        const IBtn('search', tip: 'חיפוש'),
        IBtn(d.focus ? 'do_not_disturb_on' : 'do_not_disturb_on', tip: d.focus ? 'פוקוס פעיל · כיבוי' : 'פוקוס', fill: d.focus, color: d.focus ? p.text : null, onTap: store.toggleFocus),
        IBtn('more_vert', tip: 'עוד', onTap: () => Nav.settings(context)),
      ]),
      const SystemBar(),
      Expanded(
        child: ListView(padding: EdgeInsets.zero, children: [
          Section('מחכה לך', count: d.waitingCount > 0 ? '${d.waitingCount}' : null, top: 16),
          if (items.isEmpty)
            const _EmptyWaiting()
          else
            ListBlock(children: [for (final w in items) WaitRow(item: w, key: ValueKey(w.id))]),
          if (d.decisions.isNotEmpty) ...[
            Section('יואב החליט במקומך היום', count: '${d.decisions.length}'),
            ListBlock(children: [for (final x in d.decisions) _DecisionRow(x)]),
          ],
          if (d.digest.isNotEmpty) ...[
            Section('מאז הביקור הקודם', count: d.digestSince),
            ListBlock(children: [_DigestRow(lines: d.digest)]),
          ],
          if (d.activity.isNotEmpty) ...[
            const Section('עכשיו בעבודה'),
            ListBlock(inset: 16, children: [for (final a in d.activity) _ActivityRow(a)]),
          ],
          if (d.night != null) ...[
            const Section('לילה'),
            ListBlock(inset: 16, children: [_ActivityRow(TeamActivity(symbol: 'nights_stay', team: 'לילה', line: d.night!))]),
          ],
          const SizedBox(height: 20),
        ]),
      ),
    ]);
  }
}

class _EmptyWaiting extends StatelessWidget {
  const _EmptyWaiting();
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final working = d.presence.values.where((x) => x.status == WorkerStatus.working).length;
    return ListBlock(children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('אין כלום שמחכה לך.', style: T.name.copyWith(color: p.text)),
          const SizedBox(height: 2),
          Text('$working עובדים בעבודה · יואב זמין', style: T.secondary.copyWith(color: p.text2)),
        ]),
      ),
    ]);
  }
}

/// One "waiting for you" row. Used on home, in the desktop context column and in the gallery.
class WaitRow extends StatelessWidget {
  const WaitRow({super.key, required this.item});
  final WaitItem item;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data!;
    final p = context.p;
    final who = d.who(item.from);
    final urgent = item.kind == WaitKind.urgentProd;
    final pending = store.pending(item.id);

    Widget tail;
    if (item.state == WaitState.answered) {
      tail = DoneLine(item.answerLine ?? item.doneLine ?? 'טופל · ${hm(DateTime.now())}', top: 8);
    } else if (item.state == WaitState.notNow) {
      tail = Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(children: [
          Text('לא עכשיו', style: T.secondary.copyWith(color: p.text2)),
          const SizedBox(width: 10),
          GestureDetector(
            onTap: () {
              item.state = WaitState.open;
              store.touch();
            },
            child: Text('ביטול', style: T.secondary.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
          ),
        ]),
      );
    } else if (pending != null) {
      tail = UndoLine(label: pending.label, onCancel: () => store.cancelUndo(item.id));
    } else {
      final isAsk = item.kind == WaitKind.blockingAsk || item.kind == WaitKind.softAsk;
      tail = Padding(
        padding: const EdgeInsets.only(top: 10),
        child: isAsk && item.askId != null
            ? AnswerField(item: item, key: ValueKey('answer-${item.id}'))
            : Wrap(spacing: 8, runSpacing: 8, children: _actions(context, store)),
      );
    }

    final row = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Monogram.of(d, item.from),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
              Text(who.name, style: T.name.copyWith(color: p.text)),
              const SizedBox(width: 6),
              Expanded(
                child: Rich(d.roleLine(item.from),
                    maxLines: 1, style: T.secondary.copyWith(color: p.text2)),
              ),
              const SizedBox(width: 6),
              Text(item.time, style: T.meta.copyWith(color: p.text3)),
            ]),
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Row(children: [
                if (urgent) ...[Ic('warning', size: 17, fill: true, color: p.urgent), const SizedBox(width: 4)],
                Flexible(
                  child: Rich(item.kicker,
                      style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.45, fontWeight: FontWeight.w700, color: urgent ? p.urgent : p.text)),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 2),
              // The headline in his words when the worker gave one; the details are in the conversation.
              child: _ClampedBody(item.headline ?? item.body, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text)),
            ),
            AnimatedSize(duration: const Duration(milliseconds: 150), alignment: AlignmentDirectional.topStart, child: tail),
          ]),
        ),
      ]),
    );

    final flagged = item.blocking && item.state != WaitState.answered;
    final body = Semantics(
      container: true,
      label: '${who.name}, ${who.title}. ${item.kicker}',
      child: Stack(children: [
        // A tap opens the item; a long press offers to copy it (#55).
        InkWell(onTap: () => openWait(context, item), onLongPress: () => _copySheet(context, item), child: row),
        if (flagged)
          PositionedDirectional(
            start: 0,
            top: 12,
            bottom: 12,
            child: Container(
              width: 3,
              decoration: BoxDecoration(
                color: urgent ? p.urgent : p.text,
                borderRadius: const BorderRadiusDirectional.horizontal(end: Radius.circular(2)).resolve(Directionality.of(context)),
              ),
            ),
          ),
      ]),
    );

    // Swipe = "לא עכשיו", collapsing in place; the row is never deleted (APP-SPEC §4.2).
    if (item.state != WaitState.open || pending != null) return body;
    return Dismissible(
      key: ValueKey('swipe-${item.id}'),
      direction: DismissDirection.horizontal,
      confirmDismiss: (_) async {
        store.notNow(item);
        return false;
      },
      background: Container(color: p.surface2),
      child: body,
    );
  }

  List<Widget> _actions(BuildContext context, AppStore store) {
    final chat = store.data?.canChat(item.from) ?? false;
    void open() => openWait(context, item);
    void ask() => Nav.chat(context, item.from, quote: Quote(author: store.nameOf(item.from), text: item.body, askId: item.askId), focus: true);
    switch (item.kind) {
      case WaitKind.urgentProd:
        return [
          for (final o in item.options) Btn(o.label, kind: o.primary ? BtnKind.primary : BtnKind.tonal, onTap: () => store.answerWait(item, o)),
          if (chat) Btn('שאלה', onTap: ask),
          Btn('פתיחה', onTap: open),
        ];
      case WaitKind.go:
        return [
          Btn('GO', kind: BtnKind.primary, onTap: () => store.answerWait(item, item.options.first)),
          Btn('לא עכשיו', onTap: () => store.notNow(item)),
          Btn('פתיחה', onTap: open),
        ];
      case WaitKind.login:
        return [
          Btn('פתיחה', kind: BtnKind.primary, onTap: () => Nav.handoff(context, item)),
          Btn('לא עכשיו', onTap: () => store.notNow(item)),
        ];
      case WaitKind.failure:
        return [
          Btn('ניסיון נוסף', onTap: () => store.backend.retry(item)),
          Btn('פתיחה', onTap: open),
        ];
      case WaitKind.blockingAsk:
      case WaitKind.softAsk:
        // Without an ask behind it (an escalation note): the conversation is where to answer.
        return [
          for (final o in item.options) Btn(o.label, kind: BtnKind.tonal, onTap: () => store.answerWait(item, o)),
          if (chat) Btn('תשובה', onTap: ask),
          Btn('פתיחה', onTap: open),
        ];
    }
  }

  void _copySheet(BuildContext context, WaitItem item) {
    final p = context.p;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: p.bg,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: Ic('content_copy', color: p.text),
            title: Text('העתקת הטקסט', style: T.row2.copyWith(color: p.text)),
            onTap: () {
              Clipboard.setData(ClipboardData(text: item.body));
              Navigator.pop(c);
            },
          ),
          for (final url in linksIn(item.body))
            ListTile(
              leading: Ic('link', color: p.text),
              title: Text('העתקת הקישור', style: T.row2.copyWith(color: p.text)),
              subtitle: Text(url, maxLines: 1, overflow: TextOverflow.ellipsis, textDirection: TextDirection.ltr, style: T.small.copyWith(color: p.text2)),
              onTap: () {
                Clipboard.setData(ClipboardData(text: url));
                Navigator.pop(c);
              },
            ),
        ]),
      ),
    );
  }
}

/// Opens a waiting item: a site sign-in opens the handoff, a worker's item opens the conversation
/// (where its card is), and the system's opens a page of its own (#55).
void openWait(BuildContext context, WaitItem item) {
  if (item.kind == WaitKind.login) return Nav.handoff(context, item);
  final d = StoreScope.read(context).data;
  if (d != null && d.canChat(item.from)) {
    // Straight to its message in the conversation, where the answer buttons are.
    if (item.askId != null) ChatScreen.pendingTarget[item.from] = item.askId!;
    return Nav.chat(context, item.from);
  }
  Nav.waitItem(context, item);
}

/// Every http(s) link in a text, in order.
List<String> linksIn(String s) => [for (final m in RegExp(r'''https?://[^\s)<>]*[^\s)<>.,:;!?'"]''').allMatches(s)) m[0]!];

/// The answer to a question, typed (or pasted: a code, a link). Questions with options show the
/// options, and "תשובה אחרת" opens the field; a question without options shows the field at once (#55).
class AnswerField extends StatefulWidget {
  const AnswerField({super.key, required this.item, this.autofocus = false});
  final WaitItem item;
  final bool autofocus;
  @override
  State<AnswerField> createState() => _AnswerFieldState();
}

class _AnswerFieldState extends State<AnswerField> {
  final text = TextEditingController();
  late bool open = widget.item.options.isEmpty;
  bool busy = false;
  String? error;

  @override
  void initState() {
    super.initState();
    text.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final t = text.text.trim();
    if (t.isEmpty || busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    final r = await StoreScope.read(context).answerText(widget.item, t);
    if (!mounted) return;
    setState(() {
      busy = false;
      error = r.ok ? null : r.error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final item = widget.item;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      if (item.options.isNotEmpty || !open)
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final o in item.options) Btn(o.label, kind: BtnKind.tonal, onTap: () => store.answerWait(item, o)),
          if (!open) Btn('תשובה אחרת', onTap: () => setState(() => open = true)),
        ]),
      if (open) ...[
        if (item.options.isNotEmpty) const SizedBox(height: 8),
        TextField(
          key: Key('answer-field-${item.id}'),
          controller: text,
          autofocus: widget.autofocus || item.options.isNotEmpty,
          minLines: 1,
          maxLines: 4,
          textInputAction: TextInputAction.send,
          onSubmitted: (_) => _send(),
          style: T.body.copyWith(color: p.text),
          decoration: InputDecoration(
            isDense: true,
            hintText: 'תשובה ${toName(store.nameOf(item.from))}',
            hintStyle: T.body.copyWith(color: p.text3),
            filled: true,
            fillColor: p.surface2,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(8), borderSide: BorderSide.none),
            suffixIcon: text.text.trim().isEmpty
                ? IconButton(
                    tooltip: 'הדבקה',
                    icon: Ic('content_paste', size: 20, color: p.text2),
                    onPressed: () async {
                      final t = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
                      if (!mounted || t == null) return;
                      text.text = t.trim();
                    },
                  )
                : IconButton(tooltip: 'שליחה', icon: Ic('send', size: 20, color: busy ? p.text3 : p.accent), onPressed: busy ? null : _send),
          ),
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Ic('error', size: 18, color: p.urgent),
              const SizedBox(width: 6),
              Expanded(child: Text(error!, style: T.secondary.copyWith(color: p.text))),
            ]),
          ),
      ],
    ]);
  }
}

class _DecisionRow extends StatelessWidget {
  const _DecisionRow(this.x);
  final DecisionByManager x;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Monogram.of(d, x.by, size: AvSize.sm),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Rich(x.text, style: T.row2.copyWith(color: p.text)),
            const SizedBox(height: 4),
            Row(children: [Text('${x.time} · ', style: T.small.copyWith(color: p.text2)), const LinkText('שינוי')]),
          ]),
        ),
      ]),
    );
  }
}

class _DigestRow extends StatelessWidget {
  const _DigestRow({required this.lines});
  final List<String> lines;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final style = TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.65, color: p.text);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Monogram.of(d, 'yoav', size: AvSize.sm),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final l in lines.take(5)) Rich(l, style: style),
            const SizedBox(height: 4),
            Row(children: [Text('יואב · ', style: T.small.copyWith(color: p.text2)), const LinkText('הסיכום המלא')]),
          ]),
        ),
      ]),
    );
  }
}

class _ActivityRow extends StatelessWidget {
  const _ActivityRow(this.a);
  final TeamActivity a;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return InkWell(
      onTap: () => NavScope.read(context).go(AppTab.board),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(children: [
          Ic(a.symbol, size: 20, color: p.text2),
          const SizedBox(width: 12),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                TextSpan(text: a.team, style: TextStyle(fontWeight: FontWeight.w700, color: p.text)),
                TextSpan(text: ' · ${a.line}'),
              ]),
              style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: a.dormant ? p.text2 : p.text),
            ),
          ),
        ]),
      ),
    );
  }
}

/// A waiting item's text, up to 5 lines with "עוד" to open the rest. A GO request carries its
/// whole description (what's in, risk, rollback, PR); in full, two of them filled the home screen.
class _ClampedBody extends StatefulWidget {
  const _ClampedBody(this.text, {required this.style});
  final String text;
  final TextStyle style;
  @override
  State<_ClampedBody> createState() => _ClampedBodyState();
}

class _ClampedBodyState extends State<_ClampedBody> {
  static const _lines = 5;
  bool open = false;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return LayoutBuilder(builder: (context, c) {
      final style = DefaultTextStyle.of(context).style.merge(widget.style); // as Text.rich draws it
      final tp = TextPainter(
        text: TextSpan(children: Rich.spans(context, widget.text, style, links: false), style: style),
        textDirection: paragraphDirection(widget.text),
        maxLines: _lines,
        textScaler: MediaQuery.textScalerOf(context),
      )..layout(maxWidth: c.maxWidth);
      final long = tp.didExceedMaxLines;
      tp.dispose();
      if (!long) return Rich(widget.text, style: widget.style);
      return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Rich(widget.text, style: widget.style, maxLines: open ? null : _lines, links: true),
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => setState(() => open = !open),
          child: Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 2),
            child: Text(open ? 'פחות' : 'עוד', style: widget.style.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
          ),
        ),
      ]);
    });
  }
}
