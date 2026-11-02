package com.trailpin.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the tracker every fifteen minutes.
 *
 * Android is allowed to kill a foreground service under memory pressure, and
 * Doze delays timers. A repeating alarm is the cheapest way to notice that the
 * service is gone and start it again without needing the app to be opened.
 */
class TrackerAlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TICK) return

        val configStore = ConfigStore(context)
        if (!configStore.trackingEnabled || !configStore.load().isUsable()) {
            return
        }
        TrackerService.start(context)
    }

    companion object {
        const val ACTION_TICK = "com.trailpin.tracker.action.ALARM_TICK"
    }
}
