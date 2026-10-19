// Design tokens, copied 1:1 from the CSS variables of docs/app/mockups/index.html.
// The mockup is the visual source of truth; when it changes, this file changes with it.
import 'package:flutter/material.dart';

@immutable
class Palette extends ThemeExtension<Palette> {
  const Palette({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.surface3,
    required this.line,
    required this.text,
    required this.text2,
    required this.text3,
    required this.chatBg,
    required this.bubbleIn,
    required this.bubbleOut,
    required this.codeBg,
    required this.addBg,
    required this.delBg,
    required this.urgent,
    required this.accent,
    required this.onAccent,
    required this.accentSoft,
    required this.read,
    required this.toolBg,
    required this.dark,
  });

  final Color bg, surface, surface2, surface3, line;
  final Color text, text2, text3;
  final Color chatBg, bubbleIn, bubbleOut;
  final Color codeBg, addBg, delBg, urgent;
  final Color accent, onAccent, accentSoft, read;
  final Color toolBg;
  final bool dark;

  // :root (light) with the owner's choice: blue action color (20/10/2026).
  static const light = Palette(
    bg: Color(0xFFF5F5F3),
    surface: Color(0xFFFFFFFF),
    surface2: Color(0xFFF0F0ED),
    surface3: Color(0xFFE6E6E2),
    line: Color(0xFFE3E3DF),
    text: Color(0xFF1A1B1D),
    text2: Color(0xFF5E6167),
    text3: Color(0xFF8A8D93),
    chatBg: Color(0xFFEFEFEC),
    bubbleIn: Color(0xFFFFFFFF),
    bubbleOut: Color(0xFFE4ECF7),
    codeBg: Color(0xFFF4F4F1),
    addBg: Color(0xFFE8F2EA),
    delBg: Color(0xFFF7E8E6),
    urgent: Color(0xFFB3261E),
    accent: Color(0xFF1F6FEB),
    onAccent: Color(0xFFFFFFFF),
    accentSoft: Color(0xFFE2ECFC),
    read: Color(0xFF1F6FEB),
    toolBg: Color(0xFFF0F0ED),
    dark: false,
  );

  // [data-theme=dark]: neutral grey, not green and not blue (APP-SPEC §7.2).
  static const darkPalette = Palette(
    bg: Color(0xFF121314),
    surface: Color(0xFF1B1C1E),
    surface2: Color(0xFF222326),
    surface3: Color(0xFF2C2D31),
    line: Color(0xFF2D2F33),
    text: Color(0xFFE8E8E5),
    text2: Color(0xFFA0A3A9),
    text3: Color(0xFF74777D),
    chatBg: Color(0xFF0F1011),
    bubbleIn: Color(0xFF1F2023),
    bubbleOut: Color(0xFF1E2A3B),
    codeBg: Color(0xFF17181A),
    addBg: Color(0xFF16271C),
    delBg: Color(0xFF321A1A),
    urgent: Color(0xFFF2B8B5),
    accent: Color(0xFF7AAEFF),
    onAccent: Color(0xFF0B1A33),
    accentSoft: Color(0xFF1D2A40),
    read: Color(0xFF7AAEFF),
    toolBg: Color(0xFF18191B),
    dark: true,
  );

  /// The soft 1px drop under bubbles and cards (`box-shadow:0 1px 0 rgba(0,0,0,.05)`).
  List<BoxShadow> get hairShadow => const [BoxShadow(color: Color(0x0D000000), offset: Offset(0, 1))];

  @override
  Palette copyWith() => this;

  @override
  Palette lerp(ThemeExtension<Palette>? other, double t) => t < 0.5 ? this : (other as Palette? ?? this);
}

/// Font families bundled in assets/fonts (Heebo, JetBrains Mono), APP-SPEC §7.3.
const kFont = 'Heebo';
const kMono = 'JetBrainsMono';

/// Type scale from APP-SPEC §7.3 and the mockup classes (size / line height / weight).
class T {
  static TextStyle _s(double size, double lh, FontWeight w) =>
      TextStyle(fontFamily: kFont, fontSize: size, height: lh / size, fontWeight: w, letterSpacing: 0);

  static final big = _s(28, 34, FontWeight.w700); // .big
  static final bar = _s(21, 28, FontWeight.w700); // .tbar h3
  static final name = _s(15.5, 21, FontWeight.w700); // .t1
  static final body = _s(15.5, 23, FontWeight.w400); // .b
  static final row2 = _s(14.5, 21, FontWeight.w400); // .t2
  static final secondary = _s(13.5, 20, FontWeight.w400); // .ttl, .tool
  static final small = _s(13, 19, FontWeight.w400); // .t3
  static final meta = _s(12.5, 18, FontWeight.w400); // .time, .svc
  static final chip = _s(12, 16, FontWeight.w500); // .badge
  static final section = _s(13.5, 20, FontWeight.w700); // .sec
  static final button = _s(14, 20, FontWeight.w500); // .btn
  static TextStyle mono(double size, {FontWeight w = FontWeight.w400, double? lh}) => TextStyle(
        fontFamily: kMono,
        fontSize: size,
        height: (lh ?? size * 1.55) / size,
        fontWeight: w,
        fontFeatures: const [FontFeature.disable('liga'), FontFeature.disable('calt')],
      );
}

extension PaletteX on BuildContext {
  Palette get p => Theme.of(this).extension<Palette>()!;
}

/// Unicode isolates around an LTR run (chat.md §5): first-strong-isolate does not flip `#3712` or a path.
String ltr(String s) => '\u2066$s\u2069';
