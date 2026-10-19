package app.hivecode.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import app.hivecode.hq.HqClient
import app.hivecode.hq.HqError
import app.hivecode.hq.HqSync
import app.hivecode.hq.Prefs
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Process-wide driver of the 3-second undo. Each send lives inside the goAsync() window of the
 * broadcast that started it (background broadcasts get about a minute; we need at most
 * 3 s + the 8 s call timeout), so the process stays up for the countdown without a service.
 * "ביטול" is a second broadcast into the same process and finds the send here.
 *
 * A failed send is not kept here: its notification carries the whole [ActionCall], so
 * "ניסיון נוסף" rebuilds the send even after the process died, and a refresh may redraw it.
 */
object PendingSends {
    private class Pending(val call: ActionCall, val machine: UndoMachine, var async: BroadcastReceiver.PendingResult?, val isRetry: Boolean)

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val pending = HashMap<Int, Pending>() // touched on the main thread only
    private val busy = HashSet<Int>()

    /** Showing a countdown, a spinner or "נשלח": refreshes must not overwrite it. */
    @Synchronized fun isBusy(notifId: Int): Boolean = busy.contains(notifId)

    /** Start a send with the 3-second countdown (taps and typed replies alike). */
    fun start(context: Context, call: ActionCall, async: BroadcastReceiver.PendingResult?) =
        begin(context, withMsgId(call), async, immediate = false, isRetry = false)

    /** "ניסיון נוסף": he already decided once, so it goes out at once with the same msg_id. */
    fun retry(context: Context, call: ActionCall, async: BroadcastReceiver.PendingResult?) =
        begin(context, withMsgId(call), async, immediate = true, isRetry = true)

    fun cancel(context: Context, notifId: Int, async: BroadcastReceiver.PendingResult?) {
        val app = context.applicationContext
        main.post {
            val p = pending[notifId]
            if (p != null && p.machine.cancel()) end(app, p, sent = false)
            async?.finish()
        }
    }

    private fun begin(context: Context, call: ActionCall, async: BroadcastReceiver.PendingResult?, immediate: Boolean, isRetry: Boolean) {
        val app = context.applicationContext
        main.post {
            if (pending.containsKey(call.notifId)) { async?.finish(); return@post } // a second tap mid-send
            val p = Pending(call, UndoMachine(immediate = immediate), async, isRetry)
            pending[call.notifId] = p
            setBusy(call.notifId, true)
            NotificationPoster.showState(app, call, p.machine.state)
            if (p.machine.state == UndoState.Sending) send(app, p) else main.postDelayed({ tick(app, call.notifId) }, 1000)
        }
    }

    private fun tick(app: Context, notifId: Int) {
        val p = pending[notifId] ?: return
        if (p.machine.state !is UndoState.Counting) return
        val goNow = p.machine.tick()
        NotificationPoster.showState(app, p.call, p.machine.state)
        if (goNow) send(app, p) else main.postDelayed({ tick(app, notifId) }, 1000)
    }

    private fun send(app: Context, p: Pending) {
        io.execute {
            val error: String? = try {
                perform(app, p.call, p.isRetry)
                null
            } catch (e: HqError) {
                e.sentence
            } catch (_: Exception) {
                Wording.ERR_SERVER
            }
            main.post {
                p.machine.result(error == null, error)
                NotificationPoster.showState(app, p.call, p.machine.state)
                // Release the broadcast now; the 2-second "נשלח" is cosmetic and safe to lose.
                p.async?.finish(); p.async = null
                if (error == null) {
                    main.postDelayed({ end(app, p, sent = true) }, UndoMachine.SENT_VISIBLE_MS)
                } else {
                    // "לא נשלח" stays on screen, but nothing is held: no entry, no busy flag.
                    pending.remove(p.call.notifId)
                    setBusy(p.call.notifId, false)
                }
            }
        }
    }

    /** "נשלח" (after 2 s) or "ביטול": clear the send and redraw the worker's conversation. */
    private fun end(app: Context, p: Pending, sent: Boolean) {
        pending.remove(p.call.notifId)
        setBusy(p.call.notifId, false)
        p.async?.finish(); p.async = null
        if (sent) {
            NotificationManagerCompat.from(app).cancel(p.call.notifId)
            if (p.call.demo && resolvesItem(p.call.op)) {
                val prefs = Prefs(app)
                prefs.demoRemaining = prefs.demoRemaining - p.call.itemId
            }
        }
        // Sent on hq: fetch again (the item is resolved there now). Cancelled or demo: redraw from the cache.
        HqSync.refresh(app, fetch = sent && !p.call.demo)
    }

    private fun perform(app: Context, call: ActionCall, isRetry: Boolean) {
        if (call.demo) {
            Thread.sleep(600) // let the "שולח" state be seen, like a real round trip
            return
        }
        val hq = HqClient.from(app) ?: throw HqError(Wording.ERR_NOT_CONFIGURED)
        when (call.op) {
            Op.ANSWER, Op.REPLY_ASK -> try {
                hq.answerAsk(call.askId ?: throw HqError(Wording.ERR_GONE), call.answer.orEmpty())
            } catch (e: HqError) {
                // A retry after a timeout: the first attempt may have landed, and hq says "already answered".
                if (!(isRetry && e.code == 409)) throw e
            }
            Op.GO -> hq.inboxDone(call.itemId, note = "GO")
            Op.REPLY_TELL -> hq.tell(call.identityId, call.answer.orEmpty(), priority = "next", msgId = call.msgId)
            Op.STOP -> hq.interrupt(hq.liveShiftId(call.identityId) ?: throw HqError(Wording.ERR_NO_SHIFT))
            Op.HANDLED -> hq.inboxDone(call.itemId)
            Op.SNOOZE, Op.OPEN -> Unit
        }
    }

    private fun withMsgId(call: ActionCall) =
        if (call.op == Op.REPLY_TELL && call.msgId == null) call.copy(msgId = "app-${UUID.randomUUID()}") else call

    /** A reply to a worker or a stopped shift does not close the item; it keeps waiting. */
    private fun resolvesItem(op: Op) = op == Op.ANSWER || op == Op.REPLY_ASK || op == Op.GO || op == Op.HANDLED

    @Synchronized private fun setBusy(id: Int, b: Boolean) { if (b) busy.add(id) else busy.remove(id) }
}
