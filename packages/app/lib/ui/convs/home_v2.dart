// The home in design language v2 (docs/design/language-v2.md §8, mockup behind DESIGN_V2): the head of the
// conversations screen cut down to four parts, in this order, each only when it has something:
// 1. one sentence on the state: the composer's headline while it is newer than the last change in what waits
//    for him, else one from live data: a headline from before that change may say the opposite of the card
//    under it (audit #1);
// 2. what waits for him (GO, a question), each in two full lines (audit #2);
// 3. a line per project: its tone, icon and name, what runs and who, and how many wait for him;
// 4. what finished lately.
// The recipe stays the structure (home_blocks.dart): its waiting, project and since blocks, in its words.
// Identity is tone, a state is an icon and a word. Nothing moves while the screen rests.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/home_recipe.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../blocks/blocks.dart';
import '../common.dart';
import '../entity_link.dart';
import '../nav.dart';
import 'head.dart';
import 'home_blocks.dart';

/// "שני דברים", "3 דברים": a count in words for one and two, as people say it.
String _count(int n, String one, String two, String many) => n == 1 ? one : n == 2 ? two : '$n $many';

/// The one sentence on top, from live data, so it never contradicts the card under it.
String homeSentence(CompanyData d, {required int burning, required int waiting}) {
  final running = [for (final t in d.openTasks) if (t.state == OpenTaskState.running) t];
  final projects = {for (final t in running) t.project}.length;
  final work = running.isEmpty
      ? ''
      : '${_count(running.length, 'משימה אחת רצה', 'שתי משימות רצות', 'משימות רצות')}${projects > 1 ? (projects == 2 ? ' בשני פרויקטים' : ' ב-$projects פרויקטים') : ''}.';
  if (burning > 0) return '${_count(burning, 'תקלה אחת צריכה', 'שתי תקלות צריכות', 'תקלות צריכות')} אותך עכשיו.';
  if (waiting > 0) {
    final head = '${_count(waiting, 'דבר אחד מחכה', 'שני דברים מחכים', 'דברים מחכים')} לך.';
    return work.isEmpty ? head : '$head בינתיים $work';
  }
  return work.isEmpty ? 'שום דבר לא מחכה לך. הכול שקט.' : 'שום דבר לא מחכה לך. $work';
}

/// The sentence on top: the composer's headline while it was composed after what waits for him last changed
/// (something came in, was answered or put off), else [homeSentence]. With no time from hq (an older one), the
/// newest open item is the last change it knows of. Something burning (an incident, a stuck worker) or a
/// headline older than hq's 30 minutes (a recipe from the cache) always gets the live sentence.
String topSentence(CompanyData d, HomeRecipe? recipe, {required int burning, required int waiting, DateTime? now}) {
  final headline = recipe == null || !recipe.byAgent ? null : recipe.blocks.where((b) => b.type == 'headline').firstOrNull?.text?.trim();
  final fresh = recipe != null && (now ?? CompanyTime.now()).difference(recipe.composedAt) <= const Duration(minutes: 30);
  if (headline != null && headline.isNotEmpty && burning == 0 && fresh) {
    DateTime? changed = recipe.waitingChangedAt;
    for (final w in d.waiting) {
      if ((w.state == WaitState.open || w.state == WaitState.pending) && w.createdAt != null && (changed == null || w.createdAt!.isAfter(changed))) changed = w.createdAt;
    }
    if (changed == null || recipe.composedAt.isAfter(changed)) return headline;
  }
  return homeSentence(d, burning: burning, waiting: waiting);
}

class HomeV2 extends StatelessWidget {
  const HomeV2({super.key, required this.data, required this.now, this.recipe, this.folded = false, this.onToggle});
  final CompanyData data;
  final DateTime now;

  /// v2 conversations, look 2 (convs_v2.dart): only the sentence and what waits; the projects and what
  /// finished open with a tap on the sentence.
  final bool folded;

  /// With it, the sentence is the toggle, with `expand_more` or `expand_less` after it.
  final VoidCallback? onToggle;

  /// hq's recipe; null from an older hq: the same four parts, from live data alone.
  final HomeRecipe? recipe;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = data;
    final blocks = recipe == null ? null : liveBlocks(recipe!, d);
    bool open(WaitItem w) => w.state == WaitState.open || w.state == WaitState.pending;

    // 2. What waits: every open item, live, the same list the project rows and the desktop's home row count,
    // so no part of the screen says otherwise (audit #1). The recipe only orders it: the ones it names first.
    final named = [
      for (final b in blocks ?? const <HomeBlock>[])
        if (b.type == 'alert' || b.type == 'waiting') ...b.inbox,
    ];
    int rank(WaitItem w) {
      final i = w.inboxId == null ? -1 : named.indexOf(w.inboxId!);
      return i < 0 ? named.length : i;
    }
    final live = [for (final w in d.waiting) if (open(w)) w];
    // Stable: the rest keep the data's order.
    final items = [for (final (_, w) in [for (final (i, w) in live.indexed) (i, w)]..sort((a, b) => rank(a.$2) != rank(b.$2) ? rank(a.$2).compareTo(rank(b.$2)) : a.$1.compareTo(b.$1))) w];
    final stuck = [for (final id in d.identities.keys) if (d.presence[id]?.status == WorkerStatus.stuck) id];
    final hot = [for (final w in items) if (HeadData.hot(w)) w];
    final rest = [for (final w in items) if (!HeadData.hot(w)) w];

    // 3. A line for every active project, always (decided 20/10): the recipe's first, in its order and with
    // its notes, then the rest, the busy ones first.
    final lines = blocks?.where((b) => b.type == 'project').toList() ?? const <HomeBlock>[];
    final inRecipe = {for (final b in lines) b.projects.first};
    // The ones nothing moved in during the last day: one line at the end, "שקט גם ב:" (#164, נועה 22/10). The
    // recipe's quiet block when it has one; a project it leaves out, or a home without a recipe, by the data.
    final dayAgo = now.subtract(const Duration(hours: 24));
    bool moved(String id) =>
        d.openTasks.any((t) => t.project == id && t.state == OpenTaskState.running) ||
        d.tickets.any((t) => t.project == id && [t.startedAt, t.doneAt].any((x) => x != null && x.isAfter(dayAgo)));
    final quiet = [
      for (final b in blocks ?? const <HomeBlock>[])
        if (b.type == 'quiet') ...b.projects.where((id) => !inRecipe.contains(id)),
    ];
    final others = [for (final x in projectsByActivity(d)) if (x.active && !inRecipe.contains(x.id) && !quiet.contains(x.id)) x.id];
    quiet.addAll(others.where((id) => !moved(id)));
    final projects = [
      for (final b in lines) (b.projects.first, b.note),
      for (final id in others)
        if (moved(id)) (id, null as String?),
    ];

    // 4. What finished: the recipe's sentences (hq: the last day), else the board's of the last day.
    final since = blocks?.where((b) => b.type == 'since').firstOrNull;
    final done = since != null && recipe!.byAgent
        ? [
            for (final (i, x) in since.items.indexed)
              if ((x.task == null ? null : ticketOf(d, x.task!)) case final t?)
                SinceItem(key: 'since:$i', text: x.text, at: t.doneAt ?? recipe!.composedAt, who: t.assigneeId, opener: t.openedBy, task: x.task)
              else
                SinceItem(key: 'since:$i', text: x.text, at: recipe!.composedAt, task: x.task),
          ]
        : SinceData.of(d, since: now.subtract(const Duration(hours: 24))).items;

    final sentence = topSentence(d, recipe, burning: hot.length + stuck.length, waiting: rest.length, now: now);

    final rows = <(String, Widget)>[
      ('sentence', _Sentence(sentence, open: onToggle == null ? null : !folded, onTap: onToggle)),
      if (hot.isNotEmpty || stuck.isNotEmpty || rest.isNotEmpty)
        (
          'waiting',
          BlockCard(
            label: 'מחכה לך',
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Column(children: [
                if (hot.isNotEmpty || stuck.isNotEmpty) AlertBlock(items: hot, stuck: stuck, now: now),
                if ((hot.isNotEmpty || stuck.isNotEmpty) && rest.isNotEmpty) const BlockHairline(),
                if (rest.isNotEmpty) WaitingBlock(items: rest, now: now),
              ]),
            ),
          )
        ),
      if (projects.isNotEmpty && !folded) ('projects:label', const _Label('הפרויקטים')),
      if (projects.isNotEmpty && !folded)
        (
          'projects',
          BlockCard(
            label: 'הפרויקטים',
            child: Column(children: [
              for (final (i, (id, note)) in projects.indexed) ...[
                if (i > 0) const _Inset(),
                ProjectRowV2(line: ProjectLine.of(d, id), note: note, now: now),
              ],
            ]),
          )
        ),
      if (done.isNotEmpty && !folded) ('done:label', const _Label('הסתיים לאחרונה')),
      if (done.isNotEmpty && !folded) ('done', BlockCard(label: 'הסתיים לאחרונה', child: _Done(items: done.take(3).toList(), now: now))),
      if (quiet.isNotEmpty && !folded) ('quiet', Padding(padding: const EdgeInsets.only(top: 8), child: QuietBlock(projects: quiet, data: d, color: p.bg))),
    ];
    return Semantics(
      container: true,
      label: 'מה חשוב עכשיו',
      explicitChildNodes: true,
      child: Container(
        color: p.bg,
        padding: const EdgeInsets.only(bottom: 8),
        child: BlockColumn(rows: rows),
      ),
    );
  }
}

class _Sentence extends StatelessWidget {
  const _Sentence(this.text, {this.open, this.onTap});
  final String text;

  /// Null: not a toggle. Else whether the home under it is open (`expand_less`) or folded (`expand_more`).
  final bool? open;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final sentence = _plain(context, p);
    if (open == null) return sentence;
    return Semantics(
      button: true,
      expanded: open,
      hint: open! ? 'קיפול הבית' : 'פתיחת הבית',
      child: InkWell(
        onTap: onTap,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: sentence),
          Padding(padding: const EdgeInsetsDirectional.fromSTEB(0, 18, 16, 0), child: Ic(open! ? 'expand_less' : 'expand_more', size: 22, color: p.text2)),
        ]),
      ),
    );
  }

  Widget _plain(BuildContext context, Palette p) {
    return Semantics(
      header: true,
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 20, 8),
        // The full width, so a one-line sentence starts at the start too instead of in the middle.
        child: SizedBox(
          width: double.infinity,
          child: AnimatedSwitcher(
            duration: kBlockMotion,
            layoutBuilder: (cur, prev) => Stack(alignment: AlignmentDirectional.topStart, children: [...prev, ?cur]),
            child: Rich(text, key: ValueKey(text), auto: true, maxLines: 3, style: T.name.copyWith(fontSize: 18, height: 26 / 18, color: p.text)),
          ),
        ),
      ),
    );
  }
}

/// A part's name over its card: quiet, in the secondary color, never a big title.
class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(20, 16, 20, 0),
          // At the start, like every group's name in the app (and WhatsApp's "ארכיון").
          child: Align(alignment: AlignmentDirectional.centerStart, child: Text(text, style: T.section.copyWith(color: context.p.text2))),
        ),
      );
}

/// The line between rows of a card, from where the text starts (the face stands alone).
class _Inset extends StatelessWidget {
  const _Inset();
  @override
  Widget build(BuildContext context) => Padding(padding: const EdgeInsetsDirectional.only(start: 68), child: Container(height: 1, color: context.p.line));
}

/// The project's mark: its icon on a circle in its tone. The name is always beside it.
class ProjectFace extends StatelessWidget {
  const ProjectFace({super.key, required this.symbol, this.tone, this.size = 40});
  final String symbol;
  final String? tone;
  final double size;
  @override
  Widget build(BuildContext context) {
    final (bg, fg) = context.p.identity(tone);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
      child: Ic(symbol, size: size * 0.5, color: fg),
    );
  }
}

/// A project in two lines: tone, icon and name, and how many wait for him; then what runs and who, what is
/// queued, or "שקט" and the last thing that finished. A tap opens the project.
class ProjectRowV2 extends StatelessWidget {
  const ProjectRowV2({super.key, required this.line, required this.now, this.note});
  final ProjectLine line;
  final DateTime now;

  /// The composer's line under it.
  final String? note;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final l = line;
    final project = d.projects.where((x) => x.id == l.id).firstOrNull;
    final tone = d.teams[project?.teamId ?? l.id]?.tone;
    String name(String id) => d.who(id).name;
    final who = l.who.isEmpty ? '' : (l.who.length == 1 ? name(l.who.first) : '${name(l.who.first)} ועוד ${l.who.length - 1}');
    final second = T.small.copyWith(color: p.text2, height: 19 / 13);
    final String icon, word;
    String rest = '';
    String end = '';
    if (l.now != null) {
      (icon, word) = ('play_arrow', 'רץ');
      rest = [l.now!, if (who.isNotEmpty) who, if (l.queued > 0) 'עוד ${l.queued} בתור'].join(' · ');
    } else if (l.queued > 0) {
      (icon, word) = ('schedule', l.queued == 1 ? 'משימה אחת בתור' : '${l.queued} משימות בתור');
    } else {
      (icon, word) = ('bedtime', 'שקט');
      if (l.last != null) rest = 'אחרון: ${l.last}';
      if (l.lastAt != null) end = daysAgo(l.lastAt!, now) == 0 ? hm(l.lastAt!) : (daysAgo(l.lastAt!, now) == 1 ? 'אתמול' : dm(l.lastAt!));
    }
    final waits = l.waiting == 0 ? '' : (l.waiting == 1 ? 'מחכה לך' : '${l.waiting} מחכים לך');
    return Semantics(
      button: true,
      label: [l.name, ?(waits.isEmpty ? null : waits), word, ?(rest.isEmpty ? null : rest), ?(end.isEmpty ? null : end), ?note].join('. '),
      hint: 'פתיחת הפרויקט',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => Nav.project(context, l.id),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 64),
          child: Padding(
            padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              ProjectFace(symbol: l.symbol, tone: tone),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  // The name is whole (T1); the count goes down a line before the name would be cut.
                  Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
                    Text(l.name, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5)),
                    if (waits.isNotEmpty)
                      Row(mainAxisSize: MainAxisSize.min, children: [
                        Ic('front_hand', size: 16, fill: true, color: p.text),
                        const SizedBox(width: 3),
                        Text(waits, style: second.copyWith(color: p.text, fontWeight: FontWeight.w700, fontFeatures: kTabular)),
                      ]),
                  ]),
                  const SizedBox(height: 3),
                  Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Padding(padding: const EdgeInsets.only(top: 2), child: Ic(icon, size: 15, fill: icon == 'play_arrow', color: p.text2)),
                    const SizedBox(width: 4),
                    Expanded(child: WordClamp(lead: word, leadStyle: TextStyle(fontWeight: FontWeight.w700, color: l.now != null ? p.text : p.text2), rest: rest, style: second)),
                    if (end.isNotEmpty) ...[const SizedBox(width: 8), Text(end, style: second.copyWith(fontFeatures: kTabular))],
                  ]),
                  if (note != null) ...[
                    const SizedBox(height: 4),
                    Rich(note!, auto: true, maxLines: 2, style: second.copyWith(color: p.text)),
                  ],
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// "[lead] · [rest]" in [maxLines] lines at most, cut only between words, with "…" after the last whole one
/// (T2): Flutter's own ellipsis cuts inside a word ("…התחנות ע…"). The whole text is a tap away, in the project.
class WordClamp extends StatelessWidget {
  const WordClamp({super.key, required this.lead, required this.rest, required this.style, this.leadStyle, this.maxLines = 2});
  final String lead;
  final String rest;
  final TextStyle style;
  final TextStyle? leadStyle;
  final int maxLines;

  TextSpan _span(String r) => TextSpan(children: [TextSpan(text: lead, style: leadStyle), if (r.isNotEmpty) TextSpan(text: ' · $r')]);

  @override
  Widget build(BuildContext context) {
    final full = DefaultTextStyle.of(context).style.merge(style);
    final dir = Directionality.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(builder: (context, box) {
      bool fits(String r) {
        final tp = TextPainter(text: TextSpan(style: full, children: [_span(r)]), textDirection: dir, textScaler: scaler, maxLines: maxLines)..layout(maxWidth: box.maxWidth);
        final over = tp.didExceedMaxLines;
        tp.dispose();
        return !over;
      }

      final shown = rest.isEmpty ? rest : fitWords(rest.replaceAll(RegExp(r'\s+'), ' '), fits);
      return Text.rich(_span(shown), maxLines: maxLines, overflow: TextOverflow.clip, style: style);
    });
  }
}

/// What finished lately: up to three sentences, each with who did it and when; a tap opens where it leads.
class _Done extends StatelessWidget {
  const _Done({required this.items, required this.now});
  final List<SinceItem> items;
  final DateTime now;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final second = T.small.copyWith(color: p.text2);
    String when(DateTime t) => daysAgo(t, now) == 0 ? hm(t) : (daysAgo(t, now) == 1 ? 'אתמול' : dm(t));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final (i, x) in items.indexed) ...[
          if (i > 0) const _Inset(),
          EntityLink(
            identity: sinceTarget(d, x),
            minHeight: kLinkRow,
            label: [x.text, if (x.who != null) d.who(x.who!).name, when(x.at)].join(', '),
            child: Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(16, 10, 16, 10),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(
                  width: 40,
                  child: Align(
                    alignment: AlignmentDirectional.topStart,
                    child: x.who == null
                        ? SizedBox(width: 34, height: 34, child: Center(child: Ic('check_circle', size: 20, color: p.text2)))
                        : Monogram.of(d, x.who!, size: AvSize.sm, ring: p.dark ? p.surface2 : p.surface),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Rich(x.text, auto: true, maxLines: 2, style: T.row2.copyWith(color: p.text)),
                    const SizedBox(height: 2),
                    Row(children: [
                      // With no face, the face's place already has the icon.
                      if (x.who != null) ...[Ic('check_circle', size: 14, color: p.text2), const SizedBox(width: 4)],
                      Expanded(child: Text([if (x.who != null) d.who(x.who!).name, 'הסתיים'].join(' · '), maxLines: 1, overflow: TextOverflow.ellipsis, style: second)),
                      Text(when(x.at), style: second.copyWith(fontFeatures: kTabular)),
                    ]),
                  ]),
                ),
              ]),
            ),
          ),
        ],
      ]),
    );
  }
}

/// v2 desktop: the home as a place in the main column, as wide as a chat reads.
class HomeV2Page extends StatelessWidget {
  const HomeV2Page({super.key});
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data;
    if (d == null) return const SizedBox.shrink();
    return Container(
      color: p.bg,
      child: Column(children: [
        const TopBar(title: 'בית'),
        Expanded(
          child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [
            Center(child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 720), child: HomeV2(recipe: d.home, data: d, now: CompanyTime.now()))),
          ]),
        ),
      ]),
    );
  }
}

/// v2 desktop: the first row of the chats column, the way into the home. Its second line is the sentence.
class HomeEntryRow extends StatelessWidget {
  const HomeEntryRow({super.key, required this.selected});
  final bool selected;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final d = store.data!;
    final head = HeadData.of(d, since: CompanyTime.now());
    final sentence = topSentence(d, d.home, burning: head.burning.length, waiting: head.waiting.length);
    final waits = head.burning.length + head.waiting.length;
    return Semantics(
      button: true,
      selected: selected,
      label: 'בית. $sentence',
      excludeSemantics: true,
      child: Material(
        color: selected ? p.surface2 : p.surface,
        child: InkWell(
          onTap: () {
            store.homeOpen = true;
            store.touch();
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(
                width: 34,
                height: 34,
                alignment: Alignment.center,
                decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface3),
                child: Ic('home', size: 19, fill: selected, color: p.text),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text('בית', style: T.name.copyWith(color: p.text))),
                    if (waits > 0) ...[
                      Ic('front_hand', size: 16, fill: true, color: p.text),
                      const SizedBox(width: 3),
                      Text(waits == 1 ? 'מחכה לך' : '$waits מחכים לך', style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w700, fontFeatures: kTabular)),
                    ],
                  ]),
                  const SizedBox(height: 2),
                  Rich(sentence, auto: true, maxLines: 1, style: T.small.copyWith(color: p.text2)),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}
