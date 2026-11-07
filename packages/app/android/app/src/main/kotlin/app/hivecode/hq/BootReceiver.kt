package app.hivecode.hq

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a reboot or an app update: the server watch, and hq holding this phone's FCM token. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (Prefs(context).isConfigured) ServerWatch.ensure(context)
                PushRegistration.sync(context)
            }
        }
    }
}
