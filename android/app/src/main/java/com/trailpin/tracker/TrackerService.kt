package com.trailpin.tracker

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The tracking loop, running as a foreground service so Android keeps it alive
 * when the screen is off.
 *
 * It does four things:
 *
 *  1. asks [LocationManager] for fixes from GPS and the network provider,
 *     filtered by the interval and distance the user configured;
 *  2. turns each fix into a [Position] and appends it to [PendingQueue];
 *  3. drains that queue through [ReportSender], newest configuration included;
 *  4. keeps a notification showing what happened last, with Stop / Send now.
 *
 * A heartbeat tick makes the service report even when the phone is stationary,
 * and an inexact alarm re-arms everything after the process is killed.
 */
class TrackerService : Service() {

    private lateinit var configStore: ConfigStore
    private lateinit var queue: PendingQueue
    private lateinit var locationManager: LocationManager

    @Volatile
    private var config: TrackerConfig = TrackerConfig()

    private val handler = Handler(Looper.getMainLooper())
    private val sender = Executors.newSingleThreadExecutor()
    private val sendInFlight = AtomicBoolean(false)

    @Volatile
    private var lastKnown: Location? = null

    @Volatile
    private var lastSentAtMs: Long = 0L

    @Volatile
    private var sentCount: Int = 0

    @Volatile
    private var lastStatus: String = "Starting up"

    private var foregroundStarted = false

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            lastKnown = location
            scheduleSend("fix")
        }

        override fun onProviderEnabled(provider: String) = Unit

        override fun onProviderDisabled(provider: String) {
            LogStore.append(this@TrackerService, "Provider disabled: $provider")
        }

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
    }

    private val tick = object : Runnable {
        override fun run() {
            flushQueue()
            if (config.heartbeat) {
                scheduleSend("heartbeat")
            }
            handler.postDelayed(this, tickIntervalMs())
        }
    }

    override fun onCreate() {
        super.onCreate()
        configStore = ConfigStore(this)
        queue = PendingQueue(this)
        config = configStore.load()
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        config = configStore.load()
        val action = intent?.action ?: ACTION_START

        if (!startForegroundCompat()) {
            // Without a notification there is no foreground service, and without
            // a foreground service Android will not hand us locations for long.
            stopSelf()
            return START_NOT_STICKY
        }

        return when (action) {
            ACTION_STOP -> {
                stopTracking()
                START_NOT_STICKY
            }

            ACTION_SEND_NOW -> {
                configStore.trackingEnabled = true
                startListening()
                startTicking()
                scheduleSend("manual", force = true)
                flushQueue()
                START_STICKY
            }

            ACTION_FLUSH -> {
                flushQueue()
                START_STICKY
            }

            else -> {
                configStore.trackingEnabled = true
                startListening()
                startTicking()
                scheduleAlarm()
                scheduleSend("start", force = true)
                START_STICKY
            }
        }
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        runCatching { locationManager.removeUpdates(locationListener) }
        runCatching { sender.shutdown() }
        LogStore.append(this, "service destroyed")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── locations ────────────────────────────────────────────────────────────

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    private fun startListening() {
        if (!hasLocationPermission()) {
            setStatus("Location permission is missing")
            LogStore.append(this, "not listening: location permission is not granted")
            return
        }

        // Pressing Start again after editing the interval or the distance filter
        // must apply the new values, so any previous request is replaced.
        runCatching { locationManager.removeUpdates(locationListener) }

        val intervalMs = config.effectiveIntervalSeconds() * 1000L
        val distanceM = config.effectiveDistanceMeters()

        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (!locationManager.isProviderEnabled(provider)) {
                    LogStore.append(this, "provider not enabled: $provider")
                    continue
                }
                locationManager.requestLocationUpdates(
                    provider,
                    intervalMs,
                    distanceM,
                    locationListener,
                    Looper.getMainLooper(),
                )
                LogStore.append(
                    this,
                    "listening to $provider every ${intervalMs / 1000}s / ${distanceM.toInt()}m",
                )
            } catch (_: SecurityException) {
                LogStore.append(this, "no permission for $provider")
            } catch (_: IllegalArgumentException) {
                LogStore.append(this, "provider unavailable: $provider")
            }
        }

        lastKnown = bestLastKnown()
        if (lastKnown == null) {
            setStatus("Waiting for a GPS fix")
        }
    }

    private fun bestLastKnown(): Location? {
        if (!hasLocationPermission()) return null
        val providers = listOf(
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER,
        )
        return providers
            .mapNotNull { provider -> runCatching { locationManager.getLastKnownLocation(provider) }.getOrNull() }
            .maxByOrNull { it.time }
    }

    // ── reporting ────────────────────────────────────────────────────────────

    private fun tickIntervalMs(): Long = config.effectiveIntervalSeconds() * 1000L

    private fun startTicking() {
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, tickIntervalMs())
    }

    private fun scheduleSend(reason: String, force: Boolean = false) {
        if (!config.isUsable()) {
            setStatus("Add a server URL and token")
            return
        }
        val location = lastKnown
        if (location == null) {
            setStatus("Waiting for a GPS fix")
            return
        }

        val now = System.currentTimeMillis()
        if (!force && now - lastSentAtMs < DEBOUNCE_MS) return

        queue.add(toPosition(location))
        flushQueue()
        LogStore.append(this, "queued a $reason report")
    }

    private fun toPosition(location: Location): Position = Position(
        latitude = location.latitude,
        longitude = location.longitude,
        timestampMs = System.currentTimeMillis(),
        accuracy = if (location.hasAccuracy()) location.accuracy else null,
        altitude = if (location.hasAltitude()) location.altitude else null,
        speed = if (location.hasSpeed()) location.speed else null,
        bearing = if (location.hasBearing()) location.bearing else null,
        battery = DeviceStatus.batteryPercent(this),
        provider = location.provider,
    )

    private fun flushQueue() {
        val currentConfig = config
        if (!currentConfig.isUsable()) return
        if (!sendInFlight.compareAndSet(false, true)) return

        sender.execute {
            var resend = false
            try {
                val pending = queue.snapshot()
                if (pending.isEmpty()) {
                    setStatus("Idle — nothing queued")
                    return@execute
                }

                val delivered = ArrayList<String>(pending.size)
                var failure: ReportSender.Result? = null

                for (position in pending.take(MAX_REPORTS_PER_FLUSH)) {
                    val result = ReportSender.send(currentConfig, position)
                    if (result.success) {
                        delivered.add(position.id)
                        sentCount += 1
                        lastSentAtMs = System.currentTimeMillis()
                        configStore.recordResult(true, result.message, lastSentAtMs)
                        LogStore.append(
                            this@TrackerService,
                            "sent " +
                                UrlFactory.formatDouble(position.latitude, 5) + "," +
                                UrlFactory.formatDouble(position.longitude, 5) +
                                " → " + result.message,
                        )
                    } else {
                        failure = result
                        if (result.permanent) {
                            // 4xx: this point will never be accepted, do not let
                            // it block everything behind it.
                            delivered.add(position.id)
                        }
                        break
                    }
                }

                if (delivered.isNotEmpty()) {
                    queue.removeAll(delivered)
                }

                val remaining = queue.size()
                val failed = failure
                if (failed == null) {
                    setStatus(
                        if (remaining == 0) {
                            "Synced — $sentCount report(s) sent"
                        } else {
                            "$remaining report(s) queued"
                        },
                    )
                } else {
                    configStore.recordResult(false, failed.message, System.currentTimeMillis())
                    LogStore.append(this@TrackerService, "send failed → ${failed.message}")
                    setStatus(
                        "Send failed — ${failed.message}" +
                            if (remaining > 0) " · $remaining queued" else "",
                    )
                }
                // A fix may have arrived while this batch was in flight; drain
                // it now instead of waiting a whole interval for the next tick.
                resend = failed == null && remaining > 0
            } catch (error: Exception) {
                LogStore.append(this@TrackerService, "unexpected send error: ${error.message}")
            } finally {
                sendInFlight.set(false)
            }
            if (resend) {
                flushQueue()
            }
        }
    }

    // ── lifecycle helpers ────────────────────────────────────────────────────

    private fun stopTracking() {
        configStore.trackingEnabled = false
        handler.removeCallbacksAndMessages(null)
        runCatching { locationManager.removeUpdates(locationListener) }
        cancelAlarm()
        LogStore.append(this, "tracking stopped")
        lastStatus = "Tracking stopped"
        stopForeground(Service.STOP_FOREGROUND_REMOVE)
        foregroundStarted = false
        stopSelf()
    }

    private fun scheduleAlarm() {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val pending = alarmIntent()
        runCatching {
            alarmManager.setInexactRepeating(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + ALARM_INTERVAL_MS,
                ALARM_INTERVAL_MS,
                pending,
            )
        }
    }

    private fun cancelAlarm() {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        runCatching { alarmManager.cancel(alarmIntent()) }
    }

    private fun alarmIntent(): PendingIntent {
        val intent = Intent(this, TrackerAlarmReceiver::class.java)
            .setAction(TrackerAlarmReceiver.ACTION_TICK)
        return PendingIntent.getBroadcast(this, ALARM_REQUEST_CODE, intent, pendingIntentFlags())
    }

    // ── notification ─────────────────────────────────────────────────────────

    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun startForegroundCompat(): Boolean {
        if (foregroundStarted) return true
        return try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            foregroundStarted = true
            true
        } catch (error: Exception) {
            LogStore.append(this, "foreground start failed: ${error.message}")
            false
        }
    }

    private fun setStatus(text: String) {
        lastStatus = text
        updateNotification()
    }

    private fun updateNotification() {
        if (!foregroundStarted) return
        runCatching {
            val manager = getSystemService(NotificationManager::class.java)
            manager?.notify(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun buildNotification(): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            pendingIntentFlags(),
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, TrackerService::class.java).setAction(ACTION_STOP),
            pendingIntentFlags(),
        )
        val sendNow = PendingIntent.getService(
            this,
            2,
            Intent(this, TrackerService::class.java).setAction(ACTION_SEND_NOW),
            pendingIntentFlags(),
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_pin)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(lastStatus)
            .setStyle(NotificationCompat.BigTextStyle().bigText(lastStatus))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setContentIntent(openApp)
            .addAction(0, getString(R.string.action_send_now), sendNow)
            .addAction(0, getString(R.string.action_stop), stop)
            .build()
    }

    private fun pendingIntentFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    companion object {
        const val ACTION_START = "com.trailpin.tracker.action.START"
        const val ACTION_STOP = "com.trailpin.tracker.action.STOP"
        const val ACTION_SEND_NOW = "com.trailpin.tracker.action.SEND_NOW"
        const val ACTION_FLUSH = "com.trailpin.tracker.action.FLUSH"

        private const val CHANNEL_ID = "tracking"
        private const val NOTIFICATION_ID = 4711
        private const val DEBOUNCE_MS = 8_000L
        private const val MAX_REPORTS_PER_FLUSH = 25
        private const val ALARM_INTERVAL_MS = 15 * 60 * 1000L
        private const val ALARM_REQUEST_CODE = 1001

        /** Starts (or re-arms) tracking. Safe to call from anywhere. */
        fun start(context: Context) = dispatch(context, ACTION_START)

        /** Stops tracking and removes the notification. */
        fun stop(context: Context) = dispatch(context, ACTION_STOP)

        /** Sends the last known fix right now. */
        fun sendNow(context: Context) = dispatch(context, ACTION_SEND_NOW)

        private fun dispatch(context: Context, action: String) {
            val intent = Intent(context, TrackerService::class.java).setAction(action)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (error: Exception) {
                LogStore.append(context, "could not start the service ($action): ${error.message}")
            }
        }
    }
}
