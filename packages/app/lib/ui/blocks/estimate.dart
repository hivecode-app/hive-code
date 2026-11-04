import 'package:agent_company/l10n/ui_copy.dart';
// הערכת זמן ליד משימה (noa's direction, 21/10): on a line of its own under the task's meta line (it overloaded the meta
// line and broke every row in two, noa's review), the estimate its worker gave and where it stands, in the meta's size
// and colour (no colour, bar or ring), the icon outlined:
//   on time     `schedule`            "הערכה 20 דק' · עברו 12"
//   near        `hourglass_bottom`    "נשארו 4 דק' מתוך 20"          (the smaller of 20% and 5 minutes left)
//   overdue     `running_with_errors` "**באיחור של 15 דק'** · הערכה 20"  (only the first part is 700)
//   done        `check_circle`        "הסתיים ב-18 דק' מתוך 20"
//   cancelled   nothing
// Minutes up to 59, then "1 שע' 20 דק'"; no seconds; it moves once a minute, without animation.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/backend.dart';
import '../../model/models.dart';
import '../chat/chat_screen.dart';
import '../common.dart';
import '../nav.dart';
import 'parts.dart';

enum EstimatePhase { onTime, near, overdue, done }

/// How one estimate reads at [now]: the icon, the bold part, the rest, and the words a screen reader says.
class EstimateShown {
  const EstimateShown({required this.phase, required this.icon, required this.strong, required this.rest, required this.spoken});
  final EstimatePhase phase;
  final String icon;

  /// The part in 700 (overdue only); empty otherwise.
  final String strong;
  final String rest;
  final String spoken;

  String get text => [if (strong.isNotEmpty) strong, rest].join(' · ');
  bool get overdue => phase == EstimatePhase.overdue;
}

/// "20 דק'", "1 שע' 20 דק'", "2 שע'". [unit] false drops "דק'" under an hour ("עברו 12").
/// A non-breaking space joins each number to its unit, so a wrap never splits "1 | שע'".
String minutesText(int min, {bool unit = true}) {
  if (min < 60) return unit ? UiCopy.text(37, [min]) : '$min';
  final h = min ~/ 60, m = min % 60;
  return m == 0 ? UiCopy.text(38, [h]) : UiCopy.text(39, [h, m]);
}

final _unitsF = [UiCopy.text(40), UiCopy.text(41), UiCopy.text(42), UiCopy.text(43), UiCopy.text(44), UiCopy.text(45), UiCopy.text(46), UiCopy.text(47), UiCopy.text(48), UiCopy.text(49), UiCopy.text(50)];
final _teensF = [UiCopy.text(50), UiCopy.text(51), UiCopy.text(52), UiCopy.text(53), UiCopy.text(54), UiCopy.text(55), UiCopy.text(56), UiCopy.text(57), UiCopy.text(58), UiCopy.text(59)];
final _tens = ['', '', UiCopy.text(60), UiCopy.text(61), UiCopy.text(62), UiCopy.text(63), UiCopy.text(64), UiCopy.text(65), UiCopy.text(66), UiCopy.text(67)];

/// A number up to 99 in feminine Hebrew words (minutes and hours are feminine); digits above that.
String _words(int n) {
  if (n > 99) return '$n';
  if (n <= 10) return _unitsF[n];
  if (n < 20) return _teensF[n - 10];
  final t = _tens[n ~/ 10], u = n % 10;
  return u == 0 ? t : UiCopy.text(68, [t, _unitsF[u]]);
}

String _unitSpoken(int n, String one, String two, String many) => n == 1 ? one : (n == 2 ? two : '${_words(n)} $many');

/// "עשרים דקות", "שעה ועשרים דקות", "שעתיים".
String minutesSpoken(int min) {
  if (min < 60) return _unitSpoken(min, UiCopy.text(69), UiCopy.text(70), UiCopy.text(71));
  final h = min ~/ 60, m = min % 60;
  final hs = _unitSpoken(h, UiCopy.text(72), UiCopy.text(73), UiCopy.text(74));
  return m == 0 ? hs : UiCopy.text(68, [hs, minutesSpoken(m)]);
}

/// The estimate at [now]; null when there is nothing to show.
EstimateShown? estimateShown(Estimate e, DateTime now) {
  final total = e.estimatedMin;
  if (e.closedAt != null) {
    final took = e.actualMin ?? e.closedAt!.difference(e.createdAt).inMinutes;
    return EstimateShown(
      phase: EstimatePhase.done,
      icon: 'check_circle',
      strong: '',
      rest: UiCopy.text(75, [minutesText(took), minutesText(total, unit: false)]),
      spoken: UiCopy.text(76, [minutesSpoken(took), minutesSpoken(total)]),
    );
  }
  if (!now.isBefore(e.dueAt)) {
    final late = now.difference(e.dueAt).inMinutes.clamp(1, 1 << 30);
    return EstimateShown(
      phase: EstimatePhase.overdue,
      icon: 'running_with_errors',
      strong: UiCopy.text(77, [minutesText(late)]),
      rest: UiCopy.text(78, [minutesText(total, unit: false)]),
      spoken: UiCopy.text(79, [minutesSpoken(late), minutesSpoken(total)]),
    );
  }
  final passed = now.difference(e.createdAt).inMinutes.clamp(0, total);
  final left = total - passed;
  final nearAt = (total * 0.2) < 5 ? total * 0.2 : 5.0;
  if (left <= nearAt) {
    return EstimateShown(
      phase: EstimatePhase.near,
      icon: 'hourglass_bottom',
      strong: '',
      rest: UiCopy.text(80, [minutesText(left), minutesText(total, unit: false)]),
      spoken: UiCopy.text(80, [minutesSpoken(left), minutesSpoken(total)]),
    );
  }
  return EstimateShown(
    phase: EstimatePhase.onTime,
    icon: 'schedule',
    strong: '',
    rest: UiCopy.text(81, [minutesText(total), minutesText(passed, unit: false)]),
    spoken: UiCopy.text(82, [minutesSpoken(total), minutesSpoken(passed)]),
  );
}

/// The estimate line under a task's meta line; nothing without an estimate (or one that shows nothing). It redraws
/// once a minute, and a long line wraps instead of being cut.
class EstimateLine extends StatefulWidget {
  const EstimateLine({super.key, required this.estimate, required this.style, this.now});
  final Estimate? estimate;
  final TextStyle style;

  /// Tests pin the clock through [CompanyTime]; this overrides it.
  final DateTime? now;

  @override
  State<EstimateLine> createState() => _EstimateLineState();
}

class _EstimateLineState extends State<EstimateLine> {
  Timer? _timer;

  bool get _ticks => widget.estimate != null && widget.estimate!.closedAt == null;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(EstimateLine old) {
    super.didUpdateWidget(old);
    _sync();
  }

  void _sync() {
    if (_ticks && _timer == null) {
      _timer = Timer.periodic(const Duration(minutes: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!_ticks) {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final e = widget.estimate;
    final shown = e == null ? null : estimateShown(e, widget.now ?? CompanyTime.now());
    if (shown == null) return const SizedBox.shrink();
    final style = widget.style.copyWith(fontFeatures: kTabular);
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Semantics(
        label: shown.spoken,
        excludeSemantics: true,
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 1.5), child: Ic(shown.icon, size: 16, color: style.color)),
          const SizedBox(width: 4),
          Expanded(
            child: Text.rich(
              TextSpan(children: [
                if (shown.strong.isNotEmpty) TextSpan(text: shown.strong, style: const TextStyle(fontWeight: FontWeight.w700)),
                if (shown.strong.isNotEmpty) const TextSpan(text: ' · '),
                TextSpan(text: shown.rest),
              ]),
              style: style,
            ),
          ),
        ]),
      ),
    );
  }
}

/// Past its estimate a tap on the task opens the conversation with whoever promised it, at the message it was
/// promised in (the end of it without one). Whether it is past is decided at the tap, not at the last build: the row
/// has no clock of its own. [identity] is only the fallback target when the row has none (null when there is no
/// estimate or [d] cannot talk to its worker).
({String? identity, void Function(String)? open}) estimateTap(BuildContext context, CompanyData? d, Estimate? est, void Function(String)? open) {
  if (est == null || d == null || est.identity.isEmpty || !d.canChat(est.identity) || !d.identities.containsKey(est.identity)) return (identity: null, open: open);
  return (
    identity: est.identity,
    open: (id) {
      final late = estimateShown(est, CompanyTime.now())?.overdue == true;
      final to = late ? est.identity : id;
      if (late && est.messageId != null) ChatScreen.pendingTarget[to] = est.messageId!;
      (open ?? (i) => Nav.chat(context, i))(to);
    },
  );
}
