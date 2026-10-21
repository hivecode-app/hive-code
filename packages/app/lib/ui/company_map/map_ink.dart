// The map's faces are the team's own tone at full strength (the hue is what makes the map readable at a glance), with
// a thin ring in the tone's letter colour so each holds 3:1 against the background (WCAG 1.4.11, non-text contrast).
import 'package:flutter/painting.dart';

import '../../theme/tokens.dart';

/// What a face has to reach against the background.
const kFaceContrast = 3.0;

/// WCAG contrast ratio of two opaque colours.
double contrast(Color a, Color b) {
  final x = a.computeLuminance(), y = b.computeLuminance();
  return (x > y ? x + 0.05 : y + 0.05) / (x > y ? y + 0.05 : x + 0.05);
}

/// The ring of a face: the tone's letter colour (the owner's and hq's: the text colour).
Color faceRing(Palette p, String? tone) => tone == null ? p.text2 : p.identity(tone).$2;

/// The fill of a face: the tone's container (the owner's and hq's: the neutral surface).
Color faceFill(Palette p, String? tone) => tone == null ? p.surface3 : p.identity(tone).$1;
