package app.hivecode.tiles

import android.graphics.drawable.Icon
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.hivecode.R
import app.hivecode.hq.HqClient
import app.hivecode.hq.HqJson
import app.hivecode.hq.HqSync
import app.hivecode.hq.Prefs
import kotlin.concurrent.thread

/**
 * Quick Settings tile for one hq toggle (PUT /api/toggles/:key). Shows the last known state at
 * once, refreshes it from hq in the background, and flips it optimistically on tap.
 */
abstract class ToggleTileService(private val key: String, private val label: Int, private val icon: Int) : TileService() {
    private val main = Handler(Looper.getMainLooper())

    /** Last state shown, so a tap flips what he sees without parsing on the main thread. */
    @Volatile private var shown: Boolean? = null

    override fun onStartListening() {
        super.onStartListening()
        render(shown, null)
        thread(name = "company-tile") {
            // Parsing and the network both stay off the main thread; any failure keeps the old state.
            try {
                val c = cached()
                main.post { render(c, null) }
                val hq = HqClient.from(this) ?: return@thread
                val json = hq.togglesJson()
                Prefs(this).togglesJson = json
                val v = HqJson.toggles(json)[key]
                main.post { render(v, null) }
            } catch (_: Exception) {
            }
        }
    }

    override fun onClick() {
        super.onClick()
        if (!Prefs(this).isConfigured) return
        val current = shown ?: false
        val next = !current
        render(next, null)
        thread(name = "company-tile") {
            try {
                val hq = HqClient.from(this) ?: return@thread
                val json = hq.setToggle(key, next)
                Prefs(this).togglesJson = json
                val v = HqJson.toggles(json)[key] ?: next
                main.post { render(v, null) }
                // Focus and night change which items may alert; redraw notifications with it.
                HqSync.refresh(this, fetch = false)
            } catch (_: Exception) {
                main.post { render(current, "לא נשמר") }
            }
        }
    }

    private fun cached(): Boolean? =
        Prefs(this).togglesJson?.let { runCatching { HqJson.toggles(it)[key] }.getOrNull() }

    private fun render(enabled: Boolean?, error: String?) {
        shown = enabled
        val tile = qsTile ?: return
        tile.label = getString(label)
        tile.icon = Icon.createWithResource(this, icon)
        val configured = Prefs(this).isConfigured
        tile.state = when {
            !configured -> Tile.STATE_UNAVAILABLE
            enabled == true -> Tile.STATE_ACTIVE
            else -> Tile.STATE_INACTIVE
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = when {
                !configured -> "לא מחובר"
                error != null -> error
                enabled == true -> "פועל"
                else -> "כבוי"
            }
        }
        tile.updateTile()
    }
}

class FocusTileService : ToggleTileService("focus", R.string.tile_focus, R.drawable.ic_ms_do_not_disturb_on)

class NightTileService : ToggleTileService("night", R.string.tile_night, R.drawable.ic_ms_nights_stay)
