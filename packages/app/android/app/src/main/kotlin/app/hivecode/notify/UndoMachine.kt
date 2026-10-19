package app.hivecode.notify

sealed class UndoState {
    /** "יישלח לדנה בעוד N שנ'" with a single "ביטול". */
    data class Counting(val secondsLeft: Int) : UndoState()
    /** The request is in flight. */
    object Sending : UndoState()
    /** "נשלח לדנה", removed after 2 seconds. */
    object Sent : UndoState()
    /** "לא נשלח · <reason>" with "ניסיון נוסף". Stays until retried or dismissed. */
    data class Failed(val reason: String) : UndoState()
    /** The owner tapped "ביטול": nothing was sent, the original notification comes back. */
    object Cancelled : UndoState()
}

/**
 * The 3-second undo of APP-SPEC §5.3 as a plain state machine. [PendingSends] drives it with a
 * Handler, one tick per second; this class only decides transitions, so it is unit tested.
 * Immediate sends (inline replies, retries) start at [UndoState.Sending].
 */
class UndoMachine(seconds: Int = DEFAULT_SECONDS, immediate: Boolean = false) {
    var state: UndoState = if (immediate || seconds <= 0) UndoState.Sending else UndoState.Counting(seconds)
        private set

    /** One second passed. Returns true when the request should go out now. */
    fun tick(): Boolean {
        val s = state as? UndoState.Counting ?: return false
        state = if (s.secondsLeft <= 1) UndoState.Sending else UndoState.Counting(s.secondsLeft - 1)
        return state == UndoState.Sending
    }

    /** Only possible while counting down; once the request left, it cannot be called back. */
    fun cancel(): Boolean {
        if (state !is UndoState.Counting) return false
        state = UndoState.Cancelled
        return true
    }

    fun result(ok: Boolean, reason: String? = null) {
        if (state != UndoState.Sending) return
        state = if (ok) UndoState.Sent else UndoState.Failed(reason ?: Wording.ERR_SERVER)
    }

    /** "ניסיון נוסף": the owner already decided once, so the retry goes out without a countdown. */
    fun retry(): Boolean {
        if (state !is UndoState.Failed) return false
        state = UndoState.Sending
        return true
    }

    val isFinished: Boolean get() = state == UndoState.Sent || state == UndoState.Cancelled

    companion object {
        const val DEFAULT_SECONDS = 3
        const val SENT_VISIBLE_MS = 2000L
    }
}
