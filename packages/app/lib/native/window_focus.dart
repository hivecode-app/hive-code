// Whether the window really has him now. On the web the lifecycle starts as `resumed` whatever the truth is (a tab
// restored in the background, a reload behind another window), and the engine drops a change to the state it
// already thinks it is in, so the first focus after such a load never arrives. The web listens to the DOM itself.
import 'window_focus_io.dart' if (dart.library.js_interop) 'window_focus_web.dart' as impl;

bool windowFocused() => impl.windowFocused();

/// Calls [changed] on every focus, blur and visibility change of the window (web only; a no-op elsewhere,
/// where the lifecycle is right). Returns what removes the listeners.
void Function() onWindowFocusChange(void Function() changed) => impl.onWindowFocusChange(changed);
