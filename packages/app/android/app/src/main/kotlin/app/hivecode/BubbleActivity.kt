package app.hivecode

/**
 * The floating bubble of one worker (NotificationCompat.BubbleMetadata). An embedded, resizeable
 * Flutter activity that starts the engine directly at /chat/<identityId>; the bridge also
 * returns that route from getInitialRoute() so the Dart side can open it either way.
 */
class BubbleActivity : MainActivity() {
    override fun getInitialRoute(): String = intent?.getStringExtra(EXTRA_ROUTE) ?: "/"
}
