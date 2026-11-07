package app.hivecode.notify

/**
 * Every user-visible string the notification surface builds at runtime (APP-SPEC §7.7: short,
 * gender-neutral Hebrew, one plain sentence per error, no codes). Pure, so it is unit tested.
 */
object Wording {
    const val SYSTEM_NAME = "המערכת" // hq itself as a sender; same name as in the app (#55)

    const val GO = "אישור"
    const val NOT_NOW = "לא עכשיו"
    const val OPEN = "פתיחה"
    const val REPLY = "תשובה"
    const val QUESTION = "שאלה"
    const val STOP = "עצירה"
    const val HANDLED = "טופל"
    const val CANCEL = "ביטול"
    const val RETRY = "ניסיון נוסף"
    const val ME = "אני"
    const val MARK_READ = "סימון כנקרא"

    const val SUBTEXT_URGENT = "תקלה דחופה בשירות"
    const val SUBTEXT_HANDOFF = "כניסה לאתר"
    const val BLOCKING_PREFIX = "חוסם: "

    /** "לדנה". "המערכת" drops its article ("למערכת"); a non-Hebrew name gets a hyphen ("ל-Bob"). */
    fun to(name: String): String = when {
        name == SYSTEM_NAME -> "למערכת"
        name.firstOrNull()?.let { it in 'א'..'ת' } == true -> "ל$name"
        else -> "ל-$name"
    }

    fun countdown(name: String, seconds: Int): String = "יישלח ${to(name)} בעוד $seconds שנ'"

    fun sent(name: String): String = "נשלח ${to(name)}"

    const val SENDING = "שולח"

    fun failed(reason: String): String = "לא נשלח · $reason"

    /** The group summary text. N is the waiting count (§5.6); unread messages carry their own number. */
    fun summary(count: Int): String = when {
        count <= 0 -> "אין דברים שמחכים לך"
        count == 1 -> "דבר אחד מחכה לך"
        else -> "$count דברים מחכים לך"
    }

    /** "דנה · מנכ"לית לומו" (§6.1). Title is optional. */
    fun conversationTitle(name: String, title: String): String =
        if (title.isBlank()) name else "$name · $title"

    // One sentence each: what happened and what to do (design-taste §7, no HTTP codes).
    const val ERR_OFFLINE = "אין חיבור לרשת. אפשר לנסות שוב."
    const val ERR_AUTH = "החיבור לחברה לא מאושר. צריך לחבר מחדש באפליקציה."
    const val ERR_GONE = "הפריט כבר נסגר ממקום אחר."
    const val ERR_SERVER = "החברה לא ענתה. אפשר לנסות שוב בעוד רגע."
    const val ERR_NOT_CONFIGURED = "החיבור לחברה עוד לא הוגדר באפליקציה."
    const val ERR_NO_SHIFT = "אין עבודה פעילה לעצור."
    const val ERR_LOCKED = "אישור נשלח רק כשהמכשיר פתוח. אפשר לפתוח ולנסות שוב."
}
