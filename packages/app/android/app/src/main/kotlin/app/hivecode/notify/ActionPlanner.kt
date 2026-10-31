package app.hivecode.notify

/** What a notification button does. Network ops go to hq; local ops only touch the device. */
enum class Op {
    /** POST /api/asks/:id/answer with a fixed option. One tap, 3-second undo. */
    ANSWER,
    /** POST /api/inbox/:id/done note=GO. One tap, 3-second undo, device must be unlocked. */
    GO,
    /** Inline reply to an ask: POST /api/asks/:id/answer with the typed text. Sent immediately. */
    REPLY_ASK,
    /** Inline reply as a message: POST /api/messages/tell priority=next. Sent immediately. */
    REPLY_TELL,
    /** POST /api/shifts/:id/interrupt. One tap, 3-second undo. */
    STOP,
    /** POST /api/inbox/:id/done. One tap, 3-second undo. */
    HANDLED,
    /** POST /api/inbox/:id/ack, hide, show again in an hour. Not an answer. */
    SNOOZE,
    /** Opens the app at [Action.route]. */
    OPEN,
}

data class Action(
    val op: Op,
    val label: String,
    /** ANSWER: the option text sent as the answer. */
    val answer: String? = null,
    /** OPEN: the Flutter route to open. */
    val route: String? = null,
    /** REPLY_*: smart-reply chips offered above the keyboard. */
    val choices: List<String> = emptyList(),
) {
    val isInlineReply: Boolean get() = op == Op.REPLY_ASK || op == Op.REPLY_TELL

    /**
     * Every answer gets the 3-second undo, typed or tapped (APP-SPEC §5.3: "תשובה מתוך ההתראה
     * מחכה 3 שניות כמו בכל מקום"). Only "לא עכשיו" and "פתיחה" are not answers.
     */
    val hasUndo: Boolean get() = op != Op.SNOOZE && op != Op.OPEN

    /** GO must not be approvable from a locked screen (setAuthenticationRequired, Android 12+). */
    val needsUnlock: Boolean get() = op == Op.GO
}

/** The facts about one inbox item that decide its buttons. Kept free of Android types for tests. */
data class PlanInput(
    val itemId: Long,
    val kind: String,
    val identityId: String,
    /** Options of the linked ask; null when the item is not an ask or the ask is gone. */
    val askOptions: List<String>?,
    val body: String,
    val urgency: String,
    /** Whether the sender has a live shift that "עצירה" could interrupt. */
    val hasLiveShift: Boolean,
    val isSystem: Boolean,
    val goLabel: String? = null,
)

object ActionPlanner {
    /** Android shows at most three actions on a notification. */
    const val MAX_ACTIONS = 3

    fun chatRoute(identityId: String) = "/chat/$identityId"
    fun handoffRoute(itemId: Long) = "/handoff/$itemId"
    /** The item itself in the stack of what waits on him, not the worker's chat (task 986). */
    fun waitRoute(itemId: Long) = "/wait/$itemId"
    /** Where tapping an item leads: a login to its handoff, an ask or a GO to its card, anything else to the chat. */
    fun openRoute(kind: String, itemId: Long, identityId: String) = when {
        kind == "login" -> handoffRoute(itemId)
        (kind == "ask" || kind == "go") && itemId > 0 -> waitRoute(itemId)
        else -> chatRoute(identityId)
    }

    /**
     * What the countdown says is about to be sent, so a GO can never be mistaken for another
     * item's GO: "GO לפרודקשן: לומו 1.1.20", "GO לחזרה: לחזור ל-r207", the chosen option, the typed text.
     */
    fun subject(op: Op, label: String, answer: String?, title: String, body: String): String {
        if (op == Op.ANSWER || op == Op.REPLY_ASK || op == Op.REPLY_TELL) return answer ?: label
        if (op == Op.STOP) return label // the shift is the worker's, already named in the countdown
        val topic = (if (op == Op.GO) proposal(body) else null) ?: title
        return when {
            topic.isBlank() -> label
            topic.startsWith(label) -> topic
            else -> "$label: $topic"
        }
    }

    /** "ההצעה: לחזור ל-r207." -> "לחזור ל-r207" */
    fun proposal(body: String): String? {
        val i = body.indexOf("ההצעה")
        if (i < 0) return null
        return body.substring(i + "ההצעה".length).trimStart(':', ' ').trimEnd('.', ' ').ifBlank { null }
    }

    /** An incident carries a proposal when the worker wrote one ("ההצעה: לחזור ל-r207"). */
    fun hasProposal(body: String): Boolean = body.contains("ההצעה")

    /**
     * Mirror of hq's pushWorthy (inbox.ts): only what blocks on him makes a notification (§5.1).
     * /api/inbox carries only what is his (task 986): system faults go to the manager, and what is left is a question,
     * a GO, a login or the manager himself being down. A soft question waits for him quietly; in focus or night nothing pushes.
     */
    fun pushWorthy(kind: String, urgency: String, blocking: Boolean, quiet: Boolean, ref: String? = null): Boolean {
        if (quiet) return false
        // An hq from before task 986 still lists every incident: of those only "all the accounts are full" is his.
        if (kind == "incident") return ref == ALL_FULL_REF
        return kind != "ask" || blocking
    }

    const val ALL_FULL_REF = "accounts-all-full"

    /** The button table of APP-SPEC §5.3, plus the per-worker fallback (reply, stop, handled). */
    fun plan(p: PlanInput): List<Action> {
        val open = Action(Op.OPEN, Wording.OPEN, route = openRoute(p.kind, p.itemId, p.identityId))
        val go = Action(Op.GO, p.goLabel ?: Wording.GO)
        val actions = when {
            p.kind == "ask" && p.askOptions != null -> {
                val opts = p.askOptions
                if (opts.size in 1..2) {
                    opts.map { Action(Op.ANSWER, it, answer = it) } + Action(Op.REPLY_ASK, Wording.REPLY, choices = opts)
                } else {
                    listOf(Action(Op.REPLY_ASK, Wording.REPLY, choices = opts), open)
                }
            }
            p.kind == "go" -> listOf(go, Action(Op.SNOOZE, Wording.NOT_NOW), open)
            p.kind == "login" -> listOf(open, Action(Op.SNOOZE, Wording.NOT_NOW))
            p.kind == "incident" && hasProposal(p.body) && !p.isSystem ->
                listOf(go, Action(Op.REPLY_TELL, Wording.QUESTION), open)
            else -> buildList {
                // A worker we can talk to: reply goes to them as a message. hq itself has no mailbox.
                if (!p.isSystem) add(Action(Op.REPLY_TELL, if (p.kind == "incident") Wording.QUESTION else Wording.REPLY))
                if (p.hasLiveShift && !p.isSystem) add(Action(Op.STOP, Wording.STOP))
                add(Action(Op.HANDLED, Wording.HANDLED))
                if (size < MAX_ACTIONS) add(open)
            }
        }
        return actions.take(MAX_ACTIONS)
    }
}
