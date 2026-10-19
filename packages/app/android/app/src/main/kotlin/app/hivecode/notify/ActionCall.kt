package app.hivecode.notify

import org.json.JSONObject

/**
 * Everything a BroadcastReceiver needs to perform one notification button and redraw the
 * notification afterwards, without the Flutter engine and without re-reading hq first.
 * Travels as a JSON string extra on the action PendingIntent.
 */
data class ActionCall(
    val op: Op,
    val label: String,
    val notifId: Int,
    val itemId: Long,
    val identityId: String,
    val name: String,
    val convTitle: String,
    val channel: String,
    val symbol: String,
    val ephemeral: Boolean,
    val askId: String? = null,
    /** ANSWER: the option; REPLY_*: filled in from RemoteInput when the broadcast arrives. */
    val answer: String? = null,
    /** The item title, for the countdown text ([ActionPlanner.subject]). */
    val title: String = "",
    val body: String = "",
    /** Idempotency key for a tell, created once when the send starts and reused by "ניסיון נוסף". */
    val msgId: String? = null,
) {
    val demo: Boolean get() = itemId < 0

    /** What the countdown and result lines show: "GO לפרודקשן: לומו 1.1.20", the option, the typed text. */
    val subject: String get() = ActionPlanner.subject(op, label, answer, title, body)

    fun toJson(): String = JSONObject()
        .put("op", op.name).put("label", label).put("notifId", notifId).put("itemId", itemId)
        .put("identityId", identityId).put("name", name).put("convTitle", convTitle).put("channel", channel)
        .put("symbol", symbol).put("ephemeral", ephemeral).put("title", title).put("body", body)
        .apply {
            askId?.let { put("askId", it) }
            answer?.let { put("answer", it) }
            msgId?.let { put("msgId", it) }
        }
        .toString()

    companion object {
        fun fromJson(s: String): ActionCall {
            val o = JSONObject(s)
            fun opt(key: String) = if (o.has(key)) o.getString(key) else null
            return ActionCall(
                op = Op.valueOf(o.getString("op")),
                label = o.getString("label"),
                notifId = o.getInt("notifId"),
                itemId = o.getLong("itemId"),
                identityId = o.getString("identityId"),
                name = o.getString("name"),
                convTitle = o.optString("convTitle"),
                channel = o.optString("channel", Channels.BLOCKING),
                symbol = o.optString("symbol"),
                ephemeral = o.optBoolean("ephemeral"),
                askId = opt("askId"),
                answer = opt("answer"),
                title = o.optString("title"),
                body = o.optString("body"),
                msgId = opt("msgId"),
            )
        }
    }
}
