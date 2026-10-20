import 'dart:js_interop';
import 'dart:js_interop_unsafe';

@JS('navigator')
external JSObject get _navigator;

void setAppBadge(int count) {
  try {
    final nav = _navigator;
    if (count > 0 && nav.has('setAppBadge')) {
      nav.callMethod('setAppBadge'.toJS, count.toJS);
    } else if (count <= 0 && nav.has('clearAppBadge')) {
      nav.callMethod('clearAppBadge'.toJS);
    }
  } catch (_) {
    // Not installed, or the browser refuses: the counts in the app still say it.
  }
}
