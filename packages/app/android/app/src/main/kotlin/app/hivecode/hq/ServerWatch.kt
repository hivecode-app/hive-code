package app.hivecode.hq

import android.content.Context
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.*
import app.hivecode.MainActivity
import app.hivecode.R
import java.util.concurrent.TimeUnit

/** Pure deadline rule, independent of WorkManager scheduling delays and device sleep. */
object ServerDeadline {
    const val SILENCE_MS = 10 * 60_000L
    fun shouldAlert(lastHealthy: Long, now: Long, alerted: Boolean): Boolean =
        !alerted && lastHealthy > 0 && now - lastHealthy >= SILENCE_MS
}

object ServerWatch {
    private const val WORK = "company-server-watch"
    private const val PERIODIC = "company-server-watch-periodic"
    const val NOTIFICATION = 71001
    fun state(ctx: Context) = ctx.getSharedPreferences("company_server_watch", Context.MODE_PRIVATE)
    fun configure(ctx: Context) {
        state(ctx).edit().clear().putLong("healthy", System.currentTimeMillis()).apply()
        ensure(ctx)
    }
    fun ensure(ctx: Context) {
        val manager = WorkManager.getInstance(ctx)
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        manager.enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<ServerWatchWorker>().setInitialDelay(10, TimeUnit.MINUTES).setConstraints(constraints).build())
        // OS minimum is 15 minutes. This survives process death and boot; the one-off checks the first deadline.
        manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<ServerWatchWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build())
    }
    fun healthy(ctx: Context) {
        state(ctx).edit().putLong("healthy", System.currentTimeMillis()).putBoolean("alerted", false).apply()
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION)
        ensure(ctx)
    }
    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
        WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC)
        state(ctx).edit().clear().apply()
        NotificationManagerCompat.from(ctx).cancel(NOTIFICATION)
    }
}

class ServerWatchWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val ctx = applicationContext
        val client = HqClient.from(ctx) ?: return Result.success()
        try { client.health(); ServerWatch.healthy(ctx); return Result.success() } catch (_: Exception) { /* assess deadline */ }
        val state = ServerWatch.state(ctx)
        if (!ServerDeadline.shouldAlert(state.getLong("healthy", 0), System.currentTimeMillis(), state.getBoolean("alerted", false))) return Result.retry()
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return Result.success()
        nm.createNotificationChannel(android.app.NotificationChannel("server_connection", ctx.getString(R.string.server_silent_channel), android.app.NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(ctx, ServerWatch.NOTIFICATION, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val note = NotificationCompat.Builder(ctx, "server_connection").setSmallIcon(R.drawable.ic_ms_front_hand)
            .setContentTitle(ctx.getString(R.string.server_silent_title)).setContentText(ctx.getString(R.string.server_silent_body))
            .setStyle(NotificationCompat.BigTextStyle().bigText(ctx.getString(R.string.server_silent_body)))
            .setContentIntent(open).setAutoCancel(true).build()
        try { nm.notify(ServerWatch.NOTIFICATION, note); state.edit().putBoolean("alerted", true).apply() } catch (_: SecurityException) { /* permission refusal does not block use */ }
        return Result.success()
    }
}
