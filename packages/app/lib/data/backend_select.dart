// The one place that picks the backend.
//   1. hq address + token saved on this device (its own device token, #23) -> HqBackend.
//   2. "הדגמה" chosen in settings or on the sign-in screen, or ?demo in the web URL -> FakeBackend.
//   3. Otherwise, when there is a real hq next to the app (on the web <app path>/hq on the same
//      origin; on Android the HQ_URL baked in at build time): null, and the app shows the sign-in
//      screen (passkey or pairing code). No token ships inside the app; hq's own token stays on the server.
// Tests construct FakeBackend directly.
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auth_client.dart';
import 'backend.dart';
import 'fake_backend.dart';
import 'hq_backend.dart';

const kHqUrl = 'hq.url';
const kHqToken = 'hq.token';
const kDemo = 'demo';
const kBuiltInHqUrl = String.fromEnvironment('HQ_URL');

/// The backend to open with, or null when this device still has to sign in.
Future<Backend?> selectBackend() async {
  try {
    final p = await SharedPreferences.getInstance();
    final url = p.getString(kHqUrl), token = p.getString(kHqToken);
    if (url != null && url.isNotEmpty && token != null && token.isNotEmpty) return HqBackend(baseUrl: url, token: token);
    if (p.getBool(kDemo) == true || Uri.base.queryParameters.containsKey('demo')) return FakeBackend();
  } catch (_) {}
  return gatewayUrl().isNotEmpty ? null : FakeBackend();
}

/// The saved session, if this device is signed in.
Future<Session?> savedSession() async {
  final p = await SharedPreferences.getInstance();
  final url = p.getString(kHqUrl), token = p.getString(kHqToken);
  return url != null && url.isNotEmpty && token != null && token.isNotEmpty ? Session(url, token) : null;
}

Future<void> saveSession(Session s) async {
  final p = await SharedPreferences.getInstance();
  await p.setString(kHqUrl, s.baseUrl);
  await p.setString(kHqToken, s.token);
  await p.remove(kDemo);
}

Future<void> clearSession() async {
  final p = await SharedPreferences.getInstance();
  await p.remove(kHqUrl);
  await p.remove(kHqToken);
}

/// The hq next to the app: same origin `<app path>/hq` on the web, HQ_URL on Android.
String gatewayUrl() {
  if (!kIsWeb) return kBuiltInHqUrl;
  return defaultHqUrl();
}

/// On the web build the hq API sits next to the app: `<app path>/hq` (Caddy, tool/deploy.sh).
String defaultHqUrl() {
  final b = Uri.base;
  if (b.scheme != 'https' && b.scheme != 'http') return '';
  if (b.host == 'localhost' || b.host == '127.0.0.1') return kBuiltInHqUrl;
  final path = b.path.endsWith('/') ? b.path : b.path.substring(0, b.path.lastIndexOf('/') + 1);
  return '${b.origin}${path}hq';
}

/// A pairing code that came in the link (`?pair=XXXX-XXXX`, from settings → devices).
String? pairCodeFromUrl() => kIsWeb ? Uri.base.queryParameters['pair'] : null;
