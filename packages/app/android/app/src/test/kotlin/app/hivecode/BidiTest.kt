package app.hivecode

import app.hivecode.notify.Bidi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as test/bidi_test.dart: the two implementations must agree. */
class BidiTest {
    private fun show(s: String) = s.replace(Bidi.LRI, "⟦").replace(Bidi.FSI, "⟦").replace(Bidi.PDI, "⟧").replace(Bidi.WJ, "")

    @Test fun direction() {
        assertTrue(Bidi.isRtl("שלום world"))
        assertTrue(Bidi.isRtl("t2790 סיים, וסגרתי אותו."))
        assertTrue(Bidi.isRtl("CI נכשל על guard אמיתי"))
        assertTrue(Bidi.isRtl("`hooks` עבר הפעם."))
        assertTrue(Bidi.isRtl("\u200Ft3720 opened two PRs"))
        assertFalse(Bidi.isRtl("Smoke test from the app"))
        assertFalse(Bidi.isRtl("Yossi isn't tagged, and «צירוף חברים» is showing"))
        assertFalse(Bidi.isRtl("`git status`"))
        assertTrue(Bidi.isRtl("12:30"))
    }

    @Test fun isolate() {
        assertEquals("ה-⟦CI⟧ של ⟦PR #191⟧ ירוק.", show(Bidi.isolate("ה-CI של PR #191 ירוק.")))
        assertEquals("נעצר (⟦SIGTERM, exit 143⟧) ב-11:16", show(Bidi.isolate("נעצר (SIGTERM, exit 143) ב-11:16")))
        assertEquals("ירד ל-⟦35–37ms⟧ ב-⟦worker⟧.", show(Bidi.isolate("ירד ל-35–37ms ב-worker.")))
        assertEquals("נשארו ⟦app⟧ ו-⟦ios-build⟧, ואני מחכה.", show(Bidi.isolate("נשארו `app` ו-`ios-build`, ואני מחכה.")))
        assertEquals("Smoke test", Bidi.isolate("Smoke test"))
        assertEquals("בבדיקה של ⟦05:43Z⟧, הבאה ב-⟦07:43Z⟧", show(Bidi.isolate("בבדיקה של 05:43Z, הבאה ב-07:43Z")))
    }

    @Test fun hebrewSuffixStaysOutside() {
        assertEquals("שלחתי ⟦commit⟧ים חדשים", show(Bidi.isolate("שלחתי commitים חדשים")))
    }

    @Test fun noBacktracking() {
        for (s in listOf("שלום abc" + ", ".repeat(60) + "!", "אבג " + "1".repeat(5000) + " דהו", "קרא " + List(400) { "dir" }.joinToString("/") + ".")) {
            val t0 = System.nanoTime()
            Bidi.display(s)
            assertTrue((System.nanoTime() - t0) / 1_000_000 < 1000)
        }
    }

    @Test fun hugeLineNeverThrows() {
        val s = "שלום " + "ab ".repeat(4000)
        assertTrue(Bidi.display(s).startsWith(Bidi.RLM))
    }

    @Test fun englishLineIsNotIsolated() {
        val s = "Here the code sent GPT-Live the line \"אני עכשיו מעביר אתכם לסדרן\", but GPT-Live didn't say it."
        assertEquals(Bidi.LRM + s, Bidi.display(s))
    }

    @Test fun display() {
        assertEquals("\u200F" + "t2790 סיים\n\u200EOK, done", Bidi.display("t2790 סיים\nOK, done").replace(Bidi.LRI, "").replace(Bidi.PDI, ""))
    }
}
