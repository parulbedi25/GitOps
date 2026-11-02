package com.trailpin.tracker

import android.content.Context
import android.os.BatteryManager

/** The handful of device facts that travel with every report. */
object DeviceStatus {

    /** Battery percentage, or null when the device cannot tell us. */
    fun batteryPercent(context: Context): Int? {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        val level = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }
}
