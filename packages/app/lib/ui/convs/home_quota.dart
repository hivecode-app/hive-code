// "המכסה" on the home (task 482): every Claude account the company runs on, its 5-hour and weekly use and when
// each resets, from hq's last read (accounts.ts, every 10 minutes). On 23/10 both accounts hit 100% weekly and the
// company stood for 36 hours with nothing on the screen to say so. A full account is the word "חסום" and its icon,
// with when it opens again; never a color. A read older than half an hour says when it was taken.
import 'package:flutter/material.dart';

import '../../model/home_recipe.dart';
import '../../theme/tokens.dart';
import '../blocks/blocks.dart';
import '../common.dart';

const _days = ['שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת', 'ראשון'];

/// A time ahead on his clock: "14:00", "מחר 06:59", "שבת 31/10 06:00".
String aheadAt(DateTime t, DateTime now) {
  final days = -daysAgo(t, now);
  if (days <= 0) return hm(t);
  if (days == 1) return 'מחר ${hm(t)}';
  return '${_days[wall(t).weekday - 1]} ${dm(t)} ${hm(t)}';
}

/// "17%" stays "17%" in a Hebrew line: isolated left to right, or the sign lands before the number.
String _pct(num? v) => v == null ? '?' : '$kLRI${v.round()}%$kPDI';

/// "5 שעות 17%, מתאפס 14:00": a window's line; no reset time when hq has none, or it already passed.
String windowLine(String name, num? pct, DateTime? resets, DateTime now) =>
    [ '$name ${_pct(pct)}', if (resets != null && resets.isAfter(now)) 'מתאפס ${aheadAt(resets, now)}' ].join(', ');

/// Everything the card says of one account, in reading order (also its screen reader label).
List<String> quotaLines(QuotaLine q, DateTime now) {
  final old = q.measuredAt != null && now.difference(q.measuredAt!) > const Duration(minutes: 30);
  return [
    if (!q.usable) 'לא מחובר'
    else if (q.full) q.reopensAt != null ? 'חסום עד ${aheadAt(q.reopensAt!, now)}' : 'חסום',
    if (q.usable) ...[windowLine('5 שעות', q.fiveHour, q.fiveHourResets, now), windowLine('שבועי', q.sevenDay, q.sevenDayResets, now)],
    if (q.usable && old) 'נמדד ${daysAgo(q.measuredAt!, now) == 0 ? hm(q.measuredAt!) : '${dm(q.measuredAt!)} ${hm(q.measuredAt!)}'}',
  ];
}

class QuotaCard extends StatelessWidget {
  const QuotaCard({super.key, required this.quota, required this.now});
  final List<QuotaLine> quota;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
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
