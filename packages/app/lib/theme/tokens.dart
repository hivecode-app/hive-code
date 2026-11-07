// Design tokens, copied 1:1 from the CSS variables of docs/app/prototype/index.html.
// The mockup is the visual source of truth; when it changes, this file changes with it.
// Design language v2 (docs/design/language-v2.md): its palette (the warm paper) and the identity tones are
// every build's since task 205 (נועה, 22/10). The rest of v2 is still built only with `--dart-define=DESIGN_V2=true`.
import 'package:flutter/material.dart';

/// The rest of the v2 proposal (docs/design/language-v2.md): the desktop home, the tabs' motion. Off in every normal build.
const kDesignV2 = bool.fromEnvironment('DESIGN_V2');

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

  /// v2 light (language-v2 §2): M3 tones from HCT (tool/palette_v2.dart). Brand: the owner's blue
  /// (#1F6FEB) at tone 40; neutrals: hue 90, chroma 1.5, a warm paper.
  static const lightV2 = Palette(
    bg: Color(0xFFF5F0EC), // N95
    surface: Color(0xFFFFFFFF), // N100
    surface2: Color(0xFFF2EDE9), // N94
    surface3: Color(0xFFE6E2DE), // N90
    line: Color(0xFFDFD9D2), // NV87
    text: Color(0xFF1D1B19), // N10
    text2: Color(0xFF494642), // NV30
    text3: Color(0xFF6E6A65), // NV45: 4.74:1 on bg (v1 text3 was 3.05:1)
    chatBg: Color(0xFFF2EDE9), // N94
    bubbleIn: Color(0xFFFFFFFF),
    bubbleOut: Color(0xFFE9EDFF), // brand 94
    codeBg: Color(0xFFF2EDE9),
    addBg: Color(0xFFD4F0CC),
    delBg: Color(0xFFFFE2DE),
    urgent: Color(0xFFBA1A1A), // error 40
    accent: Color(0xFF1259C3), // brand 40: 6.48:1 with white
    onAccent: Color(0xFFFFFFFF),
    accentSoft: Color(0xFFE1E8FF), // brand 92
    read: Color(0xFF1259C3),
    toolBg: Color(0xFFF2EDE9),
    dark: false,
  );

  /// v2 dark: surfaces step up in tone instead of drawing lines (M3 surface containers).
  static const darkV2 = Palette(
    bg: Color(0xFF141311), // N6
    surface: Color(0xFF1D1B19), // N10
    surface2: Color(0xFF2B2A28), // N17
    surface3: Color(0xFF363432), // N22
    line: Color(0xFF373430), // NV22: dark separates by tone, the line is a whisper
    text: Color(0xFFE6E2DE), // N90
    text2: Color(0xFFCBC6BF), // NV80
    text3: Color(0xFF95908A), // NV60: 5.42:1 on surface
    chatBg: Color(0xFF141311),
    bubbleIn: Color(0xFF2B2A28),
    bubbleOut: Color(0xFF00357E), // brand 24
    codeBg: Color(0xFF211F1D),
    addBg: Color(0xFF2A4127),
    delBg: Color(0xFF5C0004),
    urgent: Color(0xFFFFB4AB), // error 80
    accent: Color(0xFFAFC6FF), // brand 80
    onAccent: Color(0xFF002D6D), // brand 20: 7.73:1
    accentSoft: Color(0xFF00357E), // brand 24
    read: Color(0xFFAFC6FF),
    toolBg: Color(0xFF211F1D),
    dark: true,
  );

  /// Identity tone for a team or project (language-v2 §3): a muted container and the letter on it,
  /// 7.6:1 or more in both modes. [tone] is org.yaml's `teams[].tone` (hq sends it on the board); none,
  /// or one this app doesn't know, is slate. Identity only: a state is never told by these.
  (Color, Color) identity(String? tone) {
    final t = kTones[tone] ?? kTones['slate']!;
    return dark ? (t.$3, t.$4) : (t.$1, t.$2);
  }

  /// The soft 1px drop under bubbles and cards (`box-shadow:0 1px 0 rgba(0,0,0,.05)`).
  List<BoxShadow> get hairShadow => const [BoxShadow(color: Color(0x0D000000), offset: Offset(0, 1))];

  @override
  Palette copyWith() => this;

  @override
  Palette lerp(ThemeExtension<Palette>? other, double t) => t < 0.5 ? this : (other as Palette? ?? this);
}

/// The eight identity tones (language-v2 §3), from HCT at chroma 22 (slate 8) in fixed tones: light container
/// 92 and letter 30, dark 25 and 88 (tool/palette_v2.dart). By org.yaml's names, in the table's order.
const kTones = <String, (Color, Color, Color, Color)>{
  'blue': (Color(0xFFDCE9FF), Color(0xFF354860), Color(0xFF2A3D54), Color(0xFFCADEFC)),
  'teal': (Color(0xFFC6F1EB), Color(0xFF254D4A), Color(0xFF18423E), Color(0xFFBAE5E0)),
  'clay': (Color(0xFFFFE3D1), Color(0xFF613F26), Color(0xFF54341B), Color(0xFFFFD4B8)),
  'green': (Color(0xFFD4F0CC), Color(0xFF364C32), Color(0xFF2A4127), Color(0xFFC9E5C1)),
  'rose': (Color(0xFFFFE1E3), Color(0xFF633C41), Color(0xFF563136), Color(0xFFFFD2D6)),
  'sky': (Color(0xFFCAEEFE), Color(0xFF294B58), Color(0xFF1C404C), Color(0xFFBFE2F2)),
  // Olive in coral's place (21/10): coral and clay read as one. HCT hue 115, short of gold.
  'olive': (Color(0xFFEAECB8), Color(0xFF474923), Color(0xFF3B3E19), Color(0xFFDEE0AE)),
  'slate': (Color(0xFFE3E9F0), Color(0xFF41484D), Color(0xFF363C42), Color(0xFFD7DDE4)),
};

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

/// Values from design-v2/a.css: the palette of every build. Code, diff and urgent colours come from v2.
Palette productPalette(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final old = dark ? Palette.darkV2 : Palette.lightV2;
  return Palette(
    bg: Color(dark ? 0xFF141517 : 0xFFF7F7F5), surface: Color(dark ? 0xFF1C1D20 : 0xFFFFFFFF),
    surface2: Color(dark ? 0xFF111214 : 0xFFF0F0ED), surface3: Color(dark ? 0xFF26272B : 0xFFECECE8),
    line: Color(dark ? 0xFF2D2E32 : 0xFFE3E3DF), text: Color(dark ? 0xFFECECEA : 0xFF1B1C1E),
    text2: Color(dark ? 0xFFA6A9AE : 0xFF5C6066), text3: Color(dark ? 0xFF8F9398 : 0xFF6E7277),
    chatBg: Color(dark ? 0xFF141517 : 0xFFF7F7F5), bubbleIn: Color(dark ? 0xFF1C1D20 : 0xFFFFFFFF),
    bubbleOut: Color(dark ? 0xFF26272B : 0xFFECECE8), codeBg: old.codeBg, addBg: old.addBg, delBg: old.delBg,
    urgent: old.urgent, accent: Color(dark ? 0xFFECECEA : 0xFF1B1C1E), onAccent: Color(dark ? 0xFF141517 : 0xFFFFFFFF),
    accentSoft: Color(dark ? 0xFF26272B : 0xFFECECE8), read: Color(dark ? 0xFF8EB1FF : 0xFF2152C1),
    toolBg: Color(dark ? 0xFF111214 : 0xFFF0F0ED), dark: dark,
  );
}

Color projectColor(BuildContext context, String? tone) {
  final dark = context.p.dark;
  return switch (tone) {
    'teal' => Color(dark ? 0xFF4FC2B8 : 0xFF0A6A63),
    'sky' => Color(dark ? 0xFF5FA0BF : 0xFF136E90),
    'blue' => Color(dark ? 0xFF9A9EF2 : 0xFF4A4FC4),
    'violet' => Color(dark ? 0xFFA986E3 : 0xFF7A4FB7),
    'plum' => Color(dark ? 0xFFD778B0 : 0xFFA83C81),
    'clay' || 'rose' => Color(dark ? 0xFFE8A060 : 0xFF9A4A0C),
    'ochre' => Color(dark ? 0xFFB99057 : 0xFF8A5D0B),
    'olive' => Color(dark ? 0xFF9A9C55 : 0xFF696901),
    'green' => Color(dark ? 0xFF5DA861 : 0xFF0A7520),
    _ => Color(dark ? 0xFFA3ABB6 : 0xFF5B6470),
  };
}
