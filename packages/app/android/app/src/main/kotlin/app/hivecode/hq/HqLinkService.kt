package app.hivecode.hq

/*
 * HqLinkService: the push transport, self-hosted.
 *
 * The phone keeps one WebSocket to hq (`/ws?after=<seq>`) open from a foreground service on the
 * "service" channel (APP-SPEC §5.2, minimal importance). On every inbox, ask or conversation event it
 * refetches /api/inbox, /api/asks, /api/board and /api/conversations and re-posts the notifications itself. No Firebase: there is
 * no project for it and the company should not depend on Google to reach its owner.
 *
 * The alternative is UnifiedPush through an ntfy server on hq-host: no permanent connection held
 * by this app, Doze-friendly delivery. We did not start there because UnifiedPush needs a separate
 * distributor app installed and kept alive on the phone (ntfy's Android app), which is one more
 * moving part that can silently break. hq only has to POST to ntfy to add it later; this service
 * would then stop holding the socket and just refresh on each push.
 */

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.hivecode.R
import app.hivecode.notify.Channels
import app.hivecode.notify.NotificationPoster
import app.hivecode.notify.Wording
import androidx.core.app.NotificationManagerCompat
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class HqLinkService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var connected = false
    private var attempt = 0
    private var live = false
    private var inForeground = false
    private var netCallback: ConnectivityManager.NetworkCallback? = null
    private val refreshSoon = Runnable { HqSync.refresh(this) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Channels.ensure(this)
        inForeground = goForeground(connected = false)
        if (!inForeground) return
        // Reconnect as soon as a network comes back instead of waiting out the backoff.
        val cm = getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post { if (!connected) { attempt = 0; connectNow() } }
            }
        }
        try { cm.registerDefaultNetworkCallback(cb); netCallback = cb } catch (_: Exception) {}
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!inForeground || !Prefs(this).isConfigured) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_RECONNECT) {
            // New base URL or token: drop the old socket and its cursor.
            socket?.cancel()
            socket = null
            connected = false
        }
        if (socket == null) connectNow()
        HqSync.refresh(this)
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        socket?.close(1000, null)
        socket = null
        netCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        super.onDestroy()
    }

    private fun connectNow() {
        main.removeCallbacks(reconnect)
        val client = HqClient.from(this) ?: run { stopSelf(); return }
        socket?.cancel()
        live = false
        val req = client.wsRequest(Prefs(this).lastSeq) ?: run { stopSelf(); return }
        socket = HqClient.ws.newWebSocket(req, listener)
    }

    private val reconnect = Runnable { connectNow() }

    /** 1, 2, 4 … 60 seconds. */
    private fun scheduleReconnect() {
        connected = false
        goForeground(connected = false)
        val delay = minOf(60_000L, 1000L shl minOf(attempt, 6))
        attempt++
        main.removeCallbacks(reconnect)
        main.postDelayed(reconnect, delay)
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            main.post {
                if (webSocket !== socket) return@post
                connected = true
                ServerWatch.healthy(this@HqLinkService)
                attempt = 0
                goForeground(connected = true)
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val e = try { JSONObject(text) } catch (_: Exception) { return }
            val type = e.optString("type")
            val seq = e.optLong("seq", 0)
            main.post {
                if (webSocket !== socket) return@post
                // seq 0 = live-only deltas (streaming text); they are never replayed, so not a cursor.
                if (seq > 0) Prefs(this@HqLinkService).lastSeq = seq
                when {
                    // End of replay: whatever happened while we were away, one refresh covers it.
                    type == "live" -> { live = true; refreshDebounced() }
                    // Inbox and asks change what is shown; toggles change what may alert; shifts change "עצירה";
                    // conv.* is a worker's message that may alert, or one read or muted on any device.
                    live && (type.startsWith("inbox.") || type.startsWith("ask.") || type == "toggle.changed" ||
                        type == "shift.state" || type.startsWith("conv.")) -> refreshDebounced()
                }
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            main.post { if (webSocket === socket) { socket = null; scheduleReconnect() } }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val code = response?.code ?: 0
            main.post {
                if (webSocket !== socket) return@post
                socket = null
                if (code == 401 || code == 403) authFailed() else scheduleReconnect()
            }
        }
    }

    /** A burst of events (an answer resolves an ask and an inbox item) becomes one refresh. */
    private fun refreshDebounced() {
        main.removeCallbacks(refreshSoon)
        main.postDelayed(refreshSoon, 400)
    }

    /**
     * A rejected token will not start working by retrying every minute: say so once and stop.
     * Configuring again from the app (bridge configure) starts the service anew.
     */
    private fun authFailed() {
        val n = NotificationCompat.Builder(this, Channels.DIGEST)
            .setSmallIcon(R.drawable.ic_ms_link)
            .setContentTitle("החיבור לחברה נעצר")
            .setContentText(Wording.ERR_AUTH)
            .setStyle(NotificationCompat.BigTextStyle().bigText(Wording.ERR_AUTH))
            .setContentIntent(NotificationPoster.openApp(this, "/", null))
            .setAutoCancel(true)
            .build()
        try { NotificationManagerCompat.from(this).notify(AUTH_NOTIF_ID, n) } catch (_: SecurityException) {}
        stopSelf()
    }

    /** False when Android refused the foreground start (background-start limits); then the service stops. */
    private fun goForeground(connected: Boolean): Boolean {
        val n: Notification = NotificationCompat.Builder(this, Channels.SERVICE)
            .setSmallIcon(R.drawable.ic_ms_link)
            .setContentTitle(if (connected) "מחובר לחברה" else "מתחבר לחברה")
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(NotificationPoster.openApp(this, "/", null))
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else 0
        return try {
            ServiceCompat.startForeground(this, SERVICE_NOTIF_ID, n, type)
            true
        } catch (_: Exception) {
            stopSelf()
            false
        }
    }

    companion object {
        private const val SERVICE_NOTIF_ID = 2
        private const val AUTH_NOTIF_ID = 3
        private const val ACTION_RECONNECT = "app.hivecode.action.RECONNECT"

        fun start(context: Context, reconnect: Boolean = false) {
            if (!Prefs(context).isConfigured) return
            val i = Intent(context, HqLinkService::class.java)
            if (reconnect) i.action = ACTION_RECONNECT
            try {
                ContextCompat.startForegroundService(context, i)
            } catch (_: Exception) {
                // Android 12+ refuses a background start without an exemption; boot, the app
                // and the battery exemption all qualify, so the next of those starts it.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, HqLinkService::class.java))
        }
    }
}
