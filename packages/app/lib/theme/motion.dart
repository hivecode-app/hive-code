// Motion tokens of design language v2 (docs/design/language-v2.md §5), from the Material 3 duration
// and easing tokens. Used only when [kDesignV2] is on; a normal build keeps today's motion.
import 'package:flutter/material.dart';

/// Durations and curves. One scale for the whole app: nothing outside it.
class Mo {
  static const xs = Duration(milliseconds: 100); // M3 short2: a press, a checkbox
  static const sm = Duration(milliseconds: 200); // M3 short4: fold, fade of a small part
  static const md = Duration(milliseconds: 300); // M3 medium2: a screen in, tab fade-through
  static const lg = Duration(milliseconds: 400); // M3 medium4: a card that opens to a screen
  static const back = Duration(milliseconds: 250); // a screen out: leaving is faster than coming

  static const standard = Cubic(0.2, 0.0, 0.0, 1.0); // M3 standard: small things that stay on screen
  static const enter = Cubic(0.05, 0.7, 0.1, 1.0); // M3 emphasized decelerate: what comes in
  static const exit = Cubic(0.3, 0.0, 0.8, 0.15); // M3 emphasized accelerate: what leaves
  static const emphasized = Curves.easeInOutCubicEmphasized; // M3 emphasized: one thing that moves across

  /// The system's "remove animations": then every transition is a cut.
  static bool off(BuildContext context) => MediaQuery.maybeDisableAnimationsOf(context) ?? false;
}

/// A screen that opens deeper (a chat, a project): M3 shared axis X. The new screen comes 30dp from
/// the reading direction's end and fades in; the old one moves 30dp toward the start and fades out.
/// RTL-aware, unlike the framework's builders (they slide from the right in Hebrew too). Between the
/// two fades the screen shows the app background ([kDesignV2] puts it under the navigator, main.dart).
class SharedAxisPageTransitionsBuilder extends PageTransitionsBuilder {
  const SharedAxisPageTransitionsBuilder();

  @override
  Duration get transitionDuration => Mo.md;

  @override
  Duration get reverseTransitionDuration => Mo.back;

  @override
  Widget buildTransitions<T>(PageRoute<T> route, BuildContext context, Animation<double> animation, Animation<double> secondaryAnimation, Widget child) {
    if (Mo.off(context)) return child;
    final rtl = Directionality.of(context) == TextDirection.rtl;
    final dir = rtl ? -1.0 : 1.0;
    return _Axis(animation: animation, secondary: secondaryAnimation, dir: dir, child: child);
  }
}

class _Axis extends StatelessWidget {
  const _Axis({required this.animation, required this.secondary, required this.dir, required this.child});
  final Animation<double> animation, secondary;
  final double dir;
  final Widget child;

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: Listenable.merge([animation, secondary]),
        child: child,
        builder: (context, child) {
          final a = animation.value, s = secondary.value;
          final popping = animation.status == AnimationStatus.reverse;
          final uncovering = secondary.status == AnimationStatus.reverse;
          // M3 shared axis: what leaves fades out over the first 30% of the time, what comes fades in
          // over the last 70%. Pushing, this page comes (a 0→1) and the one under leaves (s 0→1);
          // popping, this page leaves (a 1→0) and the one under comes back (s 1→0).
          final inOpacity = popping ? const Interval(0.7, 1).transform(a) : const Interval(0.3, 1).transform(a);
          final outOpacity = uncovering ? 1 - const Interval(0, 0.7).transform(s) : 1 - const Interval(0, 0.3).transform(s);
          final inT = popping ? 1 - Mo.exit.transform(1 - a) : Mo.enter.transform(a);
          final outT = uncovering ? 1 - Mo.enter.transform(1 - s) : Mo.exit.transform(s);
          // In from 30dp at the reading end; out 30dp toward the start.
          final dx = 30 * dir * (1 - inT) - 30 * dir * outT;
          return Opacity(opacity: (inOpacity * outOpacity).clamp(0.0, 1.0), child: Transform.translate(offset: Offset(dx, 0), child: child));
        },
      );
}

/// Switching tabs: M3 fade through. The old tab is gone at once, the new one fades in and grows
/// from 92%, so the eye reads "a different place" and not "moved sideways". Children keep state.
class FadeThroughIndexedStack extends StatefulWidget {
  const FadeThroughIndexedStack({super.key, required this.index, required this.children});
  final int index;
  final List<Widget> children;

  @override
  State<FadeThroughIndexedStack> createState() => _FadeThroughIndexedStackState();
}

class _FadeThroughIndexedStackState extends State<FadeThroughIndexedStack> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: Mo.md, value: 1);

  @override
  void didUpdateWidget(FadeThroughIndexedStack old) {
    super.didUpdateWidget(old);
    if (old.index != widget.index && !Mo.off(context)) _c.forward(from: 0);
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _c,
        builder: (context, child) {
          final t = _c.value;
          final o = const Interval(0.3, 1, curve: Mo.enter).transform(t);
          final s = 0.92 + 0.08 * Mo.enter.transform(t);
          return Opacity(opacity: o, child: Transform.scale(scale: s, child: child));
        },
        child: IndexedStack(index: widget.index, children: widget.children),
      );
}
