// The one place that picks the backend.
//   1. hq address + token saved on this device (its own device token, #23) -> HqBackend.
//   2. Otherwise null, and the app shows the sign-in screen (passkey or pairing code).
// Which server (docs/generic/PLAN.md §2, "one app"): no hq address is built into the app.
//   - web: the hq next to the app, `<app path>/hq` on the same origin.
//   - Android: the server this device was last signed in to ([kHqServer]), or the one from a pairing
//     link (`https://<host>/pair?code=…`, hq's pairing page or a QR) or typed on the sign-in screen.
//     hq sits at `<origin>/hq` on that server, the same layout as the web build (deploy/caddy).
// A device signed in before this keeps its saved address and token as they are; [migrate] only adds
// [kHqServer] from them, so the server it used becomes the one its sign-in screen starts with.
// There is no demo mode (#53): FakeBackend lives for tests only and never reaches a release build.
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auth_client.dart';
import 'backend.dart';
import 'hq_backend.dart';

const kHqUrl = 'hq.url';
const kHqToken = 'hq.token';

/// The server's origin (`https://app.hq.example.com`). Kept after signing out, so the sign-in screen
/// starts with it; replaced when the device signs in somewhere else.
const kHqServer = 'hq.server';

/// Development only: the web build served from localhost talks to this hq (`flutter run -d chrome
/// --dart-define=HQ_URL=…`). Release builds never set it.
const kDevHqUrl = String.fromEnvironment('HQ_URL');

/// Set by the running app: back to the sign-in screen now, with [note] on it (settings → "יציאה").
void Function(String note)? kSignOut;

/// Set by the running app: the sign-in screen for another server, the current one kept until that
/// works (settings → "החלפת שרת", or a pairing link for another server). [link] fills it in.
void Function([String? link])? kSwitchServer;

/// The backend to open with, or null when this device still has to sign in.
Future<Backend?> selectBackend() async {
  try {
    final s = await savedSession();
    if (s != null) return HqBackend(baseUrl: s.baseUrl, token: s.token);
  } catch (_) {}
  return null;
}

/// The saved session, if this device is signed in.
Future<Session?> savedSession() async {
  final p = await SharedPreferences.getInstance();
  await migrate(p);
  final url = p.getString(kHqUrl), token = p.getString(kHqToken);
  return url != null && url.isNotEmpty && token != null && token.isNotEmpty ? Session(url, token) : null;
}

/// Brings what an older build saved up to date. Never drops a session.
///   - a session under the old secret path (`/<32 hex>/hq`, before 20/10/2026, #54) moves to `<origin>/hq`
///     on the same host, token kept;
///   - [kHqServer] is filled from the saved hq address, so the server the build used to have built in
///     (HQ_URL) stays this device's server.
@visibleForTesting
Future<void> migrate(SharedPreferences p) async {
  final saved = p.getString(kHqUrl);
  if (saved == null || saved.isEmpty) return;
  final a = Uri.tryParse(saved);
  if (a == null || a.host.isEmpty) return;
  if (_oldSecretPath.hasMatch(a.path)) await p.setString(kHqUrl, hqUrlFor(a.origin));
  final server = p.getString(kHqServer);
  if (server == null || server.isEmpty) await p.setString(kHqServer, a.origin);
}

final _oldSecretPath = RegExp(r'^/[0-9a-f]{32}/hq/?$');

Future<void> saveSession(Session s) async {
  final p = await SharedPreferences.getInstance();
  final old = p.getString(kHqUrl);
  if (old != null && old.isNotEmpty) {
    for (final key
        in p.getKeys().where((k) => k.startsWith('draft:') || k == 'outbox' || k == 'media-uploads' || k.startsWith('media-draft:') || k.startsWith('media-answer:')).toList()) {
      final value = p.getString(key);
      final scoped = 'company:$old:$key';
      if (value != null && !p.containsKey(scoped)) await p.setString(scoped, value);
      await p.remove(key);
    }
  }
  await p.setString(kHqUrl, s.baseUrl);
  await p.setString(kHqToken, s.token);
  final u = Uri.tryParse(s.baseUrl);
  if (u != null && u.host.isNotEmpty) await p.setString(kHqServer, u.origin);
  await p.remove('demo'); // left by builds that still had a demo mode
}

Future<void> clearSession() async {
  final p = await SharedPreferences.getInstance();
  await p.remove(kHqUrl);
  await p.remove(kHqToken);
  await p.remove(HqBackend.kCacheKey); // the last snapshot was this device's view of that hq
}

/// The server the sign-in screen starts with: this origin on the web, the last one on Android ('' = none yet).
Future<String> initialServer() async {
  if (kIsWeb) return defaultHqUrl();
  try {
    final p = await SharedPreferences.getInstance();
    await migrate(p);
    final s = p.getString(kHqServer) ?? '';
    return s.isEmpty ? '' : hqUrlFor(s);
  } catch (_) {
    return '';
  }
}

/// hq on a server: `<origin>/hq`.
String hqUrlFor(String origin) => '${origin.endsWith('/') ? origin.substring(0, origin.length - 1) : origin}/hq';

/// What a person reads as "the server": the host of an hq address (`app.hq.example.com`).
String serverHost(String hqUrl) {
  final u = Uri.tryParse(hqUrl);
  return u == null || u.host.isEmpty ? hqUrl : (u.hasPort ? '${u.host}:${u.port}' : u.host);
}

/// A server from a pairing link, a QR, or what was typed: its origin, and the code when the link has one.
@immutable
class ServerTarget {
  const ServerTarget(this.origin, [this.code]);
  final String origin;
  final String? code;
  String get hqUrl => hqUrlFor(origin);
  String get host => serverHost(origin);
}

/// Reads `https://<host>/pair?code=…`, `https://<host>/?pair=…`, `agentcompany://pair?url=…`, a plain
/// address (`app.hq.example.com`, `https://box.tail1.ts.net/`) or an hq address (`…/hq`). Only https,
/// except a local address for development. null when it is none of these.
ServerTarget? parseServer(String input) {
  var s = input.trim();
  if (s.isEmpty) return null;
  if (s.startsWith('agentcompany://')) {
    final inner = Uri.tryParse(s)?.queryParameters['url'];
    if (inner == null || inner.startsWith('agentcompany:')) return null;
    s = inner;
  }
  if (!s.contains('://')) s = 'https://$s';
  final u = Uri.tryParse(s);
  if (u == null || u.host.isEmpty || u.userInfo.isNotEmpty) return null;
  final local = u.host == 'localhost' || u.host == '127.0.0.1' || u.host == '10.0.2.2';
  if (u.scheme != 'https' && !(u.scheme == 'http' && local)) return null;
  if (!RegExp(r'^[A-Za-z0-9.-]+$').hasMatch(u.host) || (!u.host.contains('.') && !local)) return null;
  final code = (u.path == '/pair' ? u.queryParameters['code'] : u.queryParameters['pair'])?.trim();
  return ServerTarget(u.origin, code == null || code.isEmpty ? null : code.toUpperCase());
}

/// On the web build the hq API sits next to the app: `<app path>/hq` (Caddy, deploy/caddy/agent-company.caddy).
/// Also on localhost (an install with `--address local`), unless a development run set [kDevHqUrl].
String defaultHqUrl() {
  final b = Uri.base;
  if (b.scheme != 'https' && b.scheme != 'http') return '';
  if ((b.host == 'localhost' || b.host == '127.0.0.1') && kDevHqUrl.isNotEmpty) return kDevHqUrl;
  final path = b.path.endsWith('/') ? b.path : b.path.substring(0, b.path.lastIndexOf('/') + 1);
  return '${b.origin}${path}hq';
}

/// A pairing code that came in the link: `?pair=XXXX-XXXX` (settings → devices, and hq's pairing page
/// on its way to the web app).
String? pairCodeFromUrl() => kIsWeb ? Uri.base.queryParameters['pair'] : null;
