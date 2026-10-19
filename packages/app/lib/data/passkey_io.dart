// Android: Credential Manager through the `company/native` channel (Passkeys.kt).
import 'package:flutter/services.dart';

import '../native/native_bridge.dart';
import 'passkey.dart';

Passkeys platformPasskeys() => _AndroidPasskeys();

class _AndroidPasskeys implements Passkeys {
  @override
  bool get supported => NativeBridge.instance.supported;

  Future<PasskeyResult> _call(String method, String json) async {
    if (!supported) return const PasskeyResult.fail(PasskeyError.unsupported);
    try {
      final r = await NativeBridge.channel.invokeMethod<String>(method, {'json': json});
      return r == null ? const PasskeyResult.fail(PasskeyError.failed) : PasskeyResult.ok(r);
    } on PlatformException catch (e) {
      return PasskeyResult.fail(PasskeyError.values.where((v) => v.name == e.code).firstOrNull ?? PasskeyError.failed);
    } on MissingPluginException {
      return const PasskeyResult.fail(PasskeyError.unsupported);
    }
  }

  @override
  Future<PasskeyResult> create(String optionsJson) => _call('passkeyCreate', optionsJson);
  @override
  Future<PasskeyResult> get(String optionsJson) => _call('passkeyGet', optionsJson);
}
