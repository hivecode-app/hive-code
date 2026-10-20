// "מאז שהיית פה" as a block of its own: the chats card has it at its foot, the home recipe may place it anywhere.
import 'package:flutter/material.dart';

import '../../data/store.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import 'data.dart';
import 'parts.dart';

/// "מאז 19:00", "מאז אתמול 22:10", "מאז 18/10".
String sinceLabel(DateTime since, DateTime now) {
  final ago = daysAgo(since, now);
  if (ago <= 0) return 'מאז ${hm(since)}';
  if (ago == 1) return 'מאז אתמול ${hm(since)}';
  return 'מאז ${dm(since)}';
}

/// "מאז שהיית פה": one folded line, the newest sentence and how many more; a tap opens every sentence
/// in place, with who and when, and a second tap folds it. Open or not is its own, unless [open] is given.
class SinceBlock extends StatefulWidget {
  const SinceBlock({super.key, required this.data, this.now, this.max, this.open, this.onToggle});
  final SinceData data;

  /// The clock "מאז" reads the day from; now when null.
  final DateTime? now;

  /// At most this many sentences, newest first (the recipe's "up to 3"); all when null.
  final int? max;

  /// Held by the parent (with [onToggle]); null: the block keeps it.
  final bool? open;
  final VoidCallback? onToggle;

  @override
  State<SinceBlock> createState() => _SinceBlockState();
}

class _SinceBlockState extends State<SinceBlock> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final items = widget.max == null ? widget.data.items : widget.data.items.take(widget.max!).toList();
    if (items.isEmpty) return const SizedBox.shrink();
    return _Since(
      done: items,
      since: widget.data.since,
      now: widget.now ?? DateTime.now(),
      open: widget.open ?? _open,
      onTap: widget.onToggle ?? () => setState(() => _open = !_open),
    );
  }
}

class _Since extends StatelessWidget {
  const _Since({required this.done, required this.since, required this.now, required this.open, required this.onTap});
  final List<SinceItem> done;
  final DateTime since;
  final DateTime now;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final d = StoreScope.of(context).data!;
    final label = sinceLabel(since, now);
    final more = done.length - 1;
    final second = T.small.copyWith(color: p.text2);
    final head = Semantics(
      button: true,
      label: '$label, ${done.length == 1 ? 'הסתיים דבר אחד' : 'הסתיימו ${done.length} דברים'}',
      hint: open ? 'קיפול' : 'פתיחה',
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(children: [
              const BlockSymbol('history'),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Row(children: [
                    Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: T.body.copyWith(fontWeight: FontWeight.w500, color: p.text, height: 21 / 15.5, fontFeatures: kTabular))),
                    const SizedBox(width: 8),
                    AnimatedRotation(turns: open ? 0.5 : 0, duration: kBlockMotion, curve: kBlockCurve, child: Ic('expand_more', size: 20, color: p.text2)),
                  ]),
                  const SizedBox(height: 2),
                  // Folded: the newest sentence, and how many more where the others have the time.
                  AnimatedSwitcher(
                    duration: kBlockMotion,
                    layoutBuilder: (cur, prev) => Stack(alignment: AlignmentDirectional.centerStart, children: [...prev, ?cur]),
                    child: Row(key: ValueKey(open), crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: open
                        ? [Expanded(child: Text(done.length == 1 ? 'דבר אחד הסתיים' : '${done.length} דברים הסתיימו', maxLines: 1, style: second))]
                        : [
                            Expanded(child: Rich(done.first.text, auto: true, maxLines: 1, style: second)),
                            if (more > 0) ...[const SizedBox(width: 8), Text('ועוד $more', style: second.copyWith(fontFeatures: kTabular))],
                          ]),
                  ),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      head,
      ClipRect(
        child: AnimatedSize(
          duration: kBlockMotion,
          curve: kBlockCurve,
          alignment: AlignmentDirectional.topStart,
          child: !open
              ? const SizedBox(width: double.infinity)
              : Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    for (final x in done)
                      Semantics(
                        label: [x.text, if (x.who != null) d.who(x.who!).name, hm(x.at)].join(', '),
                        excludeSemantics: true,
                        child: Padding(
                          padding: const EdgeInsetsDirectional.fromSTEB(16, 6, 16, 6),
                          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            SizedBox(
                              width: 40,
                              child: Align(
                                alignment: AlignmentDirectional.topStart,
                                child: SizedBox(width: 36, child: Center(child: x.who == null ? Ic('check_circle', size: 18, color: p.text2) : Monogram.of(d, x.who!, size: AvSize.xs))),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(child: Rich(x.text, auto: true, maxLines: 2, style: T.row2.copyWith(color: p.text))),
                            const SizedBox(width: 8),
                            Padding(padding: const EdgeInsets.only(top: 2), child: Text(hm(x.at), style: second.copyWith(fontFeatures: kTabular))),
                          ]),
                        ),
                      ),
                  ]),
                ),
        ),
      ),
    ]);
  }
}
