package app.hivecode.hq

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Native SharedPreferences, separate from Flutter's shared_preferences file, so the service,
 * receivers, widget and tiles have the hq config and the last inbox without starting Flutter.
 */
class Prefs(context: Context) {
    private val p: SharedPreferences =
        context.applicationContext.getSharedPreferences("company_native", Context.MODE_PRIVATE)

    val baseUrl: String? get() = p.getString(K_BASE, null)?.trimEnd('/')?.ifBlank { null }
    val token: String? get() = p.getString(K_TOKEN, null)?.ifBlank { null }
    val isConfigured: Boolean get() = baseUrl != null && token != null

    fun configure(baseUrl: String, token: String) = p.edit {
        // A different server means a different event log: start the cursor over.
        if (baseUrl.trimEnd('/') != this@Prefs.baseUrl) remove(K_SEQ)
        putString(K_BASE, baseUrl.trimEnd('/'))
        putString(K_TOKEN, token)
    }

    fun clearConfig() = p.edit {
        remove(K_BASE); remove(K_TOKEN); remove(K_SEQ)
        remove(K_INBOX); remove(K_ASKS); remove(K_BOARD); remove(K_TOGGLES)
    }

    /**
     * Random secret put into our own PendingIntents and shortcuts. MainActivity is exported (launcher,
     * share), so it honours route and ack extras only when they carry this nonce.
     */
    val nonce: String
        get() = p.getString(K_NONCE, null) ?: java.util.UUID.randomUUID().toString().also {
            p.edit(commit = true) { putString(K_NONCE, it) }
        }

    /** Last hq event seq seen, for `/ws?after=`. -1 = never connected. */
    var lastSeq: Long
        get() = p.getLong(K_SEQ, -1L)
        set(v) = p.edit { putLong(K_SEQ, v) }

    // Raw JSON of the last successful fetches. Parsed on read; the widget and tiles render from it.
    var inboxJson: String? by string(K_INBOX)
    var asksJson: String? by string(K_ASKS)
    var boardJson: String? by string(K_BOARD)
    var togglesJson: String? by string(K_TOGGLES)

    /** Demo item ids still waiting (negative). Empty = no demo running. */
    var demoRemaining: Set<Long>
        get() = longs(K_DEMO)
        set(v) = putLongs(K_DEMO, v)

    /** When the demo was started, so demo message times stay put across re-posts. */
    var demoStartedAt: Long
        get() = p.getLong(K_DEMO_AT, 0L)
        set(v) = p.edit { putLong(K_DEMO_AT, v) }

    /** Items the owner swiped away. Dismissing is not an answer, but we do not re-post them either. */
    var dismissed: Set<Long>
        get() = longs(K_DISMISSED)
        set(v) = putLongs(K_DISMISSED, v)

    /** Items that already made a sound once; later re-posts are silent. */
    var alerted: Set<Long>
        get() = longs(K_ALERTED)
        set(v) = putLongs(K_ALERTED, v)

    /** itemId -> epoch ms until which "לא עכשיו" hides it. */
    var snoozed: Map<Long, Long>
        get() = (p.getStringSet(K_SNOOZE, emptySet()) ?: emptySet()).mapNotNull {
            val (id, until) = it.split('=').takeIf { s -> s.size == 2 } ?: return@mapNotNull null
            (id.toLongOrNull() ?: return@mapNotNull null) to (until.toLongOrNull() ?: 0L)
        }.toMap()
        set(v) = p.edit { putStringSet(K_SNOOZE, v.map { "${it.key}=${it.value}" }.toSet()) }

    /** Notification ids currently posted per worker, so stale ones can be cancelled. */
    var postedNotifIds: Set<Int>
        get() = (p.getStringSet(K_POSTED, emptySet()) ?: emptySet()).mapNotNull { it.toIntOrNull() }.toSet()
        set(v) = p.edit { putStringSet(K_POSTED, v.map { it.toString() }.toSet()) }

    /** Widget view model, written on every refresh so onUpdate can render without the network. */
    var widgetCount: Int
        get() = p.getInt(K_W_COUNT, 0)
        set(v) = p.edit { putInt(K_W_COUNT, v) }
    var widgetTopName: String? by string(K_W_NAME)
    var widgetTopLine: String? by string(K_W_LINE)

    private fun longs(key: String): Set<Long> =
        (p.getStringSet(key, emptySet()) ?: emptySet()).mapNotNull { it.toLongOrNull() }.toSet()

    private fun putLongs(key: String, v: Set<Long>) = p.edit { putStringSet(key, v.map { it.toString() }.toSet()) }

    private fun string(key: String) = object : kotlin.properties.ReadWriteProperty<Any?, String?> {
        override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>) = p.getString(key, null)
        override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: String?) =
            p.edit { if (value == null) remove(key) else putString(key, value) }
    }

    private companion object {
        const val K_BASE = "base_url"
        const val K_TOKEN = "token"
        const val K_SEQ = "last_seq"
        const val K_NONCE = "intent_nonce"
        const val K_INBOX = "inbox_json"
        const val K_ASKS = "asks_json"
        const val K_BOARD = "board_json"
        const val K_TOGGLES = "toggles_json"
        const val K_DEMO = "demo_remaining"
        const val K_DEMO_AT = "demo_started_at"
        const val K_DISMISSED = "dismissed"
        const val K_ALERTED = "alerted"
        const val K_SNOOZE = "snoozed"
        const val K_POSTED = "posted_notif_ids"
        const val K_W_COUNT = "widget_count"
        const val K_W_NAME = "widget_top_name"
        const val K_W_LINE = "widget_top_line"
    }
}
