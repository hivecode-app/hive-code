package app.hivecode.hq

import android.content.ComponentName
import android.content.Context
import android.service.quicksettings.TileService
import app.hivecode.notify.MessagePoster
import app.hivecode.notify.NotificationPoster
import app.hivecode.notify.WaitingCount
import app.hivecode.tiles.FocusTileService
import app.hivecode.tiles.NightTileService
import app.hivecode.widget.WaitingWidget
import java.util.concurrent.Executors

/**
 * One place that refreshes every native surface: fetch inbox, asks, board and toggles from hq
 * (or use the cache when offline), then re-post notifications,
 * the widget and the tiles. Runs on its own single thread so refreshes never overlap.
 */
object HqSync {
    private val exec = Executors.newSingleThreadExecutor { r -> Thread(r, "company-sync") }

    fun refresh(context: Context, fetch: Boolean = true, done: (() -> Unit)? = null) {
        val app = context.applicationContext
        exec.execute {
            try {
                if (fetch) fetchIntoCache(app)
                render(app, snapshot(app))
            } catch (_: Exception) {
                // A broken payload must not take the service down; the next event refreshes again.
            } finally {
                done?.invoke()
            }
        }
    }

    /**
     * The same refresh, waited for (PushService, on FCM's own thread): true when hq answered, so what the phone shows
     * is what hq has. Within FCM's ~10 s for a high-priority message.
     */
    fun refreshBlocking(context: Context, timeoutMs: Long = 9_000): Boolean {
        val app = context.applicationContext
        return try {
            exec.submit<Boolean> {
                val ok = fetchIntoCache(app)
                try { render(app, snapshot(app)) } catch (_: Exception) {}
                ok
            }.get(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            false
        }
    }

    /** False when hq did not answer (the cache stays as it was). */
    private fun fetchIntoCache(app: Context): Boolean {
        val prefs = Prefs(app)
        val hq = HqClient.from(app) ?: return false
        try {
            val inbox = hq.inboxJson()
            val asks = hq.asksJson()
            val board = hq.boardJson()
            val toggles = hq.togglesJson()
            ServerWatch.healthy(app)
            prefs.inboxJson = inbox
            prefs.asksJson = asks
            prefs.boardJson = board
            prefs.togglesJson = toggles
        } catch (_: HqError) {
            // Offline or hq down: keep showing the last known picture.
            return false
        }
        try {
            prefs.conversationsJson = hq.conversationsJson()
        } catch (e: HqError) {
            // An hq from before conversations (404): messages just don't notify yet. Otherwise a message push was not
            // shown, so no ack: Telegram carries it.
            if (e.code != 404) return false
        }
        return true
    }

    /** The cached hq data. */
    fun snapshot(context: Context): Snapshot {
        val prefs = Prefs(context)
        return if (prefs.isConfigured) {
            Snapshot(
                items = prefs.inboxJson?.let { runCatching { HqJson.inbox(it) }.getOrNull() } ?: emptyList(),
                asks = prefs.asksJson?.let { runCatching { HqJson.asks(it) }.getOrNull() } ?: emptyMap(),
                identities = prefs.boardJson?.let { runCatching { HqJson.board(it) }.getOrNull() } ?: emptyMap(),
                quiet = prefs.togglesJson?.let { runCatching { HqJson.toggles(it) }.getOrNull() }
                    ?.let { it["focus"] == true || it["night"] == true } ?: false,
                convs = prefs.conversationsJson?.let { runCatching { HqJson.conversations(it) }.getOrNull() } ?: emptyList(),
            )
        } else Snapshot.EMPTY
    }

    private fun render(app: Context, snap: Snapshot) {
        NotificationPoster.post(app, snap)
        MessagePoster.post(app, snap)
        WaitingWidget.store(app, snap)
        WaitingWidget.updateAll(app)
        for (cls in listOf(FocusTileService::class.java, NightTileService::class.java)) {
            try { TileService.requestListeningState(app, ComponentName(app, cls)) } catch (_: Exception) {}
        }
    }

    /** Flutter's in-app counter is the truth for the badge while the app runs (§5.6). */
    fun setWaitingCount(context: Context, count: Int) {
        WaitingCount.flutter = count
        refresh(context, fetch = false)
    }
}
