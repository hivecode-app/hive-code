package app.hivecode

import android.content.Intent
import app.hivecode.hq.HqLinkService
import app.hivecode.notify.WaitingCount
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

open class MainActivity : FlutterActivity() {
    private var bridge: NativeBridge? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        bridge = NativeBridge(this, flutterEngine.dartExecutor.binaryMessenger).also { it.takeLaunchIntent(intent) }
        flutterEngine.platformViewsController.registry.registerViewFactory("company/composer", ComposerFieldFactory(flutterEngine.dartExecutor.binaryMessenger))
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        bridge = null
        // Flutter's counter is gone with its engine; the badge falls back to hq's inbox (§5.6).
        WaitingCount.flutter = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        bridge?.onNewIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        // The app is in the foreground, so this start is always allowed; it heals a link the system killed.
        HqLinkService.start(this)
    }

    @Deprecated("Flutter's embedding still routes permission results through this callback")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        bridge?.onPermissionResult(requestCode, grantResults)
    }

    companion object {
        /**
         * Our own extra, not Flutter's "route": the main activity always starts the engine at "/"
         * and hands the route to Dart through the bridge, so the app's router decides how to open it.
         */
        const val EXTRA_ROUTE = "company.route"
        /** Inbox item to acknowledge on hq when the app opens from its notification. */
        const val EXTRA_ACK_ITEM = "company.ack_item"
        /** Must equal Prefs.nonce for the route and ack extras to count (this activity is exported). */
        const val EXTRA_NONCE = "company.nonce"
    }
}
