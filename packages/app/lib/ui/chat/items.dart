export '../media/cards.dart' show BubbleImages, AttachmentImage;
export '../media/gallery.dart' show ImageViewer;
import '../media/cards.dart';
import '../media/artifact.dart';
import '../../l10n/app_localizations.dart';
import '../product/approval.dart';

import 'package:agent_company/l10n/ui_copy.dart';

// Every chat item kind (chat.md §2), one widget each, matching the mockup's chat classes:
// .b (bubbles), .tool, .card (diff, tests, terminal, PR, ask, GO), .svc (service lines).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/error_report.dart';
import '../../data/engine_model.dart' show hebrewOrEmpty, toolHasDetail, toolHasAgentDescription, toolLabel;
import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../decision.dart';
import '../nav.dart';
import 'markdown.dart';
import 'tool_details.dart' show openInternalMessage, openToolDetails;

const _fold = Duration(milliseconds: 150);

/// Bubble frame: incoming at the start (right in RTL), outgoing at the end (left), WhatsApp style.
class Bubble extends StatelessWidget {
  const Bubble({super.key, required this.out, required this.child, this.wide = false, this.queued = false});
  final bool out;
  final bool wide;
  final bool queued;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return LayoutBuilder(
      builder: (context, c) {
        final maxW = c.maxWidth;
        return Align(
          alignment: out ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
          child: Container(
            margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
            constraints: BoxConstraints(maxWidth: maxW * (wide ? 0.92 : 0.88), minWidth: wide ? maxW * 0.92 : 0),
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 9),
            decoration: BoxDecoration(
              color: out ? p.bubbleOut : p.bubbleIn,
              border: !out ? Border.all(color: p.line) : null,
              borderRadius: BorderRadiusDirectional.only(
                topStart: const Radius.circular(14),
                topEnd: const Radius.circular(14),
                bottomStart: Radius.circular(out ? 14 : 4),
                bottomEnd: Radius.circular(out ? 4 : 14),
              ),
            ),
            child: child,
          ),
        );
      },
    );
  }
}

/// `.meta`: time + delivery ticks in the bubble's bottom end corner.
class Meta extends StatelessWidget {
  const Meta({super.key, required this.time, this.delivery});
  final String time;
  final Delivery? delivery;

  static double widthFor(Delivery? d) => d == null ? 40 : 60;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final (String? icon, Color? color, String label) = switch (delivery) {
      null => (null, null, ''),
      Delivery.pendingConnection => ('schedule', p.text2, UiCopy.text(234)),
      Delivery.queued => ('schedule', p.text2, UiCopy.text(98)),
      Delivery.delivered => ('check', p.text3, UiCopy.text(235)),
      Delivery.read || Delivery.handled => ('done_all', p.read, UiCopy.text(236)),
      Delivery.failed => ('error', p.urgent, UiCopy.text(237)),
    };
    return Semantics(
      label: '$time $label',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            time,
            style: TextStyle(fontFamily: kFont, fontSize: 11.5, height: 1, color: delivery == Delivery.queued ? p.text2 : p.text3),
          ),
          if (icon != null) ...[const SizedBox(width: 2), Ic(icon, size: 16, color: color, fill: icon == 'error')],
        ],
      ),
    );
  }
}

/// Text with the time in the bottom corner where the last line ends: left after a Hebrew line,
/// right after an English one. The last line reserves the room, so the time never covers text.
class _WithMeta extends StatelessWidget {
  const _WithMeta({required this.child, required this.meta, this.end});
  final Widget child;
  final Widget meta;
  final TextDirection? end;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    return Stack(
      children: [
        Padding(padding: const EdgeInsets.only(bottom: 2), child: child),
        Positioned(
          bottom: 0,
          left: (end ?? Directionality.of(context)) == TextDirection.rtl ? 0 : null,
          right: (end ?? Directionality.of(context)) == TextDirection.ltr ? 0 : null,
          child: meta,
        ),
      ],
    );
  }
}

// ───────────────────────────── user / text ─────────────────────────────

class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.msg, required this.identityId, this.onRetract, this.onRetry, this.onStopNow});
  final UserMsg msg;
  final String identityId;
  final VoidCallback? onRetract;
  final VoidCallback? onRetry;

  /// "עצירה עכשיו" under a message that has waited on one tool for long (the chat's stop, with its confirm).
  final VoidCallback? onStopNow;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final multi = parseMarkdown(msg.text).length > 1;
    final images = msg.attachments;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (msg.replyTo != null) QuoteStrip(quote: msg.replyTo!),
        if (images.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: BubbleImages(images: images, onCancel: onRetract, onRetry: onRetry, failed: msg.delivery == Delivery.failed),
          ),
        if (msg.text.isNotEmpty) Markdown(msg.text, trailerWidth: multi ? 0 : Meta.widthFor(msg.delivery)),
        if (multi || msg.text.isEmpty) const SizedBox(height: 14),
      ],
    );
    final bubble = Bubble(
      out: true,
      queued: msg.delivery == Delivery.queued,
      child: _WithMeta(
        meta: Meta(time: hm(msg.ts), delivery: msg.delivery),
        end: markdownEndDirection(msg.text, fallback: Directionality.of(context)),
        child: images.isEmpty ? body : IntrinsicWidth(child: body),
      ), // as wide as the image (or the text), WhatsApp
    );
    final waiting = msg.waitingOn;
    final pendingMedia = msg.attachments.any((a) => a.id == null && a.transfer != null);
    final under = pendingMedia && msg.delivery != Delivery.failed
        ? _QLine(text: AppLocalizations.of(context).mediaWaiting, link: UiCopy.text(239), onTap: onRetract)
        : switch (msg.delivery) {
            // His `now` waits for one running tool only: the line says which, never "בתור".
            Delivery.queued || Delivery.delivered when waiting != null => WaitLine(waiting: waiting, onStop: onStopNow),
            // Otherwise his `now` is on its way this second: no line.
            Delivery.queued when msg.priority == Priority.now => null,
            Delivery.queued => _QLine(text: UiCopy.text(238, [msg.priority == Priority.later ? UiCopy.text(230) : UiCopy.text(225)]), link: UiCopy.text(239), onTap: onRetract),
            Delivery.pendingConnection => _QLine(text: UiCopy.text(240), link: UiCopy.text(239), onTap: onRetract),
            // hq catches a message it could not deliver by itself (error-watch.ts): "נשלח לטיפול" is true here too.
            Delivery.failed => _QLine(text: ErrorReports.instance.active ? UiCopy.text(241, [SentNote.text]) : UiCopy.text(242), link: UiCopy.text(243), onTap: onRetry),
            _ => null,
          };
    if (under == null) return bubble;
    return Column(crossAxisAlignment: CrossAxisAlignment.end, children: [bubble, under]);
  }
}

/// What the tool a message waits for is called in the line under it: (the noun, is it feminine).
(String, bool) waitingWhat(WaitingOn w) {
  final cmd = w.command;
  if (w.tool == 'Bash' && cmd != null) {
    if (RegExp(r'\b(deploy|kubectl\s+apply|helm\s+(upgrade|install))\b').hasMatch(cmd)) return (UiCopy.text(249), true);
    var first = cmd
        .trim()
        .split(RegExp(r'&&|\|\||[;|\n]'))
        .map((s) => s.trim())
        .firstWhere((s) => s.isNotEmpty && !s.startsWith('cd '), orElse: () => cmd.trim())
        .replaceAll(RegExp(r'\s*(\d?>&\d|\d?>\s*/dev/null)'), '');
    if (first.length > 24) first = '${first.substring(0, 23)}…';
    return (UiCopy.text(250, [first]), true);
  }
  if (w.tool == 'Bash') return (UiCopy.text(251), true);
  if (w.tool == 'Edit' || w.tool == 'Write' || w.tool == 'NotebookEdit') return (UiCopy.text(252), true);
  if (w.tool == 'Agent' || w.tool == 'Task') return (UiCopy.text(253), false);
  final name = w.tool.startsWith('mcp__') ? w.tool.split('__').last : w.tool;
  return (UiCopy.text(254, [name]), false);
}

/// After this long on one tool the line shows how long, and offers to stop it.
const kLongWait = Duration(minutes: 3);

/// The line under his message while it waits for the running tool: "נכנסת כשהפקודה `npm test` תסתיים".
class WaitLine extends StatefulWidget {
  const WaitLine({super.key, required this.waiting, this.onStop});
  final WaitingOn waiting;
  final VoidCallback? onStop;
  @override
  State<WaitLine> createState() => _WaitLineState();
}

class _WaitLineState extends State<WaitLine> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 20), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final (what, f) = waitingWhat(widget.waiting);
    final ran = CompanyTime.now().difference(widget.waiting.since);
    final long = ran >= kLongWait;
    final style = TextStyle(fontFamily: kFont, fontSize: 12, height: 1.5, color: p.text2);
    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
        // No "·" before the link: when the link wraps to its own line, a dot would be left hanging (design review).
        child: Wrap(
          alignment: WrapAlignment.end,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 10,
          children: [
            Rich(
              UiCopy.text(258, [
                what,
                f ? UiCopy.text(255) : UiCopy.text(256),
                long ? UiCopy.text(257, [ran.inMinutes]) : '',
              ]),
              style: style,
            ),
            if (long && widget.onStop != null)
              Semantics(
                button: true,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: widget.onStop,
                  // A 48px target around a 12px link (design review, #168).
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
                    child: Center(
                      widthFactor: 1,
                      child: Text(
                        UiCopy.text(259),
                        style: style.copyWith(color: p.accent, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _QLine extends StatelessWidget {
  const _QLine({required this.text, required this.link, this.onTap});
  final String text;
  final String link;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: Text(
                text,
                style: TextStyle(fontFamily: kFont, fontSize: 12, height: 1.5, color: p.text2),
              ),
            ),
            GestureDetector(
              onTap: onTap,
              child: Text(
                link,
                style: TextStyle(fontFamily: kFont, fontSize: 12, height: 1.5, color: p.accent, fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// `.b .q`: the quoted line above a reply.
class QuoteStrip extends StatelessWidget {
  const QuoteStrip({super.key, required this.quote, this.onClose});
  final Quote quote;
  final VoidCallback? onClose;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Container(
      margin: const EdgeInsets.only(top: 2, bottom: 5),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: p.surface2,
        borderRadius: BorderRadius.circular(5),
        border: BorderDirectional(start: BorderSide(color: p.text3, width: 3)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  quote.askId == null ? quote.author : (quote.go ? UiCopy.text(260, [quote.author]) : UiCopy.text(261, [quote.author])),
                  style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.4, fontWeight: FontWeight.w700, color: p.text),
                ),
                Rich(
                  quote.text,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  auto: true,
                  style: TextStyle(fontFamily: kFont, fontSize: 13, height: 1.4, color: p.text2),
                ),
              ],
            ),
          ),
          if (onClose != null)
            IconButton(
              onPressed: onClose,
              tooltip: UiCopy.text(262),
              icon: Ic('close', size: 18, color: p.text2),
            ),
        ],
      ),
    );
  }
}

class TextBubble extends StatefulWidget {
  const TextBubble({super.key, required this.msg, this.from, this.footer = const []});
  final TextMsg msg;

  /// The worker whose conversation it is: its name and role head the bubble (a-he-chat `.who`). Null: no head.
  final String? from;

  /// Under the text: the cards of the tasks opened in this turn (a-he-chat `.tref`).
  final List<Widget> footer;

  /// Builds since the last reset, counted in debug and test builds only (test/perf_bench_test.dart).
  static int debugBuilds = 0;
  @override
  State<TextBubble> createState() => _TextBubbleState();
}

class _TextBubbleState extends State<TextBubble> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    assert(() {
      TextBubble.debugBuilds++;
      return true;
    }());
    final m = widget.msg;
    final p = context.p;
    if (m.artifact != null) {
      return Bubble(
        out: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ArtifactCard(info: m.artifact!),
            const SizedBox(height: 4),
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: Meta(time: hm(m.ts)),
            ),
          ],
        ),
      );
    }
    final lines = '\n'.allMatches(m.text).length + 1;
    // Long messages fold after ~30 lines; the first line always shows (chat.md §2.3).
    final long = !m.streaming && lines > 40 && !expanded;
    final text = long ? m.text.split('\n').take(30).join('\n') : m.text;
    final wide = m.text.length > 60 || m.text.contains('```');
    final multi = parseMarkdown(text).length > 1;
    final images = m.attachments;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (m.author != null)
          Text(
            m.author!,
            style: TextStyle(fontFamily: kFont, fontSize: 13, fontWeight: FontWeight.w700, color: p.text),
          )
        else if (widget.from != null)
          Builder(builder: (context) {
            final d = StoreScope.of(context).data;
            if (d == null) return const SizedBox.shrink();
            return Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(text: d.who(widget.from!).name, style: TextStyle(fontWeight: FontWeight.w600, color: p.text)),
                  TextSpan(text: '  ${d.roleLine(widget.from!)}'),
                ]),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: T.small.copyWith(color: p.text2),
              ),
            );
          }),
        if (images.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: BubbleImages(images: images),
          ),
        // One paragraph: the time rides on its last line (WhatsApp). Rich multi-block text: the
        // time gets its own corner line so it can never sit on top of a list or code.
        if (text.isNotEmpty || images.isEmpty) Markdown(text, trailerWidth: multi ? 0 : Meta.widthFor(null), caret: m.streaming),
        if (multi || (text.isEmpty && images.isNotEmpty)) const SizedBox(height: 14),
        if (long)
          GestureDetector(
            onTap: () => setState(() => expanded = true),
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                UiCopy.text(263, [lines - 30]),
                style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700),
              ),
            ),
          ),
        ...widget.footer,
        if (widget.footer.isNotEmpty) const SizedBox(height: 14),
      ],
    );
    return Bubble(
      out: false,
      wide: wide || widget.footer.isNotEmpty,
      child: _WithMeta(
        meta: Meta(time: hm(m.ts)),
        // Folded: the bottom row is the "continue reading" link on the right, so the time stays left.
        end: long ? Directionality.of(context) : markdownEndDirection(text, fallback: Directionality.of(context)),
        child: images.isEmpty ? body : IntrinsicWidth(child: body), // as wide as the images (or the text), like UserBubble
      ),
    );
  }
}

// ───────────────────────────── service lines (.svc) ─────────────────────────────

class ServiceLine extends StatelessWidget {
  const ServiceLine({super.key, required this.text, this.icon, this.strong = false, this.onTap, this.tapHint, this.iconColor});
  final String text;
  final String? icon;
  final bool strong;
  final VoidCallback? onTap;

  /// What a screen reader says a tap does.
  final String? tapHint;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final style = TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: strong ? p.text : p.text2, fontWeight: strong ? FontWeight.w700 : FontWeight.w400);
    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(8),
        boxShadow: const [BoxShadow(color: Color(0x0A000000), offset: Offset(0, 1))],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Ic(icon!, size: 15, color: iconColor ?? p.text2), const SizedBox(width: 4)],
          Flexible(
            child: Rich(text, style: style, align: TextAlign.center),
          ),
        ],
      ),
    );
    // A line that opens something takes its margin into its target (44 high), so it sits where the others do.
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: onTap == null ? 8 : 0),
      child: LayoutBuilder(
        builder: (context, c) => Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: c.maxWidth * 0.92),
            child: onTap == null
                ? pill
                : Semantics(
                    button: true,
                    hint: tapHint,
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: onTap,
                      child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: pill),
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────────── internal messages ─────────────────────────────

/// A message between two workers: one kind, a full-width line with no bubble and none of the colors of his or a
/// worker's bubbles, so it never reads as a conversation with him. "יואב ← נועה" bold, one line of the message, the
/// time. A tap opens it whole (the same screen as "שלח הודעה").
class InternalMsgRow extends StatelessWidget {
  const InternalMsgRow({super.key, required this.msg, this.inGroup = false});
  final InternalMsg msg;

  /// Inside an open group the row is indented under its header.
  final bool inGroup;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final d = StoreScope.of(context).data;
    if (d == null) return const SizedBox.shrink();
    final from = d.who(msg.from).name, to = d.who(msg.to).name;
    final line = msg.body.replaceAll(RegExp(r'\s+'), ' ').trim();
    final name = T.small.copyWith(color: p.text, fontWeight: FontWeight.w700);
    return Semantics(
      button: true,
      hint: UiCopy.text(264),
      label: '$from ← $to: $line',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => openInternalMessage(context, msg),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: EdgeInsetsDirectional.fromSTEB(inGroup ? 30 : 16, 8, 16, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: Ic('forward_to_inbox', size: 18, color: p.text2),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          // The arrow is an icon: Heebo has no "←", and the fallback face differs by device.
                          Flexible(
                            child: Text(from, maxLines: 1, overflow: TextOverflow.ellipsis, style: name),
                          ),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 4),
                            child: Ic(flowIcon(context), size: 15, color: p.text),
                          ),
                          Flexible(
                            child: Text(to, maxLines: 1, overflow: TextOverflow.ellipsis, style: name),
                          ),
                          const SizedBox(width: 8),
                          Text(hm(msg.ts), style: T.meta.copyWith(color: p.text3)),
                        ],
                      ),
                      Rich(line, maxLines: 1, style: T.row2.copyWith(color: p.text2)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A run of messages between workers as one line, "4 הודעות בין העובדים", that opens in place.
class InternalGroupRow extends StatelessWidget {
  const InternalGroupRow({super.key, required this.count, required this.open, required this.onToggle, required this.children});
  final int count;
  final bool open;
  final VoidCallback onToggle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          button: true,
          expanded: open,
          child: InkWell(
            onTap: onToggle,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 48),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Row(
                  children: [
                    Ic('forward_to_inbox', size: 18, color: p.text2),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        UiCopy.text(265, [count]),
                        style: T.small.copyWith(color: p.text, fontWeight: FontWeight.w700),
                      ),
                    ),
                    AnimatedRotation(
                      turns: open ? 0.5 : 0,
                      duration: _fold,
                      child: Ic('expand_more', size: 20, color: p.text2),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        AnimatedSize(
          duration: _fold,
          alignment: Alignment.topCenter,
          child: open ? Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children) : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

// ───────────────────────────── tools (.tool) ─────────────────────────────

String _outcomeIcon(Outcome o) => switch (o) {
  Outcome.ok => 'check',
  Outcome.error => 'error',
  Outcome.interrupted => 'stop_circle',
  Outcome.running => 'progress_activity',
};

class ToolGroupRow extends StatefulWidget {
  const ToolGroupRow({super.key, required this.group, this.forceOpen = false, this.identityId});
  final ToolGroup group;

  /// Whose tools: their gender says the Hebrew label, and a tap opens the details with their name.
  final String? identityId;
  final bool forceOpen;
  @override
  State<ToolGroupRow> createState() => _ToolGroupRowState();
}

class _ToolGroupRowState extends State<ToolGroupRow> {
  late bool open = widget.forceOpen || widget.group.outcome == Outcome.error;

  @override
  void didUpdateWidget(covariant ToolGroupRow old) {
    super.didUpdateWidget(old);
    if (widget.forceOpen && !old.forceOpen) open = true;
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final g = widget.group;
    final p = context.p;
    final style = TextStyle(fontFamily: kFont, fontSize: 13.5, height: 1.45, color: p.text2);
    final running = g.outcome == Outcome.running;
    Widget outcome = Ic(_outcomeIcon(g.outcome), size: 18, color: g.outcome == Outcome.error ? p.urgent : p.text2, fill: g.outcome == Outcome.error);
    if (running) outcome = Spin(child: outcome);
    return LayoutBuilder(
      builder: (context, c) => Align(
        alignment: AlignmentDirectional.centerStart,
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
          constraints: BoxConstraints(maxWidth: c.maxWidth * 0.92),
          decoration: BoxDecoration(color: p.toolBg, borderRadius: BorderRadius.circular(10)),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: () => setState(() => open = !open),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 1),
                        child: AnimatedRotation(
                          turns: open ? 0.5 : 0,
                          duration: _fold,
                          child: Ic('expand_more', size: 18, color: p.text2),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text.rich(
                          TextSpan(
                            children: [
                              ...Rich.spans(context, g.summary, style),
                              if (running && g.liveLabel != null) ...[
                                const TextSpan(text: ' · '),
                                TextSpan(
                                  text: g.liveLabel,
                                  style: TextStyle(fontWeight: FontWeight.w700, color: p.text),
                                ),
                                if (g.elapsed != null) TextSpan(text: ' · ${g.elapsed}'),
                              ],
                            ],
                          ),
                          style: style,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Padding(padding: const EdgeInsets.only(top: 1), child: outcome),
                    ],
                  ),
                ),
              ),
              AnimatedSize(
                duration: _fold,
                alignment: Alignment.topCenter,
                child: !open
                    ? const SizedBox(width: double.infinity)
                    : Padding(
                        padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
                        child: Column(children: [for (final t in g.tools) _ToolItem(t, identityId: widget.identityId)]),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// One tool in an open group: the Hebrew label, then its LTR detail (a path, a command) when it has one.
/// Never the tool's internal name (נועה, 22/10). A tap opens what it did (tool_details.dart).
class _ToolItem extends StatelessWidget {
  const _ToolItem(this.t, {this.identityId});
  final ToolLine t;
  final String? identityId;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final name = t.name;
    // Rows built without the event (the demo data) have no tool name: the detail alone, as before.
    if (name == null) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 5),
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: p.line)),
        ),
        child: Row(
          children: [
            Ic(t.icon, size: 16, color: t.outcome == Outcome.error ? p.urgent : p.text2),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                t.label,
                textDirection: TextDirection.ltr,
                textAlign: TextAlign.left,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: T.mono(11.5, lh: 16).copyWith(color: p.text),
              ),
            ),
            if (t.trail != null) ...[
              const SizedBox(width: 8),
              Rich(
                ltr(t.trail!),
                style: TextStyle(fontFamily: kFont, fontSize: 12.5, color: p.text2),
              ),
            ],
          ],
        ),
      );
    }
    final gender = identityId == null ? Gender.m : StoreScope.of(context).data?.who(identityId!).gender ?? Gender.m;
    final detail = toolHasDetail(name) && name != 'Bash'
        ? t.label
        : toolHasAgentDescription(t)
        ? t.label
        : null;
    // A command line says nothing to him: its Hebrew description, and without one only "הריץ פקודה" (נועה, 22/10).
    final said = name == 'Bash' ? hebrewOrEmpty((t.call?.input['description'] ?? '').toString()) : '';
    final err = t.outcome == Outcome.error;
    final row = Container(
      padding: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: p.line)),
      ),
      child: Row(
        children: [
          Ic(t.icon, size: 16, color: err ? p.urgent : p.text2),
          const SizedBox(width: 8),
          Text(
            toolLabel(name, gender),
            style: TextStyle(fontFamily: kFont, fontSize: 13, height: 1.4, color: p.text2),
          ),
          if (detail != null && detail.isNotEmpty) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                detail,
                textDirection: TextDirection.ltr,
                textAlign: TextAlign.left,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: T.mono(11.5, lh: 16).copyWith(color: p.text),
              ),
            ),
          ] else if (said.isNotEmpty) ...[
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                said,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontFamily: kFont, fontSize: 13, height: 1.4, color: p.text),
              ),
            ),
          ] else
            const Spacer(),
          if (t.trail != null) ...[
            const SizedBox(width: 8),
            Rich(
              ltr(t.trail!),
              style: TextStyle(fontFamily: kFont, fontSize: 12.5, color: p.text2),
            ),
          ],
        ],
      ),
    );
    final call = t.call;
    if (call == null || identityId == null) return row;
    return InkWell(onTap: () => openToolDetails(context, identityId!, call), child: row);
  }
}

// ───────────────────────────── cards (.card) ─────────────────────────────

/// `.card`: a wide incoming bubble with an optional thick start edge (asks) and a footer of actions.
class ChatCard extends StatelessWidget {
  const ChatCard({super.key, required this.children, this.edge = false, this.footer});
  final List<Widget> children;
  final bool edge;
  final List<CardAction>? footer;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return LayoutBuilder(
      builder: (context, c) {
        final w = c.maxWidth * 0.92;
        return Align(
          alignment: AlignmentDirectional.centerStart,
          child: Container(
            width: w.clamp(0, 760).toDouble(),
            margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: p.bubbleIn,
              boxShadow: p.hairShadow,
              borderRadius: const BorderRadiusDirectional.only(
                topStart: Radius.circular(3),
                topEnd: Radius.circular(10),
                bottomStart: Radius.circular(10),
                bottomEnd: Radius.circular(10),
              ),
            ),
            child: Stack(
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ...children,
                    if (footer != null && footer!.isNotEmpty)
                      Container(
                        decoration: BoxDecoration(
                          border: Border(top: BorderSide(color: p.line)),
                        ),
                        child: IntrinsicHeight(
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              for (var i = 0; i < footer!.length; i++) ...[if (i > 0) Container(width: 1, color: p.line), Expanded(child: footer![i])],
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
                if (edge) PositionedDirectional(start: 0, top: 0, bottom: 0, child: Container(width: 3, color: p.text)),
              ],
            ),
          ),
        );
      },
    );
  }
}

class CardAction extends StatelessWidget {
  const CardAction({super.key, required this.icon, required this.label, this.onTap, this.rotate = false});
  final String icon;
  final String label;
  final VoidCallback? onTap;
  final bool rotate;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    return InkWell(
      onTap: onTap ?? () {},
      child: SizedBox(
        height: 40,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedRotation(
              turns: rotate ? 0.5 : 0,
              duration: _fold,
              child: Ic(icon, size: 17, color: p.accent),
            ),
            const SizedBox(width: 5),
            Text(
              label,
              style: TextStyle(fontFamily: kFont, fontSize: 13.5, fontWeight: FontWeight.w700, color: p.accent),
            ),
          ],
        ),
      ),
    );
  }
}

class _CardHead extends StatelessWidget {
  const _CardHead({required this.icon, required this.child, this.trailing});
  final String icon;
  final Widget child;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Ic(icon, size: 19, color: context.p.text2),
          ),
          const SizedBox(width: 8),
          Expanded(child: child),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ],
      ),
    );
  }
}

/// File path, always LTR: folders secondary, file name bold, shortened from the start.
class PathText extends StatelessWidget {
  const PathText(this.path, {super.key, this.size = 12.5});
  final String path;
  final double size;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final i = path.lastIndexOf('/');
    final dir = i < 0 ? '' : path.substring(0, i + 1);
    final file = i < 0 ? path : path.substring(i + 1);
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: dir,
            style: TextStyle(color: p.text2),
          ),
          TextSpan(
            text: file,
            style: TextStyle(color: p.text, fontWeight: FontWeight.w700),
          ),
        ],
      ),
      textDirection: TextDirection.ltr,
      textAlign: TextAlign.left,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: T.mono(size, lh: size * 1.5),
    );
  }
}

class DiffCardView extends StatefulWidget {
  const DiffCardView({super.key, required this.card});
  final DiffCard card;
  @override
  State<DiffCardView> createState() => _DiffCardViewState();
}

class _DiffCardViewState extends State<DiffCardView> {
  bool open = false;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final c = widget.card;
    final p = context.p;
    final f = c.files.first;
    final many = c.files.length > 1;
    final add = c.files.fold(0, (s, f) => s + f.add), del = c.files.fold(0, (s, f) => s + f.del);
    return ChatCard(
      footer: [
        CardAction(icon: 'expand_more', label: UiCopy.text(266), rotate: open, onTap: () => setState(() => open = !open)),
        const CardAction(icon: 'open_in_new', label: 'VS Code'),
        if (c.prRef != null) const CardAction(icon: 'call_merge', label: 'PR'),
      ],
      children: [
        _CardHead(
          icon: 'edit',
          trailing: DiffStat('+$add −$del'),
          child: many
              ? Text(
                  UiCopy.text(267, [c.files.length]),
                  style: T.secondary.copyWith(fontWeight: FontWeight.w700, color: p.text),
                )
              : PathText(f.path),
        ),
        if (c.note != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Rich(c.note!, style: T.secondary.copyWith(color: p.text2)),
          ),
        AnimatedSize(
          duration: _fold,
          alignment: Alignment.topCenter,
          child: !open
              ? const SizedBox(width: double.infinity)
              : Column(
                  children: [for (final f in c.files) DiffBody(file: f, showPath: many)],
                ),
        ),
      ],
    );
  }
}

/// Unified diff (chat.md §2.6): +/− on every line, gentle backgrounds, wrapped long lines.
class DiffBody extends StatelessWidget {
  const DiffBody({super.key, required this.file, this.showPath = false});
  final DiffFile file;
  final bool showPath;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final mono = T.mono(11.5, lh: 18.4);
    return Container(
      decoration: BoxDecoration(
        color: p.codeBg,
        border: Border(top: BorderSide(color: p.line)),
      ),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (showPath) Padding(padding: const EdgeInsets.fromLTRB(8, 6, 8, 4), child: PathText(file.path, size: 11.5)),
            for (final h in file.hunks) ...[
              Container(
                color: p.surface2,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                child: Text(h.header, style: mono.copyWith(color: p.text2)),
              ),
              for (final l in h.lines)
                Container(
                  color: switch (l.kind) {
                    DiffLineKind.add => p.addBg,
                    DiffLineKind.del => p.delBg,
                    DiffLineKind.ctx => null,
                  },
                  padding: const EdgeInsets.only(right: 8),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: 30,
                        child: Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child: Text(
                            '${l.no}',
                            textAlign: TextAlign.right,
                            style: mono.copyWith(color: p.text3),
                          ),
                        ),
                      ),
                      SizedBox(
                        width: 14,
                        child: Text(switch (l.kind) {
                          DiffLineKind.add => '+',
                          DiffLineKind.del => '−',
                          DiffLineKind.ctx => ' ',
                        }, style: mono.copyWith(color: l.kind == DiffLineKind.ctx ? p.text2 : p.text, fontWeight: l.kind == DiffLineKind.ctx ? null : FontWeight.w700)),
                      ),
                      Expanded(
                        child: Text.rich(_marked(l, p), style: mono.copyWith(color: p.text)),
                      ),
                    ],
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  TextSpan _marked(DiffLine l, Palette p) {
    if (l.marks.isEmpty) return TextSpan(text: l.text);
    final spans = <TextSpan>[];
    var rest = l.text;
    for (final m in l.marks) {
      final i = rest.indexOf(m);
      if (i < 0) continue;
      spans.add(TextSpan(text: rest.substring(0, i)));
      spans.add(
        TextSpan(
          text: m,
          style: const TextStyle(fontWeight: FontWeight.w700, decoration: TextDecoration.underline),
        ),
      );
      rest = rest.substring(i + m.length);
    }
    spans.add(TextSpan(text: rest));
    return TextSpan(children: spans);
  }
}

class TestCardView extends StatelessWidget {
  const TestCardView({super.key, required this.card});
  final TestResultCard card;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final parts = [
      UiCopy.text(268),
      UiCopy.text(269, [card.passed]),
      if (card.failed > 0) UiCopy.text(270, [card.failed]),
      if (card.skipped > 0) UiCopy.text(271, [card.skipped]),
    ];
    return ChatCard(
      children: [
        _CardHead(
          icon: card.failed > 0 ? 'checklist' : 'check',
          trailing: card.seconds == null ? null : Text(UiCopy.text(272, [card.seconds]), style: T.meta.copyWith(color: p.text2)),
          child: Text(
            parts.join(' · '),
            style: TextStyle(fontFamily: kFont, fontSize: 14, height: 1.45, fontWeight: FontWeight.w700, color: p.text),
          ),
        ),
        if (card.failures.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Column(
              children: [
                for (final f in card.failures)
                  Container(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    decoration: BoxDecoration(
                      border: Border(top: BorderSide(color: p.line)),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(width: 20, child: Ic('error', size: 16, fill: true, color: p.text)),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Directionality(
                            textDirection: TextDirection.ltr,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        f.name,
                                        softWrap: false,
                                        overflow: TextOverflow.ellipsis,
                                        style: T.mono(12.5, w: FontWeight.w500, lh: 18).copyWith(color: p.text),
                                      ),
                                    ),
                                    Text(f.location, style: T.mono(12.5, lh: 18).copyWith(color: p.text2)),
                                  ],
                                ),
                                Text(f.why, style: T.mono(11.5, lh: 17).copyWith(color: p.text2)),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class TerminalCardView extends StatelessWidget {
  const TerminalCardView({super.key, required this.card});
  final TerminalCard card;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final mono = T.mono(11.5, lh: 17.8);
    return ChatCard(
      children: [
        Container(
          decoration: BoxDecoration(
            color: p.codeBg,
            border: Border(top: BorderSide(color: p.line)),
          ),
          child: Directionality(
            textDirection: TextDirection.ltr,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
                  decoration: BoxDecoration(
                    border: Border(bottom: BorderSide(color: p.line)),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          '\$ ${card.command}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: mono.copyWith(color: p.text),
                        ),
                      ),
                      IconButton(
                        tooltip: UiCopy.text(273),
                        visualDensity: VisualDensity.compact,
                        onPressed: () => Clipboard.setData(ClipboardData(text: card.command)),
                        icon: Ic('content_copy', size: 16, color: p.text2),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  child: Text.rich(
                    TextSpan(
                      children: [
                        for (final (i, l) in card.tail.indexed)
                          TextSpan(
                            text: '$l${i == card.tail.length - 1 ? '' : '\n'}',
                            // ANSI colour becomes weight: FAIL lines stand out without colour (chat.md §2.7).
                            style: l.contains('FAIL') ? TextStyle(fontWeight: FontWeight.w700, color: p.text) : null,
                          ),
                      ],
                    ),
                    style: mono.copyWith(color: p.text2),
                  ),
                ),
              ],
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (card.exitCode != 0)
                Text(
                  UiCopy.text(274, [card.exitCode]),
                  style: T.secondary.copyWith(color: p.text, fontWeight: FontWeight.w700),
                ),
              if (card.footer != null) Text('${card.footer} · ', style: T.secondary.copyWith(color: p.text2)),
              if (card.totalLines != null) LinkText(UiCopy.text(275, [card.totalLines]), size: 13.5),
            ],
          ),
        ),
      ],
    );
  }
}

class PrCardView extends StatelessWidget {
  const PrCardView({super.key, required this.card});
  final PrCard card;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    Widget check(String label, Check c) => switch (c) {
      Check.none => const SizedBox.shrink(),
      Check.running => Badge2(label: label, icon: 'progress_activity', spin: true),
      Check.ok => Badge2(label: label, icon: 'check'),
      Check.failed => Badge2(label: UiCopy.text(276, [label]), icon: 'error'),
    };
    final state = switch (card.state) {
      PrState.open => UiCopy.text(277),
      PrState.merged => UiCopy.text(278),
      PrState.closed => UiCopy.text(279),
    };
    return ChatCard(
      footer: [
        CardAction(icon: 'description', label: UiCopy.text(280)),
        CardAction(icon: 'open_in_new', label: 'GitHub'),
      ],
      children: [
        _CardHead(
          icon: 'call_merge',
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: ltr('PR #${card.number}'),
                  style: T.mono(12.5, w: FontWeight.w500).copyWith(color: p.text2),
                ),
                TextSpan(text: ' · ${card.title}'),
              ],
            ),
            style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.4, fontWeight: FontWeight.w700, color: p.text),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 2, 12, 10),
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Badge2(label: state),
              check('CI', card.ci),
              check(UiCopy.text(281), card.review),
              DiffStat('+${card.add} −${card.del}'),
              Text(
                UiCopy.text(267, [card.files]),
                style: TextStyle(fontFamily: kFont, fontSize: 12, color: p.text2),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Ask and GO (chat.md §2.8, #258): a message from whoever asked, in their conversation. Open, its answers are
/// buttons inside it, always there; a tap on the card itself opens or closes the details, and never starts an
/// answer (quoting is a swipe or a long press). One tap decides: the card folds at once to one line,
/// "אישרת · 02:14" with "ביטול" for 5 seconds. A closed one stays that one line; a GO with a newer one from the
/// same worker folds to "הוחלפה בבקשה חדשה". The same object as on home and in the notification.
class AskCardView extends StatefulWidget {
  const AskCardView({super.key, required this.card, required this.onOther, this.superseded = false, this.flash = false});
  final AskCard card;
  final VoidCallback onOther;

  /// A GO with a newer one open from the same worker.
  final bool superseded;

  /// Lit for a moment: "לבקשה" in the banner just brought it here.
  final bool flash;

  @override
  State<AskCardView> createState() => _AskCardViewState();
}

class _AskCardViewState extends State<AskCardView> {
  bool details = false;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final card = widget.card;
    final store = StoreScope.of(context);
    final p = context.p;
    final from = store.nameOf(card.from);
    final go = card is GoCard;
    final pending = store.decision(card.askId, card.id);
    final wait = store.data?.waiting.where((w) => w.askId != null && w.askId == card.askId).firstOrNull;
    final notNow = go && wait?.state == WaitState.notNow && card.state == AskState.open;
    final closed = widget.superseded || notNow || (card.state != AskState.open && card.state != AskState.pending);
    final check = card is CheckCard;
    final label = go
        ? UiCopy.text(282, [from])
        : check
        ? UiCopy.text(283, [from])
        : UiCopy.text(284, [from]);

    if (go && wait != null && !closed && pending == null) {
      final l = AppLocalizations.of(context);
      return Bubble(
        out: false,
        wide: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(approvalTitle(context, wait), style: T.name.copyWith(color: p.text)),
            const SizedBox(height: 4),
            Text('${store.nameOf(card.from)} · ${store.data!.roleLine(card.from)}', style: T.small.copyWith(color: p.text2)),
            const SizedBox(height: 10),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: FilledButton(onPressed: () => showApproval(context, wait), child: Text(wait.action == 'release' ? l.reviewAndRelease : l.approve)),
            ),
          ],
        ),
      );
    }
    if (pending != null || closed) {
      final (:icon, :text) = pending != null ? (icon: 'check_circle', text: pendingLine(pending)) : closedLine(card, superseded: widget.superseded, notNow: notNow);
      final VoidCallback? undo = pending != null
          ? () => store.cancelUndo(AppStore.decisionKey(card.askId, card.id))
          : notNow
          ? () => store.resume(wait!)
          : null;
      return Semantics(
        container: true,
        label: label,
        child: Bubble(
          out: false,
          wide: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              DecisionLine(icon: icon, text: text, subject: card.headline ?? card.question.split('\n').first, onUndo: undo, onTap: () => setState(() => details = !details)),
              AnimatedSize(
                duration: _fold,
                alignment: Alignment.topCenter,
                child: details
                    ? Padding(
                        padding: const EdgeInsets.only(top: 4, bottom: 2),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (card.headline != null)
                              Rich(
                                card.headline!,
                                style: TextStyle(fontFamily: kFont, fontSize: 15, height: 1.45, fontWeight: FontWeight.w700, color: p.text),
                              ),
                            Markdown(card.question),
                            Align(
                              alignment: AlignmentDirectional.centerEnd,
                              child: Meta(time: hm(card.ts)),
                            ),
                          ],
                        ),
                      )
                    : const SizedBox(width: double.infinity),
              ),
            ],
          ),
        ),
      );
    }

    final kicker = Text.rich(
      TextSpan(
        children: [
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Padding(
              padding: const EdgeInsetsDirectional.only(end: 4),
              child: Ic(check ? 'fact_check' : 'front_hand', size: 16, fill: true, color: p.text2),
            ),
          ),
          TextSpan(
            text: go
                ? UiCopy.text(177, [ltr('GO')])
                : check
                ? UiCopy.text(31)
                : (card.blocking ? UiCopy.text(285) : UiCopy.text(286)),
          ),
          if (!go && card.escalation != null) TextSpan(text: ' · ${card.escalation!.replaceAll(' ', '\u00A0')}'),
          TextSpan(text: ' · ${hm(card.ts)}'),
        ],
      ),
      style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: p.text2),
    );

    final headline = card.headline;
    final keys = go
        ? DecisionKeys.go(onGo: () => store.answerCard(card, card.options.first), onNotNow: wait == null ? null : () => store.notNow(wait))
        : DecisionKeys.ask(
            card.options,
            other: !check && !isCaughtFault(card.from, card.askId),
            onPick: (o) => store.answerCard(card, o),
            onOther: widget.onOther,
            keys: MediaQuery.sizeOf(context).width >= 800 && identical(shortcutAsk(store.data?.chats[card.from]), card),
          );

    // The whole card is the details' toggle; the buttons are its only answers.
    final top = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        kicker,
        const SizedBox(height: 2),
        if (headline != null) ...[
          Rich(
            headline,
            style: TextStyle(fontFamily: kFont, fontSize: 15.5, height: 1.45, fontWeight: FontWeight.w700, color: p.text),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  details ? UiCopy.text(287) : UiCopy.text(288),
                  style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700),
                ),
                AnimatedRotation(
                  turns: details ? 0.5 : 0,
                  duration: _fold,
                  child: Ic('expand_more', size: 18, color: p.accent),
                ),
              ],
            ),
          ),
          AnimatedSize(
            duration: _fold,
            alignment: Alignment.topCenter,
            child: details ? Padding(padding: const EdgeInsets.only(bottom: 4), child: Markdown(card.question)) : const SizedBox(width: double.infinity),
          ),
        ] else
          Markdown(card.question),
      ],
    );

    return Semantics(
      container: true,
      label: label,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 400),
        color: widget.flash ? p.accentSoft : Colors.transparent,
        child: Bubble(
          out: false,
          wide: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (headline != null)
                Semantics(
                  button: true,
                  expanded: details,
                  hint: details ? UiCopy.text(287) : UiCopy.text(288),
                  child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => setState(() => details = !details), child: top),
                )
              else
                top,
              const SizedBox(height: 8),
              DecisionKeys(keys: keys),
              const SizedBox(height: 4),
            ],
          ),
        ),
      ),
    );
  }
}

class DecidedCardView extends StatelessWidget {
  const DecidedCardView({super.key, required this.card});
  final DecidedCard card;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final by = StoreScope.of(context).nameOf(card.by);
    return ChatCard(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 2),
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: UiCopy.text(289, [by]),
                  style: TextStyle(color: p.text, fontWeight: FontWeight.w700),
                ),
                TextSpan(text: ' · ${card.time}'),
              ],
            ),
            style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: p.text2),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 2, 14, 12),
          child: Text.rich(
            TextSpan(
              children: [
                ...Rich.spans(context, card.text, T.row2),
                const TextSpan(text: ' '),
                WidgetSpan(alignment: PlaceholderAlignment.baseline, baseline: TextBaseline.alphabetic, child: LinkText(UiCopy.text(290), size: 14.5)),
              ],
            ),
            style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.55, color: p.text),
          ),
        ),
      ],
    );
  }
}

class PermissionCardView extends StatelessWidget {
  const PermissionCardView({super.key, required this.card});
  final PermissionCard card;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final from = store.nameOf(card.from);
    final done = card.state != PermissionState.open;
    return ChatCard(
      edge: !done,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
          child: Text(
            UiCopy.text(291, [from]),
            style: TextStyle(fontFamily: kFont, fontSize: 14, fontWeight: FontWeight.w700, color: p.text),
          ),
        ),
        Container(
          margin: const EdgeInsets.symmetric(horizontal: 12),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: p.codeBg,
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: p.line),
          ),
          child: Text(
            '\$ ${card.command}',
            textDirection: TextDirection.ltr,
            style: T.mono(12).copyWith(color: p.text),
          ),
        ),
        if (done)
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
            child: DoneLine(switch (card.state) {
              PermissionState.allowed => UiCopy.text(292),
              PermissionState.allowedForTask => UiCopy.text(293),
              _ => UiCopy.text(294),
            }),
          )
        else
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                Btn(
                  UiCopy.text(295),
                  kind: BtnKind.primary,
                  onTap: () {
                    card.state = PermissionState.allowed;
                    store.touch();
                  },
                ),
                Btn(
                  UiCopy.text(296),
                  onTap: () {
                    card.state = PermissionState.denied;
                    store.touch();
                  },
                ),
                Btn(
                  UiCopy.text(297),
                  onTap: () {
                    card.state = PermissionState.allowedForTask;
                    store.touch();
                  },
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class FileBubble extends StatelessWidget {
  const FileBubble({super.key, required this.msg});
  final FileMsg msg;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final icon = msg.mime.startsWith('image/')
        ? 'image'
        : msg.mime == 'application/pdf'
        ? 'picture_as_pdf'
        : 'draft';
    final kb = msg.bytes < 1024 * 1024 ? '${(msg.bytes / 1024).round()}KB' : '${(msg.bytes / 1024 / 1024).toStringAsFixed(1)}MB';
    final type = msg.mime.split('/').last.toUpperCase();
    return Bubble(
      out: false,
      child: _WithMeta(
        meta: Meta(time: hm(msg.ts)),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Ic(icon, size: 28, color: p.text2),
            const SizedBox(width: 10),
            Flexible(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    msg.name,
                    textDirection: TextDirection.ltr,
                    style: T.secondary.copyWith(color: p.text, fontWeight: FontWeight.w700),
                  ),
                  Text('$kb · $type', style: T.meta.copyWith(color: p.text2)),
                  const SizedBox(height: 10),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class HandoffCardView extends StatefulWidget {
  const HandoffCardView({super.key, required this.card, required this.from});
  final HandoffCard card;
  final String from;
  @override
  State<HandoffCardView> createState() => _HandoffCardViewState();
}

class _HandoffCardViewState extends State<HandoffCardView> {
  bool _sending = false;

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final store = StoreScope.of(context);
    final card = widget.card;
    // The live link is his "מחכה לך" item from this worker (hq's tab handoff); the card is only where he meets it.
    // Its own request, by what it asked (hq's item body is the same `what`): a worker that asks twice in one
    // conversation must not have its first, finished card close the second one.
    final logins = store.data?.waiting.where((w) => w.kind == WaitKind.login && w.from == widget.from && (card.what.isEmpty || w.body == card.what)) ?? const <WaitItem>[];
    final w = logins.where((w) => w.state != WaitState.answered).firstOrNull;
    // Answered from "מחכה לך" rather than here: done, even before the worker's call comes back.
    final done = card.done || (w == null && logins.any((w) => w.state == WaitState.answered));
    // A site, not hq's fallback title for a tab with none (a local file).
    final site = w?.domain ?? '';
    final domain = RegExp(r'^[\w.-]+\.[a-z]{2,}$', caseSensitive: false).hasMatch(site) ? site : card.domain;
    final open = w != null && !done && !card.failed;
    final Widget foot;
    if (open) {
      foot = Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          Btn(UiCopy.text(126), kind: BtnKind.primary, onTap: () => Nav.handoff(context, w)),
          Btn(
            UiCopy.text(298),
            onTap: _sending
                ? null
                : () async {
                    setState(() => _sending = true);
                    final ok = await store.handoffDone(w);
                    if (!mounted) return;
                    setState(() {
                      _sending = false;
                      if (ok) card.done = true;
                    });
                  },
          ),
        ],
      );
    } else if (card.failed) {
      foot = DoneLine(UiCopy.text(299), top: 0, icon: 'close');
    } else if (done) {
      foot = DoneLine(UiCopy.text(300), top: 0);
    } else if (card.ended) {
      foot = DoneLine(UiCopy.text(301), top: 0);
    } else {
      foot = DoneLine(UiCopy.text(302), top: 0, icon: 'schedule');
    }
    return ChatCard(
      edge: open,
      children: [
        _CardHead(
          icon: 'lock',
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: UiCopy.text(303),
                  style: TextStyle(fontWeight: FontWeight.w700, color: p.text),
                ),
                if (domain.isNotEmpty) ...[const TextSpan(text: ' · '), TextSpan(text: ltr(domain), style: T.mono(12.5))],
              ],
            ),
            style: T.secondary.copyWith(color: p.text2),
          ),
        ),
        if (card.what.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
            child: Rich(card.what, auto: true, style: T.body.copyWith(color: p.text)),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
          // How long the link lives sits with the buttons, at the far side: the head stays one line at 1.3 (נועה).
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Align(alignment: AlignmentDirectional.centerStart, child: foot),
              ),
              if (open && card.expires.isNotEmpty) ...[const SizedBox(width: 8), Text(card.expires, style: T.meta.copyWith(color: p.text2))],
            ],
          ),
        ),
      ],
    );
  }
}

/// What the worker is doing right now, at the end of the list (chat.md §2.2).
class LiveIndicator extends StatelessWidget {
  const LiveIndicator({super.key, required this.live, required this.name, required this.gender});
  final LiveState live;
  final String name;
  final Gender gender;
  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    final p = context.p;
    final f = gender == Gender.f;
    final (String? icon, String? text, bool spin) = switch (live.phase) {
      LivePhase.idle || LivePhase.writing => (null, null, false),
      LivePhase.starting => ('check', live.label ?? UiCopy.text(306, [name, f ? UiCopy.text(304) : UiCopy.text(305)]), false),
      LivePhase.thinking => (null, "${f ? UiCopy.text(307) : UiCopy.text(308)}${live.seconds != null ? UiCopy.text(309, [live.seconds]) : ''}", false),
      LivePhase.tool => (
        'progress_activity',
        '${live.label ?? (f ? UiCopy.text(85) : UiCopy.text(86))}${live.seconds != null ? ' · ${live.seconds! ~/ 60}:${(live.seconds! % 60).toString().padLeft(2, '0')}' : ''}',
        true,
      ),
      LivePhase.compacting => ('progress_activity', UiCopy.text(310), true),
      LivePhase.stopped => ('stop_circle', '${f ? UiCopy.text(159) : UiCopy.text(160)} · ${live.stoppedAt ?? ''}', false),
    };
    if (text == null) return const SizedBox.shrink();
    if (live.phase == LivePhase.stopped) return ServiceLine(text: text, icon: icon);
    Widget? ic = icon == null ? null : Ic(icon, size: 16, color: p.text2);
    if (ic != null && spin) ic = Spin(child: ic);
    return Align(
      alignment: AlignmentDirectional.centerStart,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: p.bubbleIn,
          borderRadius: const BorderRadiusDirectional.only(
            topStart: Radius.circular(3),
            topEnd: Radius.circular(10),
            bottomStart: Radius.circular(10),
            bottomEnd: Radius.circular(10),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (ic != null) ...[ic, const SizedBox(width: 6)],
            Text(
              text,
              style: TextStyle(fontFamily: kFont, fontSize: 13, height: 1.4, color: p.text2),
            ),
            if (live.phase == LivePhase.thinking) ...[const SizedBox(width: 6), const _Dots()],
          ],
        ),
      ),
    );
  }
}

class _Dots extends StatefulWidget {
  const _Dots();
  @override
  State<_Dots> createState() => _DotsState();
}

class _DotsState extends State<_Dots> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200));
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!Motion.frozen && !(MediaQuery.maybeDisableAnimationsOf(context) ?? false)) _c.repeat();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    UiCopy.watch(context);
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < 3; i++)
            Container(
              width: 4,
              height: 4,
              margin: const EdgeInsets.symmetric(horizontal: 1.5),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: context.p.text2.withValues(alpha: ((_c.value * 3 - i) % 3) < 1 ? 1 : 0.35),
              ),
            ),
        ],
      ),
    );
  }
}

/// The question the desktop's number keys answer in a conversation: the newest open one that isn't a GO.
AskCard? shortcutAsk(Conversation? chat) => chat?.items.whereType<AskCard>().where((a) => a.state == AskState.open && a is! GoCard).lastOrNull;

/// Its options, in the order of the keys: what its buttons show.
List<AskOption> shortcutOptions(AskCard ask) => ask.options.where((o) => o.id != 'q' && o.id != 'not_now').toList();
