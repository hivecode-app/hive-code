package app.hivecode

import app.hivecode.hq.ConvMessage
import app.hivecode.hq.ConvState
import app.hivecode.hq.HqJson
import app.hivecode.notify.MessagePlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MessagePlanTest {
    private fun conv(id: String, unread: Int = 1, readAt: Long = 0, alertAt: Long? = 100, muted: Long? = null) =
        ConvState(id, "$id · תואר", unread, readAt, muted, alertAt, if (unread > 0) listOf(ConvMessage("m", "שלום", 100)) else emptyList())

    @Test fun newAlertSoundsOnceThenSilent() {
        val (first, alerted) = MessagePlan.plan(listOf(conv("dana")), emptyMap())
        assertEquals(1, first.size)
        assertEquals(false, first[0].silent)
        val (again, _) = MessagePlan.plan(listOf(conv("dana")), alerted)
        assertEquals(true, again[0].silent)
        val (newer, _) = MessagePlan.plan(listOf(conv("dana", unread = 2, alertAt = 200)), alerted)
        assertEquals(false, newer[0].silent)
    }

    @Test fun readMutedOrNeverAlertedAreNotShown() {
        val (show, alerted) = MessagePlan.plan(
            listOf(
                conv("read", unread = 0, readAt = 150),
                conv("readAfterAlert", readAt = 150),
                conv("muted", muted = Long.MAX_VALUE),
                conv("quiet", alertAt = null), // came in during focus: counted, never alerted
                conv("dana"),
            ),
            mapOf("read" to 100L),
        )
        assertEquals(listOf("dana"), show.map { it.conv.identity })
        assertEquals(mapOf("dana" to 100L), alerted)
    }

    @Test fun swipedAwayStaysAwayUntilANewerMessage() {
        val (gone, _) = MessagePlan.plan(listOf(conv("dana")), emptyMap(), mapOf("dana" to 100L))
        assertEquals(0, gone.size)
        val (back, _) = MessagePlan.plan(listOf(conv("dana", unread = 2, alertAt = 200)), mapOf("dana" to 100L), mapOf("dana" to 100L))
        assertEquals(listOf("dana"), back.map { it.conv.identity })
        assertEquals(false, back[0].silent)
    }

    @Test fun parsesConversations() {
        val json = """{"conversations":[{"identity":"dana","title":"דנה · מנכ\"לית לומו","unread":2,"read_at":5,"muted_until":null,
            "alert_at":90,"last_at":90,"recent":[{"id":"a","body":"העדכון עלה","created_at":80},{"id":"b","body":"עוד","created_at":90}]}],"unread_total":2}"""
        val c = HqJson.conversations(json).single()
        assertEquals("דנה · מנכ\"לית לומו", c.title)
        assertEquals(2, c.unread)
        assertNull(c.mutedUntil)
        assertEquals(90L, c.alertAt)
        assertEquals(listOf("העדכון עלה", "עוד"), c.recent.map { it.body })
    }
}
