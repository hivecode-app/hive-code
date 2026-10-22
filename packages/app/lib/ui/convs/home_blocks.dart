// hq's recipe for the home (GET /api/home, model/home_recipe.dart) on this device: which of its blocks are still
// live (a block whose item closed since hq answered is gone at once, without waiting for the next recipe), and
// the column the home's parts move in: what stays keeps its place, what leaves folds up, what comes in opens.
// HomeV2 (home_v2.dart) draws it.
import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../model/home_recipe.dart';
import '../../model/models.dart';
import '../blocks/blocks.dart';

const _kMotion = kBlockMotion;
const _kCurve = kBlockCurve;

/// What [recipe] shows on this device now: its blocks with live data applied (closed items gone, empty
/// blocks dropped, and the ones about decisions skipped: they are the "החלטות" tab's). Pure, for tests.
List<HomeBlock> liveBlocks(HomeRecipe recipe, CompanyData d) {
  final projects = {for (final p in d.projects) p.id};
  final out = <HomeBlock>[];
  for (final b in recipe.blocks) {
    switch (b.type) {
      case 'alert':
        // A fault with no decision (a stuck worker). One on an inbox item is a decision: it waits in "החלטות".
        if (b.inbox.isEmpty && shiftAlertLine(d, b.shift) != null) out.add(b);
      case 'waiting' || 'asked' || 'awaiting':
        // Decisions are not on the home (task 306); a recipe from before that still names them.
      case 'lanes' || 'quiet':
        final ids = projects.isEmpty ? b.projects : [for (final p in b.projects) if (projects.contains(p)) p];
        if (ids.isNotEmpty) out.add(b.copyWith(projects: ids));
      case 'project':
        if (projects.isEmpty || projects.contains(b.projects.firstOrNull)) out.add(b);
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
