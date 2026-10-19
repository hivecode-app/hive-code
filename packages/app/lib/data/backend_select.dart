// The one place that picks the backend.
//   1. hq address + token saved in settings  -> HqBackend with them.
//   2. "חזרה להדגמה" chosen in settings, or ?demo in the web URL -> FakeBackend (mockup content).
//   3. Otherwise the real hq through the app's gateway: on the web <app path>/hq on the same
//      origin; on Android the HQ_URL baked in at build time. Caddy adds hq's token there, so the
//      token never ships inside the app (kGatewayToken is a placeholder Caddy replaces).
// Tests construct FakeBackend directly.
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'backend.dart';
import 'fake_backend.dart';
import 'hq_backend.dart';

const kHqUrl = 'hq.url';
const kHqToken = 'hq.token';
const kDemo = 'demo';
const kGatewayToken = 'gateway';
const kBuiltInHqUrl = String.fromEnvironment('HQ_URL');

Future<Backend> selectBackend() async {
  try {
    final p = await SharedPreferences.getInstance();
    final url = p.getString(kHqUrl), token = p.getString(kHqToken);
    if (url != null && url.isNotEmpty && token != null && token.isNotEmpty) return HqBackend(baseUrl: url, token: token);
    if (p.getBool(kDemo) == true || Uri.base.queryParameters.containsKey('demo')) return FakeBackend();
  } catch (_) {}
  final gw = gatewayUrl();
  if (gw.isNotEmpty) return HqBackend(baseUrl: gw, token: kGatewayToken);
  return FakeBackend();
}

/// The gateway next to the app: same origin `<app path>/hq` on the web, HQ_URL on Android.
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
