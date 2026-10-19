package app.hivecode

import app.hivecode.notify.UndoMachine
import app.hivecode.notify.UndoState
import app.hivecode.notify.Wording
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UndoMachineTest {
    @Test fun countsDownThreeSecondsThenSends() {
        val m = UndoMachine()
        assertEquals(UndoState.Counting(3), m.state)
        assertFalse(m.tick()); assertEquals(UndoState.Counting(2), m.state)
        assertFalse(m.tick()); assertEquals(UndoState.Counting(1), m.state)
        assertTrue(m.tick()); assertEquals(UndoState.Sending, m.state)
        assertFalse(m.tick()) // no double send
        m.result(ok = true)
        assertEquals(UndoState.Sent, m.state)
        assertTrue(m.isFinished)
    }

    @Test fun cancelDuringCountdownSendsNothing() {
        val m = UndoMachine()
        m.tick()
        assertTrue(m.cancel())
        assertEquals(UndoState.Cancelled, m.state)
        assertFalse(m.tick())
        m.result(ok = true) // a late result must not resurrect it
        assertEquals(UndoState.Cancelled, m.state)
    }

    @Test fun cannotCancelOnceSent() {
        val m = UndoMachine()
        repeat(3) { m.tick() }
        assertFalse(m.cancel())
        assertEquals(UndoState.Sending, m.state)
    }

    @Test fun failureKeepsReasonAndRetrySendsImmediately() {
        val m = UndoMachine()
        repeat(3) { m.tick() }
        m.result(ok = false, reason = Wording.ERR_OFFLINE)
        assertEquals(UndoState.Failed(Wording.ERR_OFFLINE), m.state)
        assertFalse(m.isFinished)
        assertFalse(m.cancel())
        assertTrue(m.retry())
        assertEquals(UndoState.Sending, m.state)
        m.result(ok = true)
        assertEquals(UndoState.Sent, m.state)
    }

    @Test fun failureWithoutReasonGetsPlainSentence() {
        val m = UndoMachine(immediate = true)
        m.result(ok = false)
        assertEquals(UndoState.Failed(Wording.ERR_SERVER), m.state)
    }

    @Test fun immediateSkipsCountdown() {
        val m = UndoMachine(immediate = true)
        assertEquals(UndoState.Sending, m.state)
        assertFalse(m.cancel())
    }

    @Test fun retryOnlyAfterFailure() {
        val m = UndoMachine()
        assertFalse(m.retry())
    }
}
