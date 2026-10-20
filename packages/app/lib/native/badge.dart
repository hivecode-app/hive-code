// The number on the installed web app's icon (PWA `navigator.setAppBadge`, where the browser has it).
// Android gets its number from the notifications (MessagePoster, NotificationPoster), so this is a no-op there.
import 'badge_io.dart' if (dart.library.js_interop) 'badge_web.dart' as impl;

void setAppBadge(int count) => impl.setAppBadge(count);
