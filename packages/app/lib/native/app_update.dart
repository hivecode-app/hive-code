import 'package:agent_company/l10n/ui_copy.dart';
// The in-app update on Android: hq says which APK is the newest (GET /api/app/latest,
// packages/hq/src/app-release.ts); when its versionCode is above ours, the system strip offers
// "עדכון", and one tap downloads it through hq and opens Android's installer (AppUpdater.kt).
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../data/backend_select.dart';
import '../data/error_report.dart';
import '../model/company_time.dart';
import 'native_bridge.dart';

/// One build on hq. [apkPath] is relative to hq's base URL.
@immutable
class AppRelease {
  const AppRelease({required this.versionCode, required this.versionName, required this.sha256, required this.bytes, required this.apkPath});

  final int versionCode;
  final String versionName;
  final String sha256;
  final int bytes;
  final String apkPath;

  /// The `latest` of /api/app/latest; null when hq has none or it is malformed.
  static AppRelease? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final code = raw['version_code'], sha = raw['sha256'], bytes = raw['bytes'], path = raw['apk_path'];
    if (code is! int || code <= 0 || sha is! String || !RegExp(r'^[0-9a-f]{64}$').hasMatch(sha)) return null;
    if (bytes is! int || bytes <= 0 || path is! String || !path.startsWith('/api/app/apk/')) return null;
    final name = raw['version_name'];
    return AppRelease(versionCode: code, versionName: name is String ? name : '', sha256: sha, bytes: bytes, apkPath: path);
  }
}

/// hq's newest release, with the signed-in device's address and token. Null when signed out,
/// offline, or hq has no release: the strip simply stays away.
Future<AppRelease?> fetchLatestRelease({http.Client? client}) async {
  final p = await SharedPreferences.getInstance();
  final url = (p.getString(kHqUrl) ?? '').trim(), token = (p.getString(kHqToken) ?? '').trim();
  if (url.isEmpty || token.isEmpty) return null;
  final c = client ?? http.Client();
  try {
    final r = await c.get(Uri.parse('$url/api/app/latest'), headers: {'authorization': 'Bearer $token'}).timeout(const Duration(seconds: 10));
    if (r.statusCode != 200) return null;
    return AppRelease.fromJson((jsonDecode(r.body) as Map)['latest']);
  } catch (_) {
    return null;
  } finally {
    if (client == null) c.close();
  }
}

enum UpdatePhase { none, available, needsPermission, downloading, installing, failed }

class AppUpdate extends ChangeNotifier {
  AppUpdate({Future<AppRelease?> Function()? fetch, NativeBridge? bridge, DateTime Function()? now})
      : _fetch = fetch ?? fetchLatestRelease,
        _bridge = bridge ?? NativeBridge.instance,
        _now = now ?? CompanyTime.now;

  final Future<AppRelease?> Function() _fetch;
  final NativeBridge _bridge;
  final DateTime Function() _now;
  StreamSubscription<Map<String, Object?>>? _sub;

  /// How often coming back to the app asks hq again.
  static const recheckAfter = Duration(minutes: 10);

  UpdatePhase phase = UpdatePhase.none;
  AppRelease? release;

  /// 0..1 while downloading.
  double progress = 0;

  int? _installed;
  int? _dismissed;
  DateTime? _checkedAt;

  bool get supported => _bridge.supported;

  void _set(UpdatePhase p) {
    phase = p;
    notifyListeners();
  }

  /// Asks hq (at most every [recheckAfter] unless [force]). Never interrupts a running update.
  Future<void> check({bool force = false}) async {
    if (!supported) return;
    _sub ??= _bridge.onUpdate.listen(_onEvent);
    final t = _now();
    if (!force && _checkedAt != null && t.difference(_checkedAt!) < recheckAfter) return;
    _checkedAt = t;
    _installed ??= await _bridge.appVersionCode();
    final r = await _fetch();
    if (phase == UpdatePhase.downloading || phase == UpdatePhase.installing) return;
    final installed = _installed;
    if (r == null || installed == null || r.versionCode <= installed || r.versionCode == _dismissed) {
      // Nothing newer (or he closed the strip for this version): only clear a strip that offered one.
      if (phase == UpdatePhase.available || phase == UpdatePhase.failed) _set(UpdatePhase.none);
      return;
    }
    release = r;
    if (phase != UpdatePhase.needsPermission) _set(UpdatePhase.available);
  }

  /// Back in the app: after the "install unknown apps" page, carry on by itself if he allowed it;
  /// if he left Android's install dialog (or it never opened), bring it back.
  Future<void> resumed() async {
    if (phase == UpdatePhase.installing) {
      final r = await _bridge.reopenUpdate();
      if (r != 'shown' && r != 'waiting' && phase == UpdatePhase.installing) _set(UpdatePhase.available);
      return;
    }
    if (phase == UpdatePhase.needsPermission) {
      if (await _bridge.canInstallPackages()) {
        await install();
      }
      return;
    }
    await check();
  }

  Future<void> install() async {
    final r = release;
    if (r == null || phase == UpdatePhase.downloading) return;
    progress = 0;
    _set(UpdatePhase.downloading);
    final res = await _bridge.installUpdate(path: r.apkPath, sha256: r.sha256, bytes: r.bytes);
    switch (res) {
      case 'started' || 'busy':
        break;
      case 'needs_permission':
        _set(UpdatePhase.needsPermission);
      default:
        _failed('$res');
    }
  }

  /// "העדכון לא הצליח." is shown, and so sent to hq (error_report.dart).
  void _failed(String why) {
    reportShown('screen', UiCopy.text(961, [why]), screen: UiCopy.text(962));
    _set(UpdatePhase.failed);
  }

  Future<void> cancel() => _bridge.cancelUpdate();

  /// "לא עכשיו": hidden until a newer version, or the next time the app starts.
  void dismiss() {
    _dismissed = release?.versionCode;
    _set(UpdatePhase.none);
  }

  void _onEvent(Map<String, Object?> e) {
    switch (e['state']) {
      case 'downloading':
        final got = e['received'], total = e['total'];
        if (got is int && total is int && total > 0) progress = (got / total).clamp(0, 1).toDouble();
        _set(UpdatePhase.downloading);
      case 'installing':
        _set(UpdatePhase.installing);
      case 'cancelled' || 'aborted':
        _set(UpdatePhase.available);
      case 'failed':
        _failed('${e['error'] ?? 'failed'}');
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
