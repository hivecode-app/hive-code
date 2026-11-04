package app.hivecode.hq

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Brings the hq link back after a reboot or an app update, if the app was configured. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (Prefs(context).isConfigured) ServerWatch.ensure(context)
                HqLinkService.start(context)
            }
        }
    }
}
