// The one place that picks the backend. With an hq URL + token saved in settings: HqBackend.
// Without them: the demo backend with the mockup's content (hq is not live yet).
import 'package:shared_preferences/shared_preferences.dart';

import 'backend.dart';
import 'fake_backend.dart';
import 'hq_backend.dart';

const kHqUrl = 'hq.url';
const kHqToken = 'hq.token';

Future<Backend> selectBackend() async {
  try {
    final p = await SharedPreferences.getInstance();
    final url = p.getString(kHqUrl), token = p.getString(kHqToken);
    if (url != null && url.isNotEmpty && token != null && token.isNotEmpty) return HqBackend(baseUrl: url, token: token);
  } catch (_) {}
  return FakeBackend();
}

/// On the web build the hq API sits next to the app: `<app path>/hq` (Caddy, tool/deploy.sh).
String defaultHqUrl() {
  final b = Uri.base;
  if (b.scheme != 'https' && b.scheme != 'http') return '';
  final path = b.path.endsWith('/') ? b.path : b.path.substring(0, b.path.lastIndexOf('/') + 1);
  return '${b.origin}${path}hq';
}
