package app.hivecode.hq

import org.json.JSONArray
import org.json.JSONObject

// Mirrors of the hq DTOs (packages/shared/src/index.ts on hq-phase1). Only the fields the
// notification surface reads; unknown fields are ignored so hq can grow without breaking us.

data class InboxItem(
    val id: Long,
    /** ask | go | login | delivery_failure | incident | escalation_note | shift_failure */
    val kind: String,
    val title: String,
    val body: String,
    val from: String?,
    /** urgent | normal | low */
    val urgency: String,
    val blocking: Boolean,
    /** For kind=ask: the ask id. */
    val ref: String?,
    val createdAt: Long,
    /** Local only (demo data): button label for GO, e.g. "GO לחזרה". hq items use plain "GO". */
    val goLabel: String? = null,
) {
    /** Demo items use negative ids so they can never collide with hq rows and never hit the network. */
    val isDemo: Boolean get() = id < 0
}

data class Ask(
    val id: String,
    val from: String,
    val question: String,
    val options: List<String>,
    val blocking: Boolean,
    /** open | answered | escalated | cancelled */
    val state: String,
)

data class Identity(
    val id: String,
    val name: String,
    val title: String,
    /** Material Symbols name of the team icon (org.yaml `symbol`, APP-SPEC §6.1). */
    val symbol: String,
    val team: String?,
    /** resident | ephemeral. Ephemeral workers get a dashed ring on the monogram. */
    val lifecycle: String,
    val shiftId: String?,
    val shiftLive: Boolean,
)

/** Everything the notification surface needs at one moment, real hq data plus remaining demo items. */
data class Snapshot(
    val items: List<InboxItem>,
    val asks: Map<String, Ask>,
    val identities: Map<String, Identity>,
    /** Focus or night is on: only an urgent production incident may alert (APP-SPEC §5.5). */
    val quiet: Boolean,
) {
    companion object {
        val EMPTY = Snapshot(emptyList(), emptyMap(), emptyMap(), false)
    }
}

/** The id hq uses for items it raises itself (no from_identity). */
const val SYSTEM_IDENTITY = "hq"

object HqJson {
    fun inbox(json: String): List<InboxItem> {
        val arr = JSONObject(json).optJSONArray("items") ?: return emptyList()
        return arr.objects().map { o ->
            InboxItem(
                id = o.getLong("id"),
                kind = o.optString("kind"),
                title = o.optString("title"),
                body = o.optString("body"),
                from = o.optStringOrNull("from_identity"),
                urgency = o.optString("urgency", "normal"),
                blocking = o.optBoolean("blocking"),
                ref = o.optStringOrNull("ref"),
                createdAt = o.optLong("created_at"),
            )
        }
    }

    fun asks(json: String): Map<String, Ask> {
        val arr = JSONObject(json).optJSONArray("asks") ?: return emptyMap()
        return arr.objects().map { o ->
            Ask(
                id = o.getString("id"),
                from = o.optString("from_identity"),
                question = o.optString("question"),
                options = o.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList(),
                blocking = o.optBoolean("blocking"),
                state = o.optString("state", "open"),
            )
        }.associateBy { it.id }
    }

    fun board(json: String): Map<String, Identity> {
        val arr = JSONObject(json).optJSONArray("identities") ?: return emptyMap()
        return arr.objects().map { o ->
            val shift = o.optJSONObject("shift")
            val shiftState = shift?.optString("state")
            Identity(
                id = o.getString("id"),
                name = o.optString("name").ifBlank { o.getString("id") },
                title = o.optString("title"),
                symbol = o.optString("symbol"),
                team = o.optStringOrNull("team"),
                lifecycle = o.optString("lifecycle", "resident"),
                shiftId = shift?.optStringOrNull("id"),
                shiftLive = shiftState == "live" || shiftState == "starting",
            )
        }.associateBy { it.id }
    }

    fun toggles(json: String): Map<String, Boolean> {
        val arr = JSONObject(json).optJSONArray("toggles") ?: return emptyMap()
        return arr.objects().associate { it.getString("key") to it.optBoolean("enabled") }
    }

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key) || !has(key)) null else optString(key).ifBlank { null }
}
