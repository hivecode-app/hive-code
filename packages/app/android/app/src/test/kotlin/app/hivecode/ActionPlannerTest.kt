package app.hivecode

import app.hivecode.notify.ActionPlanner
import app.hivecode.notify.Channels
import app.hivecode.notify.Op
import app.hivecode.notify.PlanInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The button table of APP-SPEC §5.3, row by row. */
class ActionPlannerTest {
    @Test fun quietModesStillShowOwnerEmergencies() {
        assertEquals(false, ActionPlanner.pushWorthy("go", "urgent", true, true))
        assertEquals(true, ActionPlanner.pushWorthy("go", "normal", true, false))
        assertEquals(true, ActionPlanner.pushWorthy("incident", "urgent", true, true, "accounts-all-full"))
        assertEquals(true, ActionPlanner.pushWorthy("shift_failure", "urgent", true, true))
        assertEquals(false, ActionPlanner.pushWorthy("incident", "urgent", true, true, "other"))
    }

    private fun input(
        kind: String,
        options: List<String>? = null,
        body: String = "",
        live: Boolean = true,
        system: Boolean = false,
        goLabel: String? = null,
    ) = PlanInput(42, kind, "dana", options, body, "normal", live, system, goLabel)

    private fun ops(p: PlanInput) = ActionPlanner.plan(p).map { it.op }
    private fun labels(p: PlanInput) = ActionPlanner.plan(p).map { it.label }

    @Test fun askWithTwoOptions() {
        val p = input("ask", listOf("ניסיון נוסף אחרי 24 ש'", "ביטול המנוי מיד"))
        assertEquals(listOf(Op.ANSWER, Op.ANSWER, Op.REPLY_ASK), ops(p))
        assertEquals(listOf("ניסיון נוסף אחרי 24 ש'", "ביטול המנוי מיד", "תשובה"), labels(p))
        val plan = ActionPlanner.plan(p)
        assertEquals("ביטול המנוי מיד", plan[1].answer)
        assertEquals(p.askOptions, plan[2].choices)
    }

    @Test fun askWithOneOption() {
        assertEquals(listOf(Op.ANSWER, Op.REPLY_ASK), ops(input("ask", listOf("כן, לפרוס"))))
    }

    @Test fun askWithThreeOptionsBecomesReplyWithChips() {
        val opts = listOf("א", "ב", "ג")
        val plan = ActionPlanner.plan(input("ask", opts))
        assertEquals(listOf(Op.REPLY_ASK, Op.OPEN), plan.map { it.op })
        assertEquals(opts, plan[0].choices)
        assertEquals("/wait/42", plan[1].route)
    }

    @Test fun askWithoutOptions() {
        val plan = ActionPlanner.plan(input("ask", emptyList()))
        assertEquals(listOf(Op.REPLY_ASK, Op.OPEN), plan.map { it.op })
        assertTrue(plan[0].choices.isEmpty())
    }

    @Test fun go() {
        val plan = ActionPlanner.plan(input("go"))
        assertEquals(listOf(Op.GO, Op.SNOOZE, Op.OPEN), plan.map { it.op })
        assertEquals(listOf("אישור", "לא עכשיו", "פתיחה"), plan.map { it.label })
        assertTrue(plan[0].needsUnlock)
        assertTrue(plan[0].hasUndo)
        assertFalse(plan[1].hasUndo) // "לא עכשיו" is not an answer
    }

    @Test fun urgentIncidentWithProposal() {
        val plan = ActionPlanner.plan(input("incident", body = "ה-webhook מחזיר 502. ההצעה: לחזור ל-r207.", goLabel = "GO לחזרה"))
        assertEquals(listOf(Op.GO, Op.REPLY_TELL, Op.OPEN), plan.map { it.op })
        assertEquals(listOf("GO לחזרה", "שאלה", "פתיחה"), plan.map { it.label })
        assertTrue(plan[0].needsUnlock)
    }

    @Test fun incidentWithoutProposalFallsBackToWorkerActions() {
        assertEquals(listOf(Op.REPLY_TELL, Op.STOP, Op.HANDLED), ops(input("incident", body = "תקלה ב-webhook")))
        assertEquals("שאלה", ActionPlanner.plan(input("incident", body = "תקלה"))[0].label)
    }

    @Test fun loginHandoff() {
        val plan = ActionPlanner.plan(input("login"))
        assertEquals(listOf(Op.OPEN, Op.SNOOZE), plan.map { it.op })
        assertEquals("/handoff/42", plan[0].route)
    }

    @Test fun workerItemWithLiveShift() {
        assertEquals(listOf(Op.REPLY_TELL, Op.STOP, Op.HANDLED), ops(input("delivery_failure")))
        assertEquals(listOf("תשובה", "עצירה", "טופל"), labels(input("shift_failure")))
    }

    @Test fun workerItemWithoutShiftGetsOpenInstead() {
        assertEquals(listOf(Op.REPLY_TELL, Op.HANDLED, Op.OPEN), ops(input("escalation_note", live = false)))
    }

    @Test fun systemItemHasNoReplyOrStop() {
        assertEquals(listOf(Op.HANDLED, Op.OPEN), ops(input("delivery_failure", system = true)))
    }

    @Test fun askWhoseAskIsGoneIsTreatedAsWorkerItem() {
        assertEquals(listOf(Op.REPLY_TELL, Op.STOP, Op.HANDLED), ops(input("ask", options = null)))
    }

    @Test fun neverMoreThanThree() {
        for (kind in listOf("ask", "go", "login", "incident", "delivery_failure", "escalation_note", "shift_failure")) {
            for (opts in listOf(null, emptyList(), listOf("א"), listOf("א", "ב"), listOf("א", "ב", "ג", "ד"))) {
                assertTrue(ActionPlanner.plan(input(kind, opts, body = "ההצעה: x")).size <= ActionPlanner.MAX_ACTIONS)
            }
        }
    }

    @Test fun everyAnswerHasUndoButSnoozeAndOpenDoNot() {
        val plan = ActionPlanner.plan(input("ask", listOf("א", "ב")))
        assertTrue(plan.all { it.hasUndo }) // two options and the typed reply
        val go = ActionPlanner.plan(input("go"))
        assertEquals(listOf(true, false, false), go.map { it.hasUndo })
    }

    @Test fun subjectNamesTheItem() {
        assertEquals("GO לפרודקשן: לומו 1.1.20", ActionPlanner.subject(Op.GO, "GO", null, "GO לפרודקשן: לומו 1.1.20", "תיקון"))
        assertEquals("GO לחזרה: לחזור ל-r207",
            ActionPlanner.subject(Op.GO, "GO לחזרה", null, "דחוף בפרודקשן", "טיקיבוט: 502 מ-13:58. ההצעה: לחזור ל-r207."))
        assertEquals("GO: גרסה 2", ActionPlanner.subject(Op.GO, "GO", null, "גרסה 2", ""))
        assertEquals("ביטול המנוי מיד", ActionPlanner.subject(Op.ANSWER, "ביטול המנוי מיד", "ביטול המנוי מיד", "שאלה", ""))
        assertEquals("רק אחרי מייל", ActionPlanner.subject(Op.REPLY_ASK, "תשובה", "רק אחרי מייל", "שאלה", ""))
        assertEquals("טופל: הודעה לא נמסרה", ActionPlanner.subject(Op.HANDLED, "טופל", null, "הודעה לא נמסרה", "ההצעה: x"))
        assertEquals("עצירה", ActionPlanner.subject(Op.STOP, "עצירה", null, "משהו", ""))
        assertEquals("GO", ActionPlanner.subject(Op.GO, "GO", null, "", ""))
    }

    @Test fun handoffRemaining() {
        val created = 1_000_000L
        assertEquals(10 * 60_000L, Channels.handoffRemainingMs(created, created))
        assertEquals(60_000L, Channels.handoffRemainingMs(created, created + 9 * 60_000L))
        assertTrue(Channels.handoffRemainingMs(created, created + 10 * 60_000L) <= 0)
    }

    @Test fun pushWorthyMirrorsHq() {
        assertTrue(ActionPlanner.pushWorthy("ask", "normal", blocking = true, quiet = false))
        assertFalse(ActionPlanner.pushWorthy("ask", "normal", blocking = false, quiet = false))
        assertTrue(ActionPlanner.pushWorthy("go", "normal", blocking = true, quiet = false))
        assertTrue(ActionPlanner.pushWorthy("login", "normal", blocking = true, quiet = false))
        // Task 986: a system fault goes to the manager and never reaches /api/inbox; what does (the manager down) is his.
        assertTrue(ActionPlanner.pushWorthy("incident", "urgent", blocking = false, quiet = false, ref = "accounts-all-full"))
        assertFalse(ActionPlanner.pushWorthy("incident", "urgent", blocking = false, quiet = false, ref = "pressure-adi"))
        assertTrue(ActionPlanner.pushWorthy("delivery_failure", "normal", blocking = false, quiet = false))
        // Focus and night push nothing.
        assertFalse(ActionPlanner.pushWorthy("incident", "urgent", blocking = true, quiet = true))
        assertFalse(ActionPlanner.pushWorthy("go", "normal", blocking = true, quiet = true))
        assertFalse(ActionPlanner.pushWorthy("ask", "urgent", blocking = true, quiet = true))
    }

    @Test fun tapLeadsToTheItem() {
        assertEquals("/wait/7", ActionPlanner.openRoute("ask", 7, "dana"))
        assertEquals("/wait/8", ActionPlanner.openRoute("go", 8, "dana"))
        assertEquals("/handoff/9", ActionPlanner.openRoute("login", 9, "dana"))
        assertEquals("/chat/dana", ActionPlanner.openRoute("incident", 10, "dana"))
        assertEquals("/chat/dana", ActionPlanner.openRoute("ask", 0, "dana"))
    }
}
