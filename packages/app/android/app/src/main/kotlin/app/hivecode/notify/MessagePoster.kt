package app.hivecode.notify

import android.annotation.SuppressLint
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import app.hivecode.R
import app.hivecode.hq.Identity
import app.hivecode.hq.Prefs
import app.hivecode.hq.Snapshot

/**
 * A worker's message to him, as in WhatsApp: one MessagingStyle notification per conversation with its unread
 * messages, on the "הודעות" channel, apart from the "מחכה לך" group. A tap opens the conversation; reading it
 * on any device clears it here (conv.read → refresh). The number on it is the conversation's unread count,
 * which launchers that sum notification numbers add to the badge.
 */
object MessagePoster {
    const val GROUP = "company.messages"

    fun notifId(identityId: String): Int = 3_000_000 + (identityId.hashCode() and 0x7ffff)

    @SuppressLint("MissingPermission") // areNotificationsEnabled() is checked first.
    fun post(context: Context, snap: Snapshot) {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        Channels.ensure(context)
        val prefs = Prefs(context)
        // Forget a swipe once its conversation is read or has a newer alert: the map stays small.
        prefs.updateMsgDismissed { d -> d.filter { (id, at) -> snap.convs.any { it.identity == id && (it.alertAt ?: 0) <= at && it.readAt < at } } }
        val (show, alerted) = MessagePlan.plan(snap.convs, prefs.msgAlerted, prefs.msgDismissed)
        val posted = mutableSetOf<Int>()
        for (n in show) {
            val id = notifId(n.conv.identity)
            posted += id
            nm.notify(id, build(context, n, snap))
        }
        for (stale in prefs.postedMsgIds - posted) nm.cancel(stale)
        prefs.postedMsgIds = posted
        prefs.msgAlerted = alerted
    }

    private fun build(context: Context, n: MessageNotif, snap: Snapshot): android.app.Notification {
        val c = n.conv
        val who = snap.identities[c.identity] ?: Identity(c.identity, c.title.substringBefore(" · "), "", "", null, "resident", null, false)
        val person = NotificationPoster.person(context, who)
        val sid = NotificationPoster.shortcutId(c.identity)
        NotificationPoster.pushShortcut(context, who, person, c.title)
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName(Wording.ME).build())
            .setConversationTitle(c.title)
            .setGroupConversation(false)
        c.recent.forEach { style.addMessage(Bidi.display(it.body), it.createdAt, person) }
        return NotificationCompat.Builder(context, Channels.MESSAGES)
            .setSmallIcon(R.drawable.ic_ms_front_hand)
            .setStyle(style)
            .setShortcutId(sid)
            .setLocusId(LocusIdCompat(sid))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(GROUP)
            .setNumber(c.unread)
            .setWhen(c.recent.last().createdAt)
            .setShowWhen(true)
            .setOnlyAlertOnce(n.silent)
            .setSilent(n.silent)
            .setAutoCancel(true)
            .setContentIntent(NotificationPoster.openApp(context, ActionPlanner.chatRoute(c.identity), null))
            .setDeleteIntent(ActionReceiver.messageDismissedIntent(context, c.identity, notifId(c.identity), c.alertAt ?: 0L))
            .addAction(NotificationCompat.Action.Builder(0, Wording.MARK_READ, ActionReceiver.markReadIntent(context, c.identity, notifId(c.identity)))
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
                .setShowsUserInterface(false)
                .build())
            .build()
    }
}
