import 'package:flutter/widgets.dart';

bool windowFocused() {
  final s = WidgetsBinding.instance.lifecycleState;
  return s == null || s == AppLifecycleState.resumed;
}

void Function() onWindowFocusChange(void Function() changed) => () {};
