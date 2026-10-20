// Status (#53), the secondary screen: what waits for him, what still waits on him to check or deploy (#108),
// what finished since his last visit (one line each), and one line per project with what runs there now.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../blocks/awaiting.dart';
import '../blocks/tasks.dart';
import '../common.dart';
import '../entity_link.dart';
import '../nav.dart';
import '../system_bar.dart';

class StatusScreen extends StatelessWidget {
  const StatusScreen({super.key});

  /// Lines under "מאז הביקור הקודם" before "עוד N".
  static const kDoneShown = 6;

  @override
  Widget build(BuildContext context) {
    final store = StoreScope.of(context);
    final d = store.data;
    if (d == null) return const SizedBox.shrink();
    final waiting = [for (final w in d.waiting) if (w.state == WaitState.open || w.state == WaitState.pending) w];
    final now = CompanyTime.now();
    final since = store.statusSeenAt ?? dayStart(now);
    final done = [for (final t in d.tickets) if (t.doneAt != null && t.assigneeId != null && t.doneAt!.isAfter(since)) t]..sort((a, b) => b.doneAt!.compareTo(a.doneAt!));
    return Column(children: [
      const TopBar(title: 'סטטוס', showLink: true),
      const SystemBar(),
      Expanded(
        child: ListView(padding: EdgeInsets.zero, children: [
          // "בעבודה ובתור" (#128): every open task, wherever it runs, queued ones too.
          Section('בעבודה ובתור', count: d.openTasks.isEmpty ? null : '${d.openTasks.length}', top: 8),
          ListBlock(children: [
            if (d.openTasks.isEmpty) const _Quiet(icon: 'radio_button_unchecked', text: 'אין משימות פתוחות')
            else TasksBlock(tasks: d.openTasks, now: now),
          ]),
          Section('מחכה לך', count: waiting.isEmpty ? null : '${waiting.length}'),
          ListBlock(children: [
            if (waiting.isEmpty) const _Quiet(icon: 'check_circle', text: 'אין מה שמחכה לך')
            else for (final w in waiting) _WaitLine(item: w),
          ]),
          // "מה לבדוק" (#108): only when something waits on him.
          // The last one checked folds the section away, not a jump.
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            switchInCurve: Curves.easeOutCubic,
            switchOutCurve: Curves.easeOutCubic,
            transitionBuilder: (child, a) => SizeTransition(sizeFactor: a, alignment: Alignment.topCenter, child: child),
            child: d.awaiting.isEmpty
                ? const SizedBox(key: ValueKey('awaiting-none'), width: double.infinity)
                : Column(key: const ValueKey('awaiting'), children: [
                    Section('מה לבדוק', count: '${d.awaiting.length}'),
                    ListBlock(children: [AwaitingBlock(data: AwaitingData.of(d), now: now)]),
                  ]),
          ),
          Section('מאז הביקור הקודם', count: 'מ-${_since(since, now)}'),
          ListBlock(inset: 16, children: [
            if (done.isEmpty) const _Quiet(icon: 'radio_button_unchecked', text: 'לא הסתיים כלום מאז')
            else for (final t in done.take(kDoneShown)) _DoneLine(t: t),
          ]),
          if (done.length > kDoneShown)
            MoreRow(icon: 'history', bold: 'עוד ${done.length - kDoneShown}', rest: 'בפרויקטים', top: false, onTap: () => NavScope.read(context).go(AppTab.projects)),
          const Section('בפרויקטים עכשיו'),
          ListBlock(inset: 16, children: [for (final proj in d.projects.where((x) => x.active)) _ProjectNow(proj: proj)]),
          const SizedBox(height: 24),
        ]),
      ),
    ]);
  }

  static String _since(DateTime since, DateTime now) {
    final ago = daysAgo(since, now);
    if (ago <= 0) return hm(since);
    return ago == 1 ? 'אתמול ${hm(since)}' : dm(since);
  }
}

class _Quiet extends StatelessWidget {
  const _Quiet({required this.icon, required this.text});
  final String icon;
  final String text;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(children: [
        Ic(icon, size: 20, color: p.text2),
        const SizedBox(width: 8),
        Text(text, style: T.row2.copyWith(color: p.text2)),
      ]),
    );
  }
}

/// One thing waiting for him: who, what kind, the headline. The card itself is in the conversation (#79).
class _WaitLine extends StatelessWidget {
  const _WaitLine({required this.item});
  final WaitItem item;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final who = d.who(item.from);
    final urgent = item.kind == WaitKind.urgentProd;
    return InkWell(
      onTap: () => d.canChat(item.from) ? Nav.chat(context, item.from) : Nav.waitItem(context, item),
      child: Padding(
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
                  child: Row(children: [
                    Ic(urgent ? 'warning' : 'pause_circle', size: 16, fill: true, color: urgent ? p.urgent : p.text),
                    const SizedBox(width: 3),
                    Flexible(child: Rich(item.kicker, maxLines: 1, style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.45, fontWeight: FontWeight.w700, color: urgent ? p.urgent : p.text))),
                  ]),
                ),
                const SizedBox(width: 6),
                Text(item.time, style: T.meta.copyWith(color: p.text3)),
              ]),
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Rich((item.headline ?? item.body).split('\n').first, auto: true, maxLines: 2, style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.45, color: p.text)),
              ),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// A finished task in one line (its summary, or its title), and under it the project, who did it and when.
/// A tap opens the conversation with who did it, or with who opened it once a task worker is done.
class _DoneLine extends StatelessWidget {
  const _DoneLine({required this.t});
  final Ticket t;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    return EntityLink(
      identity: chatTargetOfTicket(d, t),
      minHeight: kLinkRow,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 2), child: Ic('check_circle', size: 18, fill: true, color: p.text2)),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Rich(t.doneLine, auto: true, maxLines: 2, style: T.row2.copyWith(color: p.text)),
              Text([if (t.projectName.isNotEmpty) t.projectName, if (t.assignee.isNotEmpty) t.assignee, hm(t.doneAt!)].join(' · '), style: T.small.copyWith(color: p.text2)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// A project and what runs in it now: the running tasks with who is on them, or that it is quiet.
class _ProjectNow extends StatelessWidget {
  const _ProjectNow({required this.proj});
  final ProjectInfo proj;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final running = runningIn(d, proj.id);
    final queued = d.tickets.where((t) => t.project == proj.id && t.group == TicketGroup.queued).length;
    return InkWell(
      onTap: () => Nav.project(context, proj.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Rich(proj.name, style: T.name.copyWith(color: p.text))),
            if (queued > 0) Text('$queued בתור', style: T.small.copyWith(color: p.text2)),
          ]),
          if (running.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(children: [
                Ic('bedtime', size: 16, fill: true, color: p.text2),
                const SizedBox(width: 4),
                Text('שקט, אין משימה שרצה', style: T.secondary.copyWith(color: p.text2)),
              ]),
            )
          else
            // Each running task opens the conversation with the worker on it; the rest of the card, the project.
            for (final t in running)
              EntityLink(
                identity: chatTargetOfTicket(d, t),
                minHeight: kLinkLine,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Row(children: [
                    Ic(statusLoud(t.status) ? 'pause_circle' : 'play_arrow', size: 17, fill: true, color: p.text),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Rich('${t.assignee}: ${plainTitle(t.title)}', auto: true, maxLines: 1, style: T.secondary.copyWith(color: p.text)),
                    ),
                  ]),
                ),
              ),
        ]),
      ),
    );
  }
}

/// A project's tasks with a worker on them now, oldest first.
List<Ticket> runningIn(CompanyData d, String projectId) => [
      for (final t in d.tickets)
        if (t.project == projectId && t.group != TicketGroup.queued && t.group != TicketGroup.doneToday) t,
    ]..sort((a, b) => (a.startedAt ?? DateTime(0)).compareTo(b.startedAt ?? DateTime(0)));
