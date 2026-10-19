package app.hivecode.hq

import android.content.ComponentName
import android.content.Context
import android.service.quicksettings.TileService
import app.hivecode.notify.DemoData
import app.hivecode.notify.NotificationPoster
import app.hivecode.notify.WaitingCount
import app.hivecode.tiles.FocusTileService
import app.hivecode.tiles.NightTileService
import app.hivecode.widget.WaitingWidget
import java.util.concurrent.Executors

/**
 * One place that refreshes every native surface: fetch inbox, asks, board and toggles from hq
 * (or use the cache when offline), merge in the remaining demo items, then re-post notifications,
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

    private fun fetchIntoCache(app: Context) {
        val prefs = Prefs(app)
        val hq = HqClient.from(app) ?: return
        try {
            val inbox = hq.inboxJson()
            val asks = hq.asksJson()
            val board = hq.boardJson()
            val toggles = hq.togglesJson()
            prefs.inboxJson = inbox
            prefs.asksJson = asks
            prefs.boardJson = board
            prefs.togglesJson = toggles
        } catch (_: HqError) {
            // Offline or hq down: keep showing the last known picture.
        }
    }

    /** Cached hq data plus the demo items that were not answered yet. */
    fun snapshot(context: Context): Snapshot {
        val prefs = Prefs(context)
        val real = if (prefs.isConfigured) {
            Snapshot(
                items = prefs.inboxJson?.let { runCatching { HqJson.inbox(it) }.getOrNull() } ?: emptyList(),
                asks = prefs.asksJson?.let { runCatching { HqJson.asks(it) }.getOrNull() } ?: emptyMap(),
                identities = prefs.boardJson?.let { runCatching { HqJson.board(it) }.getOrNull() } ?: emptyMap(),
                quiet = prefs.togglesJson?.let { runCatching { HqJson.toggles(it) }.getOrNull() }
                    ?.let { it["focus"] == true || it["night"] == true } ?: false,
            )
        } else Snapshot.EMPTY
        val demoIds = prefs.demoRemaining
        if (demoIds.isEmpty()) return real
        val demo = DemoData.items(prefs.demoStartedAt.takeIf { it > 0 } ?: System.currentTimeMillis()).filter { it.id in demoIds }
        return real.copy(
            items = real.items + demo,
            asks = DemoData.asks + real.asks,
            identities = DemoData.identities + real.identities,
        )
    }

    private fun render(app: Context, snap: Snapshot) {
        NotificationPoster.post(app, snap)
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

    fun startDemo(context: Context) {
        val prefs = Prefs(context)
        prefs.demoStartedAt = System.currentTimeMillis()
        prefs.demoRemaining = DemoData.ALL_IDS
        // A fresh demo should ring and show every button again.
        prefs.dismissed = prefs.dismissed - DemoData.ALL_IDS
        prefs.alerted = prefs.alerted - DemoData.ALL_IDS
        prefs.snoozed = prefs.snoozed - DemoData.ALL_IDS
        refresh(context, fetch = false)
    }
}
