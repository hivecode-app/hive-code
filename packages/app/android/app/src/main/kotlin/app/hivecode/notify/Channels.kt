package app.hivecode.notify

import android.content.Context
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationManagerCompat

/** The channels of APP-SPEC §5.2. Ids are stable: renaming one would reset his settings. */
object Channels {
    const val BLOCKING = "blocking"
    const val URGENT_PROD = "urgent_prod"
    const val HANDOFF = "handoff"
    const val DIGEST = "digest"
    const val MESSAGES = "messages"
    const val SERVICE = "service"

    /** A login handoff is only good for 10 minutes (§5.2, timeoutAfter). */
    const val HANDOFF_TIMEOUT_MS = 10 * 60_000L

    /** Time left on a handoff created at [createdAt]; <= 0 means it already expired. */
    fun handoffRemainingMs(createdAt: Long, now: Long): Long = createdAt + HANDOFF_TIMEOUT_MS - now

    fun ensure(context: Context) {
        val nm = NotificationManagerCompat.from(context)
        fun ch(id: String, importance: Int, name: String, desc: String) =
            NotificationChannelCompat.Builder(id, importance).setName(name).setDescription(desc).build()
        nm.createNotificationChannelsCompat(
            listOf(
                ch(BLOCKING, NotificationManagerCompat.IMPORTANCE_HIGH, "מחכה לך", "שאלה חוסמת ובקשת GO"),
                ch(URGENT_PROD, NotificationManagerCompat.IMPORTANCE_HIGH, "דחוף בפרודקשן",
                    "תקלה דחופה. כדאי לאפשר לערוץ הזה לעקוף את נא לא להפריע"),
                ch(HANDOFF, NotificationManagerCompat.IMPORTANCE_HIGH, "כניסה לאתר", "בקשה להיכנס לאתר מהטלפון, בתוקף 10 דקות"),
                ch(MESSAGES, NotificationManagerCompat.IMPORTANCE_HIGH, "הודעות", "הודעה מעובד, כמו בוואטסאפ. שיחה מושתקת לא מתריעה"),
                ch(DIGEST, NotificationManagerCompat.IMPORTANCE_LOW, "סיכום", "סיכום הבוקר וסיום פוקוס"),
                ch(SERVICE, NotificationManagerCompat.IMPORTANCE_MIN, "חיבור", "החיבור לחברה ברקע"),
            ),
        )
    }

    /** Which channel a worker's conversation goes to, by its most pressing item. */
    fun forKinds(kinds: List<Pair<String, String>>): String = when {
        kinds.any { (kind, urgency) -> kind == "incident" && urgency == "urgent" } -> URGENT_PROD
        kinds.firstOrNull()?.first == "login" -> HANDOFF
        else -> BLOCKING
    }
}
