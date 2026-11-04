import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';

import 'motion.dart';
import 'tokens.dart';

/// Material 3 theme from the palette. Dynamic color is off on purpose (APP-SPEC §7.2).
ThemeData buildTheme(Palette p, {bool product = false}) {
  final scheme = ColorScheme(
    brightness: p.dark ? Brightness.dark : Brightness.light,
    primary: p.accent,
    onPrimary: p.onAccent,
    secondary: p.text2,
    onSecondary: p.surface,
    error: p.urgent,
    onError: p.surface,
    surface: p.surface,
    onSurface: p.text,
    surfaceContainerHighest: p.surface2,
    outline: p.line,
    outlineVariant: p.line,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: kFont,
    scaffoldBackgroundColor: p.bg,
    canvasColor: p.bg,
    dividerColor: p.line,
    splashFactory: InkRipple.splashFactory,
    highlightColor: p.text.withValues(alpha: 0.04),
    splashColor: p.text.withValues(alpha: 0.06),
    hoverColor: p.surface2,
    filledButtonTheme: product
        ? FilledButtonThemeData(
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              minimumSize: const Size(0, 48),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              textStyle: T.button.copyWith(fontSize: 14.5),
            ),
          )
        : null,
    outlinedButtonTheme: product
        ? OutlinedButtonThemeData(
            style: OutlinedButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              minimumSize: const Size(0, 48),
              side: BorderSide(color: p.line),
              foregroundColor: p.text,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              textStyle: T.button.copyWith(fontSize: 14.5),
            ),
          )
        : null,
    switchTheme: product
        ? SwitchThemeData(
            thumbColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? p.onAccent : p.text2),
            trackColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? p.accent : p.surface),
            trackOutlineColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? Colors.transparent : p.text2),
            trackOutlineWidth: const WidgetStatePropertyAll(2),
          )
        : null,
    iconTheme: IconThemeData(color: p.text2, size: 24),
    navigationBarTheme: product
        ? NavigationBarThemeData(
            iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(color: states.contains(WidgetState.selected) ? p.text : p.text2, size: 24)),
            labelTextStyle: WidgetStateProperty.resolveWith((states) => T.small.copyWith(color: states.contains(WidgetState.selected) ? p.text : p.text2)),
          )
        : null,
    textTheme: TextTheme(
      bodyMedium: T.body.copyWith(color: p.text),
      bodyLarge: T.body.copyWith(color: p.text),
    ),
    tooltipTheme: TooltipThemeData(
      textStyle: T.meta.copyWith(color: p.surface),
      decoration: BoxDecoration(color: p.text, borderRadius: BorderRadius.circular(6)),
      waitDuration: const Duration(milliseconds: 600),
    ),
    textSelectionTheme: TextSelectionThemeData(cursorColor: p.accent, selectionColor: p.accent.withValues(alpha: 0.25), selectionHandleColor: p.accent),
    pageTransitionsTheme: kDesignV2
        // v2 (language-v2 §5): Android keeps the system's predictive back and iOS its edge swipe;
        // web and desktop get a shared axis X that follows the reading direction.
        ? const PageTransitionsTheme(
            builders: {
              TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
              TargetPlatform.linux: SharedAxisPageTransitionsBuilder(),
              TargetPlatform.windows: SharedAxisPageTransitionsBuilder(),
              TargetPlatform.macOS: SharedAxisPageTransitionsBuilder(),
              TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
              TargetPlatform.fuchsia: SharedAxisPageTransitionsBuilder(),
            },
          )
        : const PageTransitionsTheme(builders: {TargetPlatform.android: PredictiveBackPageTransitionsBuilder()}),
    extensions: [p],
  );
}
