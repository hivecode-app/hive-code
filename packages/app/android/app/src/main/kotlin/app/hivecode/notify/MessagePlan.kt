package app.hivecode.notify

import app.hivecode.hq.ConvState

/** One message notification to show: the conversation, and whether it may make a sound now. */
data class MessageNotif(val conv: ConvState, val silent: Boolean)

/**
 * Which conversations get a message notification (pure, unit tested). hq already decided which messages may
 * alert (not muted, not open on a screen, not focus or night) and moved `alertAt`; a conversation shows while
 * that alert is unread. It sounds once per new alert: [alerted] remembers the alertAt that already did. One he
 * swiped away stays away until a newer alert: [dismissed] is the alertAt it had then.
 */
object MessagePlan {
    fun plan(convs: List<ConvState>, alerted: Map<String, Long>, dismissed: Map<String, Long> = emptyMap()): Pair<List<MessageNotif>, Map<String, Long>> {
        val show = convs.filter { c ->
            val at = c.alertAt
            at != null && at > c.readAt && c.unread > 0 && c.mutedUntil == null && c.recent.isNotEmpty() &&
                at > (dismissed[c.identity] ?: Long.MIN_VALUE)
        }
        val out = show.map { c -> MessageNotif(c, silent = (alerted[c.identity] ?: Long.MIN_VALUE) >= c.alertAt!!) }
        // Only the shown ones are remembered: read or muted ones drop out, and the map stays small.
        return out to show.associate { it.identity to it.alertAt!! }
    }
}
