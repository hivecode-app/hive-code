// Passkeys on this platform (#23): the browser's WebAuthn on the web (web/passkey.js), Credential
// Manager on Android (Passkeys.kt). Both take hq's options JSON and return the response JSON that
// hq verifies. Anywhere else (tests, desktop) there are none, and the device pairs with a code.
import 'passkey_io.dart' if (dart.library.js_interop) 'passkey_web.dart' as impl;

/// Why a passkey call didn't produce a credential.
enum PasskeyError {
  /// He closed the prompt.
  cancelled,

  /// This authenticator already holds a passkey for the company (registration).
  exists,

  /// No passkey for the company on this device (login).
  none,

  /// No passkey support here.
  unsupported,
  failed,
}

class PasskeyResult {
  const PasskeyResult.ok(String this.json) : error = null;
  const PasskeyResult.fail(PasskeyError this.error) : json = null;
  final String? json;
  final PasskeyError? error;
}

abstract class Passkeys {
  bool get supported;
  Future<PasskeyResult> create(String optionsJson);
  Future<PasskeyResult> get(String optionsJson);

  /// This platform's passkeys. Tests replace it.
  static Passkeys instance = impl.platformPasskeys();
}
