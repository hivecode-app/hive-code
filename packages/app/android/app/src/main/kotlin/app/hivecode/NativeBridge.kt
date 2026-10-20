package app.hivecode

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.webkit.MimeTypeMap
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.net.toUri
import app.hivecode.hq.HqClient
import app.hivecode.hq.HqLinkService
import app.hivecode.hq.HqSync
import app.hivecode.hq.Prefs
import app.hivecode.update.AppUpdater
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import kotlin.concurrent.thread

/**
 * The `company/native` MethodChannel (Dart side: lib/native/native_bridge.dart).
 * Dart -> native: the methods in [onMethodCall]. Native -> Dart: "route" (a notification or
 * shortcut tap while the app runs), "shared" (a share into the app while it runs) and "update"
 * (progress of the in-app update, update/AppUpdater.kt).
 */
class NativeBridge(private val activity: Activity, messenger: BinaryMessenger) : MethodChannel.MethodCallHandler {
    private val channel = MethodChannel(messenger, CHANNEL).also { it.setMethodCallHandler(this) }
    private val main = Handler(Looper.getMainLooper())
    private var initialRoute: String? = null
    private var initialShare: Intent? = null
    private var permissionResult: MethodChannel.Result? = null
    private val passkeys by lazy { Passkeys(activity) }

    /** The intent the activity was created with: remembered until Dart asks for it. */
    fun takeLaunchIntent(intent: Intent?) {
        intent ?: return
        initialRoute = trustedRoute(intent)
        if (isShare(intent)) initialShare = intent
        ackIfAsked(intent)
    }

    /** A new intent while running: pushed to Dart as events. */
    fun onNewIntent(intent: Intent) {
        ackIfAsked(intent)
        trustedRoute(intent)?.let { channel.invokeMethod("route", it) }
        if (isShare(intent)) {
            thread(name = "company-share") {
                val payload = sharedPayload(activity, intent)
                main.post { channel.invokeMethod("shared", payload) }
            }
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val ctx = activity.applicationContext
        when (call.method) {
            "configure" -> {
                val base = call.argument<String>("baseUrl")?.trim().orEmpty()
                val token = call.argument<String>("token")?.trim().orEmpty()
                if (token.isEmpty() || !HqClient.isValidBaseUrl(base)) {
                    result.error("bad_config", "baseUrl must be an http(s) URL and token non-empty", null)
                    return
                }
                Prefs(ctx).configure(base, token)
                HqLinkService.start(ctx, reconnect = true)
                result.success(null)
            }
            "getConfig" -> {
                val p = Prefs(ctx)
                result.success(if (p.isConfigured) mapOf("baseUrl" to p.baseUrl, "token" to p.token) else null)
            }
            "clearConfig" -> {
                HqLinkService.stop(ctx)
                Prefs(ctx).clearConfig()
                ShortcutManagerCompat.removeAllDynamicShortcuts(ctx)
                HqSync.refresh(ctx, fetch = false)
                result.success(null)
            }
            "notificationsEnabled" -> result.success(NotificationManagerCompat.from(ctx).areNotificationsEnabled())
            "requestNotificationPermission" -> requestNotificationPermission(result)
            "openNotificationSettings" -> {
                val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                activity.startActivity(i)
                result.success(null)
            }
            "requestBatteryExemption" -> result.success(requestBatteryExemption())
            "getInitialRoute" -> {
                result.success(initialRoute)
                initialRoute = null
            }
            "getSharedPayload" -> {
                val intent = initialShare
                initialShare = null
                if (intent == null) {
                    result.success(null)
                } else {
                    thread(name = "company-share") {
                        val payload = sharedPayload(ctx, intent)
                        main.post { result.success(payload) }
                    }
                }
            }
            "setWaitingCount" -> {
                HqSync.setWaitingCount(ctx, call.argument<Int>("count") ?: 0)
                result.success(null)
            }
            // A tab handoff link (B.9): the phone page opens in the browser, as the bet6 spike had it.
            "openUrl" -> {
                val url = call.argument<String>("url").orEmpty()
                if (!url.startsWith("https://")) {
                    result.error("bad_url", "only https links", null)
                    return
                }
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
                    result.success(true)
                } catch (e: ActivityNotFoundException) {
                    result.success(false)
                }
            }
            // Pasting an image into the composer (Flutter's own paste knows only text).
            "clipboardHasImage" -> result.success(clipboardHasImage(ctx))
            "clipboardImage" -> {
                val uri = clipboardImageUri(ctx)
                if (uri == null) {
                    result.success(null)
                } else {
                    thread(name = "company-paste") {
                        val image = readImage(ctx, uri)
                        main.post { result.success(image) }
                    }
                }
            }
            // The in-app update (update/AppUpdater.kt).
            "appVersionCode" -> result.success(AppUpdater.versionCode(ctx))
            "canInstallPackages" -> result.success(AppUpdater.canInstall(ctx))
            "installUpdate" -> {
                val path = call.argument<String>("path").orEmpty()
                val sha256 = call.argument<String>("sha256").orEmpty()
                val bytes = call.argument<Number>("bytes")?.toLong() ?: 0L
                if (!path.startsWith("/api/app/apk/") || !Regex("^[0-9a-fA-F]{64}$").matches(sha256) || bytes <= 0) {
                    result.error("bad_update", "path, sha256 and bytes from /api/app/latest", null)
                    return
                }
                // Android asks once to let this app install apps; he comes back and taps again.
                if (!AppUpdater.canInstall(ctx)) {
                    AppUpdater.openInstallPermission(activity)
                    result.success("needs_permission")
                    return
                }
                val started = AppUpdater.start(activity, path, sha256, bytes) { ev -> main.post { channel.invokeMethod("update", ev) } }
                result.success(if (started) "started" else "busy")
            }
            "reopenUpdate" -> result.success(AppUpdater.reopen(activity))
            "cancelUpdate" -> {
                AppUpdater.cancel()
                result.success(null)
            }
            "passkeyCreate" -> passkeys.create(call.argument<String>("json").orEmpty(), result)
            "passkeyGet" -> passkeys.get(call.argument<String>("json").orEmpty(), result)
            else -> result.notImplemented()
        }
    }

    private fun requestNotificationPermission(result: MethodChannel.Result) {
        val ctx = activity.applicationContext
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) {
            result.success(NotificationManagerCompat.from(ctx).areNotificationsEnabled())
            return
        }
        permissionResult?.success(false)
        permissionResult = result
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
    }

    fun onPermissionResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != REQ_NOTIFICATIONS) return
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        permissionResult?.success(granted)
        permissionResult = null
        // Whatever was waiting while notifications were off can show now.
        if (granted) HqSync.refresh(activity.applicationContext, fetch = false)
    }

    /** True if already exempt. Otherwise opens the system dialog and returns false. */
    @SuppressLint("BatteryLife") // Sideloaded app that must hold a socket; the exemption is the point.
    private fun requestBatteryExemption(): Boolean {
        val pm = activity.getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(activity.packageName)) return true
        try {
            activity.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData("package:${activity.packageName}".toUri()),
            )
        } catch (_: ActivityNotFoundException) {
            activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        return false
    }

    /** Our own intents carry the nonce; anything else that starts this exported activity is a plain launch. */
    private fun trusted(intent: Intent): Boolean =
        intent.getStringExtra(MainActivity.EXTRA_NONCE) == Prefs(activity).nonce

    private fun trustedRoute(intent: Intent): String? =
        intent.getStringExtra(MainActivity.EXTRA_ROUTE)?.takeIf { trusted(intent) && it.startsWith("/") }

    private fun ackIfAsked(intent: Intent) {
        // Opening a notification is an acknowledgement (APP-SPEC §5.4).
        if (!trusted(intent)) return
        val id = intent.getLongExtra(MainActivity.EXTRA_ACK_ITEM, 0L)
        if (id <= 0) return
        intent.removeExtra(MainActivity.EXTRA_ACK_ITEM)
        val hq = HqClient.from(activity) ?: return
        thread(name = "company-ack") { runCatching { hq.inboxAck(id) } }
    }

    companion object {
        const val CHANNEL = "company/native"
        private const val REQ_NOTIFICATIONS = 7301

        fun isShare(intent: Intent) = intent.action == Intent.ACTION_SEND

        /**
         * {text?, imagePath?, identityId?}. The image is copied into the app cache, because the
         * content:// grant of the sharing app does not outlive this intent.
         */
        fun sharedPayload(context: Context, intent: Intent): Map<String, Any?> {
            val text = listOfNotNull(
                intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() },
                intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() },
            ).distinct().joinToString("\n").ifBlank { null }
            val uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            // Only another app's content:// URI: never file://, never our own provider (that would copy our private files).
            val foreign = uri != null && uri.scheme == "content" && uri.authority?.startsWith(context.packageName) == false
            val image = if (foreign && intent.type?.startsWith("image/") == true) copyToCache(context, uri) else null
            val identity = intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID)?.removePrefix("worker-")
            return mapOf("text" to text, "imagePath" to image, "identityId" to identity)
        }

        /**
         * Only the description: reading the clip itself makes Android 12+ show "pasted from your
         * clipboard" on every long press, even when he pastes nothing.
         */
        fun clipboardHasImage(context: Context): Boolean {
            val desc = context.getSystemService(ClipboardManager::class.java)?.primaryClipDescription ?: return false
            return desc.hasMimeType("image/*") && !desc.hasMimeType("text/*")
        }

        /** The first image on the clipboard, if another app put one there (same rule as a share). Read on paste only. */
        fun clipboardImageUri(context: Context): Uri? {
            val cm = context.getSystemService(ClipboardManager::class.java) ?: return null
            val clip = cm.primaryClip ?: return null
            if (clip.description.hasMimeType("text/plain") && clip.getItemAt(0)?.text?.isNotBlank() == true) return null
            for (i in 0 until clip.itemCount) {
                val uri = clip.getItemAt(i).uri ?: continue
                if (uri.scheme != "content" || uri.authority?.startsWith(context.packageName) != false) continue
                if (context.contentResolver.getType(uri)?.startsWith("image/") == true) return uri
            }
            return null
        }

        /** {bytes, mime, name} of an image, or null when it can't be read or is too big to send. */
        fun readImage(context: Context, uri: Uri): Map<String, Any?>? = try {
            val type = context.contentResolver.getType(uri) ?: "image/png"
            val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            if (bytes == null || bytes.isEmpty() || bytes.size > MAX_IMAGE_BYTES) null
            else mapOf("bytes" to bytes, "mime" to type, "name" to (uri.lastPathSegment ?: "image"))
        } catch (_: Exception) {
            null
        }

        /** hq's limit (packages/hq/src/uploads.ts). */
        private const val MAX_IMAGE_BYTES = 25 * 1024 * 1024

        private fun copyToCache(context: Context, uri: Uri): String? = try {
            val type = context.contentResolver.getType(uri)
            val ext = type?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) } ?: "jpg"
            val dir = File(context.cacheDir, "shared").apply { mkdirs() }
            val out = File(dir, "shared-${System.currentTimeMillis()}.$ext")
            context.contentResolver.openInputStream(uri)?.use { input -> out.outputStream().use { input.copyTo(it) } }
            out.takeIf { it.exists() && it.length() > 0 }?.absolutePath
        } catch (_: Exception) {
            null
        }
    }
}
