package app.hivecode

import android.app.Activity
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import io.flutter.plugin.common.MethodChannel

/**
 * Passkeys through Credential Manager (#23). JSON in (hq's WebAuthn options), JSON out (the
 * response hq verifies), so the app never handles key material. The origin hq sees is
 * `android:apk-key-hash:<release cert sha256>`, and app.hq.example.com serves
 * `.well-known/assetlinks.json` for this package (deploy/caddy/assetlinks.json).
 * Error codes for Dart: cancelled, exists (already on this device), none (no passkey here), unsupported, failed.
 */
class Passkeys(private val activity: Activity) {
    private val cm = CredentialManager.create(activity)
    private val executor = ContextCompat.getMainExecutor(activity)

    fun create(json: String, result: MethodChannel.Result) {
        cm.createCredentialAsync(activity, CreatePublicKeyCredentialRequest(json), CancellationSignal(), executor,
            object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
                override fun onResult(result0: CreateCredentialResponse) {
                    val r = result0 as? CreatePublicKeyCredentialResponse
                    if (r == null) result.error("failed", "unexpected response", null) else result.success(r.registrationResponseJson)
                }
                override fun onError(e: CreateCredentialException) {
                    val code = when {
                        e is CreateCredentialCancellationException -> "cancelled"
                        e is CreatePublicKeyCredentialDomException && e.domError.type.contains("InvalidStateError") -> "exists"
                        e is CreateCredentialNoCreateOptionException -> "unsupported"
                        else -> "failed"
                    }
                    result.error(code, e.message, null)
                }
            })
    }

    fun get(json: String, result: MethodChannel.Result) {
        val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(json)))
        cm.getCredentialAsync(activity, request, CancellationSignal(), executor,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result0: GetCredentialResponse) {
                    val c = result0.credential as? PublicKeyCredential
                    if (c == null) result.error("failed", "unexpected credential", null) else result.success(c.authenticationResponseJson)
                }
                override fun onError(e: GetCredentialException) {
                    val code = when (e) {
                        is GetCredentialCancellationException -> "cancelled"
                        is NoCredentialException -> "none"
                        else -> "failed"
                    }
                    result.error(code, e.message, null)
                }
            })
    }
}
