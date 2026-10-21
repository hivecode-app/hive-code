// The head of the conversations screen, drawn from hq's recipe (GET /api/home, model/home_recipe.dart).
// The recipe says which blocks, in what order and in what words; each block is drawn by its own fixed
// component and filled from the live data on this device, so whoever composes can't make it look bad.
// Live data wins here too: a block whose item closed since hq answered is gone at once, without waiting
// for the next recipe. Between recipes the blocks move: what stays keeps its place, what leaves folds
// up, what comes in opens, and a block that changed place leaves its old place and opens in the new one.
// Under it, quietly, who arranged it and when ("סודר ע״י עדי · 21:40").
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../model/home_recipe.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../blocks/blocks.dart';
import '../entity_link.dart';
import 'head.dart';

const _kMotion = kBlockMotion;
const _kCurve = kBlockCurve;

/// What [recipe] shows on this device now: its blocks with live data applied (closed items gone, empty
/// blocks dropped). Pure, for tests.
List<HomeBlock> liveBlocks(HomeRecipe recipe, CompanyData d) {
  final open = {
    for (final w in d.waiting)
      if ((w.state == WaitState.open || w.state == WaitState.pending) && w.inboxId != null) w.inboxId!: w,
  };
  final projects = {for (final p in d.projects) p.id};
  final out = <HomeBlock>[];
  for (final b in recipe.blocks) {
    switch (b.type) {
      case 'alert':
        if (b.inbox.isNotEmpty ? open.containsKey(b.inbox.first) : shiftAlertLine(d, b.shift) != null) out.add(b);
      case 'waiting':
        final ids = [for (final i in b.inbox) if (open.containsKey(i)) i];
        if (ids.isNotEmpty) out.add(b.copyWith(inbox: ids));
      case 'lanes' || 'quiet':
        final ids = projects.isEmpty ? b.projects : [for (final p in b.projects) if (projects.contains(p)) p];
        if (ids.isNotEmpty) out.add(b.copyWith(projects: ids));
      case 'project':
        if (projects.isEmpty || projects.contains(b.projects.firstOrNull)) out.add(b);
      case 'asked':
        // A request he read the answer to is gone; one the recipe names that this device doesn't know, too.
        final asked = {for (final a in d.asked) a.id};
        final ids = [for (final m in b.messages) if (asked.contains(m)) m];
        if (ids.isNotEmpty) out.add(b.copyWith(messages: ids));
      case 'people':
        final ids = [for (final i in b.identities) if (d.identities.containsKey(i)) i];
        if (ids.isNotEmpty) out.add(b.copyWith(identities: ids));
      case 'tasks':
        // "open" follows the list; a named task leaves when it is done.
        if (b.allOpen) {
          if (d.openTasks.isNotEmpty) out.add(b);
        } else {
          final openIds = {for (final t in d.openTasks) t.id};
          final ids = [for (final i in b.tasks) if (openIds.contains(i)) i];
          if (ids.isNotEmpty) out.add(b.copyWith(tasks: ids));
        }
      default:
        out.add(b);
    }
  }
  return out;
}

/// The identity of a shift id (`<identity>-<n>`).
String shiftIdentity(String shift) => shift.replaceFirst(RegExp(r'-\d+$'), '');

/// The worker a shift alert points at, while it is still stuck; null once it isn't.
String? shiftAlertLine(CompanyData d, String? shift) {
  if (shift == null) return null;
  final id = shiftIdentity(shift);
  return d.presence[id]?.status == WorkerStatus.stuck ? id : null;
}

/// "סודר ע״י עדי · 21:40", or for hq's own shape "סדר קבוע".
String composedLine(HomeRecipe r, CompanyData d) {
  if (!r.byAgent) return 'סדר קבוע';
  final who = r.composedBy == 'owner' ? 'אותך' : d.who(r.composedBy).name;
  return 'סודר ע״י $who · ${hm(r.composedAt)}';
}

class HomeBlocks extends StatelessWidget {
  const HomeBlocks({super.key, required this.recipe, required this.data, required this.now, required this.since});
  final HomeRecipe recipe;
  final CompanyData data;
  final DateTime now;

  /// His last visit: "מאז שהיית פה" in hq's default counts from here.
  final DateTime since;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final blocks = liveBlocks(recipe, data);
    // Two blocks of one kind (two notes) are two rows: the second of a key gets its count.
    final seen = <String, int>{};
    final rows = <(String, Widget)>[
      for (final g in _groups(blocks))
        if (_GroupView.build(context, g, data, recipe, now, since) case final w?) (_unique(seen, g.key), w),
    ];
    return Semantics(
      container: true,
      label: 'מה חשוב עכשיו',
      explicitChildNodes: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        BlockColumn(rows: rows),
        if (rows.isNotEmpty)
          Container(
            color: p.surface,
            padding: const EdgeInsetsDirectional.fromSTEB(20, 0, 20, 10),
            child: AnimatedSwitcher(
              duration: _kMotion,
              child: Text(composedLine(recipe, data), key: ValueKey('${recipe.version}:${recipe.source}'), style: T.meta.copyWith(color: p.text3)),
            ),
          ),
      ]),
    );
  }
}

String _unique(Map<String, int> seen, String key) {
  final n = seen[key] = (seen[key] ?? 0) + 1;
  return n == 1 ? key : '$key#$n';
}

/// What shares one card: consecutive alert and waiting blocks ("מה צריך ממך", the way the card always
/// looked), and consecutive project lines. Every other block has a card of its own; a headline has none.
class _Group {
  _Group(this.kind, this.blocks);
  final String kind;
  final List<HomeBlock> blocks;
  String get key => blocks.length == 1 ? blocks.first.key : '$kind:${blocks.map((b) => b.key).join('+')}';
}

String _kindOf(HomeBlock b) => switch (b.type) { 'alert' || 'waiting' => 'card', 'project' => 'projects', _ => b.type };

List<_Group> _groups(List<HomeBlock> blocks) {
  final out = <_Group>[];
  for (final b in blocks) {
    final k = _kindOf(b);
    if ((k == 'card' || k == 'projects') && out.isNotEmpty && out.last.kind == k) {
      out.last.blocks.add(b);
    } else {
      out.add(_Group(k, [b]));
    }
  }
  return out;
}

class _GroupView {
  /// The group's card, or null when there is nothing to draw in it (a stuck worker who came back, say).
  static Widget? build(BuildContext context, _Group g, CompanyData d, HomeRecipe recipe, DateTime now, DateTime since) {
    final byInbox = {for (final w in d.waiting) if (w.inboxId != null) w.inboxId!: w};
    Widget card(String label, List<Widget> parts) => BlockCard(
          label: label,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(children: [
              for (final (i, w) in parts.indexed) ...[if (i > 0) const BlockHairline(), w],
            ]),
          ),
        );
    switch (g.kind) {
      case 'card':
        final parts = <Widget>[];
        for (final b in g.blocks) {
          final items = [for (final i in b.inbox) ?byInbox[i]];
          if (b.type == 'alert') {
            final stuck = shiftAlertLine(d, b.shift);
            parts.add(AlertBlock(items: items, stuck: [?stuck], now: now));
          } else {
            // A burning item a composer put under "waiting" still burns: it goes above, as in the card.
            final hot = [for (final w in items) if (HeadData.hot(w)) w];
            if (hot.isNotEmpty) parts.add(AlertBlock(items: hot, now: now));
            final rest = [for (final w in items) if (!HeadData.hot(w)) w];
            if (rest.isNotEmpty) parts.add(WaitingBlock(items: rest, now: now));
          }
        }
        return parts.isEmpty ? null : card('מה צריך ממך', parts);
      case 'projects':
        return card('הפרויקטים', [
          for (final b in g.blocks)
            ProjectBlock(
              data: b.note == null ? ProjectLine.of(d, b.projects.first) : ProjectLine.fromJson({...ProjectLine.of(d, b.projects.first).toJson(), 'note': b.note}),
              now: now,
            ),
        ]);
    }
    final b = g.blocks.single;
    switch (b.type) {
      case 'headline':
        return Headline(text: b.text ?? '', emphasis: b.emphasis);
      case 'lanes':
        return BlockCard(label: 'פסי היום', child: LanesBlock(data: LanesData.of(d, now: now, projects: b.projects)));
      case 'people':
        final all = PeopleData.of(d).people;
        final people = [
          for (final id in b.identities) all.where((x) => x.id == id).firstOrNull ?? PersonNow(id: id, text: d.presence[id]?.activity ?? d.who(id).title, status: d.presence[id]?.status ?? WorkerStatus.free),
        ];
        return BlockCard(
          label: b.caption ?? 'מי עובד עכשיו',
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (b.caption != null) Padding(padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 0), child: Text(b.caption!, style: T.small.copyWith(color: context.p.text2))),
            PeopleBlock(data: PeopleData(people: people)),
          ]),
        );
      case 'since':
        // hq's own "since" is live: what finished after his last visit (two of it), with who and when. A composer's is her
        // sentences, as of when she wrote them; one that names its task has the face, the time and the tap of it.
        final data = recipe.byAgent
            ? SinceData(since: since, items: [
                for (final (i, x) in b.items.indexed)
                  if ((x.task == null ? null : ticketOf(d, x.task!)) case final t?)
                    SinceItem(key: 'since:$i:${x.text}', text: x.text, at: t.doneAt ?? recipe.composedAt, who: t.assigneeId, opener: t.openedBy, task: x.task)
                  else
                    SinceItem(key: 'since:$i:${x.text}', text: x.text, at: recipe.composedAt, task: x.task),
              ])
            : SinceData.of(d, since: since);
        if (data.items.isEmpty) return null;
        return BlockCard(label: 'מאז שהיית פה', child: SinceBlock(data: data, now: now, max: recipe.byAgent ? 3 : 2));
      case 'quiet':
        // No card: a quiet line at the end.
        return QuietBlock(projects: b.projects, data: d);
      case 'note':
        return BlockCard(child: NoteBlock(data: NoteData(text: b.text ?? '', icon: b.icon, from: recipe.byAgent ? recipe.composedBy : null)));
      case 'tasks':
        final tasks = openTasksOf(d, b.allOpen ? null : b.tasks);
        if (tasks.isEmpty) return null;
        return BlockCard(label: 'בעבודה ובתור', child: TasksBlock(tasks: tasks, now: now));
      case 'awaiting':
        final data = AwaitingData.of(d, b.tasks);
        if (data.items.isEmpty) return null;
        return BlockCard(label: 'מה לבדוק', child: AwaitingBlock(data: data, now: now));
      case 'asked':
        final data = AskedData.of(d, b.messages);
        if (data.items.isEmpty) return null;
        return BlockCard(label: 'ביקשת', child: AskedBlock(data: data, now: now));
    }
    return null;
  }
}

/// The composer's one sentence at the top. Emphasis is type only: size and weight, never color.
class Headline extends StatelessWidget {
  const Headline({super.key, required this.text, this.emphasis = Emphasis.normal});
  final String text;
  final Emphasis emphasis;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final style = switch (emphasis) {
      Emphasis.strong => T.bar.copyWith(color: p.text),
      Emphasis.normal => T.name.copyWith(fontSize: 17, height: 24 / 17, color: p.text),
      Emphasis.quiet => T.row2.copyWith(color: p.text2),
    };
    return Semantics(
      header: true,
      child: Container(
        color: p.surface,
        padding: const EdgeInsetsDirectional.fromSTEB(20, 12, 20, 4),
        child: AnimatedSwitcher(
          duration: _kMotion,
          layoutBuilder: (cur, prev) => Stack(alignment: AlignmentDirectional.topStart, children: [...prev, ?cur]),
          child: Rich(text, key: ValueKey('$text:${emphasis.name}'), auto: true, style: style),
        ),
      ),
    );
  }
}

/// A column of keyed rows that move between versions: a new row opens, a gone one folds up, one that
/// changed place leaves its old place and opens in the new one (AnimatedList's insert and remove, by key).
class BlockColumn extends StatefulWidget {
  const BlockColumn({super.key, required this.rows});
  final List<(String, Widget)> rows;

  @override
  State<BlockColumn> createState() => _BlockColumnState();
}

class _Entry {
  _Entry(this.id, this.key, this.child, this.c);

  /// Unique per appearance: a row that moved has a new entry in its new place while the old one leaves.
  final int id;
  final String key;
  Widget child;
  final AnimationController c;
  bool leaving = false;
}

class _BlockColumnState extends State<BlockColumn> with TickerProviderStateMixin {
  int _ids = 0;
  late List<_Entry> _entries = [for (final (k, w) in widget.rows) _Entry(_ids++, k, w, _controller(1))];

  AnimationController _controller(double value) => AnimationController(vsync: this, duration: _kMotion, value: value);

  /// The longest run of rows that kept their relative order: those stay put, every other one moved.
  static Set<String> _stayed(List<String> before, List<String> after) {
    final common = [for (final k in after) if (before.contains(k)) k];
    final idx = [for (final k in common) before.indexOf(k)];
    // Longest increasing subsequence over the old positions (n is a dozen at most).
    final len = List.filled(idx.length, 1), prev = List.filled(idx.length, -1);
    for (var i = 0; i < idx.length; i++) {
      for (var j = 0; j < i; j++) {
        if (idx[j] < idx[i] && len[j] + 1 > len[i]) {
          len[i] = len[j] + 1;
          prev[i] = j;
        }
      }
    }
    var best = -1;
    for (var i = 0; i < idx.length; i++) {
      if (best < 0 || len[i] > len[best]) best = i;
    }
    final out = <String>{};
    for (var i = best; i >= 0; i = prev[i]) {
      out.add(common[i]);
    }
    return out;
  }

  @override
  void didUpdateWidget(BlockColumn old) {
    super.didUpdateWidget(old);
    final live = [for (final e in _entries) if (!e.leaving) e];
    final stayed = _stayed([for (final e in live) e.key], [for (final (k, _) in widget.rows) k]);
    final byKey = {for (final e in live) e.key: e};
    final wanted = {for (final (k, _) in widget.rows) k};
    // Leaving: gone from the recipe, or moved (its new place gets a fresh entry below).
    for (final e in live) {
      if (!wanted.contains(e.key) || !stayed.contains(e.key)) _leave(e);
    }
    // Rebuild the order: the new rows in recipe order, each leaving one kept right where it was.
    final next = <_Entry>[];
    var cursor = 0;
    void flushLeavingUpTo(_Entry? anchor) {
      while (cursor < _entries.length && _entries[cursor] != anchor) {
        if (_entries[cursor].leaving) next.add(_entries[cursor]);
        cursor++;
      }
      if (anchor != null && cursor < _entries.length) cursor++;
    }

    for (final (k, w) in widget.rows) {
      final e = byKey[k];
      if (e != null && stayed.contains(k)) {
        flushLeavingUpTo(e);
        e.child = w;
        next.add(e);
      } else {
        next.add(_Entry(_ids++, k, w, _controller(0))..c.forward());
      }
    }
    flushLeavingUpTo(null);
    _entries = next;
  }

  void _leave(_Entry e) {
    if (e.leaving) return;
    e.leaving = true;
    e.c.reverse().whenComplete(() {
      if (!mounted) return;
      setState(() => _entries.remove(e));
      e.c.dispose();
    });
  }

  @override
  void dispose() {
    for (final e in _entries) {
      e.c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        for (final e in _entries)
          KeyedSubtree(
            key: ValueKey(e.id),
            child: SizeTransition(
              sizeFactor: CurvedAnimation(parent: e.c, curve: _kCurve),
              alignment: AlignmentDirectional.topCenter,
              child: FadeTransition(
                opacity: e.c,
                child: IgnorePointer(ignoring: e.leaving, child: ExcludeSemantics(excluding: e.leaving, child: e.child)),
              ),
            ),
          ),
      ]);
}
