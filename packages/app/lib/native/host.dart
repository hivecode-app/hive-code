// The real device, not the platform Flutter pretends to be: widget tests run as "Android" on the
// host, where an Android view can't be created.
import 'host_io.dart' if (dart.library.js_interop) 'host_web.dart' as impl;

bool get runsOnAndroid => impl.runsOnAndroid;
