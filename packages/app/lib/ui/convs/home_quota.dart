import 'package:agent_company/l10n/ui_copy.dart';
// "המכסה" on the home (task 482): every Claude account the company runs on, its 5-hour and weekly use and when
// each resets, from hq's last read (accounts.ts, every 10 minutes). On 23/10 both accounts hit 100% weekly and the
// company stood for 36 hours with nothing on the screen to say so. A full account is the word "חסום" and its icon,
// with when it opens again; never a color. A read older than half an hour says when it was taken. Under the accounts,
// Codex's week (task 836): it runs only tasks sent to it, so a line says when new ones stop going to it.
import 'package:flutter/material.dart';

import '../../model/home_recipe.dart';
import '../../theme/tokens.dart';
import '../blocks/blocks.dart';
import '../common.dart';

List<String> get _days => [UiCopy.copy.monday, UiCopy.copy.tuesday, UiCopy.copy.wednesday, UiCopy.copy.thursday, UiCopy.copy.friday, UiCopy.copy.saturday, UiCopy.copy.sunday];

/// A time ahead on his clock: "14:00", "מחר 06:59", "שבת 31/10 06:00".
String aheadAt(DateTime t, DateTime now) {
  final days = -daysAgo(t, now);
  if (days <= 0) return hm(t);
  if (days == 1) return UiCopy.copy.tomorrow(hm(t));
  return '${_days[wall(t).weekday - 1]} ${dm(t)} ${hm(t)}';
}

/// "17%" stays "17%" in a Hebrew line: isolated left to right, or the sign lands before the number.
String _pct(num? v) => v == null ? '?' : '$kLRI${v.round()}%$kPDI';

/// "5 שעות 17%, מתאפס 14:00": a window's line; no reset time when hq has none, or it already passed.
String windowLine(String name, num? pct, DateTime? resets, DateTime now) =>
    [ '$name ${_pct(pct)}', if (resets != null && resets.isAfter(now)) UiCopy.copy.resets(aheadAt(resets, now)) ].join(', ');

/// Everything the card says of one account, in reading order (also its screen reader label).
List<String> quotaLines(QuotaLine q, DateTime now) {
  final old = q.measuredAt != null && now.difference(q.measuredAt!) > const Duration(minutes: 30);
  return [
    if (!q.usable) UiCopy.copy.offline2
    else if (q.full) q.reopensAt != null ? UiCopy.copy.unavailableUntil(aheadAt(q.reopensAt!, now)) : UiCopy.copy.blocked4,
    // Codex has one window, the week: no "5 שעות ?" line for a window it does not have.
    if (q.usable) ...[if (!q.isCodex) windowLine(UiCopy.copy.n5Hours, q.fiveHour, q.fiveHourResets, now), windowLine(UiCopy.copy.weekly, q.sevenDay, q.sevenDayResets, now)],
    if (q.note != null) q.note!,
    if (q.usable && old) UiCopy.copy.measured(daysAgo(q.measuredAt!, now) == 0 ? hm(q.measuredAt!) : '${dm(q.measuredAt!)} ${hm(q.measuredAt!)}'),
  ];
}

class QuotaCard extends StatelessWidget {
  const QuotaCard({super.key, required this.quota, required this.now});
  final List<QuotaLine> quota;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final (i, q) in quota.indexed) ...[
          if (i > 0) Padding(padding: const EdgeInsetsDirectional.only(start: 68), child: Container(height: 1, color: p.line)),
          _Row(q: q, now: now),
        ],
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.q, required this.now});
  final QuotaLine q;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final lines = quotaLines(q, now);
    final second = T.small.copyWith(color: p.text2, height: 19 / 13, fontFeatures: kTabular);
    final stop = !q.usable || q.full;
    return Semantics(
      container: true,
      label: [q.label, ...lines].join('. '),
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
              child: Ic(stop ? 'block' : 'data_usage', size: 20, color: p.text),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(q.label, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5)),
                const SizedBox(height: 3),
                for (final (i, l) in lines.indexed)
                  Text(l, style: i == 0 && stop ? second.copyWith(color: p.text, fontWeight: FontWeight.w700) : second),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
