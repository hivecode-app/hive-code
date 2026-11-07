package app.hivecode.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.view.View
import android.widget.RemoteViews
import app.hivecode.R
import app.hivecode.hq.Prefs
import app.hivecode.hq.SYSTEM_IDENTITY
import app.hivecode.hq.Snapshot
import app.hivecode.notify.NotificationPoster
import app.hivecode.notify.WaitingCount
import app.hivecode.notify.Wording

/** Home-screen widget "מחכה לך": the waiting count and the top item. Tap opens the app home. */
class WaitingWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
    }

    companion object {
        /** Saves the widget's view model; called on every refresh so onUpdate never needs the network. */
        fun store(context: Context, snap: Snapshot) {
            val prefs = Prefs(context)
            val top = snap.items.firstOrNull()
            prefs.widgetCount = WaitingCount.flutter ?: snap.items.size
            prefs.widgetTopName = top?.let { snap.identities[it.from ?: SYSTEM_IDENTITY]?.name ?: it.from?.takeIf { f -> f != SYSTEM_IDENTITY } ?: Wording.SYSTEM_NAME }
            prefs.widgetTopLine = top?.let { NotificationPoster.messageText(it, snap) }
        }

        fun updateAll(context: Context) {
            val m = AppWidgetManager.getInstance(context)
            val ids = m.getAppWidgetIds(ComponentName(context, WaitingWidget::class.java))
            if (ids.isNotEmpty()) render(context, m, ids)
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val prefs = Prefs(context)
            val count = prefs.widgetCount
            val v = RemoteViews(context.packageName, R.layout.widget_waiting)
            v.setTextViewText(R.id.widget_count, count.toString())
            val name = prefs.widgetTopName
            val line = prefs.widgetTopLine
            if (count > 0 && name != null && line != null) {
                v.setViewVisibility(R.id.widget_top_name, View.VISIBLE)
                v.setTextViewText(R.id.widget_top_name, name)
                v.setTextViewText(R.id.widget_top_line, line)
            } else {
                v.setViewVisibility(R.id.widget_top_name, View.GONE)
                v.setTextViewText(
                    R.id.widget_top_line,
                    if (!prefs.isConfigured) "לא מחובר לשרת. נגיעה לפתיחה." else Wording.summary(0),
                )
            }
            v.setOnClickPendingIntent(R.id.widget_root, NotificationPoster.openApp(context, "/", null))
            manager.updateAppWidget(ids, v)
        }
    }
}
