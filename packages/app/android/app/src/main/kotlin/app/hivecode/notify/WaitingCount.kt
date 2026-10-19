package app.hivecode.notify

/**
 * The single source of the badge and widget number (APP-SPEC §5.6). While the Flutter app runs,
 * its own waiting counter wins (setWaitingCount); when its engine goes away this is cleared and
 * the native side falls back to hq's open inbox items.
 */
object WaitingCount {
    @Volatile var flutter: Int? = null
}
