package app.hivecode.notify

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.net.toUri
import app.hivecode.BubbleActivity
import app.hivecode.MainActivity
import app.hivecode.R
import app.hivecode.hq.Identity
import app.hivecode.hq.InboxItem
import app.hivecode.hq.Prefs
import app.hivecode.hq.SYSTEM_IDENTITY
import app.hivecode.hq.Snapshot

/**
 * Turns a [Snapshot] into Android notifications: one MessagingStyle conversation per worker, all in
 * one group under the "N דברים מחכים לך" summary (APP-SPEC §5.3, §5.6). Idempotent: every refresh
 * re-posts the whole picture, silently unless an item is new.
 */
object NotificationPoster {
    const val GROUP = "company.waiting"
    const val SUMMARY_ID = 1
    const val SHARE_CATEGORY = "app.hivecode.category.WORKER"
    const val KEY_REPLY = "reply"

    fun notifId(identityId: String): Int = 1000 + (identityId.hashCode() and 0x7ffff)
    fun shortcutId(identityId: String) = "worker-$identityId"

    @SuppressLint("MissingPermission") // areNotificationsEnabled() is checked first.
    fun post(context: Context, snap: Snapshot) {
        Channels.ensure(context)
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        val prefs = Prefs(context)
        val now = System.currentTimeMillis()

        val openIds = snap.items.map { it.id }.toSet()
        val snoozed = prefs.snoozed.filter { it.value > now && it.key in openIds }
        prefs.snoozed = snoozed
        val dismissed = prefs.dismissed intersect openIds
        prefs.dismissed = dismissed
        val alerted = prefs.alerted intersect openIds

        val visible = snap.items.filter {
            ActionPlanner.pushWorthy(it.kind, it.urgency, it.blocking, snap.quiet) && it.id !in snoozed &&
                // A login handoff is worthless after its 10 minutes; it stays in the app, not in the shade.
                !(it.kind == "login" && Channels.handoffRemainingMs(it.createdAt, now) <= 0)
        }
        // Server order is already blocking first, then urgency, then age; groupBy keeps it.
        val byWorker = visible.groupBy { it.from ?: SYSTEM_IDENTITY }
            .filter { (_, items) -> items.any { it.id !in dismissed } }
        // Above three items only the summary makes a sound (§5.3).
        val many = byWorker.values.sumOf { it.size } > 3
        val anyNew = byWorker.values.flatten().any { it.id !in alerted }

        val posted = mutableSetOf<Int>()
        for ((wid, items) in byWorker) {
            val id = notifId(wid)
            posted += id
            if (PendingSends.isBusy(id)) continue // showing a countdown or a result; leave it alone
            val silent = many || items.none { it.id !in alerted }
            nm.notify(id, worker(context, identity(snap, wid), items, snap, silent))
        }
        for (stale in prefs.postedNotifIds - posted) if (!PendingSends.isBusy(stale)) nm.cancel(stale)
        prefs.postedNotifIds = posted
        prefs.alerted = alerted + visible.map { it.id }

        // One badge source (§5.6): the app's own counter while Flutter runs, else hq's open items.
        val count = WaitingCount.flutter ?: snap.items.size
        summary(context, count, byWorker.map { (wid, items) -> identity(snap, wid).name to messageText(items.first(), snap) },
            alert = many && anyNew)
    }

    /** The group summary carries the launcher badge number = waiting count. Never posted without a conversation under it. */
    @SuppressLint("MissingPermission")
    private fun summary(context: Context, count: Int, lines: List<Pair<String, String>>, alert: Boolean) {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        if (count <= 0 || lines.isEmpty()) {
            nm.cancel(SUMMARY_ID)
            return
        }
        Channels.ensure(context)
        val text = Wording.summary(count)
        val style = NotificationCompat.InboxStyle().setSummaryText(text)
        lines.take(5).forEach { (name, line) -> style.addLine("$name: $line") }
        val n = NotificationCompat.Builder(context, Channels.BLOCKING)
            .setSmallIcon(R.drawable.ic_ms_front_hand)
            .setContentTitle(text)
            .setContentText(lines.joinToString(" · ") { it.first })
            .setStyle(style)
            .setNumber(count)
            .setBadgeIconType(NotificationCompat.BADGE_ICON_SMALL)
            .setGroup(GROUP)
            .setGroupSummary(true)
            // An update is silent unless it brings a new item; then it may sound again.
            .setOnlyAlertOnce(!alert)
            .setSilent(!alert)
            .setContentIntent(openApp(context, "/", null))
            .build()
        nm.notify(SUMMARY_ID, n)
    }

    private fun identity(snap: Snapshot, wid: String): Identity = snap.identities[wid]
        ?: Identity(wid, if (wid == SYSTEM_IDENTITY) Wording.SYSTEM_NAME else wid, "", "", null, "resident", null, false)

    /** The text a notification, the summary and the widget show for [item], bidi-safe (Bidi.kt). */
    fun messageText(item: InboxItem, snap: Snapshot): String = Bidi.display(rawMessageText(item, snap))

    private fun rawMessageText(item: InboxItem, snap: Snapshot): String {
        if (item.kind == "ask") {
            val q = item.ref?.let { snap.asks[it]?.question } ?: listOf(item.title, item.body).filter { it.isNotBlank() }.joinToString(". ")
            return (if (item.blocking) Wording.BLOCKING_PREFIX else "") + q
        }
        if (item.kind == "incident") return item.body.ifBlank { item.title }
        return listOf(item.title.trimEnd('.'), item.body).filter { it.isNotBlank() }.joinToString(". ")
    }

    fun person(context: Context, who: Identity): Person = Person.Builder()
        .setName(who.name)
        .setKey(who.id)
        .setImportant(true)
        .setIcon(icon(context, who))
        .build()

    fun icon(context: Context, who: Identity): IconCompat =
        IconCompat.createWithBitmap(Monogram.bitmap(context, who.name, who.symbol, who.lifecycle == "ephemeral"))

    private fun worker(context: Context, who: Identity, items: List<InboxItem>, snap: Snapshot, silent: Boolean): android.app.Notification {
        val primary = items.first()
        val convTitle = Wording.conversationTitle(who.name, who.title)
        val channel = Channels.forKinds(items.map { it.kind to it.urgency })
        val person = person(context, who)
        val sid = shortcutId(who.id)
        pushShortcut(context, who, person, convTitle)

        val style = NotificationCompat.MessagingStyle(Person.Builder().setName(Wording.ME).build())
            .setConversationTitle(convTitle)
            .setGroupConversation(false)
        // The collapsed notification shows the last message, and the buttons act on `primary`:
        // so primary goes last, whatever its age, and the buttons always match the visible text.
        (items.drop(1).sortedBy { it.createdAt } + primary).forEach { style.addMessage(messageText(it, snap), it.createdAt, person) }

        val ask = primary.ref?.let { snap.asks[it] }
        val actions = ActionPlanner.plan(
            PlanInput(
                itemId = primary.id,
                kind = primary.kind,
                identityId = who.id,
                askOptions = if (primary.kind == "ask") ask?.options else null,
                body = primary.body,
                urgency = primary.urgency,
                hasLiveShift = who.shiftLive && who.shiftId != null,
                isSystem = who.id == SYSTEM_IDENTITY,
                goLabel = primary.goLabel,
            ),
        )
        val openRoute = if (primary.kind == "login") ActionPlanner.handoffRoute(primary.id) else ActionPlanner.chatRoute(who.id)
        val b = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_ms_front_hand)
            .setStyle(style)
            .setShortcutId(sid)
            .setLocusId(LocusIdCompat(sid))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(GROUP)
            .setWhen(primary.createdAt)
            .setShowWhen(true)
            .setOnlyAlertOnce(silent)
            .setSilent(silent)
            .setAutoCancel(true)
            .setContentIntent(openApp(context, openRoute, primary.id.takeIf { it > 0 }))
            .setDeleteIntent(dismissIntent(context, notifId(who.id), items.map { it.id }))
            .setBubbleMetadata(bubble(context, who, person))
        when (channel) {
            Channels.URGENT_PROD -> b.setSubText(Wording.SUBTEXT_URGENT)
            Channels.HANDOFF -> {
                b.setSubText(Wording.SUBTEXT_HANDOFF)
                val left = Channels.handoffRemainingMs(primary.createdAt, System.currentTimeMillis())
                if (left > 0) b.setTimeoutAfter(left)
            }
        }
        actions.forEachIndexed { i, a ->
            val call = ActionCall(
                op = a.op, label = a.label, notifId = notifId(who.id), itemId = primary.id, identityId = who.id,
                name = who.name, convTitle = convTitle, channel = channel, symbol = who.symbol,
                ephemeral = who.lifecycle == "ephemeral", askId = ask?.id, answer = a.answer,
                title = primary.title, body = primary.body,
            )
            b.addAction(action(context, a, call, i))
        }
        return b.build()
    }

    private fun action(context: Context, a: Action, call: ActionCall, index: Int): NotificationCompat.Action {
        if (a.op == Op.OPEN) {
            return NotificationCompat.Action.Builder(0, a.label, openApp(context, a.route ?: "/", call.itemId.takeIf { it > 0 }))
                .setShowsUserInterface(true).build()
        }
        val pi = ActionReceiver.runIntent(context, call, index, mutable = a.isInlineReply)
        val b = NotificationCompat.Action.Builder(0, a.label, pi)
        if (a.needsUnlock) b.setAuthenticationRequired(true)
        if (a.isInlineReply) {
            val ri = RemoteInput.Builder(KEY_REPLY).setLabel(a.label)
            if (a.choices.isNotEmpty()) ri.setChoices(a.choices.toTypedArray())
            b.addRemoteInput(ri.build())
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .setAllowGeneratedReplies(a.choices.isEmpty())
        } else {
            b.setShowsUserInterface(false)
        }
        return b.build()
    }

    /** Long-lived shortcut per worker: makes the notification a real Android conversation and a Direct Share target. */
    private fun pushShortcut(context: Context, who: Identity, person: Person, convTitle: String) {
        val sid = shortcutId(who.id)
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(MainActivity.EXTRA_ROUTE, ActionPlanner.chatRoute(who.id))
            .putExtra(MainActivity.EXTRA_NONCE, Prefs(context).nonce)
        val info = ShortcutInfoCompat.Builder(context, sid)
            .setShortLabel(who.name)
            .setLongLabel(convTitle)
            .setIcon(icon(context, who))
            .setPerson(person)
            .setLongLived(true)
            .setLocusId(LocusIdCompat(sid))
            .setCategories(setOf(SHARE_CATEGORY))
            .setIntent(intent)
            .build()
        try {
            ShortcutManagerCompat.pushDynamicShortcut(context, info)
        } catch (_: Exception) {
            // Rate-limited in the background on some devices; the notification still works without it.
        }
    }

    private fun bubble(context: Context, who: Identity, person: Person): NotificationCompat.BubbleMetadata? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        val intent = Intent(context, BubbleActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData("company://bubble/${who.id}".toUri())
            .putExtra(MainActivity.EXTRA_ROUTE, ActionPlanner.chatRoute(who.id))
            .putExtra(MainActivity.EXTRA_NONCE, Prefs(context).nonce)
        // Bubbles require a mutable PendingIntent (the system adds the task info).
        val pi = PendingIntent.getActivity(context, notifId(who.id), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        return NotificationCompat.BubbleMetadata.Builder(pi, person.icon ?: icon(context, who))
            .setDesiredHeight(640)
            .build()
    }

    fun openApp(context: Context, route: String, ackItemId: Long?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            // A distinct action per route keeps PendingIntents for different routes apart.
            .setAction("company.open:$route")
            .putExtra(MainActivity.EXTRA_ROUTE, route)
            .putExtra(MainActivity.EXTRA_NONCE, Prefs(context).nonce)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (ackItemId != null) intent.putExtra(MainActivity.EXTRA_ACK_ITEM, ackItemId)
        return PendingIntent.getActivity(context, route.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun dismissIntent(context: Context, notifId: Int, itemIds: List<Long>): PendingIntent =
        ActionReceiver.dismissedIntent(context, notifId, itemIds)

    // ── transient states of a one-tap send (UndoMachine) ───────────────────────

    @SuppressLint("MissingPermission")
    fun showState(context: Context, call: ActionCall, state: UndoState) {
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        val who = Identity(call.identityId, call.name, "", call.symbol, null,
            if (call.ephemeral) "ephemeral" else "resident", null, false)
        val b = NotificationCompat.Builder(context, call.channel)
            .setSmallIcon(R.drawable.ic_ms_front_hand)
            .setLargeIcon(Monogram.bitmap(context, who.name, who.symbol, call.ephemeral))
            .setShortcutId(shortcutId(call.identityId))
            .setGroup(GROUP)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp(context, ActionPlanner.chatRoute(call.identityId), null))
        when (state) {
            is UndoState.Counting -> b.setContentTitle(Wording.countdown(call.name, state.secondsLeft))
                .setContentText(call.subject)
                .setOngoing(true)
                .addAction(NotificationCompat.Action.Builder(0, Wording.CANCEL, ActionReceiver.cancelIntent(context, call.notifId)).build())
            UndoState.Sending -> b.setContentTitle(call.subject)
                .setContentText(Wording.SENDING)
                .setProgress(0, 0, true)
                .setOngoing(true)
            UndoState.Sent -> b.setContentTitle(Wording.sent(call.name, call.demo))
                .setContentText(call.subject)
                // Safety net if the process dies before PendingSends removes it.
                .setTimeoutAfter(UndoMachine.SENT_VISIBLE_MS + 1000)
            is UndoState.Failed -> b.setContentTitle(Wording.failed(state.reason))
                .setContentText(call.subject)
                .setStyle(NotificationCompat.BigTextStyle().setBigContentTitle(Wording.failed(state.reason)).bigText(call.subject))
                .setDeleteIntent(ActionReceiver.failedDismissedIntent(context, call))
                .addAction(
                    NotificationCompat.Action.Builder(0, Wording.RETRY, ActionReceiver.retryIntent(context, call))
                        // A retried GO is still a GO: same unlock rule as the first tap.
                        .setAuthenticationRequired(call.op == Op.GO)
                        .build(),
                )
            UndoState.Cancelled -> return
        }
        nm.notify(call.notifId, b.build())
    }
}
