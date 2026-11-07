import 'package:flutter/material.dart';

import '../../theme/tokens.dart';
import '../../data/backend.dart';
import '../bidi.dart';

String twoLetters(String name) {
  final words = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  if (words.isEmpty) return '';
  // A single first name uses its first two graphemes, as Mi / Mira in the source.
  if (words.length == 1) return words.first.characters.take(2).toString();
  return '${words.first.characters.first}${words.last.characters.first}';
}

class ProjectMonogram extends StatelessWidget {
  const ProjectMonogram({super.key, required this.name, this.tone, this.size = 36});
  final String name;
  final String? tone;
  final double size;
  factory ProjectMonogram.person(CompanyData d, String id, {double size = 36}) => ProjectMonogram(name: d.who(id).name, tone: d.toneOf(id), size: size);
  @override
  Widget build(BuildContext context) {
    final color = projectColor(context, tone);
    return ExcludeSemantics(
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(shape: BoxShape.circle, color: Color.alphaBlend(color.withValues(alpha: .14), context.p.surface)),
        child: Text(
          twoLetters(name),
          textScaler: TextScaler.noScaling,
          style: TextStyle(fontFamily: kFont, fontSize: size == 36 ? 14 : size * .41, fontWeight: FontWeight.w600, height: 1, color: color),
        ),
      ),
    );
  }
}

/// Content follows its own paragraph direction, independently of the interface language.
class ProductContentText extends StatelessWidget {
  const ProductContentText(this.text, {super.key, this.style, this.maxLines, this.overflow});
  final String text;
  final TextStyle? style;
  final int? maxLines;
  final TextOverflow? overflow;
  @override
  Widget build(BuildContext context) =>
      Text(isolateLtr(text), textDirection: paragraphDirection(text), textAlign: TextAlign.start, style: style, maxLines: maxLines, overflow: overflow);
}

/// Counts and monograms are symbols: they keep their geometry at large text sizes.
class ProductUnreadBadge extends StatelessWidget {
  const ProductUnreadBadge(this.count, {super.key});
  final int count;
  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    final p = context.p;
    return Container(
      constraints: const BoxConstraints(minWidth: 18, minHeight: 18),
      padding: const EdgeInsets.symmetric(horizontal: 6),
      decoration: BoxDecoration(color: p.accent, borderRadius: BorderRadius.circular(10)),
      alignment: Alignment.center,
      child: Text(
        '$count',
        textScaler: TextScaler.noScaling,
        style: TextStyle(fontFamily: kFont, fontSize: 11.5, height: 1.4, fontWeight: FontWeight.w600, color: p.onAccent),
      ),
    );
  }
}
