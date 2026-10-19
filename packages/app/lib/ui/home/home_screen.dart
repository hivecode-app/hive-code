// Home: "מחכה לך" (APP-SPEC §4.2, mockup screen 1).
// Only what blocks on the owner, sorted by urgency, one-tap answers with a 3s in-place undo.
// Rows never move while the screen is open: answered rows collapse in place.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import '../system_bar.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, this.embedded = false});

  /// Desktop list column: smaller title, no top-bar actions.
  final bool embedded;

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
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final items = _sorted(d);
    return Column(children: [
      TopBar(title: 'החברה', actions: [
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
      tail = Padding(padding: const EdgeInsets.only(top: 10), child: Wrap(spacing: 8, runSpacing: 8, children: _actions(context, store)));
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
                child: Rich(who.taskRef != null ? '${who.title} · ${ltr(who.taskRef!)}' : who.title,
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
              child: Rich(item.body,
                  style: TextStyle(
                      fontFamily: kFont,
                      fontSize: 14.5,
                      height: 1.45,
                      color: p.text,
                      fontWeight: item.blocking ? FontWeight.w400 : FontWeight.w400)),
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
        row,
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
    void open() => Nav.chat(context, item.from);
    void ask() => Nav.chat(context, item.from, quote: Quote(author: store.nameOf(item.from), text: item.body), focus: true);
    switch (item.kind) {
      case WaitKind.urgentProd:
        return [
          for (final o in item.options) Btn(o.label, kind: o.primary ? BtnKind.primary : BtnKind.tonal, onTap: () => store.answerWait(item, o)),
          Btn('שאלה', onTap: ask),
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
        return [
          for (final o in item.options) Btn(o.label, kind: BtnKind.tonal, onTap: () => store.answerWait(item, o)),
          Btn('תשובה אחרת', onTap: ask),
        ];
    }
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
