import 'package:agent_company/native/native_bridge.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final bridge = NativeBridge.instance;
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final calls = <MethodCall>[];

  void mockNative(Object? Function(MethodCall call) handler) {
    messenger.setMockMethodCallHandler(NativeBridge.channel, (call) async {
      calls.add(call);
      return handler(call);
    });
  }

  /// Simulates the Kotlin side invoking a method on Dart.
  Future<void> fromNative(String method, Object? args) async {
    await messenger.handlePlatformMessage(
      NativeBridge.channel.name,
      NativeBridge.channel.codec.encodeMethodCall(MethodCall(method, args)),
      (_) {},
    );
  }

  setUp(() {
    calls.clear();
    NativeBridge.debugSupportedOverride = true;
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(NativeBridge.channel, null);
    NativeBridge.debugSupportedOverride = null;
  });

  test('configure passes base URL and token', () async {
    mockNative((_) => null);
    await bridge.configure(baseUrl: 'https://app.hq.example.com/s3cret/hq', token: 't0k');
    expect(calls.single.method, 'configure');
    expect(calls.single.arguments, {'baseUrl': 'https://app.hq.example.com/s3cret/hq', 'token': 't0k'});
  });

  test('booleans and counts round-trip', () async {
    mockNative((call) => switch (call.method) {
          'notificationsEnabled' => false,
          'requestNotificationPermission' => true,
          'requestBatteryExemption' => false,
          'showDemoNotifications' => true,
          _ => null,
        });
    expect(await bridge.notificationsEnabled(), isFalse);
    expect(await bridge.requestNotificationPermission(), isTrue);
    expect(await bridge.requestBatteryExemption(), isFalse);
    expect(await bridge.showDemoNotifications(), isTrue);
    await bridge.setWaitingCount(4);
    expect(calls.last.method, 'setWaitingCount');
    expect(calls.last.arguments, {'count': 4});
  });

  test('initial route and shared payload', () async {
    mockNative((call) => switch (call.method) {
          'getInitialRoute' => '/chat/dana',
          'getSharedPayload' => {'text': 'שלום', 'imagePath': null, 'identityId': 'dana'},
          _ => null,
        });
    expect(await bridge.getInitialRoute(), '/chat/dana');
    expect(await bridge.getSharedPayload(), const SharedPayload(text: 'שלום', identityId: 'dana'));
  });

  test('getConfig maps the native config', () async {
    mockNative((_) => {'baseUrl': 'https://h/s/hq', 'token': 'gateway'});
    final c = await bridge.getConfig();
    expect(c?.baseUrl, 'https://h/s/hq');
    expect(c?.token, 'gateway');
    mockNative((_) => null);
    expect(await bridge.getConfig(), isNull);
  });

  test('empty shared payload is null', () async {
    mockNative((_) => {'text': null, 'imagePath': null, 'identityId': null});
    expect(await bridge.getSharedPayload(), isNull);
  });

  test('native events reach the streams', () async {
    mockNative((_) => null);
    final routes = <String>[];
    final shared = <SharedPayload>[];
    final s1 = bridge.routeStream.listen(routes.add);
    final s2 = bridge.onShared.listen(shared.add);
    await fromNative('route', '/handoff/17');
    await fromNative('shared', {'text': null, 'imagePath': '/cache/shared/a.jpg', 'identityId': null});
    await Future<void>.delayed(Duration.zero);
    expect(routes, ['/handoff/17']);
    expect(shared, [const SharedPayload(imagePath: '/cache/shared/a.jpg')]);
    await s1.cancel();
    await s2.cancel();
  });

  test('missing native side is a no-op', () async {
    // No mock handler: the channel throws MissingPluginException, which the bridge swallows.
    expect(await bridge.getInitialRoute(), isNull);
    expect(await bridge.notificationsEnabled(), isFalse);
    await bridge.setWaitingCount(1);
  });

  test('unsupported platform never touches the channel', () async {
    NativeBridge.debugSupportedOverride = false;
    mockNative((_) => throw StateError('must not be called'));
    await bridge.configure(baseUrl: 'https://x', token: 'y');
    expect(await bridge.notificationsEnabled(), isTrue);
    expect(await bridge.requestBatteryExemption(), isTrue);
    expect(await bridge.showDemoNotifications(), isFalse);
    expect(calls, isEmpty);
  });
}
