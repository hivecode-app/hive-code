// Every chat item kind (chat.md §2), one widget each, matching the mockup's chat classes:
// .b (bubbles), .tool, .card (diff, tests, terminal, PR, ask, GO), .svc (service lines).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../data/store.dart';
import '../../model/models.dart';
import '../../theme/tokens.dart';
import '../common.dart';
import '../nav.dart';
import 'markdown.dart';
import '../convs/kbd.dart';

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
    final p = context.p;
    return LayoutBuilder(builder: (context, c) {
      final maxW = c.maxWidth;
      return Align(
        alignment: out ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
          constraints: BoxConstraints(maxWidth: maxW * (wide ? 0.92 : 0.88), minWidth: wide ? maxW * 0.92 : 0),
          padding: const EdgeInsets.fromLTRB(10, 6, 10, 6),
          decoration: BoxDecoration(
            color: out ? p.bubbleOut : p.bubbleIn,
            boxShadow: p.hairShadow,
            borderRadius: BorderRadiusDirectional.only(
              topStart: Radius.circular(out ? 10 : 3),
              topEnd: Radius.circular(out ? 3 : 10),
              bottomStart: const Radius.circular(10),
              bottomEnd: const Radius.circular(10),
            ),
          ),
          child: child,
        ),
      );
    });
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
    final p = context.p;
    final (String? icon, Color? color, String label) = switch (delivery) {
      null => (null, null, ''),
      Delivery.pendingConnection => ('schedule', p.text2, 'ממתינה לחיבור'),
      Delivery.queued => ('schedule', p.text2, 'בתור'),
      Delivery.delivered => ('check', p.text3, 'נמסר'),
      Delivery.read || Delivery.handled => ('done_all', p.read, 'נקרא'),
      Delivery.failed => ('error', p.urgent, 'לא נמסר'),
    };
    return Semantics(
      label: '$time $label',
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Text(time, style: TextStyle(fontFamily: kFont, fontSize: 11.5, height: 1, color: delivery == Delivery.queued ? p.text2 : p.text3)),
        if (icon != null) ...[const SizedBox(width: 2), Ic(icon, size: 16, color: color, fill: icon == 'error')],
      ]),
    );
  }
}

/// Text with the time in the bottom corner where the last line ends: left after a Hebrew line,
/// right after an English one. The last line reserves the room, so the time never covers text.
class _WithMeta extends StatelessWidget {
  const _WithMeta({required this.child, required this.meta, this.end = TextDirection.rtl});
  final Widget child;
  final Widget meta;
  final TextDirection end;
  @override
  Widget build(BuildContext context) => Stack(children: [
        Padding(padding: const EdgeInsets.only(bottom: 2), child: child),
        Positioned(bottom: 0, left: end == TextDirection.rtl ? 0 : null, right: end == TextDirection.ltr ? 0 : null, child: meta),
      ]);
}

// ───────────────────────────── user / text ─────────────────────────────

class UserBubble extends StatelessWidget {
  const UserBubble({super.key, required this.msg, required this.identityId, this.onRetract, this.onRetry});
  final UserMsg msg;
  final String identityId;
  final VoidCallback? onRetract;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final multi = parseMarkdown(msg.text).length > 1;
    final images = msg.attachments.where((a) => a.isImage).toList();
    final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      if (msg.replyTo != null) QuoteStrip(quote: msg.replyTo!),
      if (images.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: BubbleImages(images: images, uploading: msg.delivery == Delivery.queued && images.any((a) => a.id == null)),
        ),
      if (msg.text.isNotEmpty) Markdown(msg.text, trailerWidth: multi ? 0 : Meta.widthFor(msg.delivery)),
      if (multi || msg.text.isEmpty) const SizedBox(height: 14),
    ]);
    final bubble = Bubble(
      out: true,
      queued: msg.delivery == Delivery.queued,
      child: _WithMeta(meta: Meta(time: hm(msg.ts), delivery: msg.delivery), end: markdownEndDirection(msg.text), child: images.isEmpty ? body : IntrinsicWidth(child: body)), // as wide as the image (or the text), WhatsApp
    );
    final under = switch (msg.delivery) {
      Delivery.queued => _QLine(
          text: 'בתור · ${msg.priority == Priority.later ? 'בסוף התור' : 'אחרי הצעד הנוכחי'} · ',
          link: 'משיכה חזרה',
          onTap: onRetract),
      Delivery.pendingConnection => _QLine(text: 'ממתינה לחיבור · ', link: 'משיכה חזרה', onTap: onRetract),
      Delivery.failed => _QLine(text: 'לא נמסר · ', link: 'ניסיון נוסף', onTap: onRetry),
      _ => null,
    };
    if (under == null) return bubble;
    return Column(crossAxisAlignment: CrossAxisAlignment.end, children: [bubble, under]);
  }
}

/// The images of a message, WhatsApp style: one fills the bubble, more make a grid of squares.
/// A tap opens it full screen, where a swipe moves between the message's images.
class BubbleImages extends StatelessWidget {
  const BubbleImages({super.key, required this.images, this.uploading = false});
  final List<Attachment> images;

  /// Still going up to hq: a spinner over each image until the message is sent.
  final bool uploading;
  @override
  Widget build(BuildContext context) {
    Widget one(int i, {double? side}) => uploading ? _uploading(images[i], side) : _open(context, i, side);
    if (images.length == 1) {
      // widthFactor 1: the bubble is as wide as the image, not the whole row.
      return Align(alignment: AlignmentDirectional.centerStart, widthFactor: 1, child: one(0));
    }
    return Wrap(spacing: 4, runSpacing: 4, children: [for (var i = 0; i < images.length; i++) one(i, side: 128)]);
  }

  Widget _image(Attachment a, double? side) => ClipRRect(
        borderRadius: BorderRadius.circular(6),
        child: side == null
            ? ConstrainedBox(constraints: const BoxConstraints(maxWidth: 260, maxHeight: 320), child: AttachmentImage(attachment: a, fit: BoxFit.contain))
            : SizedBox(width: side, height: side, child: AttachmentImage(attachment: a, fit: BoxFit.cover)),
      );

  Widget _uploading(Attachment a, double? side) => Stack(alignment: Alignment.center, children: [
        _image(a, side),
        Container(
          width: 44,
          height: 44,
          decoration: const BoxDecoration(color: Color(0x80000000), shape: BoxShape.circle),
          padding: const EdgeInsets.all(10),
          child: Semantics(label: 'מעלה את התמונה', child: const CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white)),
        ),
      ]);

  Widget _open(BuildContext context, int i, double? side) => GestureDetector(
          onTap: () => Navigator.of(context).push(PageRouteBuilder(
            opaque: false,
            pageBuilder: (_, _, _) => ImageViewer(images: images, initial: i),
            transitionsBuilder: (_, anim, _, child) => FadeTransition(opacity: anim, child: child),
          )),
          child: _image(images[i], side),
        );
}

/// An attached image: from this device's bytes when it has them, otherwise from hq (and kept).
class AttachmentImage extends StatefulWidget {
  const AttachmentImage({super.key, required this.attachment, this.fit = BoxFit.cover});
  final Attachment attachment;
  final BoxFit fit;
  @override
  State<AttachmentImage> createState() => _AttachmentImageState();
}

class _AttachmentImageState extends State<AttachmentImage> {
  Future<Uint8List?>? _load;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final a = widget.attachment;
    _load ??= a.data != null ? Future.value(a.data) : (a.id == null ? Future.value(null) : StoreScope.read(context).backend.attachmentData(a.id!));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return FutureBuilder<Uint8List?>(
      future: _load,
      builder: (context, snap) {
        final data = snap.data;
        if (data != null) {
          return Semantics(image: true, label: 'תמונה', child: Image.memory(data, fit: widget.fit, gaplessPlayback: true));
        }
        return Container(
          width: 200,
          height: 150,
          color: p.surface2,
          child: Center(
            child: snap.connectionState == ConnectionState.done
                ? Ic('image', size: 32, color: p.text3, semantic: 'התמונה לא נטענה')
                : SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: p.text3)),
          ),
        );
      },
    );
  }
}

/// A message's images full screen, from the one tapped: zoomable, a swipe moves to the next;
/// a tap on the dark around it or the × closes it.
class ImageViewer extends StatefulWidget {
  const ImageViewer({super.key, required this.images, this.initial = 0});
  final List<Attachment> images;
  final int initial;
  @override
  State<ImageViewer> createState() => _ImageViewerState();
}

class _ImageViewerState extends State<ImageViewer> {
  late final _pages = PageController(initialPage: widget.initial);
  late int _at = widget.initial;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: const Color(0xF0000000),
        body: SafeArea(
          child: Stack(children: [
            Positioned.fill(
              child: GestureDetector(
                onTap: () => Navigator.pop(context),
                child: PageView.builder(
                  controller: _pages,
                  itemCount: widget.images.length,
                  onPageChanged: (i) => setState(() => _at = i),
                  itemBuilder: (_, i) => InteractiveViewer(maxScale: 5, child: Center(child: AttachmentImage(attachment: widget.images[i], fit: BoxFit.contain))),
                ),
              ),
            ),
            if (widget.images.length > 1)
              PositionedDirectional(
                top: 16,
                end: 16,
                child: Text('${_at + 1} מתוך ${widget.images.length}', style: const TextStyle(fontFamily: kFont, fontSize: 14, color: Colors.white)),
              ),
            PositionedDirectional(
              top: 4,
              start: 4,
              child: IconButton(
                tooltip: 'סגירה',
                onPressed: () => Navigator.pop(context),
                icon: const Ic('close', color: Colors.white),
              ),
            ),
          ]),
        ),
      );
}

class _QLine extends StatelessWidget {
  const _QLine({required this.text, required this.link, this.onTap});
  final String text;
  final String link;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Align(
      alignment: AlignmentDirectional.centerEnd,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Text(text, style: TextStyle(fontFamily: kFont, fontSize: 12, height: 1.5, color: p.text2)),
          GestureDetector(
            onTap: onTap,
            child: Text(link, style: TextStyle(fontFamily: kFont, fontSize: 12, height: 1.5, color: p.accent, fontWeight: FontWeight.w700)),
          ),
        ]),
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
    final p = context.p;
    return Container(
      margin: const EdgeInsets.only(top: 2, bottom: 5),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: p.surface2,
        borderRadius: BorderRadius.circular(5),
        border: BorderDirectional(start: BorderSide(color: p.text3, width: 3)),
      ),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(quote.askId == null ? quote.author : (quote.go ? 'תשובה לבקשת GO של ${quote.author}' : 'תשובה לשאלה של ${quote.author}'), style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.4, fontWeight: FontWeight.w700, color: p.text)),
            Rich(quote.text, maxLines: 2, auto: true, style: TextStyle(fontFamily: kFont, fontSize: 13, height: 1.4, color: p.text2)),
          ]),
        ),
        if (onClose != null) IconButton(onPressed: onClose, tooltip: 'ביטול הציטוט', icon: Ic('close', size: 18, color: p.text2)),
      ]),
    );
  }
}

class TextBubble extends StatefulWidget {
  const TextBubble({super.key, required this.msg});
  final TextMsg msg;

  /// Builds since the last reset, counted in debug and test builds only (test/perf_bench_test.dart).
  static int debugBuilds = 0;
  @override
  State<TextBubble> createState() => _TextBubbleState();
}

class _TextBubbleState extends State<TextBubble> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    assert(() {
      TextBubble.debugBuilds++;
      return true;
    }());
    final m = widget.msg;
    final p = context.p;
    final lines = '\n'.allMatches(m.text).length + 1;
    // Long messages fold after ~30 lines; the first line always shows (chat.md §2.3).
    final long = !m.streaming && lines > 40 && !expanded;
    final text = long ? m.text.split('\n').take(30).join('\n') : m.text;
    final wide = m.text.length > 60 || m.text.contains('```');
    final multi = parseMarkdown(text).length > 1;
    final images = m.attachments.where((a) => a.isImage).toList();
    final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
      if (m.author != null) Text(m.author!, style: TextStyle(fontFamily: kFont, fontSize: 13, fontWeight: FontWeight.w700, color: p.text)),
      if (images.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 4), child: BubbleImages(images: images)),
      // One paragraph: the time rides on its last line (WhatsApp). Rich multi-block text: the
      // time gets its own corner line so it can never sit on top of a list or code.
      if (text.isNotEmpty || images.isEmpty) Markdown(text, trailerWidth: multi ? 0 : Meta.widthFor(null), caret: m.streaming),
      if (multi || (text.isEmpty && images.isNotEmpty)) const SizedBox(height: 14),
      if (long)
        GestureDetector(
          onTap: () => setState(() => expanded = true),
          child: Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('המשך קריאה (עוד ${lines - 30} שורות)', style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
          ),
        ),
    ]);
    return Bubble(
      out: false,
      wide: wide,
      child: _WithMeta(
        meta: Meta(time: hm(m.ts)),
        // Folded: the bottom row is the "continue reading" link on the right, so the time stays left.
        end: long ? TextDirection.rtl : markdownEndDirection(text),
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
    final p = context.p;
    final style = TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: strong ? p.text : p.text2, fontWeight: strong ? FontWeight.w700 : FontWeight.w400);
    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: p.surface, borderRadius: BorderRadius.circular(8), boxShadow: const [BoxShadow(color: Color(0x0A000000), offset: Offset(0, 1))]),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[Ic(icon!, size: 15, color: iconColor ?? p.text2), const SizedBox(width: 4)],
        Flexible(child: Rich(text, style: style, align: TextAlign.center)),
      ]),
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
                    child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: onTap, child: Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: pill)),
                  ),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────────── tools (.tool) ─────────────────────────────

String _outcomeIcon(Outcome o) => switch (o) { Outcome.ok => 'check', Outcome.error => 'error', Outcome.interrupted => 'stop_circle', Outcome.running => 'progress_activity' };

class ToolGroupRow extends StatefulWidget {
  const ToolGroupRow({super.key, required this.group, this.forceOpen = false});
  final ToolGroup group;
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
    final g = widget.group;
    final p = context.p;
    final style = TextStyle(fontFamily: kFont, fontSize: 13.5, height: 1.45, color: p.text2);
    final running = g.outcome == Outcome.running;
    Widget outcome = Ic(_outcomeIcon(g.outcome), size: 18, color: g.outcome == Outcome.error ? p.urgent : p.text2, fill: g.outcome == Outcome.error);
    if (running) outcome = Spin(child: outcome);
    return LayoutBuilder(builder: (context, c) => Align(
      alignment: AlignmentDirectional.centerStart,
      child: Container(
        margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 3),
        constraints: BoxConstraints(maxWidth: c.maxWidth * 0.92),
        decoration: BoxDecoration(color: p.toolBg, borderRadius: BorderRadius.circular(10)),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() => open = !open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: AnimatedRotation(turns: open ? 0.5 : 0, duration: _fold, child: Ic('expand_more', size: 18, color: p.text2)),
                ),
                const SizedBox(width: 6),
                Flexible(
                  child: Text.rich(
                    TextSpan(children: [
                      ...Rich.spans(context, g.summary, style),
                      if (running && g.liveLabel != null) ...[
                        const TextSpan(text: ' · '),
                        TextSpan(text: g.liveLabel, style: TextStyle(fontWeight: FontWeight.w700, color: p.text)),
                        if (g.elapsed != null) TextSpan(text: ' · ${g.elapsed}'),
                      ],
                    ]),
                    style: style,
                  ),
                ),
                const SizedBox(width: 6),
                Padding(padding: const EdgeInsets.only(top: 1), child: outcome),
              ]),
            ),
          ),
          AnimatedSize(
            duration: _fold,
            alignment: Alignment.topCenter,
            child: !open
                ? const SizedBox(width: double.infinity)
                : Padding(
                    padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
                    child: Column(children: [for (final t in g.tools) _ToolItem(t)]),
                  ),
          ),
        ]),
      ),
    ));
  }
}

class _ToolItem extends StatelessWidget {
  const _ToolItem(this.t);
  final ToolLine t;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Tooltip(
      message: t.label,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 5),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
        child: Row(children: [
          Ic(t.icon, size: 16, color: t.outcome == Outcome.error ? p.urgent : p.text2),
          const SizedBox(width: 8),
          Expanded(
            child: Text(t.label,
                textDirection: TextDirection.ltr,
                textAlign: TextAlign.left,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: T.mono(11.5, lh: 16).copyWith(color: p.text)),
          ),
          if (t.trail != null) ...[const SizedBox(width: 8), Rich(ltr(t.trail!), style: TextStyle(fontFamily: kFont, fontSize: 12.5, color: p.text2))],
        ]),
      ),
    );
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
    final p = context.p;
    return LayoutBuilder(builder: (context, c) {
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
          child: Stack(children: [
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
              ...children,
              if (footer != null && footer!.isNotEmpty)
                Container(
                  decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
                  child: IntrinsicHeight(
                    child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                      for (var i = 0; i < footer!.length; i++) ...[
                        if (i > 0) Container(width: 1, color: p.line),
                        Expanded(child: footer![i]),
                      ],
                    ]),
                  ),
                ),
            ]),
            if (edge) PositionedDirectional(start: 0, top: 0, bottom: 0, child: Container(width: 3, color: p.text)),
          ]),
        ),
      );
    });
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
    final p = context.p;
    return InkWell(
      onTap: onTap ?? () {},
      child: SizedBox(
        height: 40,
        child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          AnimatedRotation(turns: rotate ? 0.5 : 0, duration: _fold, child: Ic(icon, size: 17, color: p.accent)),
          const SizedBox(width: 5),
          Text(label, style: TextStyle(fontFamily: kFont, fontSize: 13.5, fontWeight: FontWeight.w700, color: p.accent)),
        ]),
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
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.only(top: 1), child: Ic(icon, size: 19, color: context.p.text2)),
          const SizedBox(width: 8),
          Expanded(child: child),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ]),
      );
}

/// File path, always LTR: folders secondary, file name bold, shortened from the start.
class PathText extends StatelessWidget {
  const PathText(this.path, {super.key, this.size = 12.5});
  final String path;
  final double size;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final i = path.lastIndexOf('/');
    final dir = i < 0 ? '' : path.substring(0, i + 1);
    final file = i < 0 ? path : path.substring(i + 1);
    return Text.rich(
      TextSpan(children: [
        TextSpan(text: dir, style: TextStyle(color: p.text2)),
        TextSpan(text: file, style: TextStyle(color: p.text, fontWeight: FontWeight.w700)),
      ]),
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
    final c = widget.card;
    final p = context.p;
    final f = c.files.first;
    final many = c.files.length > 1;
    final add = c.files.fold(0, (s, f) => s + f.add), del = c.files.fold(0, (s, f) => s + f.del);
    return ChatCard(
      footer: [
        CardAction(icon: 'expand_more', label: 'השינויים', rotate: open, onTap: () => setState(() => open = !open)),
        const CardAction(icon: 'open_in_new', label: 'VS Code'),
        if (c.prRef != null) const CardAction(icon: 'call_merge', label: 'PR'),
      ],
      children: [
        _CardHead(
          icon: 'edit',
          trailing: DiffStat('+$add −$del'),
          child: many ? Text('${c.files.length} קבצים', style: T.secondary.copyWith(fontWeight: FontWeight.w700, color: p.text)) : PathText(f.path),
        ),
        if (c.note != null) Padding(padding: const EdgeInsets.fromLTRB(12, 0, 12, 8), child: Rich(c.note!, style: T.secondary.copyWith(color: p.text2))),
        AnimatedSize(
          duration: _fold,
          alignment: Alignment.topCenter,
          child: !open ? const SizedBox(width: double.infinity) : Column(children: [for (final f in c.files) DiffBody(file: f, showPath: many)]),
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
    final p = context.p;
    final mono = T.mono(11.5, lh: 18.4);
    return Container(
      decoration: BoxDecoration(color: p.codeBg, border: Border(top: BorderSide(color: p.line))),
      child: Directionality(
        textDirection: TextDirection.ltr,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (showPath) Padding(padding: const EdgeInsets.fromLTRB(8, 6, 8, 4), child: PathText(file.path, size: 11.5)),
          for (final h in file.hunks) ...[
            Container(
              color: p.surface2,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              child: Text(h.header, style: mono.copyWith(color: p.text2)),
            ),
            for (final l in h.lines)
              Container(
                color: switch (l.kind) { DiffLineKind.add => p.addBg, DiffLineKind.del => p.delBg, DiffLineKind.ctx => null },
                padding: const EdgeInsets.only(right: 8),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 30, child: Padding(padding: const EdgeInsets.only(right: 6), child: Text('${l.no}', textAlign: TextAlign.right, style: mono.copyWith(color: p.text3)))),
                  SizedBox(
                    width: 14,
                    child: Text(switch (l.kind) { DiffLineKind.add => '+', DiffLineKind.del => '−', DiffLineKind.ctx => ' ' },
                        style: mono.copyWith(color: l.kind == DiffLineKind.ctx ? p.text2 : p.text, fontWeight: l.kind == DiffLineKind.ctx ? null : FontWeight.w700)),
                  ),
                  Expanded(child: Text.rich(_marked(l, p), style: mono.copyWith(color: p.text))),
                ]),
              ),
          ],
        ]),
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
      spans.add(TextSpan(text: m, style: const TextStyle(fontWeight: FontWeight.w700, decoration: TextDecoration.underline)));
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
    final p = context.p;
    final parts = ['בדיקות', '${card.passed} עברו', if (card.failed > 0) '${card.failed} נכשלו', if (card.skipped > 0) '${card.skipped} דולגו'];
    return ChatCard(children: [
      _CardHead(
        icon: card.failed > 0 ? 'checklist' : 'check',
        trailing: card.seconds == null ? null : Text("${card.seconds} שנ'", style: T.meta.copyWith(color: p.text2)),
        child: Text(parts.join(' · '), style: TextStyle(fontFamily: kFont, fontSize: 14, height: 1.45, fontWeight: FontWeight.w700, color: p.text)),
      ),
      if (card.failures.isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          child: Column(children: [
            for (final f in card.failures)
              Container(
                padding: const EdgeInsets.symmetric(vertical: 6),
                decoration: BoxDecoration(border: Border(top: BorderSide(color: p.line))),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  SizedBox(width: 20, child: Ic('error', size: 16, fill: true, color: p.text)),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Directionality(
                      textDirection: TextDirection.ltr,
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Row(children: [
                          Expanded(child: Text(f.name, softWrap: false, overflow: TextOverflow.ellipsis, style: T.mono(12.5, w: FontWeight.w500, lh: 18).copyWith(color: p.text))),
                          Text(f.location, style: T.mono(12.5, lh: 18).copyWith(color: p.text2)),
                        ]),
                        Text(f.why, style: T.mono(11.5, lh: 17).copyWith(color: p.text2)),
                      ]),
                    ),
                  ),
                ]),
              ),
          ]),
        ),
    ]);
  }
}

class TerminalCardView extends StatelessWidget {
  const TerminalCardView({super.key, required this.card});
  final TerminalCard card;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final mono = T.mono(11.5, lh: 17.8);
    return ChatCard(children: [
      Container(
        decoration: BoxDecoration(color: p.codeBg, border: Border(top: BorderSide(color: p.line))),
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(
              padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
              decoration: BoxDecoration(border: Border(bottom: BorderSide(color: p.line))),
              child: Row(children: [
                Expanded(child: Text('\$ ${card.command}', maxLines: 1, overflow: TextOverflow.ellipsis, style: mono.copyWith(color: p.text))),
                IconButton(
                  tooltip: 'העתקת הפקודה',
                  visualDensity: VisualDensity.compact,
                  onPressed: () => Clipboard.setData(ClipboardData(text: card.command)),
                  icon: Ic('content_copy', size: 16, color: p.text2),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Text.rich(
                TextSpan(children: [
                  for (final (i, l) in card.tail.indexed)
                    TextSpan(
                      text: '$l${i == card.tail.length - 1 ? '' : '\n'}',
                      // ANSI colour becomes weight: FAIL lines stand out without colour (chat.md §2.7).
                      style: l.contains('FAIL') ? TextStyle(fontWeight: FontWeight.w700, color: p.text) : null,
                    ),
                ]),
                style: mono.copyWith(color: p.text2),
              ),
            ),
          ]),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Wrap(crossAxisAlignment: WrapCrossAlignment.center, children: [
          if (card.exitCode != 0) Text('יצא עם שגיאה (${card.exitCode}) · ', style: T.secondary.copyWith(color: p.text, fontWeight: FontWeight.w700)),
          if (card.footer != null) Text('${card.footer} · ', style: T.secondary.copyWith(color: p.text2)),
          if (card.totalLines != null) LinkText('כל הפלט (${card.totalLines} שורות)', size: 13.5),
        ]),
      ),
    ]);
  }
}

class PrCardView extends StatelessWidget {
  const PrCardView({super.key, required this.card});
  final PrCard card;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    Widget check(String label, Check c) => switch (c) {
          Check.none => const SizedBox.shrink(),
          Check.running => Badge2(label: label, icon: 'progress_activity', spin: true),
          Check.ok => Badge2(label: label, icon: 'check'),
          Check.failed => Badge2(label: '$label נכשל', icon: 'error'),
        };
    final state = switch (card.state) { PrState.open => 'פתוח', PrState.merged => 'מוזג', PrState.closed => 'נסגר' };
    return ChatCard(
      footer: const [CardAction(icon: 'description', label: 'קבצים'), CardAction(icon: 'open_in_new', label: 'GitHub')],
      children: [
        _CardHead(
          icon: 'call_merge',
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: ltr('PR #${card.number}'), style: T.mono(12.5, w: FontWeight.w500).copyWith(color: p.text2)),
              TextSpan(text: ' · ${card.title}'),
            ]),
            style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.4, fontWeight: FontWeight.w700, color: p.text),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 2, 12, 10),
          child: Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            Badge2(label: state),
            check('CI', card.ci),
            check('סקירה', card.review),
            DiffStat('+${card.add} −${card.del}'),
            Text('${card.files} קבצים', style: TextStyle(fontFamily: kFont, fontSize: 12, color: p.text2)),
          ]),
        ),
      ],
    );
  }
}

/// Ask and GO (chat.md §2.8): a message from whoever asked, in their conversation, with the answers as
/// buttons right under it (Telegram's inline keyboard). The first line is the headline in his words;
/// the technical details fold under it. The same object as on home and in the notification.
class AskCardView extends StatefulWidget {
  const AskCardView({super.key, required this.card, required this.onOther});
  final AskCard card;
  final VoidCallback onOther;

  @override
  State<AskCardView> createState() => _AskCardViewState();
}

class _AskCardViewState extends State<AskCardView> {
  bool details = false;

  @override
  Widget build(BuildContext context) {
    final card = widget.card;
    final store = StoreScope.of(context);
    final p = context.p;
    final from = store.nameOf(card.from);
    final go = card is GoCard;
    final pending = store.pending('card:${card.id}');
    final answered = card.state == AskState.answered || card.state == AskState.decidedByManager;
    final desktop = MediaQuery.sizeOf(context).width >= 800;

    final kicker = Text.rich(
      TextSpan(children: [
        WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Padding(padding: const EdgeInsetsDirectional.only(end: 4), child: Ic('front_hand', size: 16, fill: true, color: p.text2)),
        ),
        TextSpan(text: go ? 'בקשת ${ltr('GO')}' : (card.blocking ? 'שאלה · חוסמת את העבודה' : 'שאלה · יכולה לחכות')),
        if (!go && card.escalation != null) TextSpan(text: ' · ${card.escalation!.replaceAll(' ', '\u00A0')}'),
      ]),
      style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: p.text2),
    );

    final headline = card.headline;
    final bubble = Bubble(
      out: false,
      wide: true,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        kicker,
        const SizedBox(height: 2),
        if (headline != null) ...[
          Rich(headline, style: TextStyle(fontFamily: kFont, fontSize: 15.5, height: 1.45, fontWeight: FontWeight.w700, color: p.text)),
          // The technical part folds under the headline, like a long message (chat.md §2.3).
          Semantics(
            button: true,
            child: InkWell(
              onTap: () => setState(() => details = !details),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  Text(details ? 'הסתרת הפרטים' : 'פרטים', style: T.small.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
                  AnimatedRotation(turns: details ? 0.5 : 0, duration: _fold, child: Ic('expand_more', size: 18, color: p.accent)),
                ]),
              ),
            ),
          ),
          AnimatedSize(
            duration: _fold,
            alignment: Alignment.topCenter,
            child: details ? Padding(padding: const EdgeInsets.only(bottom: 4), child: Markdown(card.question)) : const SizedBox(width: double.infinity),
          ),
        ] else
          Markdown(card.question),
        if (answered) ...[
          const SizedBox(height: 4),
          DoneLine(_doneLine(card, from, go), top: 2),
        ],
        Align(alignment: AlignmentDirectional.centerEnd, child: Meta(time: hm(card.ts))),
      ]),
    );

    Widget? keyboard;
    if (answered) {
      keyboard = null;
    } else if (pending != null) {
      keyboard = Padding(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 6),
        child: UndoLine(label: pending.label, onCancel: () => store.cancelUndo('card:${card.id}'), top: 2),
      );
    } else {
      final opts = card.options.where((o) => o.id != 'q' && o.id != 'not_now').toList();
      final rows = <List<Widget>>[];
      if (go) {
        rows.add([
          _KeyButton('GO', primary: true, onTap: () => store.answerCard(card, card.options.first)),
          _KeyButton('לא עכשיו', onTap: () {
            final w = store.data?.waiting.where((w) => w.askId == card.askId).firstOrNull;
            if (w != null) store.notNow(w);
          }),
        ]);
      } else {
        for (final (i, o) in opts.indexed) {
          rows.add([_KeyButton(o.label, primary: o.primary, hint: desktop ? '${i + 1}' : null, onTap: () => store.answerCard(card, o))]);
        }
      }
      rows.add([_KeyButton('תשובה אחרת', hint: desktop && !go ? '${opts.length + 1}' : null, onTap: widget.onOther)]);
      keyboard = LayoutBuilder(builder: (context, c) {
        return Align(
          alignment: AlignmentDirectional.centerStart,
          child: Container(
            width: c.maxWidth * 0.92,
            margin: const EdgeInsets.fromLTRB(12, 0, 12, 4),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              for (final r in rows)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(children: [
                    for (final (i, b) in r.indexed) ...[if (i > 0) const SizedBox(width: 4), Expanded(child: b)],
                  ]),
                ),
            ]),
          ),
        );
      });
    }

    return Semantics(
      container: true,
      label: go ? 'בקשת GO מ$from' : 'שאלה מ$from',
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: [
        bubble,
        AnimatedSize(duration: _fold, alignment: Alignment.topCenter, child: keyboard ?? const SizedBox(width: double.infinity)),
      ]),
    );
  }

  static String _doneLine(AskCard card, String from, bool go) {
    if (card.state == AskState.decidedByManager) {
      final n = companyNames;
      return '${n.manager} ${n.m('החליט', 'החליטה')} במקומך: ${card.answer}';
    }
    final a = card.answer;
    if (a == null) return go ? 'הבקשה נסגרה' : 'השאלה נסגרה';
    if (go && a == 'GO') return '${ltr('GO')} נשלח ל$from';
    return 'ענית: $a';
  }
}

/// One button of the inline keyboard under a question (Telegram): a quiet chip in the bubble's colour,
/// the full answer in it. GO is the one primary action, in the brand colour (design-taste §1.2).
class _KeyButton extends StatelessWidget {
  const _KeyButton(this.label, {required this.onTap, this.primary = false, this.hint});
  final String label;
  final VoidCallback onTap;
  final bool primary;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      button: true,
      child: DecoratedBox(
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(8), boxShadow: primary ? null : p.hairShadow),
        child: Material(
          color: primary ? p.accent : p.bubbleIn,
          borderRadius: BorderRadius.circular(8),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Container(
              constraints: const BoxConstraints(minHeight: 40),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              alignment: Alignment.center,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (hint != null) ...[Kbd(hint!), const SizedBox(width: 6)],
                Flexible(
                  child: Rich(label,
                      align: TextAlign.center,
                      style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.35, fontWeight: FontWeight.w700, color: primary ? p.onAccent : p.accent)),
                ),
              ]),
            ),
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
    final p = context.p;
    final by = StoreScope.of(context).nameOf(card.by);
    return ChatCard(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 2),
        child: Text.rich(
          TextSpan(children: [TextSpan(text: '$by החליט במקומך', style: TextStyle(color: p.text, fontWeight: FontWeight.w700)), TextSpan(text: ' · ${card.time}')]),
          style: TextStyle(fontFamily: kFont, fontSize: 12.5, height: 1.5, color: p.text2),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 2, 14, 12),
        child: Text.rich(
          TextSpan(children: [
            ...Rich.spans(context, card.text, T.row2),
            const TextSpan(text: ' '),
            WidgetSpan(alignment: PlaceholderAlignment.baseline, baseline: TextBaseline.alphabetic, child: LinkText('שינוי', size: 14.5)),
          ]),
          style: TextStyle(fontFamily: kFont, fontSize: 14.5, height: 1.55, color: p.text),
        ),
      ),
    ]);
  }
}

class PermissionCardView extends StatelessWidget {
  const PermissionCardView({super.key, required this.card});
  final PermissionCard card;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    final from = store.nameOf(card.from);
    final done = card.state != PermissionState.open;
    return ChatCard(edge: !done, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 6),
        child: Text('$from רוצה להריץ פקודה', style: TextStyle(fontFamily: kFont, fontSize: 14, fontWeight: FontWeight.w700, color: p.text)),
      ),
      Container(
        margin: const EdgeInsets.symmetric(horizontal: 12),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(color: p.codeBg, borderRadius: BorderRadius.circular(6), border: Border.all(color: p.line)),
        child: Text('\$ ${card.command}', textDirection: TextDirection.ltr, style: T.mono(12).copyWith(color: p.text)),
      ),
      if (done)
        Padding(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
          child: DoneLine(switch (card.state) {
            PermissionState.allowed => 'אושר',
            PermissionState.allowedForTask => 'אושר לכל המשימה',
            _ => 'נדחה',
          }),
        )
      else
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
          child: Wrap(spacing: 8, runSpacing: 8, children: [
            Btn('אישור', kind: BtnKind.primary, onTap: () {
              card.state = PermissionState.allowed;
              store.touch();
            }),
            Btn('דחייה', onTap: () {
              card.state = PermissionState.denied;
              store.touch();
            }),
            Btn('אישור לכל המשימה', onTap: () {
              card.state = PermissionState.allowedForTask;
              store.touch();
            }),
          ]),
        ),
    ]);
  }
}

class FileBubble extends StatelessWidget {
  const FileBubble({super.key, required this.msg});
  final FileMsg msg;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final icon = msg.mime.startsWith('image/') ? 'image' : msg.mime == 'application/pdf' ? 'picture_as_pdf' : 'draft';
    final kb = msg.bytes < 1024 * 1024 ? '${(msg.bytes / 1024).round()}KB' : '${(msg.bytes / 1024 / 1024).toStringAsFixed(1)}MB';
    final type = msg.mime.split('/').last.toUpperCase();
    return Bubble(
      out: false,
      child: _WithMeta(
        meta: Meta(time: hm(msg.ts)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Ic(icon, size: 28, color: p.text2),
          const SizedBox(width: 10),
          Flexible(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(msg.name, textDirection: TextDirection.ltr, style: T.secondary.copyWith(color: p.text, fontWeight: FontWeight.w700)),
              Text('$kb · $type', style: T.meta.copyWith(color: p.text2)),
              const SizedBox(height: 10),
            ]),
          ),
        ]),
      ),
    );
  }
}

class HandoffCardView extends StatelessWidget {
  const HandoffCardView({super.key, required this.card, required this.from});
  final HandoffCard card;
  final String from;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final store = StoreScope.of(context);
    return ChatCard(edge: !card.done, children: [
      _CardHead(
        icon: 'lock',
        child: Text.rich(
          TextSpan(children: [
            TextSpan(text: 'כניסה לאתר', style: TextStyle(fontWeight: FontWeight.w700, color: p.text)),
            const TextSpan(text: ' · '),
            TextSpan(text: ltr(card.domain), style: T.mono(12.5)),
            TextSpan(text: ' · ${card.expires}'),
          ]),
          style: T.secondary.copyWith(color: p.text2),
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 12),
        child: card.done
            ? const DoneLine('נכנסת', top: 0)
            : Align(
                alignment: AlignmentDirectional.centerStart,
                child: Btn('פתיחה', kind: BtnKind.primary, onTap: () {
                  final w = store.data?.waiting.where((w) => w.kind == WaitKind.login && w.from == from).firstOrNull;
                  if (w != null) Nav.handoff(context, w);
                }),
              ),
      ),
    ]);
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
    final p = context.p;
    final f = gender == Gender.f;
    final (String? icon, String? text, bool spin) = switch (live.phase) {
      LivePhase.idle || LivePhase.writing => (null, null, false),
      LivePhase.starting => ('check', live.label ?? 'נמסר · $name ${f ? 'מתחילה' : 'מתחיל'}…', false),
      LivePhase.thinking => (null, "${f ? 'חושבת' : 'חושב'}${live.seconds != null ? " · ${live.seconds} שנ'" : ''}", false),
      LivePhase.tool => ('progress_activity', '${live.label ?? (f ? 'עובדת' : 'עובד')}${live.seconds != null ? ' · 0:${live.seconds.toString().padLeft(2, '0')}' : ''}', true),
      LivePhase.compacting => ('progress_activity', 'מסדר את הזיכרון', true),
      LivePhase.stopped => ('stop_circle', '${f ? 'נעצרה' : 'נעצר'} · ${live.stoppedAt ?? ''}', false),
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
          borderRadius: const BorderRadiusDirectional.only(topStart: Radius.circular(3), topEnd: Radius.circular(10), bottomStart: Radius.circular(10), bottomEnd: Radius.circular(10)),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (ic != null) ...[ic, const SizedBox(width: 6)],
          Text(text, style: TextStyle(fontFamily: kFont, fontSize: 13, height: 1.4, color: p.text2)),
          if (live.phase == LivePhase.thinking) ...[const SizedBox(width: 6), const _Dots()],
        ]),
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
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (_, _) => Row(mainAxisSize: MainAxisSize.min, children: [
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
        ]),
      );
}
