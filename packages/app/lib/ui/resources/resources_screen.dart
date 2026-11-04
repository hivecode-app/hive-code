import 'package:agent_company/l10n/ui_copy.dart';
// "משאבים" (resources-design.md §2), opened from "סטטוס": a card for each machine with its memory, CPU and disk in a number
// and a word, who holds it by project ("לא מזוהה" is always there), who waits for room, and, on a tap, the leases that are
// open on it. What could not be read says "לא נמדד"; it is never shown as fine. The state is a word and an icon, not a colour.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../model/resources.dart';
import '../../theme/tokens.dart';
import '../common.dart';

/// How often the screen asks hq again while it is open (hq reads the machines every 30 seconds).
const kResourcesRefresh = Duration(seconds: 20);

/// The route: the screen on the app's backend.
class ResourcesPage extends StatelessWidget {
  const ResourcesPage({super.key});
  @override
  Widget build(BuildContext context) { UiCopy.watch(context); return ResourcesScreen(load: StoreScope.read(context).backend.resources, refresh: kResourcesRefresh); }
}

class ResourcesScreen extends StatefulWidget {
  const ResourcesScreen({super.key, required this.load, this.refresh});

  /// The machines now (null: could not be had).
  final Future<ResourcesView?> Function() load;

  /// How often it asks again; null: never (tests).
  final Duration? refresh;

  @override
  State<ResourcesScreen> createState() => _ResourcesScreenState();
}

class _ResourcesScreenState extends State<ResourcesScreen> {
  ResourcesView? view;
  bool failed = false;

  /// A refresh that did not get an answer: what is on screen is the reading before it.
  bool _stale = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
    final every = widget.refresh;
    if (every != null) _timer = Timer.periodic(every, (_) => unawaited(_load(quiet: true)));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  /// [quiet]: a refresh keeps what is on screen when hq does not answer once.
  Future<void> _load({bool quiet = false}) async {
    if (!quiet && mounted) setState(() => failed = false);
    final v = await widget.load().catchError((_) => null);
    if (!mounted) return;
    setState(() {
      if (v != null) {
        view = v;
        failed = false;
        _stale = false;
      } else if (view == null) {
        failed = true;
      } else {
        _stale = true;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final v = view;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(
          children: [
            TopBar(
              title: UiCopy.text(636),
              leading: IBtn(backIcon(context), tip: UiCopy.text(161), onTap: () => Navigator.of(context).maybePop()),
            ),
            Expanded(
              child: v == null
                  ? _Waiting(failed: failed, onRetry: _load)
                  : ListView(
                      padding: const EdgeInsets.only(bottom: 24),
                      children: [
                        if (_stale)  _Line(icon: 'help', text: UiCopy.text(637)),
                        if (v.machines.isEmpty)  _Line(icon: 'radio_button_unchecked', text: UiCopy.text(638)),
                        for (final m in v.machines)
                          _MachineCard(
                            key: ValueKey('machine-${m.name}'),
                            m: m,
                            waiting: m.name == 'local' ? v.waiting : const [],
                            leases: [
                              for (final l in v.leases)
                                if (l.machine == m.name) l,
                            ],
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Waiting extends StatelessWidget {
  const _Waiting({required this.failed, required this.onRetry});
  final bool failed;
  final Future<void> Function({bool quiet}) onRetry;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Center(
      child: failed
          ? Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(UiCopy.text(639), style: T.row2.copyWith(color: p.text)),
                const SizedBox(height: 4),
                InkWell(
                  onTap: () => onRetry(),
                  child: Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(UiCopy.text(217), style: T.row2.copyWith(color: p.accent)),
                  ),
                ),
              ],
            )
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Spin(child: Ic('progress_activity', size: 20, color: p.text2)),
                const SizedBox(width: 8),
                Text(UiCopy.text(640), style: T.secondary.copyWith(color: p.text2)),
              ],
            ),
    );
  }
}

String gb(double mb) => '${(mb / 1024).toStringAsFixed(1)}GB';

/// A machine: its name and whether it is read, three lines of numbers, who holds it, who waits; a tap opens its leases.
class _MachineCard extends StatefulWidget {
  const _MachineCard({super.key, required this.m, required this.waiting, required this.leases});
  final MachineRes m;
  final List<WaitingRes> waiting;
  final List<LeaseRes> leases;
  @override
  State<_MachineCard> createState() => _MachineCardState();
}

class _MachineCardState extends State<_MachineCard> {
  bool open = false;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final m = widget.m;
    final miss = m.unmeasuredWords;
    final held = m.holders.where((h) => h.project != null).toList();
    final granted = widget.leases.where((l) => l.granted).length;
    final queued = widget.leases.length - granted;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
          child: Row(
            children: [
              Ic('dns', size: 18, color: p.text2),
              const SizedBox(width: 6),
              Expanded(
                child: Rich(m.label, style: T.section.copyWith(color: p.text2)),
              ),
              if (!m.measured) Text(UiCopy.text(641), style: T.secondary.copyWith(color: p.text3)),
            ],
          ),
        ),
        ListBlock(
          inset: 16,
          children: [
            if (!m.measured) _Line(icon: 'help', text: UiCopy.text(642, [m.errorWords])),
            // An old reading is not a measurement of now: its numbers are not shown as if they were.
            _Meter(
              label: UiCopy.text(643),
              value: !m.measured || m.memUsedMb == null || m.memTotalMb == null
                  ? null
                  : UiCopy.text(187, [(m.memUsedMb! / 1024).toStringAsFixed(1), gb(m.memTotalMb!)]),
              reading: m.measured ? m.memory : null,
            ),
            _Meter(
              label: UiCopy.text(644),
              value: !m.measured || m.load1 == null || m.cpus == null ? null : UiCopy.text(645, [m.load1!.toStringAsFixed(1), m.cpus]),
              reading: m.measured ? m.cpu : null,
            ),
            _Meter(
              label: UiCopy.text(646),
              value: !m.measured || m.diskPct == null || m.diskFreeMb == null ? null : UiCopy.text(647, [m.diskPct, gb(m.diskFreeMb!)]),
              reading: m.measured ? m.disk : null,
            ),
            if (m.measured && miss.isNotEmpty) _Line(icon: 'help', text: UiCopy.text(648, [miss.join(', ')])),
          ],
        ),
        if (m.measured) ...[
          Section(UiCopy.text(649), top: 12),
          ListBlock(
            inset: 16,
            children: [
              for (final h in held) _HolderRow(name: h.name, mem: gb(h.memMb), detail: _holderDetail(h)),
              // "לא מזוהה" is the one that took us down: it is always a row, with what is inside it. When the cgroups could not be
              // read it does not say "אין": it says it was not measured.
              _HolderRow(
                key: const ValueKey('unidentified'),
                name: UiCopy.text(650),
                mem: m.unidentifiedMb > 0 ? gb(m.unidentifiedMb) : (m.unmeasured.contains('cgroups') ? UiCopy.text(641) : UiCopy.text(651)),
                detail: [for (final u in m.unidentified.take(3)) '${u.readable} ${gb(u.memMb)}'].join(' · '),
                raw: [
                  for (final u in m.unidentified.take(3))
                    if (u.readable != u.name) u.name,
                ].join(' · '),
              ),
            ],
          ),
        ],
        if (widget.waiting.isNotEmpty || queued > 0) ...[
          Section(UiCopy.text(652), count: '${widget.waiting.length + queued}', top: 12),
          ListBlock(
            inset: 16,
            children: [
              for (final w in widget.waiting) _WaitRow(w: w),
              for (final l in widget.leases.where((l) => !l.granted)) _LeaseRow(l: l),
            ],
          ),
        ],
        MoreRow(
          icon: open ? 'expand_less' : 'expand_more',
          bold: granted == 0 ? UiCopy.text(653) : (granted == 1 ? UiCopy.text(654) : UiCopy.text(655, [granted])),
          rest: open ? '' : UiCopy.text(656),
          top: false,
          onTap: () => setState(() => open = !open),
        ),
        if (open)
          ListBlock(
            inset: 16,
            top: false,
            children: [
              if (granted == 0)
                 _Line(icon: 'radio_button_unchecked', text: UiCopy.text(657))
              else
                for (final l in widget.leases.where((l) => l.granted)) _LeaseRow(l: l),
            ],
          ),
      ],
    );
  }

  static String _holderDetail(Holder h) => [if (h.count > 1) UiCopy.text(658, [h.count]), if (h.cpuPct != null) UiCopy.text(659, [h.cpuPct!.round()])].join(' · ');
}

/// One number with its word: "זיכרון · 14.2 מתוך 23.0GB · עמוס". The warning icon only in front of a threshold.
class _Meter extends StatelessWidget {
  const _Meter({required this.label, required this.value, required this.reading});
  final String label;
  final String? value;
  final Reading? reading;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final r = reading;
    return Semantics(
      container: true,
      label: [label, value ?? UiCopy.text(641), ?r?.word].join(', '),
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        child: Row(
          children: [
            SizedBox(
              width: 64,
              child: Text(label, style: T.row2.copyWith(color: p.text2)),
            ),
            Expanded(
              child: Rich(value ?? UiCopy.text(641), style: T.row2.copyWith(color: value == null ? p.text2 : p.text)),
            ),
            if (r != null) ...[
              const SizedBox(width: 8),
              if (r.warn) ...[Ic('warning', size: 16, fill: true, color: p.text), const SizedBox(width: 3)],
              Text(
                r.word,
                style: T.secondary.copyWith(color: p.text, fontWeight: r.warn ? FontWeight.w700 : FontWeight.w400),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _HolderRow extends StatelessWidget {
  const _HolderRow({super.key, required this.name, required this.mem, this.detail = '', this.raw = ''});
  final String name, mem, detail;

  /// The names as hq has them, small, under the readable ones.
  final String raw;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Rich(name, style: T.row2.copyWith(color: p.text)),
              ),
              Rich(mem, style: T.row2.copyWith(color: p.text)),
            ],
          ),
          if (detail.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Rich(detail, maxLines: 2, style: T.small.copyWith(color: p.text2)),
            ),
          if (raw.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Rich(raw, maxLines: 2, style: T.small.copyWith(color: p.text3)),
            ),
        ],
      ),
    );
  }
}

/// A row of the queue or of the open leases: one thing in his words, one sentence, one meta line.
class _Item extends StatelessWidget {
  const _Item({required this.icon, required this.title, required this.meta, required this.sentence, this.auto = false});
  final String icon, title, meta, sentence;
  final bool auto;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Ic(icon, size: 18, fill: true, color: p.text2),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Expanded(
                      child: Rich(
                        title,
                        auto: auto,
                        maxLines: 2,
                        style: T.row2.copyWith(color: p.text, fontWeight: FontWeight.w700),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(meta, style: T.small.copyWith(color: p.text2)),
                  ],
                ),
                if (sentence.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Rich(sentence, maxLines: 4, style: T.secondary.copyWith(color: p.text2)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

String _eta(int? min) => min == null ? '' : (min <= 1 ? UiCopy.text(660) : UiCopy.text(661, [min]));

/// A task held back for room: how long it waits, and a sentence: who holds the machine and when it frees. Without an honest
/// estimate it says there is none.
class _WaitRow extends StatelessWidget {
  const _WaitRow({required this.w});
  final WaitingRes w;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final holder = w.waitingFor ?? UiCopy.text(662);
    final sentence = w.etaMin != null ? UiCopy.text(663, [holder, _eta(w.etaMin)]) : UiCopy.text(664, [holder]);
    return _Item(icon: 'schedule', title: w.title, meta: UiCopy.text(665, [w.waitingMin]), sentence: sentence, auto: true);
  }
}

/// A lease. Granted: whose, how big, how long it runs and what is left. Queued: what it needs and who holds it.
class _LeaseRow extends StatelessWidget {
  const _LeaseRow({required this.l});
  final LeaseRes l;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final of = [l.cls, if (l.project != null) UiCopy.text(666, [l.project]), if (l.task != null) UiCopy.text(667, [l.task])].join(' ');
    if (l.granted) {
      return _Item(
        icon: 'play_arrow',
        title: of,
        meta: UiCopy.text(668, [l.ageMin]),
        sentence: [gb(l.memMb), if (l.etaMin != null) UiCopy.text(669, [_eta(l.etaMin)]), ?l.note].join(' · '),
      );
    }
    final who = l.waitingFor == null ? UiCopy.text(670) : UiCopy.text(671, [l.waitingFor]);
    return _Item(
      icon: 'schedule',
      title: of,
      meta: UiCopy.text(665, [l.ageMin]),
      sentence: UiCopy.text(673, [gb(l.memMb), who, l.etaMin != null ? UiCopy.text(672, [_eta(l.etaMin)]) : '']),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.icon, required this.text});
  final String icon, text;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        children: [
          Ic(icon, size: 18, fill: icon == 'warning', color: p.text2),
          const SizedBox(width: 8),
          Expanded(
            child: Rich(text, maxLines: 3, style: T.row2.copyWith(color: p.text2)),
          ),
        ],
      ),
    );
  }
}
