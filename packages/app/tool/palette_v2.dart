// ignore_for_file: avoid_print
// Prints the v2 tonal palettes (docs/design/language-v2.md §2) from M3's HCT: brand, neutral, and the
// identity hues for avatars. Run: dart run tool/palette_v2.dart
// ignore: depend_on_referenced_packages
import 'package:material_color_utilities/material_color_utilities.dart';

String hex(int argb) => '#${(argb & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}';

void main() {
  final brand = Hct.fromInt(0xFF1F6FEB);
  print('brand seed hue ${brand.hue.toStringAsFixed(1)} chroma ${brand.chroma.toStringAsFixed(1)}');
  void row(String name, TonalPalette p) =>
      print('$name: ${[0, 4, 6, 10, 12, 17, 20, 22, 24, 30, 40, 45, 50, 55, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100].map((t) => '$t=${hex(p.get(t))}').join(' ')}');
  row('brand', TonalPalette.of(brand.hue, 60));
  row('neutral', TonalPalette.of(90, 1.5)); // a warm paper, near today's #F5F5F3
  row('neutralVariant', TonalPalette.of(90, 3));
  row('grey', TonalPalette.of(0, 0)); // the neutral alternative to the paper (language-v2 §2)
  row('error', TonalPalette.of(25, 84));
  // Identity hues: one per project/team, muted (chroma 36), used as avatar container (light 92/30, dark 25/88) + on-container.
  const hues = {'blue': 255.0, 'sky': 225.0, 'teal': 190.0, 'green': 145.0, 'clay': 55.0, 'olive': 115.0, 'rose': 10.0, 'slate': 240.0};
  for (final e in hues.entries) {
    final p = TonalPalette.of(e.value, e.key == 'slate' ? 8 : 22);
    print('id-${e.key}: light bg=${hex(p.get(92))} fg=${hex(p.get(30))} | dark bg=${hex(p.get(25))} fg=${hex(p.get(88))}');
  }
}
