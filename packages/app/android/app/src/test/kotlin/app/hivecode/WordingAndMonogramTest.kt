package app.hivecode

import app.hivecode.hq.HqJson
import app.hivecode.notify.ActionCall
import app.hivecode.notify.Monogram
import app.hivecode.notify.Op
import app.hivecode.notify.Wording
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WordingAndMonogramTest {
    @Test fun monogramLetter() {
        assertEquals("ד", Monogram.letter("דנה"))
        assertEquals("ע", Monogram.letter("  עידו"))
        assertEquals("ש", Monogram.letter("\"שירה\""))
        assertEquals("ש", Monogram.letter("שָׁרוֹן")) // niqqud stays behind
        assertEquals("V", Monogram.letter("voice-bot"))
        assertEquals("B", Monogram.letter("🙂 bob"))
        assertEquals("A", Monogram.letter("3amit"))
        assertEquals("?", Monogram.letter(""))
        assertEquals("?", Monogram.letter("123 -"))
    }

    @Test fun recipient() {
        assertEquals("לדנה", Wording.to("דנה"))
        assertEquals("לשרת", Wording.to(Wording.SYSTEM_NAME))
        assertEquals("ל-Bob", Wording.to("Bob"))
        assertEquals("להדס", Wording.to("הדס")) // a name that starts with ה keeps it
    }

    @Test fun undoTexts() {
        assertEquals("יישלח לדנה בעוד 3 שנ'", Wording.countdown("דנה", 3))
        assertEquals("נשלח לדנה", Wording.sent("דנה"))
        assertEquals("לא נשלח · אין חיבור לרשת. אפשר לנסות שוב.", Wording.failed(Wording.ERR_OFFLINE))
    }

    @Test fun summary() {
        assertEquals("אין דברים שמחכים לך", Wording.summary(0))
        assertEquals("דבר אחד מחכה לך", Wording.summary(1))
        assertEquals("4 דברים מחכים לך", Wording.summary(4))
    }

    @Test fun conversationTitle() {
        assertEquals("דנה · מנכ\"לית לומו", Wording.conversationTitle("דנה", "מנכ\"לית לומו"))
        assertEquals("החברה", Wording.conversationTitle("החברה", ""))
    }

    @Test fun errorsHaveNoCodes() {
        val all = listOf(Wording.ERR_OFFLINE, Wording.ERR_AUTH, Wording.ERR_GONE, Wording.ERR_SERVER, Wording.ERR_NOT_CONFIGURED, Wording.ERR_NO_SHIFT)
        for (e in all) {
            assertFalse(e, Regex("[0-9]|exception|http|error", RegexOption.IGNORE_CASE).containsMatchIn(e))
            assertTrue(e, e.endsWith("."))
            assertFalse(e, e.contains("—"))
        }
    }

    @Test fun actionCallRoundTrip() {
        val c = ActionCall(Op.ANSWER, "ביטול המנוי מיד", 1234, -2, "ido", "עידו", "עידו · מפתח", "blocking", "local_shipping",
            ephemeral = true, askId = "ask-1", answer = "ביטול המנוי מיד")
        assertEquals(c, ActionCall.fromJson(c.toJson()))
        val noAsk = c.copy(op = Op.GO, itemId = 7, askId = null, answer = null)
        assertEquals(noAsk, ActionCall.fromJson(noAsk.toJson()))
    }

    @Test fun parsesHqPayloads() {
        val inbox = HqJson.inbox(
            """{"items":[{"id":5,"kind":"ask","title":"t","body":"","from_identity":"ido","urgency":"normal","blocking":true,
            "ref":"ask-1","state":"open","created_at":1000,"pushed_at":null,"acked_at":null},
            {"id":6,"kind":"shift_failure","title":"x","body":"y","from_identity":null,"urgency":"urgent","blocking":true,
            "ref":null,"state":"open","created_at":2000}]}""",
        )
        assertEquals(2, inbox.size)
        assertEquals("ask-1", inbox[0].ref)
        assertNull(inbox[1].from)
        assertNull(inbox[1].ref)

        val asks = HqJson.asks("""{"asks":[{"id":"ask-1","from_identity":"ido","question":"q","options":["a","b"],"blocking":true,"state":"open"}]}""")
        assertEquals(listOf("a", "b"), asks["ask-1"]?.options)

        val board = HqJson.board(
            """{"identities":[{"id":"dana","name":"דנה","title":"מנכ\"לית לומו","symbol":"local_shipping","team":"lumo",
            "lifecycle":"resident","shift":{"id":"dana-3","state":"live"}},{"id":"eli","name":"אלי","title":"","symbol":"folder_shared",
            "team":null,"lifecycle":"resident","shift":null}]}""",
        )
        assertEquals("dana-3", board["dana"]?.shiftId)
        assertTrue(board["dana"]!!.shiftLive)
        assertFalse(board["eli"]!!.shiftLive)
        assertNull(board["eli"]!!.team)

        val toggles = HqJson.toggles("""{"toggles":[{"key":"focus","enabled":true},{"key":"night","enabled":false}]}""")
        assertEquals(mapOf("focus" to true, "night" to false), toggles)
    }
}
