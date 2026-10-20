// Opening a link outside the app: the tab handoff page (B.9) is the bet6 spike's page in the browser.
import 'open_url_io.dart' if (dart.library.js_interop) 'open_url_web.dart' as impl;

Future<bool> openExternalUrl(String url) => impl.openExternalUrl(url);
