// The conversations screen on the phone (design language v2, mockup company-engine#37, built in task 205): one
// list by latest activity, his own messages too, as in WhatsApp. Yoav stays pinned. A row says who, their team
// or project, the last line ("אתה: " with the delivery ticks when he wrote last), when, and the state when it
// says something. As he approved it (version B, scroll 2): a rounded search field on top, then the home
// (home_v2.dart) as the list's first item, folded: its sentence as one row when nothing waits for him, the
// sentence and "מחכה לך" when something does; a tap opens the rest. Once it has scrolled away its sentence
// stays as one row under the title, and a tap brings the home back.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/motion.dart';
import '../../theme/tokens.dart';
import '../blocks/parts.dart' show kTabular;
import '../common.dart';
import '../nav.dart';
import '../system_bar.dart';
import 'conversations_screen.dart';

/// The list: Yoav first, then by the last message either way, newest first. Only who he has talked with (a
/// message in his last 200, [ConversationSummary.at]); anyone else is in "שיחה חדשה", as in WhatsApp. A task
/// worker shows until its task is done, and after that while something from it is unread; the finished ones live
/// in their project's screen. The search ([withDone]) finds those too: a worker who wrote to him is always reachable.
List<ConversationSummary> convsByActivity(CompanyData d, {bool withDone = false}) {
  final shown = [
    for (final c in d.conversations)
      if (c.identityId != kSystemId && (withDone || !d.isDone(c.identityId) || c.unread > 0) && (c.at != null || c.unread > 0 || c.identityId == d.managerId)) c,
  ];
  final at = {for (final (i, c) in shown.indexed) c.identityId: i};
  int cmp(ConversationSummary a, ConversationSummary b) {
    final pa = a.pinned || a.identityId == d.managerId, pb = b.pinned || b.identityId == d.managerId;
    if (pa != pb) return pa ? -1 : 1;
    if (a.at != null && b.at != null && a.at != b.at) return b.at!.compareTo(a.at!);
    if ((a.at == null) != (b.at == null)) return a.at == null ? 1 : -1;
    return at[a.identityId]!.compareTo(at[b.identityId]!);
  }

  return shown..sort(cmp);
}

/// The first sentence of [s], with its stop: "שום דבר לא מחכה לך. 5 משימות רצות." is "שום דבר לא מחכה לך.". A
/// stop inside a word ("2.6.10") is not the end of one.
String firstSentence(String s) => RegExp(r'^.*?[.!?](?=\s|$)').firstMatch(s.trim())?.group(0) ?? s.trim();

/// "14:02" today, "אתמול", else "20/10", as in WhatsApp.
String whenV2(DateTime t, DateTime now) => switch (daysAgo(t, now)) { 0 => hm(t), 1 => 'אתמול', _ => dm(t) };

/// The text a row shows: no markdown marks (the chat draws them, a one-line preview can't).
String plainLine(String s) => s.replaceAll(RegExp(r'\*\*|__|`'), '').replaceAll(RegExp(r'\s+'), ' ').trim();

final _letter = RegExp(r'[\p{L}\p{N}]', unicode: true);

/// Where [q] first starts a word of [s] (case aside), or -1: "דנה" finds "דנה ביקשה" and "(דנה)", not "עדנה".
/// Only the start of a word (נועה, 21/10): a match inside a word is noise in a list of names.
int wordStart(String s, String q) {
  if (q.isEmpty) return -1;
  final hay = s.toLowerCase(), needle = q.toLowerCase();
  for (var i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (i == 0 || !_letter.hasMatch(hay[i - 1])) return i;
  }
  return -1;
}

class ConversationsV2 extends StatefulWidget {
  const ConversationsV2({super.key});

  @override
  State<ConversationsV2> createState() => _ConversationsV2State();
}

class _ConversationsV2State extends State<ConversationsV2> {
  final scroll = ScrollController();
  final field = TextEditingController();
  final homeKey = GlobalKey();
  /// How far the home has folded into its row, 0 (open) to 1 (the row in full), from the offset.
  final folded = ValueNotifier(0.0);
  String q = '';

  /// The home with its projects and what finished (a tap on its sentence), or folded.
  bool homeOpen = false;
  AppNav? _nav;

  static const _fieldH = 60.0;
  static const _barH = 48.0;

  @override
  void initState() {
    super.initState();
    scroll.addListener(_onScroll);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _nav = NavScope.read(context);
  }

  @override
  void dispose() {
    final nav = _nav;
    if (nav != null && nav.backHandler == _clear) nav.backHandler = null;
    scroll.dispose();
    field.dispose();
    folded.dispose();
    super.dispose();
  }

  /// Where the fold starts and ends in the scroll: the home's last [_barH] going up is the row coming down.
  (double, double)? _zone() {
    final h = homeKey.currentContext?.size?.height;
    if (h == null) return null;
    final end = _fieldH + h;
    return (end - _barH, end);
  }

  // Follows the offset, as iOS folds its large title: no animation of its own while the finger moves.
  void _onScroll() {
    final z = _zone();
    if (z == null || !scroll.hasClients || q.isNotEmpty) {
      folded.value = 0;
      return;
    }
    final t = ((scroll.offset - z.$1) / _barH).clamp(0.0, 1.0);
    // "הפחת תנועה": open or folded, never in between.
    folded.value = Mo.off(context) ? (t >= 0.5 ? 1.0 : 0.0) : t;
  }

  // Stopped half folded: finish to the nearer end, in Mo.sm (נועה, 21/10). A jump without motion when asked.
  bool _onScrollEnd(ScrollNotification n) {
    if (n is! ScrollEndNotification || !scroll.hasClients) return false;
    final z = _zone(), t = folded.value;
    if (z == null || t <= 0 || t >= 1) return false;
    final to = t >= 0.5 ? z.$2 : z.$1;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !scroll.hasClients) return;
      if (Mo.off(context)) {
        scroll.jumpTo(to);
      } else {
        scroll.animateTo(to, duration: Mo.sm, curve: Mo.standard);
      }
    });
    return false;
  }

  void _setQ(String v) {
    setState(() => q = v.trim());
    // Android back clears the search before it leaves the tab.
    NavScope.read(context).setBackHandler(q.isEmpty ? null : _clear);
    _onScroll();
  }

  void _clear() {
    field.clear();
    setState(() => q = '');
    NavScope.read(context).setBackHandler(null);
    FocusScope.of(context).unfocus();
  }

  void _openHome() {
    setState(() => homeOpen = true);
    if (Mo.off(context)) {
      scroll.jumpTo(0);
    } else {
      scroll.animateTo(0, duration: Mo.md, curve: Mo.emphasized);
    }
  }

  /// The list's first item: the home, folded, as one row when nothing waits for him.
  Widget _home(CompanyData d, DateTime now) {
    if (!homeOpen && stuckWorkers(d) == 0) return HomeBarV2(onTap: _openHome, height: _barH);
    return HomeV2(recipe: d.home, data: d, now: now, folded: !homeOpen, onToggle: () => setState(() => homeOpen = !homeOpen));
  }

  @override
  Widget build(BuildContext context) {
    assert(() {
      ConversationsScreen.debugBuilds++;
      return true;
    }());
    final store = StoreScope.of(context);
    final d = store.data;
    final p = context.p;
    if (d == null) return const SizedBox.shrink();
    final now = CompanyTime.now();
    final list = convsByActivity(d);
    final rows = <Widget>[
      for (final (i, c) in list.indexed) ...[
        if (i > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 72), child: Container(height: 1, color: p.line)),
        ConversationRowV2(c: c, now: now, pinned: c.identityId == d.managerId),
      ],
    ];
    final title = TopBar(title: 'שיחות', showLink: true);
    return Stack(children: [
      Column(children: [
        title,
        const SystemBar(),
        Expanded(
          child: Stack(children: [
            NotificationListener<ScrollNotification>(
              onNotification: _onScrollEnd,
              child: CustomScrollView(controller: scroll, slivers: [
              SliverToBoxAdapter(child: _SearchField(controller: field, onChanged: _setQ, onClear: _clear)),
              if (q.isEmpty) ...[
                SliverToBoxAdapter(child: KeyedSubtree(key: homeKey, child: _home(d, now))),
                if (rows.isNotEmpty) SliverToBoxAdapter(child: ColoredBox(color: p.surface, child: Column(children: rows))),
              ] else
                SliverToBoxAdapter(child: SearchResultsV2(q: q, now: now)),
              // Room for "שיחה חדשה" (52, 16 from the bottom) with a gap, so the last row never rests under it.
              const SliverToBoxAdapter(child: SizedBox(height: 52 + 16 + 24)),
            ]),
            ),
            PositionedDirectional(
                top: 0,
                start: 0,
                end: 0,
                // The row comes down from under the title as the home's end goes up under it: same distance,
                // same moment, so the two read as one thing folding.
                child: ValueListenableBuilder(
                  valueListenable: folded,
                  builder: (context, t, _) => t == 0
                      ? const SizedBox.shrink()
                      : ClipRect(
                          child: Align(
                            alignment: Alignment.bottomCenter,
                            heightFactor: t,
                            child: HomeBarV2(onTap: _openHome, height: _barH),
                          ),
                        ),
                ),
              ),
          ]),
        ),
      ]),
      PositionedDirectional(
        end: 16,
        bottom: 16,
        child: Fab(icon: 'edit_square', label: 'שיחה חדשה', onTap: () => newChat(context, d)),
      ),
    ]);
  }
}

/// The search field above the home, rounded, as in WhatsApp.
class _SearchField extends StatelessWidget {
  const _SearchField({required this.controller, required this.onChanged, required this.onClear});
  final TextEditingController controller;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      height: _ConversationsV2State._fieldH,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
      child: Container(
        padding: const EdgeInsetsDirectional.only(start: 14, end: 4),
        // surface2 is the paper's own tone (1.04:1 on it): one step darker, so the field reads as one.
        decoration: BoxDecoration(color: p.surface3, borderRadius: BorderRadius.circular(22)),
        child: Row(children: [
          Ic('search', size: 20, color: p.text2),
          const SizedBox(width: 10),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              textInputAction: TextInputAction.search,
              style: T.body.copyWith(color: p.text),
              decoration: InputDecoration(isCollapsed: true, border: InputBorder.none, hintText: 'חיפוש', hintStyle: T.body.copyWith(color: p.text2)),
            ),
          ),
          ListenableBuilder(
            listenable: controller,
            builder: (context, _) => controller.text.isEmpty ? const SizedBox(width: 40) : IBtn('close', tip: 'ניקוי החיפוש', onTap: onClear),
          ),
        ]),
      ),
    );
  }
}

/// The home folded to its sentence, under the title. Same ground as the screen, no shadow;
/// a tap opens the home again. Only the sentence's first sentence ("5 דברים מחכים לך."): it is a title, never
/// cut (T1), and the rest is a tap away. When even that doesn't fit (text at 130%), it takes a second line.
class HomeBarV2 extends StatelessWidget {
  const HomeBarV2({super.key, required this.onTap, this.height = 48});
  final VoidCallback onTap;
  final double height;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final decisions = d.waitingCount;
    final sentence = firstSentence(fullSentence(d, d.home, stuck: stuckWorkers(d)));
    final chevron = Ic('expand_more', size: 22, color: p.text2);
    final decorated = BoxDecoration(border: Border(bottom: BorderSide(color: p.line)));
    // Something waits for him: the sentence is the way to it (the "החלטות" tab), and the chevron opens the home.
    if (decisions > 0) {
      return Material(
        color: p.bg,
        child: Container(
          constraints: BoxConstraints(minHeight: height),
          decoration: decorated,
          child: Row(children: [
            Expanded(
              child: Semantics(
                button: true,
                label: sentence,
                hint: 'מעבר להחלטות',
                excludeSemantics: true,
                onTap: () => NavScope.read(context).go(AppTab.decisions),
                child: InkWell(
                  onTap: () => NavScope.read(context).go(AppTab.decisions),
                  child: Container(
                    constraints: BoxConstraints(minHeight: height),
                    padding: const EdgeInsetsDirectional.fromSTEB(16, 6, 8, 6),
                    alignment: AlignmentDirectional.centerStart,
                    child: Row(children: [
                      Ic('front_hand', size: 18, fill: true, color: p.text),
                      const SizedBox(width: 8),
                      Expanded(child: Text(sentence, style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w500))),
                    ]),
                  ),
                ),
              ),
            ),
            Semantics(
              button: true,
              label: 'פתיחת הבית',
              excludeSemantics: true,
              onTap: onTap,
              child: InkWell(onTap: onTap, child: SizedBox(width: 52, height: height, child: Center(child: chevron))),
            ),
          ]),
        ),
      );
    }
    return Semantics(
      button: true,
      label: sentence,
      hint: 'פתיחת הבית',
      excludeSemantics: true,
      child: Material(
        color: p.bg,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: BoxConstraints(minHeight: height),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            decoration: decorated,
            child: Row(children: [
              Expanded(child: Text(sentence, style: T.row2.copyWith(color: p.text))),
              const SizedBox(width: 8),
              chevron,
            ]),
          ),
        ),
      ),
    );
  }
}

/// A conversation in two lines, as in WhatsApp: the face in its project's tone, the name and "· team", the
/// time; then the last line, his own as "אתה: " after the ticks. A third line only when the state says
/// something (מחכה לך, עובד, חסום, תקוע). Name and time are never cut (T1); the rest only between words (T2).
class ConversationRowV2 extends StatelessWidget {
  const ConversationRowV2({super.key, required this.c, required this.now, this.pinned = false, this.selected = false});
  final ConversationSummary c;
  final DateTime now;
  final bool pinned;

  /// The conversation open beside the list (the desktop): one step darker, as the home's row is.
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final who = d.who(c.identityId);
    final pr = d.presence[c.identityId] ?? const Presence(status: WorkerStatus.free);
    final team = d.teamOf(c.identityId)?.name ?? '';
    final teamText = team.isEmpty ? '' : (RegExp(r'[֐-׿]').hasMatch(team) ? team : ltr(team));
    final unread = c.unread > 0;
    final loud = unread && !c.muted;
    final time = c.at == null ? c.time : whenV2(c.at!, now);
    final draft = (d.chats[c.identityId]?.draft ?? '').trim();
    final line = plainLine(draft.isNotEmpty ? draft.split('\n').first : (c.text ?? c.lastLine));
    final mine = draft.isEmpty && c.delivery != null;
    final working = pr.status == WorkerStatus.working;
    final showStatus = (statusLoud(pr.status) || working || d.isDone(c.identityId)) && pr.status != WorkerStatus.waiting;
    final lineStyle = T.row2.copyWith(color: unread ? p.text : p.text2, fontWeight: unread ? FontWeight.w500 : null);
    final (String tick, Color tickColor, String tickWord) = switch (c.delivery) {
      Delivery.read || Delivery.handled => ('done_all', p.read, 'נקרא'),
      Delivery.delivered => ('done', p.text3, 'נמסר'),
      Delivery.failed => ('error', p.urgent, 'לא נמסר'),
      _ => ('schedule', p.text2, 'בתור'),
    };
    // The state at the end of the second line, as the count is (נועה, 21/10): only when it says something.
    final statusText = statusWord(pr.status, who.gender);
    final statusColor = statusLoud(pr.status) ? p.text : p.text2;
    // A decision of his waits in "החלטות"; the row says so with the hand alone.
    final decides = (pr.status == WorkerStatus.waiting || d.waiting.any((w) => w.from == c.identityId && (w.state == WaitState.open || w.state == WaitState.pending) && !d.superseded(w)));
    return Semantics(
      button: true,
      label: [
        who.name, if (team.isNotEmpty) team, time,
        if (mine) 'אתה: $line, $tickWord' else if (draft.isNotEmpty) 'טיוטה: $line' else line,
        if (showStatus) statusText,
        if (decides) 'מחכה להחלטה שלך',
        if (unread) c.unread == 1 ? 'הודעה אחת שלא נקראה' : '${c.unread} הודעות שלא נקראו',
        if (c.muted) 'מושתקת',
        if (pinned) 'מוצמדת',
      ].join(', '),
      excludeSemantics: true,
      selected: selected,
      child: Material(
        color: selected ? p.surface2 : p.surface,
        child: InkWell(
          onTap: () => Nav.chat(context, c.identityId),
          onLongPress: () => pickMute(context, c.identityId),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 72),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Monogram.of(d, c.identityId),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
                      Text(who.name, softWrap: false, style: T.name.copyWith(color: p.text)),
                      if (c.muted) ...[const SizedBox(width: 4), Ic('notifications_off', size: 16, color: p.text3)],
                      const SizedBox(width: 6),
                      Expanded(child: teamText.isEmpty ? const SizedBox.shrink() : WordFit(text: '· $teamText', style: T.secondary.copyWith(color: p.text2))),
                      const SizedBox(width: 8),
                      if (pinned) ...[Ic('push_pin', size: 15, color: p.text3), const SizedBox(width: 4)],
                      Text(time, softWrap: false, style: T.meta.copyWith(color: loud ? p.text : p.text3, fontWeight: loud ? FontWeight.w700 : null, fontFeatures: kTabular)),
                    ]),
                    const SizedBox(height: 2),
                    Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      if (mine) ...[Padding(padding: const EdgeInsets.only(top: 2), child: Ic(tick, size: 17, color: tickColor, fill: tick == 'error')), const SizedBox(width: 3)],
                      Expanded(
                        child: WordFit(
                          lead: mine ? 'אתה: ' : (draft.isNotEmpty ? 'טיוטה: ' : null),
                          leadStyle: draft.isNotEmpty && !mine ? TextStyle(color: p.accent, fontWeight: FontWeight.w700) : null,
                          text: line.isEmpty ? ' ' : line,
                          style: lineStyle,
                        ),
                      ),
                      if (showStatus) ...[
                        const SizedBox(width: 8),
                        Padding(padding: const EdgeInsets.only(top: 2), child: Ic(statusIcon(pr.status), size: 16, fill: true, color: statusColor)),
                        const SizedBox(width: 3),
                        Text(statusText, softWrap: false, style: T.small.copyWith(height: 21 / 13, color: statusColor, fontWeight: statusLoud(pr.status) ? FontWeight.w700 : null)),
                      ],
                      if (decides) ...[const SizedBox(width: 8), Padding(padding: const EdgeInsets.only(top: 2), child: Ic('front_hand', size: 17, fill: true, color: p.text))],
                      if (unread) ...[const SizedBox(width: 8), Padding(padding: const EdgeInsets.only(top: 1), child: UnreadPill(c.unread, muted: c.muted))],
                    ]),
                  ]),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// While he types: the conversations whose name, title or team has a word that starts with it, then the
/// messages that have one, each with its conversation's face and when. Content is what the app holds: his
/// last 200 messages both ways.
class SearchResultsV2 extends StatelessWidget {
  const SearchResultsV2({super.key, required this.q, required this.now});
  final String q;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    bool hit(String s) => wordStart(s, q) >= 0;
    final convs = [
      for (final c in convsByActivity(d, withDone: true))
        if (hit('${d.who(c.identityId).name} ${d.who(c.identityId).title} ${d.teamOf(c.identityId)?.name ?? ''}')) c,
    ];
    final lines = [for (final r in d.recent) if (hit(plainLine(r.text))) r].take(30).toList();
    if (convs.isEmpty && lines.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(24, 32, 24, 0),
        child: Text('לא נמצאה שיחה או הודעה עם "$q"', textAlign: TextAlign.center, style: T.row2.copyWith(color: p.text2)),
      );
    }
    Widget label(String s) => Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 16, 16, 6),
          child: Align(alignment: AlignmentDirectional.centerStart, child: Text(s, style: T.section.copyWith(color: p.text2))),
        );
    Widget hairline() => Padding(padding: const EdgeInsetsDirectional.only(start: 72), child: Container(height: 1, color: p.line));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (convs.isNotEmpty) ...[
        label('שיחות'),
        ColoredBox(
          color: p.surface,
          child: Column(children: [
            for (final (i, c) in convs.indexed) ...[if (i > 0) hairline(), ConversationRowV2(c: c, now: now, pinned: c.identityId == d.managerId)],
          ]),
        ),
      ],
      if (lines.isNotEmpty) ...[
        label('הודעות'),
        ColoredBox(
          color: p.surface,
          child: Column(children: [
            for (final (i, r) in lines.indexed) ...[if (i > 0) hairline(), _MessageHit(line: r, q: q, now: now)],
          ]),
        ),
      ],
    ]);
  }
}

class _MessageHit extends StatelessWidget {
  const _MessageHit({required this.line, required this.q, required this.now});
  final RecentLine line;
  final String q;
  final DateTime now;
  @override
  Widget build(BuildContext context) {
    final d = StoreScope.of(context).data!;
    final p = context.p;
    final text = plainLine(line.text);
    final style = T.row2.copyWith(color: p.text2);
    return InkWell(
      onTap: () => Nav.chat(context, line.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Monogram.of(d, line.id),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text(d.who(line.id).name, softWrap: false, style: T.name.copyWith(color: p.text))),
                const SizedBox(width: 8),
                Text(whenV2(line.at, now), softWrap: false, style: T.meta.copyWith(color: p.text3, fontFeatures: kTabular)),
              ]),
              const SizedBox(height: 2),
              WordFit(lead: line.mine ? 'אתה: ' : null, text: text, mark: q, maxLines: 2, style: style, markStyle: TextStyle(color: p.text, fontWeight: FontWeight.w700)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// [lead] then [text] in [maxLines] lines at most, cut only between words with "…" (T2): Flutter's own
/// ellipsis cuts inside a word ([fitWords]). With [mark], the first match is bold, and a match too far in starts the
/// text a few words before it, after "…". The text is isolated in its own direction ([paragraphDirection]), so a Latin line keeps its order.
class WordFit extends StatelessWidget {
  const WordFit({super.key, required this.text, required this.style, this.lead, this.leadStyle, this.mark, this.markStyle, this.maxLines = 1});
  final String text;
  final TextStyle style;
  final String? lead;
  final TextStyle? leadStyle;
  final String? mark;
  final TextStyle? markStyle;
  final int maxLines;

  TextSpan _span(String t) {
    final m = mark == null ? -1 : wordStart(t, mark!);
    return TextSpan(children: [
      if (lead != null) TextSpan(text: lead, style: leadStyle),
      // The direction of the whole text, not of its first letter: "GO לפרודקשן" is Hebrew.
      TextSpan(text: paragraphDirection(text) == TextDirection.rtl ? kRLI : kLRI),
      if (m < 0)
        TextSpan(text: t)
      else ...[
        TextSpan(text: t.substring(0, m)),
        TextSpan(text: t.substring(m, m + mark!.length), style: markStyle),
        TextSpan(text: t.substring(m + mark!.length)),
      ],
      const TextSpan(text: kPDI),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final full = DefaultTextStyle.of(context).style.merge(style);
    final dir = Directionality.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(builder: (context, box) {
      bool fits(String t) {
        final tp = TextPainter(text: TextSpan(style: full, children: [_span(t)]), textDirection: dir, textScaler: scaler, maxLines: maxLines)..layout(maxWidth: box.maxWidth);
        final over = tp.didExceedMaxLines || (maxLines == 1 && tp.width > box.maxWidth);
        tp.dispose();
        return !over;
      }

      var words = text.split(' ');
      var head = '';
      // A match past the first line or so: start a few words before it.
      if (mark != null && mark!.isNotEmpty) {
        final at = words.indexWhere((w) => wordStart(w, mark!) >= 0);
        if (at > 4 && !fits(words.take(at + 1).join(' '))) {
          words = words.sublist(at - 3);
          head = '…';
        }
      }
      final shown = fitWords(words.join(' '), fits, head: head);
      return Text.rich(_span(shown), maxLines: maxLines, softWrap: maxLines > 1, overflow: TextOverflow.clip, style: style);
    });
  }
}
