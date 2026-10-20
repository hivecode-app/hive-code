package app.hivecode.notify

import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.net.toUri
import app.hivecode.hq.HqClient
import app.hivecode.hq.HqSync
import app.hivecode.hq.Prefs
import kotlin.concurrent.thread

/**
 * Every notification button lands here. Runs without the Flutter engine: goAsync() keeps the
 * process alive while PendingSends counts down and calls hq on a background thread.
 */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_RUN, ACTION_REPLY -> run(context, intent)
            ACTION_CANCEL -> PendingSends.cancel(context, intent.getIntExtra(EXTRA_NOTIF, 0), goAsync())
            ACTION_RETRY -> {
                val call = ActionCall.fromJson(intent.getStringExtra(EXTRA_CALL) ?: return)
                if (lockedGo(context, call)) {
                    NotificationPoster.showState(context, call, UndoState.Failed(Wording.ERR_LOCKED))
                    return
                }
                PendingSends.retry(context, call, goAsync())
            }
            ACTION_FAILED_DISMISSED -> {
                // He swiped away "לא נשלח": nothing was sent and nothing is pending. The item stays in
                // "מחכה לך" like any dismissed notification.
                val itemId = intent.getLongExtra(EXTRA_ITEM, 0L)
                val prefs = Prefs(context)
                prefs.dismissed = prefs.dismissed + itemId
            }
            ACTION_DISMISSED -> {
                // Swiping away is not an answer (§5.3): the item stays in "מחכה לך", it just won't be re-posted.
                val ids = intent.getLongArrayExtra(EXTRA_ITEMS) ?: return
                val prefs = Prefs(context)
                prefs.dismissed = prefs.dismissed + ids.toSet()
            }
            ACTION_MARK_READ -> {
                // Read on hq, so every device clears it; the notification goes now, not after the round trip.
                val identity = intent.getStringExtra(EXTRA_IDENTITY) ?: return
                val app = context.applicationContext
                NotificationManagerCompat.from(app).cancel(intent.getIntExtra(EXTRA_NOTIF, 0))
                val async = goAsync()
                thread(name = "company-read") {
                    try { HqClient.from(app)?.markRead(identity) } catch (_: Exception) {}
                    HqSync.refresh(app, fetch = true) { async.finish() }
                }
            }
            ACTION_MSG_DISMISSED -> {
                // Swiping a message away is not reading it: the count stays, the notification stays down until a newer message.
                val identity = intent.getStringExtra(EXTRA_IDENTITY) ?: return
                val at = intent.getLongExtra(EXTRA_ALERT_AT, 0L)
                Prefs(context).updateMsgDismissed { it + (identity to at) }
            }
            ACTION_SNOOZE_END -> {
                val async = goAsync()
                HqSync.refresh(context, fetch = true) { async.finish() }
            }
        }
    }

    private fun run(context: Context, intent: Intent) {
        var call = ActionCall.fromJson(intent.getStringExtra(EXTRA_CALL) ?: return)
        // The reply PendingIntent is mutable (RemoteInput fills it in), so it may only ever carry a reply.
        val isReply = call.op == Op.REPLY_ASK || call.op == Op.REPLY_TELL
        if (isReply != (intent.action == ACTION_REPLY)) return
        if (lockedGo(context, call)) {
            // setAuthenticationRequired only exists from Android 12; this covers 8 to 11 and any
            // launcher that ignores the flag. Redraw so the buttons come back.
            HqSync.refresh(context, fetch = false)
            return
        }
        when (call.op) {
            Op.SNOOZE -> snooze(context, call)
            Op.REPLY_ASK, Op.REPLY_TELL -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(NotificationPoster.KEY_REPLY)?.toString()?.trim()
                if (text.isNullOrEmpty()) {
                    // Android keeps a spinner on the reply field until the notification is re-posted.
                    HqSync.refresh(context, fetch = false)
                    return
                }
                call = call.copy(answer = text)
                PendingSends.start(context, call, goAsync())
            }
            Op.OPEN -> Unit // OPEN buttons are activity intents, never broadcasts
            else -> PendingSends.start(context, call, goAsync())
        }
    }

    /** "לא עכשיו": ack on hq (he saw it), hide it, and bring it back in an hour. */
    private fun snooze(context: Context, call: ActionCall) {
        val app = context.applicationContext
        val async = goAsync()
        val until = System.currentTimeMillis() + SNOOZE_MS
        val prefs = Prefs(app)
        prefs.snoozed = prefs.snoozed + (call.itemId to until)
        NotificationManagerCompat.from(app).cancel(call.notifId)
        val am = app.getSystemService(AlarmManager::class.java)
        // Inexact is fine for "in an hour" and needs no exact-alarm permission.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, snoozeEndIntent(app, call.itemId))
        thread(name = "company-snooze") {
            try { HqClient.from(app)?.inboxAck(call.itemId) } catch (_: Exception) {}
            HqSync.refresh(app, fetch = false) { async.finish() }
        }
    }

    companion object {
        const val ACTION_RUN = "app.hivecode.action.RUN"
        const val ACTION_CANCEL = "app.hivecode.action.CANCEL"
        const val ACTION_RETRY = "app.hivecode.action.RETRY"
        const val ACTION_DISMISSED = "app.hivecode.action.DISMISSED"
        const val ACTION_SNOOZE_END = "app.hivecode.action.SNOOZE_END"
        const val ACTION_REPLY = "app.hivecode.action.REPLY"
        const val ACTION_FAILED_DISMISSED = "app.hivecode.action.FAILED_DISMISSED"
        const val ACTION_MARK_READ = "app.hivecode.action.MARK_READ"
        const val ACTION_MSG_DISMISSED = "app.hivecode.action.MSG_DISMISSED"
        private const val EXTRA_IDENTITY = "identity"
        private const val EXTRA_ALERT_AT = "alert_at"
        private const val EXTRA_ITEM = "item"

        /** GO is never sent from a locked screen (APP-SPEC §5.3). */
        private fun lockedGo(context: Context, call: ActionCall): Boolean =
            call.op == Op.GO && context.getSystemService(KeyguardManager::class.java)?.isDeviceLocked == true
        private const val EXTRA_CALL = "call"
        private const val EXTRA_NOTIF = "notif"
        private const val EXTRA_ITEMS = "items"
        const val SNOOZE_MS = 60 * 60_000L

        private fun base(context: Context, action: String, key: String) =
            Intent(context, ActionReceiver::class.java).setAction(action)
                // A unique data URI per button keeps PendingIntents (and their extras) apart.
                .setData("company://$action/$key".toUri())

        fun runIntent(context: Context, call: ActionCall, index: Int, mutable: Boolean): PendingIntent {
            val i = base(context, if (mutable) ACTION_REPLY else ACTION_RUN, "${call.notifId}/$index").putExtra(EXTRA_CALL, call.toJson())
            // RemoteInput needs a mutable PendingIntent so the system can attach the typed text.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getBroadcast(context, call.notifId * 4 + index, i, flags)
        }

        fun cancelIntent(context: Context, notifId: Int): PendingIntent = PendingIntent.getBroadcast(
            context, notifId, base(context, ACTION_CANCEL, "$notifId").putExtra(EXTRA_NOTIF, notifId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun retryIntent(context: Context, call: ActionCall): PendingIntent = PendingIntent.getBroadcast(
            context, call.notifId, base(context, ACTION_RETRY, "${call.notifId}").putExtra(EXTRA_CALL, call.toJson()),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun failedDismissedIntent(context: Context, call: ActionCall): PendingIntent = PendingIntent.getBroadcast(
            context, call.notifId, base(context, ACTION_FAILED_DISMISSED, "${call.notifId}").putExtra(EXTRA_ITEM, call.itemId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun dismissedIntent(context: Context, notifId: Int, itemIds: List<Long>): PendingIntent = PendingIntent.getBroadcast(
            context, notifId, base(context, ACTION_DISMISSED, "$notifId").putExtra(EXTRA_ITEMS, itemIds.toLongArray()),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun markReadIntent(context: Context, identityId: String, notifId: Int): PendingIntent = PendingIntent.getBroadcast(
            context, notifId, base(context, ACTION_MARK_READ, "$notifId").putExtra(EXTRA_IDENTITY, identityId).putExtra(EXTRA_NOTIF, notifId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        fun messageDismissedIntent(context: Context, identityId: String, notifId: Int, alertAt: Long): PendingIntent = PendingIntent.getBroadcast(
            context, notifId, base(context, ACTION_MSG_DISMISSED, "$notifId").putExtra(EXTRA_IDENTITY, identityId).putExtra(EXTRA_ALERT_AT, alertAt),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        /** One alarm per item, so a second "לא עכשיו" does not move the first one. */
        fun snoozeEndIntent(context: Context, itemId: Long): PendingIntent = PendingIntent.getBroadcast(
            context, itemId.toInt(), base(context, ACTION_SNOOZE_END, "$itemId"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
