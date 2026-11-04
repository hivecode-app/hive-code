import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Keep the route's focus scope so Back/Esc returns focus to its originating card.
class DismissMedia extends StatelessWidget {
  const DismissMedia({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {const SingleActivator(LogicalKeyboardKey.escape): () => Navigator.maybePop(context)},
    child: Focus(autofocus: true, child: child),
  );
}

/// Measure long titles at the selected text size instead of clipping the file name.
double mediaToolbarHeight(BuildContext context, String title, {int actions = 1}) {
  final width = (MediaQuery.sizeOf(context).width - 56 - actions * 48 - 32).clamp(64.0, double.infinity);
  final painter = TextPainter(
    maxLines: 3,
    ellipsis: '…',
    text: TextSpan(text: title, style: Theme.of(context).textTheme.titleLarge),
    textDirection: Directionality.of(context),
    textScaler: MediaQuery.textScalerOf(context),
  )..layout(maxWidth: width);
  final height = painter.height + 16;
  painter.dispose();
  return height < kToolbarHeight ? kToolbarHeight : height;
}
