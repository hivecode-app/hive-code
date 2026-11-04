import 'package:agent_company/l10n/ui_copy.dart';
// The tables under the company map: quiet tables in Stripe's manner, tabular figures, one chart only where a
// table can't say it (when in the day each worker worked).
import 'package:flutter/material.dart';

import '../../theme/tokens.dart';
import '../common.dart';
import '../../model/map_day.dart';

const _tab = [FontFeature.tabularFigures()];

Map<String, String> get _kindName => {
  'small-fix': UiCopy.text(439),
  'feature': UiCopy.text(440),
  'investigation': UiCopy.text(441),
  'report': UiCopy.text(442),
  'build': UiCopy.text(443),
  'deploy': UiCopy.text(444),
  'release': UiCopy.text(445),
};

class MapStats extends StatelessWidget {
  const MapStats({super.key, required this.day});
  final MapDay day;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 960;
      final side = [
        _projects(context),
        const SizedBox(height: 36),
        _shipped(context),
        const SizedBox(height: 36),
        _estimates(context),
      ];
      return Padding(
        padding: EdgeInsets.symmetric(horizontal: wide ? 24 : 16),
        child: wide
            ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(flex: 11, child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: side)),
                const SizedBox(width: 48),
                Expanded(flex: 13, child: _Workers(day: day)),
              ])
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [...side, const SizedBox(height: 36), _Workers(day: day)]),
      );
    });
  }

  Widget _project(BuildContext context, String id) {
    final t = day.teams.where((t) => t.id == id).firstOrNull;
    if (t == null) return Text(id, style: T.row2.copyWith(color: context.p.text), textDirection: TextDirection.ltr);
    return Row(children: [
      Monogram(letter: '', symbol: t.symbol, size: AvSize.xs, tone: t.tone, toned: true),
      const SizedBox(width: 10),
      Flexible(child: Text(t.name, style: T.row2.copyWith(color: context.p.text))),
    ]);
  }

  Widget _projects(BuildContext context) {
    final rows = [...day.projects.where((r) => r.opened + r.done + r.open > 0)]..sort((a, b) => b.done.compareTo(a.done));
    return QuietTable(
      title: UiCopy.text(446),
      head:  [UiCopy.text(382), UiCopy.text(447), UiCopy.text(448), UiCopy.text(449)],
      flex: const [5, 2, 2, 3],
      rows: [for (final r in rows) [_project(context, r.project), _num(context, r.opened), _num(context, r.done), _num(context, r.open)]],
      total: [UiCopy.text(450), _sum(rows.map((r) => r.opened)), _sum(rows.map((r) => r.done)), _sum(rows.map((r) => r.open))],
    );
  }

  Widget _shipped(BuildContext context) {
    final merges = <String, int>{}, deploys = <String, int>{};
    for (final m in day.marks) {
      if (m.kind == 'merge') merges.update(m.project ?? '', (n) => n + 1, ifAbsent: () => 1);
      if (m.kind == 'deploy') deploys.update(m.project ?? '', (n) => n + 1, ifAbsent: () => 1);
    }
    final keys = {...merges.keys, ...deploys.keys}.toList()
      ..sort((a, b) => ((merges[b] ?? 0) + (deploys[b] ?? 0)).compareTo((merges[a] ?? 0) + (deploys[a] ?? 0)));
    // What has no project of ours (a merge in a repo outside the projects) folds into one row.
    final known = keys.where((k) => day.teams.any((t) => t.id == k)).toList();
    final other = keys.where((k) => !known.contains(k)).toList();
    final otherM = other.fold(0, (s, k) => s + (merges[k] ?? 0));
    return QuietTable(
      title: UiCopy.text(451),
      head:  [UiCopy.text(382), UiCopy.text(432), UiCopy.text(434)],
      flex: const [5, 2, 2],
      rows: [
        for (final k in known) [_project(context, k), _num(context, merges[k] ?? 0), _num(context, deploys[k] ?? 0)],
        if (other.isNotEmpty)
          [
            Text(UiCopy.text(452), style: T.row2.copyWith(color: context.p.text2)),
            _num(context, otherM),
            _num(context, other.fold(0, (s, k) => s + (deploys[k] ?? 0))),
          ],
      ],
      total: [UiCopy.text(450), '${merges.values.fold(0, (a, b) => a + b)}', '${deploys.values.fold(0, (a, b) => a + b)}'],
    );
  }

  Widget _estimates(BuildContext context) {
    final rows = [...day.estimates]..sort((a, b) => b.n.compareTo(a.n));
    String ratio(double? r) => r == null ? '' : '${(r * 100).round()}%';
    return QuietTable(
      title: UiCopy.text(453),
      note: UiCopy.text(454),
      head:  [UiCopy.text(316), UiCopy.text(455), UiCopy.text(456), UiCopy.text(457), UiCopy.text(458), UiCopy.text(459)],
      flex: const [4, 2, 2, 2, 2, 2],
      rows: [
        for (final r in rows)
          [
            Text(_kindName[r.kind] ?? r.kind, style: T.row2.copyWith(color: context.p.text)),
            _num(context, r.n),
            _num(context, r.onTime),
            _num(context, r.late),
            _num(context, r.open),
            _cell(context, ratio(r.ratio)),
          ],
      ],
    );
  }
}

String _sum(Iterable<int> xs) => '${xs.fold(0, (a, b) => a + b)}';

Widget _num(BuildContext context, int n) => _cell(context, '$n', dim: n == 0);

Widget _cell(BuildContext context, String s, {bool dim = false}) =>
    Text(s, textAlign: TextAlign.end, style: T.row2.copyWith(color: dim ? context.p.text3 : context.p.text, fontFeatures: _tab));

/// A Stripe-style table: a bold title, small grey heads, hairline rows, numbers at the end in tabular figures.
class QuietTable extends StatelessWidget {
  const QuietTable({super.key, required this.title, required this.head, required this.flex, required this.rows, this.total, this.note, this.footer});
  final String title;
  final String? note;
  final List<String> head;
  final List<int> flex;
  final List<List<Widget>> rows;
  final List<String>? total;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    Widget row(List<Widget> cells, {double v = 11}) => Container(
          padding: EdgeInsets.symmetric(vertical: v),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
          child: Row(children: [
            for (var i = 0; i < cells.length; i++)
              Expanded(flex: flex[i], child: Padding(padding: EdgeInsetsDirectional.only(start: i == 0 ? 0 : 12), child: cells[i])),
          ]),
        );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(title, style: T.name.copyWith(color: p.text)),
      if (note != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(note!, style: T.meta.copyWith(color: p.text3))),
      const SizedBox(height: 10),
      row([
        for (var i = 0; i < head.length; i++)
          Text(head[i], textAlign: i == 0 ? TextAlign.start : TextAlign.end, style: T.meta.copyWith(color: p.text3)),
      ], v: 7),
      for (final r in rows) row(r),
      if (total != null)
        row([
          for (var i = 0; i < total!.length; i++)
            Text(total![i], textAlign: i == 0 ? TextAlign.start : TextAlign.end, style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w500, fontFeatures: _tab)),
        ]),
      ?footer,
    ]);
  }
}

class _Workers extends StatefulWidget {
  const _Workers({required this.day});
  final MapDay day;

  @override
  State<_Workers> createState() => _WorkersState();
}

class _WorkersState extends State<_Workers> {
  bool all = false;

  /// How long it took, as he reads it: "40 שנ'", "3 דק'", "1.5 שע'".
  static String took(int ms) {
    if (ms < 60000) return UiCopy.text(272, [(ms / 1000).round()]);
    if (ms < 3600000) return UiCopy.text(460, [(ms / 60000).round()]);
    return UiCopy.text(461, [(ms / 3600000).toStringAsFixed(1)]);
  }

  /// His messages to this worker and what came back: the time to the first answer (median), or that none came.
  static String answer(WorkerStat w) {
    if (w.answerMs != null) return took(w.answerMs!);
    return w.asked > 0 ? UiCopy.text(462) : '';
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = widget.day;
    final ws = [...d.workers.where((w) => d.people.containsKey(w.id) && w.workMs > 0)]..sort((a, b) => b.workMs.compareTo(a.workMs));
    final shown = all ? ws : ws.take(12).toList();
    Widget who(WorkerStat w) {
      final x = d.people[w.id]!;
      final team = d.team(x.team);
      return Row(children: [
        x.role == MapRole.owner ? Monogram(letter: x.mono, size: AvSize.xs) : Monogram(letter: x.mono, size: AvSize.xs, tone: team.tone, toned: true),
        const SizedBox(width: 10),
        Flexible(child: Text(x.name, maxLines: 1, overflow: TextOverflow.visible, softWrap: false, style: T.row2.copyWith(color: p.text))),
        const SizedBox(width: 6),
        Flexible(child: Text(team.name, maxLines: 1, softWrap: false, overflow: TextOverflow.fade, style: T.meta.copyWith(color: p.text3))),
      ]);
    }

    // On a narrow screen (a phone upright) the hours and the strip go: what is left is who, how much, and how fast.
    return LayoutBuilder(builder: (context, c) {
      final narrow = c.maxWidth < 520;
      return QuietTable(
        title: UiCopy.text(463),
        note: UiCopy.text(465, [narrow ? '' : UiCopy.text(464)]),
        head: narrow ?  [UiCopy.text(86), UiCopy.text(421), UiCopy.text(466)] :  [UiCopy.text(86), UiCopy.text(467), UiCopy.text(421), UiCopy.text(466), UiCopy.text(468)],
        flex: narrow ? const [7, 3, 5] : const [7, 2, 3, 4, 6],
        rows: [
          for (final w in shown)
            narrow
                ? [who(w), _cell(context, '${w.inbox + w.out}'), _cell(context, answer(w), dim: w.answerMs == null)]
                : [who(w), _cell(context, (w.workMs / 3600000).toStringAsFixed(1)), _cell(context, '${w.inbox + w.out}'), _cell(context, answer(w), dim: w.answerMs == null), _Strip(w.hourly)],
        ],
        footer: ws.length > 12
            ? InkWell(
                onTap: () => setState(() => all = !all),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Row(children: [
                    Text(all ? UiCopy.text(469) : UiCopy.text(470, [ws.length - 12]), style: T.row2.copyWith(color: p.accent)),
                    Ic(all ? 'expand_less' : 'expand_more', size: 20, color: p.accent),
                  ]),
                ),
              )
            : null,
      );
    });
  }
}

/// 24 cells, one an hour. Left to right like the timeline (a clock runs that way in Hebrew too). One hue,
/// light to dark (dataviz: sequential); an hour with no shift is the empty surface.
class _Strip extends StatelessWidget {
  const _Strip(this.hourly);
  final List<double> hourly;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 24 * 7),
          child: Row(children: [
            for (final h in hourly)
              Expanded(
                child: Container(
                  height: 16,
                  margin: const EdgeInsets.only(left: 1),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(1),
                    color: h <= 0.02 ? p.surface3.withValues(alpha: p.dark ? 0.6 : 0.8) : Color.lerp(p.accentSoft, p.accent, h.clamp(0.0, 1.0)),
                  ),
                ),
              ),
          ]),
        ),
      ),
    );
  }
}
