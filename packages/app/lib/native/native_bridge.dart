// The Dart side of the Android-native surface (MethodChannel `company/native`, implemented in
// android/app/src/main/kotlin/.../NativeBridge.kt): notifications, the hq link service, share
// target, widget badge. On web and desktop every method is a safe no-op with a neutral result.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// What another app shared into this one. [identityId] is set when the owner picked a worker
/// directly in the Android share sheet (Direct Share); otherwise the UI shows a worker picker.
@immutable
class SharedPayload {
  const SharedPayload({this.text, this.imagePath, this.identityId});

  final String? text;

  /// A copy in the app cache (the sharing app's grant does not outlive the intent).
  final String? imagePath;
  final String? identityId;

  bool get isEmpty => (text == null || text!.isEmpty) && imagePath == null;

  static SharedPayload? fromMap(Object? raw) {
    if (raw is! Map) return null;
    final p = SharedPayload(
      text: raw['text'] as String?,
      imagePath: raw['imagePath'] as String?,
      identityId: raw['identityId'] as String?,
    );
    return p.isEmpty ? null : p;
  }

  @override
  bool operator ==(Object other) =>
      other is SharedPayload && other.text == text && other.imagePath == imagePath && other.identityId == identityId;

  @override
  int get hashCode => Object.hash(text, imagePath, identityId);

  @override
  String toString() => 'SharedPayload(text: $text, imagePath: $imagePath, identityId: $identityId)';
}

/// Routes the native side can ask the app to open (from a notification, shortcut or bubble):
/// `/` (home), `/chat/<identityId>`, `/handoff/<inboxItemId>`.
class NativeBridge {
  NativeBridge._();

  static final NativeBridge instance = NativeBridge._();

  static const MethodChannel channel = MethodChannel('company/native');

  /// Only Android has the native side. Tests can force it on.
  @visibleForTesting
  static bool? debugSupportedOverride;

  bool get supported => debugSupportedOverride ?? (!kIsWeb && defaultTargetPlatform == TargetPlatform.android);

  final StreamController<String> _routes = StreamController<String>.broadcast();
  final StreamController<SharedPayload> _shared = StreamController<SharedPayload>.broadcast();
  bool _listening = false;

  void _listen() {
    if (_listening || !supported) return;
    _listening = true;
    channel.setMethodCallHandler((call) async {
      switch (call.method) {
        case 'route':
          final route = call.arguments as String?;
          if (route != null && route.isNotEmpty) _routes.add(route);
        case 'shared':
          final p = SharedPayload.fromMap(call.arguments);
          if (p != null) _shared.add(p);
      }
      return null;
    });
  }

  /// A route to open while the app is already running (notification, shortcut tap).
  Stream<String> get routeStream {
    _listen();
    return _routes.stream;
  }

  /// Something shared into the app while it is running.
  Stream<SharedPayload> get onShared {
    _listen();
    return _shared.stream;
  }

  Future<T?> _call<T>(String method, [Map<String, Object?>? args]) async {
    if (!supported) return null;
    _listen();
    try {
      return await channel.invokeMethod<T>(method, args);
    } on MissingPluginException {
      return null;
    }
  }

  /// Stores the hq base URL (e.g. `https://app.hq.example.com/<secret>/hq`) and token in native
  /// storage and (re)starts the background link, so notifications work without the app open.
  Future<void> configure({required String baseUrl, required String token}) =>
      _call<void>('configure', {'baseUrl': baseUrl, 'token': token});

  /// What the native side is configured with, or null when it is not configured.
  Future<({String baseUrl, String token})?> getConfig() async {
    final raw = await _call<Object>('getConfig');
    if (raw is! Map) return null;
    final url = raw['baseUrl'], token = raw['token'];
    if (url is! String || token is! String) return null;
    return (baseUrl: url, token: token);
  }

  /// Opens an https link in the browser (a tab handoff, B.9). False when nothing could open it.
  Future<bool> openUrl(String url) async => await _call<bool>('openUrl', {'url': url}) ?? false;

  /// Forgets the hq config, stops the link and removes hq notifications.
  Future<void> clearConfig() => _call<void>('clearConfig');

  /// Android 13+ runtime prompt. Returns whether notifications are now allowed.
  Future<bool> requestNotificationPermission() async => await _call<bool>('requestNotificationPermission') ?? false;

  /// For the "ההתראות כבויות" strip. True off-Android so the strip never shows there.
  Future<bool> notificationsEnabled() async => await _call<bool>('notificationsEnabled') ?? !supported;

  /// Opens the system notification settings of the app (after a permanent "don't allow").
  Future<void> openNotificationSettings() => _call<void>('openNotificationSettings');

  /// True if the app is already exempt from battery optimization; otherwise opens the system
  /// dialog and returns false (check again on resume).
  Future<bool> requestBatteryExemption() async => await _call<bool>('requestBatteryExemption') ?? !supported;

  /// The route the app was launched with, once; null for a plain launch.
  Future<String?> getInitialRoute() => _call<String>('getInitialRoute');

  /// What was shared when the app was launched by a share, once; null otherwise.
  Future<SharedPayload?> getSharedPayload() async => SharedPayload.fromMap(await _call<Object>('getSharedPayload'));

  /// The in-app waiting counter is the source of truth for the launcher badge (APP-SPEC §5.6).
  Future<void> setWaitingCount(int count) => _call<void>('setWaitingCount', {'count': count});
}
