// Getting and managing device tokens (#23, packages/hq/src/auth.ts). Each device has its own
// token, which settings → devices can revoke; hq's own token never leaves the server.
//   open:   GET /health (is hq there), POST /api/auth/login/options, /api/auth/login, /api/auth/register/options,
//           /api/auth/register, /api/auth/pair
//   device: GET /api/devices, POST /api/devices/pair, /api/devices/:id/revoke, /api/passkeys/:id/revoke
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'passkey.dart';

/// A signed-in device: where hq is and this device's own token.
@immutable
class Session {
  const Session(this.baseUrl, this.token);
  final String baseUrl;
  final String token;
}

/// Plain sentences for the screen (design-taste §7). [code] is set for the passkey cases the
/// screen reacts to (offer pairing, offer the code-only path).
class AuthFailure implements Exception {
  const AuthFailure(this.message, {this.code});
  final String message;
  final PasskeyError? code;
  @override
  String toString() => message;
}

class DeviceInfo {
  DeviceInfo.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        name = j['name'] as String,
        via = j['via'] as String,
        passkeyId = j['passkey_id'] as String?,
        createdAt = DateTime.fromMillisecondsSinceEpoch(j['created_at'] as int),
        lastSeenAt = j['last_seen_at'] == null ? null : DateTime.fromMillisecondsSinceEpoch(j['last_seen_at'] as int),
        current = j['current'] == true;
  final String id, name, via;
  final String? passkeyId;
  final DateTime createdAt;
  final DateTime? lastSeenAt;
  final bool current;
}

class PasskeyInfo {
  PasskeyInfo.fromJson(Map<String, dynamic> j)
      : id = j['id'] as String,
        name = j['name'] as String,
        createdAt = DateTime.fromMillisecondsSinceEpoch(j['created_at'] as int),
        lastUsedAt = j['last_used_at'] == null ? null : DateTime.fromMillisecondsSinceEpoch(j['last_used_at'] as int);
  final String id, name;
  final DateTime createdAt;
  final DateTime? lastUsedAt;
}

class PairCode {
  PairCode.fromJson(Map<String, dynamic> j)
      : code = j['code'] as String,
        expiresAt = DateTime.fromMillisecondsSinceEpoch(j['expires_at'] as int),
        link = j['link'] as String?;
  final String code;
  final DateTime expiresAt;
  final String? link;
}

class AuthClient {
  AuthClient(this.baseUrl, {http.Client? client, Passkeys? passkeys})
      : _http = client ?? http.Client(),
        _passkeys = passkeys ?? Passkeys.instance,
        _ownsHttp = true;

  /// The same HTTP client and passkeys, another hq (switching servers: leaving the old one).
  AuthClient.at(this.baseUrl, AuthClient other)
      : _http = other._http,
        _passkeys = other._passkeys,
        _ownsHttp = false;
  final bool _ownsHttp;
  /// The hq this client talks to. The sign-in screen points it at the server typed or linked there.
  String baseUrl;
  final http.Client _http;
  final Passkeys _passkeys;

  bool get passkeysSupported => _passkeys.supported;

  /// Is there an hq at [baseUrl]? Its open GET /health answers JSON with the store's schema (503 too:
  /// hq is there, only its scheduler is late).
  Future<void> probe() async {
    const missing = AuthFailure('לא נמצא שרת של החברה בכתובת הזו. כדאי לבדוק את הכתובת ולנסות שוב.');
    final http.Response r;
    try {
      r = await _http.get(Uri.parse('$baseUrl/health')).timeout(const Duration(seconds: 10));
    } catch (_) {
      throw const AuthFailure('אין חיבור לשרת בכתובת הזו. כדאי לבדוק את הכתובת ואת החיבור לאינטרנט.');
    }
    try {
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if ((r.statusCode == 200 || r.statusCode == 503) && j is Map && j.containsKey('schema')) return;
    } catch (_) {}
    throw missing;
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body,
      {String? token, String otherwise = 'השרת לא אישר את הכניסה. אפשר לנסות שוב.'}) async {
    final http.Response r;
    try {
      r = await _http
          .post(Uri.parse('$baseUrl$path'),
              headers: {'content-type': 'application/json', if (token != null) 'authorization': 'Bearer $token'}, body: jsonEncode(body))
          .timeout(const Duration(seconds: 15));
    } catch (_) {
      throw const AuthFailure('אין חיבור לשרת. אפשר לנסות שוב.');
    }
    if (r.statusCode == 200) return (jsonDecode(utf8.decode(r.bodyBytes)) as Map).cast<String, dynamic>();
    if (r.statusCode == 429) throw const AuthFailure('היו יותר מדי קודים שגויים. אפשר לנסות שוב בעוד כמה דקות.');
    final err = (() {
      try {
        return (jsonDecode(r.body) as Map)['error'] as String? ?? '';
      } catch (_) {
        return '';
      }
    })();
    if (err.contains('pairing code')) throw const AuthFailure('הקוד שגוי, כבר שומש או שפג תוקפו. צריך קוד חדש ממסך המכשירים שבהגדרות.');
    if (err.contains('unknown passkey')) throw const AuthFailure('ה-passkey הזה לא רשום בחברה, או שהוסר. צריך לצמד את המכשיר עם קוד.');
    throw AuthFailure(otherwise);
  }

  Future<String> _passkey(Future<PasskeyResult> call) async {
    final r = await call;
    if (r.json != null) return r.json!;
    throw AuthFailure(
        switch (r.error!) {
          PasskeyError.cancelled => 'הכניסה בוטלה.',
          PasskeyError.exists => 'במכשיר הזה כבר יש passkey של החברה. אפשר להיכנס איתו.',
          PasskeyError.none => 'אין במכשיר הזה passkey של החברה. צריך לצמד אותו עם קוד.',
          PasskeyError.unsupported => 'המכשיר הזה לא תומך ב-passkey. אפשר לצמד אותו עם קוד בלבד.',
          PasskeyError.failed => 'טביעת האצבע לא עברה. אפשר לנסות שוב.',
        },
        code: r.error);
  }

  Session _session(Map<String, dynamic> r) => Session(baseUrl, r['token'] as String);

  /// Fingerprint with a passkey that is already registered (also one synced from another device).
  Future<Session> login(String deviceName) async {
    final options = await _post('/api/auth/login/options', {});
    final credential = await _passkey(_passkeys.get(jsonEncode(options)));
    return _session(await _post('/api/auth/login', {'name': deviceName, 'credential': jsonDecode(credential)}));
  }

  /// A pairing code and a new passkey on this device.
  Future<Session> register(String code, String deviceName) async {
    final options = await _post('/api/auth/register/options', {'code': code});
    final credential = await _passkey(_passkeys.create(jsonEncode(options)));
    return _session(await _post('/api/auth/register', {'name': deviceName, 'credential': jsonDecode(credential)}));
  }

  /// The pairing code alone, for a device without passkeys.
  Future<Session> pair(String code, String deviceName) async => _session(await _post('/api/auth/pair', {'code': code, 'name': deviceName}));

  // ── signed in ──────────────────────────────────────────────────────────────

  Future<({List<DeviceInfo> devices, List<PasskeyInfo> passkeys})> devices(String token) async {
    final http.Response r;
    try {
      r = await _http.get(Uri.parse('$baseUrl/api/devices'), headers: {'authorization': 'Bearer $token'}).timeout(const Duration(seconds: 10));
    } catch (_) {
      throw const AuthFailure('אין חיבור לשרת. אפשר לנסות שוב.');
    }
    if (r.statusCode != 200) throw const AuthFailure('השרת לא החזיר את רשימת המכשירים.');
    final j = (jsonDecode(utf8.decode(r.bodyBytes)) as Map).cast<String, dynamic>();
    return (
      devices: [for (final d in (j['devices'] as List).cast<Map<String, dynamic>>()) DeviceInfo.fromJson(d)],
      passkeys: [for (final p in (j['passkeys'] as List).cast<Map<String, dynamic>>()) PasskeyInfo.fromJson(p)],
    );
  }

  Future<PairCode> newPairCode(String token) async =>
      PairCode.fromJson(await _post('/api/devices/pair', {}, token: token, otherwise: 'השרת לא יצר קוד. אפשר לנסות שוב.'));
  Future<void> revokeDevice(String token, String id) =>
      _post('/api/devices/${Uri.encodeComponent(id)}/revoke', {}, token: token, otherwise: 'הביטול לא עבר. ייתכן שהמכשיר כבר בוטל.');
  Future<void> revokePasskey(String token, String id) =>
      _post('/api/passkeys/${Uri.encodeComponent(id)}/revoke', {}, token: token, otherwise: 'ההסרה לא עברה. ייתכן שה-passkey כבר הוסר.');

  void close() {
    if (_ownsHttp) _http.close();
  }
}

/// A name for this device in the devices list ("Android", "Chrome · Linux"…).
String defaultDeviceName() {
  if (kIsWeb) {
    return switch (defaultTargetPlatform) {
      TargetPlatform.android => 'דפדפן בטלפון',
      TargetPlatform.iOS => 'דפדפן באייפון',
      TargetPlatform.macOS => 'דפדפן ב-Mac',
      TargetPlatform.windows => 'דפדפן ב-Windows',
      _ => 'דפדפן במחשב',
    };
  }
  return defaultTargetPlatform == TargetPlatform.android ? 'האפליקציה באנדרואיד' : 'מכשיר';
}
