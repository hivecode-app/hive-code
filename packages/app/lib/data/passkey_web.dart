// Web: the browser's WebAuthn through web/passkey.js.
import 'dart:convert';
import 'dart:js_interop';

import 'passkey.dart';

@JS('companyPasskey')
external _Api? get _api;

extension type _Api(JSObject _) implements JSObject {
  external bool get supported;
  external JSPromise<JSString> create(JSString json);
  external JSPromise<JSString> get(JSString json);
}

Passkeys platformPasskeys() => _WebPasskeys();

class _WebPasskeys implements Passkeys {
  @override
  bool get supported => _api?.supported ?? false;

  Future<PasskeyResult> _run(JSPromise<JSString> Function(_Api) f) async {
    final api = _api;
    if (api == null || !api.supported) return const PasskeyResult.fail(PasskeyError.unsupported);
    final out = (await f(api).toDart).toDart;
    final v = jsonDecode(out);
    if (v is Map && v['error'] != null) {
      return PasskeyResult.fail(switch (v['error']) {
        'NotAllowedError' || 'AbortError' => PasskeyError.cancelled,
        'InvalidStateError' => PasskeyError.exists,
        'NotSupportedError' || 'SecurityError' => PasskeyError.unsupported,
        _ => PasskeyError.failed,
      });
    }
    return PasskeyResult.ok(out);
  }

  @override
  Future<PasskeyResult> create(String optionsJson) => _run((a) => a.create(optionsJson.toJS));
  @override
  Future<PasskeyResult> get(String optionsJson) => _run((a) => a.get(optionsJson.toJS));
}
