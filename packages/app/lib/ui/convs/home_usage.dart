import '../../l10n/app_localizations.dart';
import 'package:intl/intl.dart';
import 'package:agent_company/l10n/ui_copy.dart';
// "השימוש" on the home (task 496), under "המכסה": how fast the quota goes and on what. The weekly % the company used in
// the last hour and day, how many tasks run side by side, and the day's spend by kind and by worker (hq usage.ts). The
// shares are one series in one ink: a thin bar under each line, the number beside it, never a color per kind.
import 'package:flutter/material.dart';

import '../../model/home_recipe.dart';
import '../../theme/tokens.dart';
import '../blocks/blocks.dart';
import '../common.dart';

Map<String, String> get kUsageKinds => {
  'tasks': UiCopy.copy.tasks3,
  'leads_workers': UiCopy.copy.messagesFromWorkers,
  'leads_owner': UiCopy.copy.yourMessages,
  'leads_hq': UiCopy.copy.systemReminders,
  'leads_other': UiCopy.copy.repeatedWork,
};

/// The day's spend as the card lists it: tasks, then the leads with their sum and, under it, what woke them (noa 24/10:
/// "ראשי צוות" once, not four times). (label, share, indented).
List<(String, num, bool)> kindRows(List<(String, num)> kinds) {
  final leads = [for (final k in kinds) if (k.$1.startsWith('leads_')) k];
  final sum = leads.fold<num>(0, (a, k) => a + k.$2);
  final tasks = [for (final k in kinds) if (!k.$1.startsWith('leads_')) (kUsageKinds[k.$1] ?? k.$1, k.$2, false)];
  final lead = [
    if (leads.isNotEmpty) (UiCopy.copy.teamLeads, sum, false),
    for (final (k, s) in leads) (kUsageKinds[k] ?? k, s, true),
  ];
  // Whichever went on more comes first.
  return sum > (tasks.firstOrNull?.$2 ?? 0) ? [...lead, ...tasks] : [...tasks, ...lead];
}

String _pct(num v) => '$kLRI${v.round()}%$kPDI';

/// A share of the day: a sliver that rounds to nothing still went somewhere.
String _share(num f) => f > 0 && f < 0.005 ? '$kLRI<1%$kPDI' : _pct(f * 100);

/// A rate under 10% keeps its tenth: "1.4%" an hour says more than "1%".
String _rate(num v) => v < 10 && v != v.roundToDouble() ? '$kLRI${v.toStringAsFixed(1)}%$kPDI' : _pct(v);
String _num(num v) => '$kLRI${v == v.roundToDouble() ? v.toInt() : v.toStringAsFixed(1)}$kPDI';

/// The rate and parallel rows, in reading order (also their screen reader labels).
List<String> rateLines(UsageData u) => [
      if (u.hourPct != null) UiCopy.copy.lastHour(_rate(u.hourPct!)),
      if (u.dayPct != null) UiCopy.copy.last24Hours(_rate(u.dayPct!)),
      if (u.hourPct == null && u.dayPct == null) UiCopy.copy.usageHasNot,
    ];

List<String> parallelLines(UsageData u) => [
      u.parallelNow == 0 ? UiCopy.copy.noTaskRunning : u.parallelNow == 1 ? UiCopy.copy.oneTaskRunningNow : UiCopy.copy.tasksRunningNow(u.parallelNow),
      UiCopy.copy.dailyAverageBusiest(_num(u.parallelAvg), _num(u.parallelPeak)),
    ];

class UsageCard extends StatelessWidget {
  const UsageCard({super.key, required this.usage});
  final UsageData usage;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final u = usage;
    final rows = <Widget>[
      _Row(icon: 'schedule', title: UiCopy.copy.rateWeeklyUsage, lines: [...rateLines(u), if (u.sufficientUntil != null) AppLocalizations.of(context).workForecast(DateFormat.EEEE(Localizations.localeOf(context).languageCode).format(wall(u.sufficientUntil!)))]),
      _Row(icon: 'play_arrow', title: UiCopy.copy.concurrent, lines: parallelLines(u)),
      if (u.kinds.isNotEmpty)
        _Row(icon: 'data_usage', title: UiCopy.copy.workLast24, bars: kindRows(u.kinds)),
      if (u.people.isNotEmpty)
        _Row(icon: 'group', title: UiCopy.copy.peopleLast24, bars: [for (final (n, s, task) in u.people) (task ? UiCopy.copy.task(n) : n, s, false)]),
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final (i, r) in rows.indexed) ...[
          if (i > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 68), child: Container(height: 1, color: p.line)),
          r,
        ],
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.title, this.lines = const [], this.bars = const []});
  final String icon;
  final String title;
  final List<String> lines;
  final List<(String, num, bool)> bars;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final second = T.small.copyWith(color: p.text2, height: 19 / 13, fontFeatures: kTabular);
    return Semantics(
      container: true,
      label: [title, ...lines, for (final (l, s, _) in bars) '$l ${_share(s)}'].join('. '),
      excludeSemantics: true,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 64),
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(16, 12, 16, 12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(shape: BoxShape.circle, color: p.surface3),
              child: Ic(icon, size: 20, color: p.text),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(title, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5)),
                const SizedBox(height: 3),
                for (final l in lines) Text(l, style: second),
                for (final (l, s, sub) in bars) _Bar(label: l, share: s, sub: sub, style: second),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

/// One share: its words (never cut: a long name wraps) and number on a line, a 4px bar under them; the track is the card's line, the fill its ink.
class _Bar extends StatelessWidget {
  const _Bar({required this.label, required this.share, required this.style, this.sub = false});
  final String label;
  final num share;

  /// A part of the row above it (what woke the leads): indented under it.
  final bool sub;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final f = share.clamp(0, 1).toDouble();
    return Padding(
      padding: EdgeInsetsDirectional.only(top: 4, bottom: 2, start: sub ? 16 : 0),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Text(label, style: style)),
          const SizedBox(width: 8),
          Text(_share(f), style: style.copyWith(color: p.text)),
        ]),
        const SizedBox(height: 3),
        ClipRRect(
          borderRadius: BorderRadius.circular(2),
          child: SizedBox(
            height: 4,
            child: Stack(children: [
              Positioned.fill(child: ColoredBox(color: p.line)),
              Positioned.fill(
                child: FractionallySizedBox(
                  alignment: AlignmentDirectional.centerStart,
                  widthFactor: f,
                  heightFactor: 1,
                  child: ColoredBox(color: p.text2),
                ),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}
