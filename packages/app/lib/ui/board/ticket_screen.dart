// Ticket page (mockup screen 6), shaped like a Stripe payment page: title and status, details in
// pairs, and a timeline where every line links to the message that explains it ("למה?").
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';

class TicketScreen extends StatefulWidget {
  const TicketScreen({super.key, required this.number, this.embedded = false});
  final String number;
  final bool embedded;
  @override
  State<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends State<TicketScreen> {
  bool nightReady = false;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final t = d.tickets.where((t) => t.number == widget.number).firstOrNull;
    final detail = d.ticketDetails[widget.number];
    if (t == null) return const SizedBox.shrink();
    final who = d.identities.values.where((i) => i.name == t.assignee).firstOrNull;
    final pairs = detail?.pairs ?? [('עובד', t.assignee), ('פרויקט', t.projectName)];

    final body = ListView(padding: EdgeInsets.zero, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text.rich(
            TextSpan(children: [TextSpan(text: ltr(t.number), style: T.mono(13)), TextSpan(text: ' · ${t.projectName}')]),
            style: TextStyle(fontFamily: kFont, fontSize: 13, color: p.text2),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 2, bottom: 8),
            child: Text(t.title, style: TextStyle(fontFamily: kFont, fontSize: 23, height: 1.3, fontWeight: FontWeight.w700, color: p.text)),
          ),
          Badge2(
            label: detail?.statusLine ?? statusWord(t.status, who?.gender ?? Gender.m),
            icon: statusIcon(t.status),
            kind: t.status == WorkerStatus.waiting ? BadgeKind.dark : BadgeKind.plain,
          ),
          const SizedBox(height: 14),
          Wrap(spacing: 8, runSpacing: 8, children: [
            if (who != null) Btn('לשיחה עם ${who.name}', kind: BtnKind.primary, onTap: () => Nav.chat(context, who.id)),
            Btn(nightReady ? 'מוכן ללילה · כן' : 'מוכן ללילה', icon: nightReady ? 'check' : null, onTap: () => setState(() => nightReady = !nightReady)),
          ]),
        ]),
      ),
      const Section('פרטים'),
      ListBlock(inset: 16, children: [
        for (final (k, v) in pairs)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(k, style: T.row2.copyWith(color: p.text2)),
              const SizedBox(width: 12),
              Expanded(child: Rich(v, align: TextAlign.end, style: T.row2.copyWith(color: p.text))),
            ]),
          ),
      ]),
      if (detail != null) ...[
        const Section('ציר זמן'),
        Container(
          decoration: BoxDecoration(color: p.surface, border: Border.symmetric(horizontal: BorderSide(color: p.line))),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Column(children: [
            for (final (i, e) in detail.timeline.indexed) _TimelineRow(e: e, last: i == detail.timeline.length - 1, onLink: who == null ? null : () => Nav.chat(context, who.id)),
          ]),
        ),
      ],
      const SizedBox(height: 24),
    ]);

    final bar = TopBar(
      leading: widget.embedded ? null : IBtn('arrow_forward', tip: 'חזרה', onTap: () => Navigator.of(context).maybePop()),
      actions: [const IBtn('open_in_new', tip: 'GitHub'), const IBtn('more_vert', tip: 'עוד')],
    );
    final col = Column(children: [bar, Expanded(child: body)]);
    if (widget.embedded) return Container(color: p.bg, child: col);
    return Scaffold(backgroundColor: p.bg, body: SafeArea(child: col));
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.e, required this.last, this.onLink});
  final TimelineEntry e;
  final bool last;
  final VoidCallback? onLink;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return IntrinsicHeight(
      child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SizedBox(
          width: 22,
          child: Stack(alignment: Alignment.topCenter, children: [
            if (!last) Positioned(top: 30, bottom: 0, child: Container(width: 1, color: p.line)),
            Padding(padding: const EdgeInsets.only(top: 8), child: Ic(e.icon, size: 18, fill: e.filled, color: p.text2)),
          ]),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(e.text, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text)),
              const SizedBox(height: 1),
              Row(children: [
                Text(e.time, style: T.meta.copyWith(color: p.text2)),
                if (e.link != null) ...[Text(' · ', style: T.meta.copyWith(color: p.text2)), LinkText(e.link!, size: 12.5, onTap: onLink)],
              ]),
            ]),
          ),
        ),
      ]),
    );
  }
}
