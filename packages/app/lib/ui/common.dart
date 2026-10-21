// Shared building blocks, one per mockup CSS class: .ms (Ic), .av (Monogram), .st (StatusWord),
// .badge (Badge), .btn (Btn), .sec (Section), .list/.row (ListBlock), and the markup text (Rich).

import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../data/backend.dart';
import '../data/error_report.dart';
import '../model/models.dart';
import '../native/open_url.dart';
import '../theme/icons.dart';
import '../theme/tokens.dart';
import 'bidi.dart';
import 'system_bar.dart';

export '../model/company_time.dart' show CompanyTime, wall, dayStart, hourStart, daysAgo, hm, dm;

export 'bidi.dart';

/// `.ms`: a Material Symbols Rounded glyph. [fill] = FILL 1 (active state, APP-SPEC §7.6).
class Ic extends StatelessWidget {
  const Ic(this.name, {super.key, this.size = 24, this.fill = false, this.color, this.weight = 400, this.semantic});
  final String name;
  final double size;
  final bool fill;
  final Color? color;
  final double weight;
  final String? semantic;

  @override
  Widget build(BuildContext context) {
    // Unknown names (e.g. a team symbol from org.yaml the app does not ship) fall back quietly.
    final data = kIcons[name];
    // Glyphs are drawn as-is like the mockup's font (no automatic RTL mirroring): the back arrow
    // points right in RTL, and the send arrow is mirrored explicitly where the mockup does it.
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Icon(
      data ?? kIcons['help']!,
      size: size,
      fill: fill ? 1 : 0,
      weight: weight,
      opticalSize: size <= 20 ? 20 : 24,
      grade: 0,
      color: color ?? IconTheme.of(context).color,
      semanticLabel: semantic,
    ),
    );
  }
}

String statusIcon(WorkerStatus s) => switch (s) {
      WorkerStatus.free => 'radio_button_unchecked',
      WorkerStatus.working => 'play_arrow',
      WorkerStatus.waiting => 'front_hand',
      WorkerStatus.blocked => 'block',
      WorkerStatus.stuck => 'warning',
      WorkerStatus.restarting => 'autorenew',
      WorkerStatus.resting => 'bedtime',
      WorkerStatus.done => 'check_circle',
    };

/// The status word follows the worker's grammatical gender (APP-SPEC §6.2).
String statusWord(WorkerStatus s, Gender g) {
  final f = g == Gender.f;
  return switch (s) {
    WorkerStatus.free => f ? 'פנויה' : 'פנוי',
    WorkerStatus.working => f ? 'עובדת' : 'עובד',
    WorkerStatus.waiting => 'מחכה לך',
    WorkerStatus.blocked => f ? 'חסומה' : 'חסום',
    WorkerStatus.stuck => f ? 'תקועה' : 'תקוע',
    WorkerStatus.restarting => f ? 'קמה מחדש' : 'קם מחדש',
    WorkerStatus.resting => f ? 'נחה' : 'נח',
    WorkerStatus.done => 'הושלם',
  };
}

/// Statuses that need the owner read in bold (`.st.b`).
bool statusLoud(WorkerStatus s) => s == WorkerStatus.waiting || s == WorkerStatus.stuck || s == WorkerStatus.blocked;

// ───────────────────────────── monogram (.av) ─────────────────────────────

enum AvSize { md, sm, xs }

class Monogram extends StatelessWidget {
  const Monogram({super.key, required this.letter, this.size = AvSize.md, this.temp = false, this.teamSymbol, this.ringColor, this.symbol, this.tone, this.toned = false});
  final String letter;

  /// The circle is filled with its team's identity tone (language-v2 §3), slate when [tone] is null.
  /// Not toned: grey (the system sender).
  final bool toned;
  final String? tone;

  /// A symbol instead of the letter (the system sender, #55).
  final String? symbol;
  final AvSize size;
  final bool temp;
  final String? teamSymbol;

  /// Ring around the team mark: the background the avatar sits on.
  final Color? ringColor;

  factory Monogram.of(CompanyData d, String identityId, {AvSize size = AvSize.md, Color? ring}) {
    final who = d.who(identityId);
    if (identityId == kSystemId) return Monogram(letter: '', symbol: 'dns', size: size);
    final team = d.teamOf(identityId);
    // A task worker's team carries its project's tone (hq_backend), so a row shows at once which project it is.
    return Monogram(letter: who.initial, size: size, temp: who.temp, teamSymbol: team?.symbol, ringColor: ring, tone: team?.tone, toned: true);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final (dim, font) = switch (size) { AvSize.md => (42.0, 17.0), AvSize.sm => (34.0, 14.5), AvSize.xs => (22.0, 11.0) };
    final (bg, fg) = toned ? p.identity(tone) : (p.surface3, p.text);
    final circle = Container(
      width: dim,
      height: dim,
      alignment: Alignment.center,
      decoration: BoxDecoration(shape: BoxShape.circle, color: bg),
      child: symbol != null
          ? Ic(symbol!, size: font + 3, color: fg)
          : Text(letter, style: TextStyle(fontFamily: kFont, fontWeight: FontWeight.w700, fontSize: font, height: 1, color: fg)),
    );
    // A task worker is a full face in its team's tone too; a dashed ring read as "empty" (audit #28).
    final face = circle;
    if (teamSymbol == null || size == AvSize.xs) return SizedBox(width: dim, height: dim, child: face);
    // The project mark reads at a glance, 14px and up, and sits out in the corner, off the letter (#148 §11, audit #16).
    final tm = size == AvSize.md ? 22.0 : 20.0;
    final icon = size == AvSize.md ? 15.0 : 14.0;
    return SizedBox(
      width: dim,
      height: dim,
      child: Stack(clipBehavior: Clip.none, children: [
        face,
        PositionedDirectional(
          bottom: -5,
          end: -6,
          child: Container(
            width: tm,
            height: tm,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: p.surface,
              boxShadow: [BoxShadow(color: ringColor ?? p.bg, spreadRadius: 1.5)],
            ),
            child: Ic(teamSymbol!, size: icon, fill: true, weight: 500, color: p.text2),
          ),
        ),
      ]),
    );
  }
}

// ───────────────────────────── status, badge ─────────────────────────────

/// `.st`: filled icon + word, bold when it waits on the owner.
class StatusWord extends StatelessWidget {
  const StatusWord({super.key, required this.icon, required this.word, this.bold = false, this.size = 12.5, this.trailing});
  final String icon;
  final String word;
  final bool bold;
  final double size;
  final Widget? trailing;

  factory StatusWord.of(Presence p, Gender g, {double size = 12.5, bool withActivity = false, String? suffix}) {
    var w = statusWord(p.status, g);
    if (withActivity && p.activity != null) w = '$w · ${p.activity}';
    if (suffix != null) w = '$w · $suffix';
    return StatusWord(icon: statusIcon(p.status), word: w, bold: statusLoud(p.status), size: size);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final color = bold ? p.text : p.text2;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Ic(icon, size: 16, fill: true, color: color),
      const SizedBox(width: 3),
      Flexible(
        child: Text(word,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontFamily: kFont, fontSize: size, height: 1.4, color: color, fontWeight: bold ? FontWeight.w700 : FontWeight.w400)),
      ),
      ?trailing,
    ]);
  }
}

enum BadgeKind { plain, dark, urgent }

class Badge2 extends StatelessWidget {
  const Badge2({super.key, required this.label, this.icon, this.kind = BadgeKind.plain, this.spin = false});
  final String label;
  final String? icon;
  final BadgeKind kind;
  final bool spin;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final (bg, fg) = switch (kind) {
      BadgeKind.plain => (p.surface2, p.text2),
      BadgeKind.dark => (p.text, p.surface),
      BadgeKind.urgent => (Colors.transparent, p.urgent),
    };
    Widget? ic = icon == null ? null : Ic(icon!, size: 15, fill: true, color: fg);
    if (ic != null && spin) ic = Spin(child: ic);
    return Container(
      height: 22,
      padding: const EdgeInsets.symmetric(horizontal: 8),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
        border: kind == BadgeKind.urgent ? Border.all(color: p.urgent) : null,
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (ic != null) ...[ic, const SizedBox(width: 3)],
        Text(label, style: T.chip.copyWith(color: fg)),
      ]),
    );
  }
}

/// Endless animations (spinner, caret, typing dots) stop when frozen: goldens and widget tests.
class Motion {
  static bool frozen = false;
}

/// `.spin`: 1s linear rotation; stops under the system's "reduce motion" (APP-SPEC §7.5).
class Spin extends StatefulWidget {
  const Spin({super.key, required this.child});
  final Widget child;
  @override
  State<Spin> createState() => _SpinState();
}

class _SpinState extends State<Spin> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(seconds: 1));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduce || Motion.frozen) {
      _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RotationTransition(turns: _c, child: widget.child);
}

/// `.stat`: "+48 −11" in mono, LTR.
class DiffStat extends StatelessWidget {
  const DiffStat(this.text, {super.key, this.size = 12});
  final String text;
  final double size;
  @override
  Widget build(BuildContext context) =>
      Text(ltr(text), textDirection: TextDirection.ltr, style: T.mono(size, lh: size * 1.4).copyWith(color: context.p.text2));
}

// ───────────────────────────── buttons ─────────────────────────────

enum BtnKind { plain, primary, tonal }

/// `.btn`, `.btn.pri`, `.btn.ton`, `.btn.wide`.
class Btn extends StatelessWidget {
  const Btn(this.label, {super.key, this.onTap, this.kind = BtnKind.plain, this.wide = false, this.icon, this.height = 36, this.fontSize = 14, this.leading, this.hpad = 16});
  final double hpad;
  final String label;
  final VoidCallback? onTap;
  final BtnKind kind;
  final bool wide;
  final String? icon;
  final double height;
  final double fontSize;
  final Widget? leading;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final (bg, border, fg) = switch (kind) {
      BtnKind.plain => (p.surface, p.line, p.text),
      BtnKind.primary => (p.accent, p.accent, p.onAccent),
      BtnKind.tonal => p.dark ? (p.surface3, p.surface3, p.text) : (p.surface2, p.surface2, p.text),
    };
    final radius = BorderRadius.circular(wide ? 10 : height / 2);
    final text = Text(label,
        textAlign: wide ? TextAlign.start : TextAlign.center,
        style: TextStyle(
            fontFamily: kFont,
            fontSize: fontSize,
            height: 1.35,
            color: fg,
            fontWeight: kind == BtnKind.primary ? FontWeight.w700 : FontWeight.w500));
    final content = Row(
      mainAxisSize: wide ? MainAxisSize.max : MainAxisSize.min,
      mainAxisAlignment: wide ? MainAxisAlignment.start : MainAxisAlignment.center,
      children: [
        if (leading != null) ...[leading!, const SizedBox(width: 6)],
        if (icon != null) ...[Ic(icon!, size: 18, color: fg), const SizedBox(width: 6)],
        if (wide) Expanded(child: text) else Flexible(child: text),
      ],
    );
    return Semantics(
      button: true,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(borderRadius: radius, side: BorderSide(color: border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: wide ? 42 : height),
            child: Padding(
              padding: wide ? EdgeInsets.symmetric(horizontal: hpad, vertical: 9) : EdgeInsets.symmetric(horizontal: hpad),
              child: Center(widthFactor: wide ? null : 1, child: content),
            ),
          ),
        ),
      ),
    );
  }
}

/// `.ibtn`: 44x44 round icon button with a tooltip (APP-SPEC §7.6: every icon has a label).
class IBtn extends StatelessWidget {
  const IBtn(this.icon, {super.key, required this.tip, this.onTap, this.fill = false, this.color, this.mirror = false});
  final String icon;
  final String tip;
  final VoidCallback? onTap;
  final bool fill;
  final Color? color;
  final bool mirror;

  @override
  Widget build(BuildContext context) {
    Widget ic = Ic(icon, fill: fill, color: color ?? context.p.text2);
    if (mirror) ic = Transform.flip(flipX: true, child: ic);
    return Tooltip(
      message: tip,
      child: SizedBox(
        width: 44,
        height: 44,
        child: Material(
          type: MaterialType.transparency,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(onTap: onTap ?? () {}, child: Center(child: Semantics(label: tip, button: true, child: ic))),
        ),
      ),
    );
  }
}

/// `.link`: accent, bold text button.
class LinkText extends StatelessWidget {
  const LinkText(this.text, {super.key, this.onTap, this.size = 13});
  final String text;
  final VoidCallback? onTap;
  final double size;
  @override
  Widget build(BuildContext context) => GestureDetector(
        onTap: onTap ?? () {},
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          child: Text(text, style: TextStyle(fontFamily: kFont, fontSize: size, height: 1.4, fontWeight: FontWeight.w700, color: context.p.accent)),
        ),
      );
}

// ───────────────────────────── sections and lists ─────────────────────────────

/// `.sec`: 13.5/700 secondary header with an optional count.
class Section extends StatelessWidget {
  const Section(this.title, {super.key, this.count, this.top = 16});
  final String title;
  final String? count;
  final double top;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, top, 16, 6),
      child: Row(children: [
        Expanded(child: Text(title, style: T.section.copyWith(color: p.text2))),
        if (count != null) Text(count!, style: T.secondary.copyWith(color: p.text3)),
      ]),
    );
  }
}

/// `.list`: white block with hairlines top and bottom; rows get inset dividers (`.row+.row::before`).
class ListBlock extends StatelessWidget {
  const ListBlock({super.key, required this.children, this.inset = 68, this.top = true});
  final List<Widget> children;

  /// Divider start inset: 68 when rows start with a monogram, 16 otherwise.
  final double inset;
  final bool top;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    final out = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      if (i > 0) out.add(Padding(padding: EdgeInsetsDirectional.only(start: inset), child: Container(height: 1, color: p.line)));
      out.add(children[i]);
    }
    return Container(
      decoration: BoxDecoration(
        color: p.surface,
        border: Border(top: top ? BorderSide(color: p.line) : BorderSide.none, bottom: BorderSide(color: p.line)),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: out),
    );
  }
}

/// `.more`: a full-width row that opens something ("לפי צוות · עוד 6 עובדים").
class MoreRow extends StatelessWidget {
  const MoreRow({super.key, required this.icon, required this.bold, required this.rest, this.top = true, this.onTap});
  final String icon;
  final String bold;
  final String rest;
  final bool top;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Material(
      color: p.surface,
      child: InkWell(
        onTap: onTap ?? () {},
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(border: Border(top: top ? BorderSide(color: p.line) : BorderSide.none, bottom: BorderSide(color: p.line))),
          child: Row(children: [
            Ic(icon, size: 20, color: p.text2),
            const SizedBox(width: 6),
            Expanded(
              child: Text.rich(
                TextSpan(children: [
                  TextSpan(text: bold, style: TextStyle(color: p.text, fontWeight: FontWeight.w700)),
                  TextSpan(text: bold.isEmpty ? rest : (rest.isEmpty ? '' : ' · $rest')),
                ]),
                style: TextStyle(fontFamily: kFont, fontSize: 14, height: 1.4, color: p.text2),
              ),
            ),
          ]),
        ),
      ),
    );
  }
}

/// `.done`: the collapsed line after an answer lands ("ענית: X · 14:03").
class DoneLine extends StatelessWidget {
  const DoneLine(this.text, {super.key, this.top = 8, this.icon = 'check'});
  final String text;
  final double top;

  /// `check` for what was done; `close` for "נכשל" (#219).
  final String icon;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: EdgeInsets.only(top: top),
      child: Row(children: [
        Ic(icon, size: 18, color: p.text2),
        const SizedBox(width: 6),
        Expanded(child: Rich(text, style: T.secondary.copyWith(color: p.text2))),
      ]),
    );
  }
}

/// `.undo`: "יישלח לעידו בעוד 3 שנ' · ביטול", in place of the buttons. Never a bottom bar.
class UndoLine extends StatelessWidget {
  const UndoLine({super.key, required this.label, required this.onCancel, this.top = 10});
  final String label;
  final VoidCallback onCancel;
  final double top;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: EdgeInsets.only(top: top),
      child: Semantics(
        liveRegion: true,
        child: Row(children: [
          Flexible(child: Text(label, style: T.secondary.copyWith(color: p.text))),
          const SizedBox(width: 10),
          GestureDetector(
            onTap: onCancel,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Text('ביטול', style: T.secondary.copyWith(color: p.accent, fontWeight: FontWeight.w700)),
            ),
          ),
        ]),
      ),
    );
  }
}

// ───────────────────────────── markup text ─────────────────────────────

/// [text] when it [fits], else cut after the most whole words that fit with "…" (T2): never inside a word,
/// as Flutter's own ellipsis does. Only a first word longer than the room is cut inside, the most of it that
/// fits. [head] goes before the text (a "…" when it starts mid-way); [close] mends what a cut leaves open.
String fitWords(String text, bool Function(String) fits, {String head = '', String Function(String)? close}) {
  if (fits('$head$text')) return '$head$text';
  final words = text.split(' ');
  String end(String t) => '$head${close?.call(t) ?? t}…';
  int most(int n, String Function(int) cut) {
    var (lo, hi) = (0, n);
    while (lo < hi) {
      final m = (lo + hi + 1) ~/ 2;
      if (fits(cut(m))) {
        lo = m;
      } else {
        hi = m - 1;
      }
    }
    return lo;
  }

  String cut(int n) => end(words.take(n).join(' ').replaceFirst(RegExp(r'[\s·,.:;–-]+$'), ''));
  final n = most(words.length - 1, cut);
  if (n > 0) return cut(n);
  final chars = words.first.characters.toList();
  String part(int n) => end(chars.take(n).join());
  return part(most(chars.length - 1, part));
}

/// Small inline markup used across the app (not full markdown):
///   `code`      → mono, isolated (chat.md §5), optionally boxed like the mockup's `.b code`
///   **x**       → bold, and the inside is markup too (`**השינויים ב-`main`:**`)
///   [t](url)    → link colour; bare URLs too
///   everything else: LTR runs (paths, ids, versions, `PR #17`, English phrases) are wrapped in
///   LRI…PDI when the text has Hebrew, so punctuation and brackets around them stay put (bidi.dart).
class Rich extends StatelessWidget {
  const Rich(this.markup, {super.key, this.style, this.codeBox = false, this.maxLines, this.overflow, this.align, this.auto = false, this.links});
  final String markup;
  final TextStyle? style;
  final bool codeBox;
  final int? maxLines;
  final TextOverflow? overflow;
  final TextAlign? align;

  /// Align by the text's own direction (chat content). Otherwise aligned like the screen (RTL).
  final bool auto;

  /// Links open on tap. Default: yes, except in clamped previews.
  final bool? links;

  @override
  Widget build(BuildContext context) {
    final base = style ?? DefaultTextStyle.of(context).style;
    // Clamped, it is cut only between words (T2): Flutter's own ellipsis cuts inside one ("כב…"). An explicit
    // [overflow] keeps Flutter's (a clamp under an IntrinsicWidth, where a LayoutBuilder can't measure).
    if (maxLines == null || overflow != null) return _text(context, markup, base);
    final dir = paragraphDirection(markup), scaler = MediaQuery.textScalerOf(context);
    return LayoutBuilder(builder: (context, box) {
      if (!box.maxWidth.isFinite) return _text(context, markup, base);
      bool fits(String m) {
        final tp = TextPainter(text: TextSpan(style: base, children: spans(context, m, base, codeBox: codeBox, links: false)), textDirection: dir, textScaler: scaler, maxLines: maxLines)
          ..layout(maxWidth: box.maxWidth);
        final over = tp.didExceedMaxLines;
        tp.dispose();
        return !over;
      }

      return _text(context, fitWords(markup, fits, close: _closeMarks), base);
    });
  }

  /// A cut that left a `code` or a **bold** open closes it, so the marks don't show as text.
  static String _closeMarks(String t) {
    var out = t;
    if ('`'.allMatches(t).length.isOdd) out = '$out`';
    if ('**'.allMatches(t.replaceAll(RegExp('`[^`]*`?'), '')).length.isOdd) out = '$out**';
    return out;
  }

  Widget _text(BuildContext context, String markup, TextStyle base) {
    return Text.rich(
      // Clamped lines are previews: the row's tap opens it, so links there don't take the tap.
      TextSpan(children: spans(context, markup, base, codeBox: codeBox, links: links ?? maxLines == null)),
      style: base,
      maxLines: maxLines,
      overflow: overflow ?? (maxLines != null ? TextOverflow.clip : null),
      // The text's own direction always, so an English title ends with its period on the
      // right. Lists and rows keep their RTL alignment unless [auto] asks for the text's own.
      textAlign: align ?? (auto ? TextAlign.start : (Directionality.of(context) == TextDirection.rtl ? TextAlign.right : TextAlign.left)),
      textDirection: paragraphDirection(markup),
    );
  }

  static final _tok = RegExp(r'''`([^`]+)`|\*\*(.+?)\*\*(?!\*)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?://[^\s)<>]*[^\s)<>.,:;!?'"])''');

  /// [links]: links open on tap (#55). Off in one-line previews, where the row's own tap wins.
  /// Shared by every span of the same link; they hold no state between taps.
  static final _linkTaps = <String, TapGestureRecognizer>{};

  static List<InlineSpan> spans(BuildContext context, String s, TextStyle base, {bool codeBox = false, bool? isolate, bool links = true}) {
    final p = context.p;
    TapGestureRecognizer? tap(String url) => links ? _linkTaps.putIfAbsent(url, () => TapGestureRecognizer()..onTap = () => openLink(url)) : null;
    final iso = isolate ?? (s.runes.any(isHebrewRune) && paragraphDirection(s) == TextDirection.rtl);
    String plain(String t) => iso ? isolateLtr(t, force: true) : t;
    final out = <InlineSpan>[];
    var i = 0;
    for (final m in _tok.allMatches(s)) {
      if (m.start > i) {
        var pre = plain(s.substring(i, m.start));
        // "ב-" right before code: a word joiner keeps the prefix on the code's line.
        if (m.group(1) != null && endsWithHebrewPrefix(pre)) pre = '$pre$kWJ';
        out.add(TextSpan(text: pre));
      }
      if (m.group(1) != null) {
        final code = m.group(1)!;
        final mono = T.mono((base.fontSize ?? 15.5) * 0.86, lh: (base.fontSize ?? 15.5) * 1.2).copyWith(color: base.color);
        // Boxed code is a background on the text run, not a WidgetSpan: with two or more
        // WidgetSpans in an RTL paragraph the engine paints each child in the other's slot
        // (QA-LOG, RTL/bidi). Narrow no-break spaces pad the box without adding a line break point.
        final whole = keepWhole(code);
        final run = codeBox ? '\u202F$whole\u202F' : whole;
        out.add(TextSpan(
          text: iso ? '$kFSI$run$kPDI' : run,
          style: codeBox ? mono.copyWith(background: Paint()..color = p.codeBg) : mono,
        ));
      } else if (m.group(2) != null) {
        out.add(TextSpan(
          style: const TextStyle(fontWeight: FontWeight.w700),
          children: spans(context, m.group(2)!, base.copyWith(fontWeight: FontWeight.w700), codeBox: codeBox, isolate: iso, links: links),
        ));
      } else if (m.group(3) != null) {
        // The label's own spans can't carry the tap (a recognizer belongs to a span with text), so
        // the label is one run with the link's recognizer.
        final label = m.group(3)!.replaceAll('`', '').replaceAll('**', '');
        out.add(TextSpan(text: plain(label), style: TextStyle(color: p.accent, decoration: links ? TextDecoration.underline : null, decorationColor: p.accent), recognizer: tap(m.group(4)!)));
      } else {
        final raw = m.group(5)!;
        final url = keepWhole(raw);
        out.add(TextSpan(
          text: iso ? '$kLRI$url$kPDI' : url,
          style: TextStyle(color: p.accent, decoration: links ? TextDecoration.underline : null, decorationColor: p.accent),
          recognizer: tap(raw),
        ));
      }
      i = m.end;
    }
    if (i < s.length) out.add(TextSpan(text: plain(s.substring(i))));
    return out;
  }
}

/// Opens a link from a message in the browser (a new tab on the web). Only https links open.
Future<void> openLink(String url) async {
  final u = Uri.tryParse(url);
  if (u == null || u.scheme != 'https') return;
  try {
    await openExternalUrl(u.toString());
  } catch (_) {}
}

/// Top app bar of the main screens (`.tbar`).
class TopBar extends StatelessWidget {
  const TopBar({super.key, this.title, this.actions = const [], this.leading, this.showLink = false});
  final String? title;

  /// The four main screens show "מתעדכן" next to the title while the link comes up (LinkHint).
  final bool showLink;
  final List<Widget> actions;
  final Widget? leading;
  @override
  Widget build(BuildContext context) => SizedBox(
        height: 56,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(children: [
            ?leading,
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(children: [
                  Flexible(child: Text(title ?? '', style: T.bar.copyWith(color: context.p.text), maxLines: 1)),
                  if (showLink) ...[const SizedBox(width: 10), const LinkHint()],
                ]),
              ),
            ),
            ...actions,
          ]),
        ),
      );
}

/// `.big`: Stripe-style large title with a secondary line.
class BigTitle extends StatelessWidget {
  const BigTitle(this.title, {super.key, this.sub});
  final String title;
  final String? sub;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: T.big.copyWith(color: p.text, height: 1.2)),
        if (sub != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(sub!, style: T.secondary.copyWith(color: p.text2))),
      ]),
    );
  }
}

/// `.tog`: 46x28 switch, accent when on.
class Toggle extends StatelessWidget {
  const Toggle({super.key, required this.on, required this.onTap, required this.label});
  final bool on;
  final VoidCallback onTap;
  final String label;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Semantics(
      toggled: on,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.only(top: 2),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: 46,
            height: 28,
            decoration: BoxDecoration(color: on ? p.accent : p.surface3, borderRadius: BorderRadius.circular(14)),
            child: AnimatedAlign(
              duration: const Duration(milliseconds: 150),
              alignment: on ? AlignmentDirectional.centerEnd : AlignmentDirectional.centerStart,
              child: Container(
                width: 20,
                height: 20,
                margin: const EdgeInsets.all(4),
                decoration: BoxDecoration(shape: BoxShape.circle, color: on ? p.onAccent : p.text3),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "נשלח לטיפול": the small line next to an error that went to hq by itself (error_report.dart).
/// Nothing while the app is not signed in to hq (the demo, the sign-in screen before there is a link).
class SentNote extends StatelessWidget {
  const SentNote({super.key, this.inline = false});

  /// Part of a line of text (" · נשלח לטיפול") rather than a line of its own.
  final bool inline;
  static const text = 'נשלח לטיפול';

  @override
  Widget build(BuildContext context) {
    if (!ErrorReports.instance.active) return const SizedBox.shrink();
    final p = context.p;
    return Text(inline ? ' · $text' : text, style: T.meta.copyWith(color: p.text2));
  }
}

/// An error on a screen (the red mark and its sentence), shown and so sent to hq once per text,
/// with "נשלח לטיפול" under it. [report]: false for one that is his to fix (a wrong code).
class ShownError extends StatefulWidget {
  const ShownError(this.text, {super.key, required this.screen, this.report = true, this.padding = EdgeInsets.zero});
  final String text;
  final String screen;
  final bool report;
  final EdgeInsetsGeometry padding;

  @override
  State<ShownError> createState() => _ShownErrorState();
}

class _ShownErrorState extends State<ShownError> {
  @override
  void initState() {
    super.initState();
    _report();
  }

  @override
  void didUpdateWidget(ShownError old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text) _report();
  }

  void _report() {
    if (widget.report) reportShown('screen', widget.text, screen: widget.screen);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Padding(
      padding: widget.padding,
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Ic('error', size: 18, color: p.urgent),
        const SizedBox(width: 6),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(widget.text, style: T.secondary.copyWith(color: p.text)),
            if (widget.report) const SentNote(),
          ]),
        ),
      ]),
    );
  }
}

/// A screen still loading after [after] is an error he is shown (error-catcher): it goes to hq once,
/// and "נשלח לטיפול" shows under what is loading. [child] is the spinner and its word.
class LoadingWatch extends StatefulWidget {
  const LoadingWatch({super.key, required this.screen, required this.child, this.after = const Duration(seconds: 15)});
  final String screen;
  final Widget child;
  final Duration after;

  @override
  State<LoadingWatch> createState() => _LoadingWatchState();
}

class _LoadingWatchState extends State<LoadingWatch> {
  Timer? _timer;
  bool stuck = false;

  @override
  void initState() {
    super.initState();
    _timer = Timer(widget.after, () {
      reportShown('stuck', 'המסך נתקע בטעינה יותר מ-${widget.after.inSeconds} שניות', screen: widget.screen);
      if (mounted) setState(() => stuck = true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => !stuck
      ? widget.child
      : Column(mainAxisSize: MainAxisSize.min, children: [widget.child, const SizedBox(height: 6), const SentNote()]);
}
