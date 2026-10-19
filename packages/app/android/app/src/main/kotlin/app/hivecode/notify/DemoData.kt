package app.hivecode.notify

import app.hivecode.hq.Ask
import app.hivecode.hq.Identity
import app.hivecode.hq.InboxItem

/**
 * The four notifications of mockup screen 9 (docs/app/mockups/index.html#s-notif), local only,
 * so every button can be tried on the phone before hq is live. Ids are negative: actions on them
 * run the full undo and result flow without touching the network.
 */
object DemoData {
    private const val MIN = 60_000L

    val identities: Map<String, Identity> = listOf(
        Identity("rotem", "רותם", "ראש צוות הניטור", "shield", "monitor", "resident", "demo-shift-rotem", true),
        Identity("ido", "עידו", "מפתח · t3711", "local_shipping", "lumo", "ephemeral", "demo-shift-ido", true),
        Identity("dana", "דנה", "מנכ\"לית לומו", "local_shipping", "lumo", "resident", "demo-shift-dana", true),
        Identity("amit", "עמית", "מומחה כספים", "folder_shared", "personal", "resident", null, false),
    ).associateBy { it.id }

    val asks: Map<String, Ask> = mapOf(
        "demo-ask-ido" to Ask(
            id = "demo-ask-ido",
            from = "ido",
            question = "רותם מצאה 37 מנויים עם כרטיס שנדחה פעמיים השבוע. מה עושים איתם?",
            options = listOf("ניסיון נוסף אחרי 24 ש'", "ביטול המנוי מיד"),
            blocking = true,
            state = "open",
        ),
    )

    fun items(now: Long): List<InboxItem> = listOf(
        InboxItem(-1, "incident", "דחוף בפרודקשן", "טיקיבוט: ה-webhook מחזיר 502 מ-13:58. ההצעה: לחזור ל-r207.",
            "rotem", "urgent", true, null, now - 6 * MIN, goLabel = "GO לחזרה"),
        InboxItem(-2, "ask", "שאלה מעידו", "", "ido", "normal", true, "demo-ask-ido", now - 4 * MIN),
        InboxItem(-3, "go", "GO לפרודקשן: לומו 1.1.20", "תיקון הטקסט בטלפון, סיכון נמוך.",
            "dana", "normal", true, null, now - 25 * MIN),
        InboxItem(-4, "login", "נדרש קוד אימות ל-Mercury", "", "amit", "normal", true, null, now - 2 * MIN),
    )

    val ALL_IDS: Set<Long> = setOf(-1L, -2L, -3L, -4L)
}
