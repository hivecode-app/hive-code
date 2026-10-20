package app.hivecode.update

import android.app.Activity
import android.app.ActivityManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.IntentCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.net.toUri
import app.hivecode.hq.HqClient
import okhttp3.Call
import java.io.InputStream
import java.io.OutputStream
import java.lang.ref.WeakReference
import java.security.MessageDigest
import kotlin.concurrent.thread

/**
 * The in-app update (hq: packages/hq/src/app-release.ts). Dart sees a newer version_code on
 * GET /api/app/latest and calls [start] with its apk_path. The APK streams from hq straight into
 * a PackageInstaller session, its size and sha256 are checked, and only then is the session
 * committed; Android shows its own install confirmation and replaces the app.
 *
 * Events to Dart (NativeBridge "update"): {state: downloading, received, total}, {state: installing},
 * {state: cancelled}, {state: aborted} (he closed Android's dialog), {state: failed, reason}.
 */
object AppUpdater {
    private const val TAG = "AppUpdater"

    /** The bridge that started the current update: gets the events, and hosts Android's dialog. */
    @Volatile private var listener: ((Map<String, Any?>) -> Unit)? = null
    @Volatile private var host: WeakReference<Activity>? = null
    @Volatile private var call: Call? = null
    @Volatile private var cancelled = false
    /** A download is running. After the commit it is Android's dialog, and a new tap may start over. */
    @Volatile private var busy = false
    /** Committed, and Android has not answered yet. */
    @Volatile private var awaiting = false
    /** Android's confirm dialog for [liveSession]. Shown once: from the foreground at once, otherwise
     *  (Android does not open it from the background) by [reopen] when he comes back. */
    @Volatile private var confirm: Intent? = null
    @Volatile private var shown = false
    @Volatile private var liveSession = -1

    fun versionCode(context: Context): Long =
        PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))

    /** "Install unknown apps" for this app, which Android asks for once. */
    fun canInstall(context: Context): Boolean = context.packageManager.canRequestPackageInstalls()

    fun openInstallPermission(activity: Activity) {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${activity.packageName}".toUri()))
    }

    /** False when an update is already running. */
    @Synchronized
    fun start(activity: Activity, path: String, sha256: String, bytes: Long, onEvent: (Map<String, Any?>) -> Unit): Boolean {
        if (busy) return false
        busy = true
        cancelled = false
        awaiting = false
        confirm = null
        shown = false
        // Before the old sessions are abandoned below: their "aborted" answers must not count.
        liveSession = -1
        listener = onEvent
        host = WeakReference(activity)
        val ctx = activity.applicationContext
        thread(name = "company-update") { run(ctx, path, sha256.lowercase(), bytes) }
        return true
    }

    fun cancel() {
        cancelled = true
        call?.cancel()
    }

    private fun emit(event: Map<String, Any?>) {
        listener?.invoke(event)
    }

    private fun run(ctx: Context, path: String, sha256: String, bytes: Long) {
        val installer = ctx.packageManager.packageInstaller
        var sessionId = -1
        var committed = false
        try {
            val c = HqClient.from(ctx)?.download(path) ?: throw UpdateFailure("not_configured")
            call = c
            c.execute().use { res ->
                if (!res.isSuccessful) throw UpdateFailure("download")
                val body = res.body ?: throw UpdateFailure("download")
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(ctx.packageName)
                    setSize(bytes)
                    // Once this app installed itself, Android 12+ may update it without asking again
                    // (needs UPDATE_PACKAGES_WITHOUT_USER_ACTION in the manifest).
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
                // A session an earlier tap left waiting for Android's dialog: this one replaces it.
                installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } }
                sessionId = installer.createSession(params)
                liveSession = sessionId
                installer.openSession(sessionId).use { session ->
                    session.openWrite("base.apk", 0, bytes).use { out ->
                        ApkStream.copyVerified(body.byteStream(), out, bytes, sha256, { cancelled }) { received ->
                            emit(mapOf("state" to "downloading", "received" to received, "total" to bytes))
                        }
                        session.fsync(out)
                    }
                    if (cancelled) throw UpdateCancelled()
                    emit(mapOf("state" to "installing"))
                    val intent = Intent(ctx, UpdateReceiver::class.java).setPackage(ctx.packageName)
                    // Mutable: the installer adds the status extras to it.
                    val pi = PendingIntent.getBroadcast(ctx, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                    awaiting = true
                    session.commit(pi.intentSender)
                    committed = true
                }
            }
        } catch (e: UpdateFailure) {
            awaiting = false
            emit(mapOf("state" to "failed", "reason" to e.reason))
        } catch (e: Exception) {
            awaiting = false
            // A cancel closes the socket under the read: that is a cancel, not a failure.
            if (cancelled) emit(mapOf("state" to "cancelled"))
            else {
                Log.w(TAG, "update failed", e)
                emit(mapOf("state" to "failed", "reason" to "download"))
            }
        } finally {
            call = null
            busy = false
            if (sessionId >= 0 && !committed) runCatching { installer.abandonSession(sessionId) }
        }
    }

    /**
     * Back in the app while Dart still shows "installing": "shown" (the dialog Android would not
     * open from the background is open now), "waiting" (the session is still with Android: the
     * dialog is up, or he tapped it and the install runs), or "none" (no install pending).
     * The dialog is never opened twice: resuming right after he taps it must not bring it back.
     */
    fun reopen(activity: Activity): String {
        if (awaiting) return "waiting"
        val c = confirm ?: return "none"
        if (!shown) {
            host = WeakReference(activity)
            shown = show(activity, c)
            return if (shown) "shown" else "none"
        }
        if (activity.packageManager.packageInstaller.getSessionInfo(liveSession) != null) return "waiting"
        confirm = null
        return "none"
    }

    private fun show(ctx: Context, c: Intent): Boolean = runCatching {
        val a = host?.get()
        if (a != null && !a.isFinishing) a.startActivity(Intent(c))
        else ctx.startActivity(Intent(c).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.isSuccess

    private fun foreground(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    /** From [UpdateReceiver]: what Android did with the committed session. */
    internal fun onStatus(ctx: Context, intent: Intent) {
        // A late answer about a session a newer tap replaced: not about this install.
        if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != liveSession) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        awaiting = false
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) confirm = null
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val c = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                if (c == null) {
                    emit(mapOf("state" to "failed", "reason" to "install"))
                    return
                }
                confirm = c
                // From the background Android silently refuses: then it opens on his return (reopen).
                shown = foreground() && show(ctx, c)
            }
            // The new version replaces this process; nothing to tell.
            PackageInstaller.STATUS_SUCCESS -> Unit
            PackageInstaller.STATUS_FAILURE_ABORTED -> emit(mapOf("state" to "aborted"))
            else -> {
                Log.w(TAG, "install failed: $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                emit(mapOf("state" to "failed", "reason" to "install"))
            }
        }
    }
}

/** Not exported: only our own PendingIntent (handed to PackageInstaller) reaches it. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = AppUpdater.onStatus(context, intent)
}

class UpdateFailure(val reason: String) : Exception(reason)
class UpdateCancelled : Exception("cancelled")

/** The download loop, apart from Android so a JVM test can run it. */
object ApkStream {
    /**
     * Copies exactly [bytes] bytes, reporting progress at most once per percent, and throws
     * [UpdateFailure] ("integrity") when the size or sha256 differ from what hq announced.
     */
    fun copyVerified(input: InputStream, out: OutputStream, bytes: Long, sha256: String, cancelled: () -> Boolean, progress: (Long) -> Unit) {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        var received = 0L
        var lastPct = -1L
        while (true) {
            if (cancelled()) throw UpdateCancelled()
            val n = input.read(buf)
            if (n < 0) break
            received += n
            if (received > bytes) throw UpdateFailure("integrity")
            md.update(buf, 0, n)
            out.write(buf, 0, n)
            val pct = received * 100 / bytes
            if (pct != lastPct) {
                lastPct = pct
                progress(received)
            }
        }
        val hex = md.digest().joinToString("") { "%02x".format(it) }
        if (received != bytes || hex != sha256) throw UpdateFailure("integrity")
    }
}
