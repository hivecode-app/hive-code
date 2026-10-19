import 'package:flutter/material.dart';

import '../../theme/tokens.dart';

/// `.kb`: a keyboard key hint.
class Kbd extends StatelessWidget {
  const Kbd(this.label, {super.key});
  final String label;
  @override
  Widget build(BuildContext context) {
    final p = context.p;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 5),
      decoration: BoxDecoration(
        color: p.surface,
        borderRadius: BorderRadius.circular(4),
        border: Border(top: BorderSide(color: p.line), left: BorderSide(color: p.line), right: BorderSide(color: p.line), bottom: BorderSide(color: p.line, width: 2)),
      ),
      child: Text(label, textDirection: TextDirection.ltr, style: T.mono(11, lh: 17).copyWith(color: p.text2)),
    );
  }
}

