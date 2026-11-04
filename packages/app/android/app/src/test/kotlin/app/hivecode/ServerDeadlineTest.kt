package app.hivecode

import app.hivecode.hq.ServerDeadline
import org.junit.Assert.*
import org.junit.Test

class ServerDeadlineTest {
    @Test fun tenMinutesAndOnlyOnce() {
        val last = 100_000L
        assertFalse(ServerDeadline.shouldAlert(last, last + 9 * 60_000, false))
        assertTrue(ServerDeadline.shouldAlert(last, last + 10 * 60_000, false))
        assertFalse(ServerDeadline.shouldAlert(last, last + 11 * 60_000, true))
        assertFalse(ServerDeadline.shouldAlert(0, last + 11 * 60_000, false))
        assertFalse(ServerDeadline.shouldAlert(last, last - 1, false))
    }
}
