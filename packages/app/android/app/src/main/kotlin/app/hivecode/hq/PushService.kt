package app.hivecode.hq

/*
 * PushService: the push transport, through FCM (task 1474).
 *
 * Until 1474 the phone held a WebSocket to hq from a foreground service, and Android keeps a foreground service's
 * notification on screen ("מחובר לחברה"): it raises a MIN channel to LOW the first time one is shown on it. FCM
 * wakes the app instead, in every state (open, in the background, closed), with no permanent notification.
 *
 * A push carries no content he reads: it says "something changed" (an alert at high priority, a sync at normal). The app
 * fetches from hq over HTTPS and re-posts every surface itself (HqSync), exactly as it did on a socket event, so
 * grouping, muting and "read elsewhere" behave as before. Then it acks; hq counts a high push not acked in 2 minutes as
 * "the app is not connected" and sends Telegram. That is the backup for depending on Google to reach him: a push
 * Google drops, or one the phone gets but cannot act on (hq unreachable), still reaches him.
 */

import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.hivecode.R
import app.hivecode.notify.Channels
import app.hivecode.notify.NotificationPoster
import app.hivecode.notify.Wording
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.concurrent.Executors

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        PushRegistration.register(applicationContext, token)
    }

    /** On FCM's own background thread: it may block (within ~10 s for a high-priority message). */
    override fun onMessageReceived(message: RemoteMessage) {
        val app = applicationContext
        if (!Prefs(app).isConfigured) return
        // No ack when hq did not answer: then what he sees is not what hq has, and Telegram should go.
        if (!HqSync.refreshBlocking(app)) return
        val hq = HqClient.from(app) ?: return
        try { hq.fcmAck() } catch (_: HqError) {}
    }
}

/** Keeps hq holding this phone's current FCM token. */
object PushRegistration {
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "company-push") }

    /** hq may lose a token (a restore, a revoked device re-paired): say it again once a day even when it did not change. */
    private const val REFRESH_MS = 24 * 60 * 60_000L

    /** After configure, at boot and when the app comes to the front. Cheap when hq already has it. */
    fun sync(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        if (!Prefs(app).isConfigured) return
        try {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
                val p = Prefs(app)
                if (force || token != p.fcmRegistered || System.currentTimeMillis() - p.fcmRegisteredAt > REFRESH_MS) register(app, token)
            }
        } catch (_: Exception) {
            // No Firebase in this build (google-services.json missing): nothing to register.
        }
    }

    fun register(context: Context, token: String) {
        val app = context.applicationContext
        exec.execute {
            val hq = HqClient.from(app) ?: return@execute
            try {
                hq.registerFcm(token)
                Prefs(app).apply { fcmRegistered = token; fcmRegisteredAt = System.currentTimeMillis() }
            } catch (e: HqError) {
                if (e.code == 401 || e.code == 403) authFailed(app)
                // Otherwise offline or hq down: the next sync (front, boot, a day) tries again.
            }
        }
    }

    /** A rejected device token will not start working by retrying: say so once. Configuring again registers anew. */
    private fun authFailed(app: Context) {
        val n = NotificationCompat.Builder(app, Channels.DIGEST)
            .setSmallIcon(R.drawable.ic_ms_link)
            .setContentTitle("החיבור לחברה נעצר")
            .setContentText(Wording.ERR_AUTH)
            .setStyle(NotificationCompat.BigTextStyle().bigText(Wording.ERR_AUTH))
            .setContentIntent(NotificationPoster.openApp(app, "/", null))
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(app).notify(AUTH_NOTIF_ID, n) } catch (_: SecurityException) {}
    }

    private const val AUTH_NOTIF_ID = 3

    /** Disconnect from the app: hq stops pushing to this phone, and the token goes. */
    fun forget(context: Context) {
        val app = context.applicationContext
        val hq = HqClient.from(app)
        exec.execute {
            try { hq?.unregisterFcm() } catch (_: HqError) {}
            try { FirebaseMessaging.getInstance().deleteToken() } catch (_: Exception) {}
        }
    }
}
