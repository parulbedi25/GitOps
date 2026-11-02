package com.trailpin.tracker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Resumes tracking after a reboot or an app update, when the user asked for it.
 *
 * Nothing else is started here: if the toggle is off, or the location
 * permission was revoked, the receiver stays silent.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
            else -> return
        }

        val config = ConfigStore(context).load()
        if (!config.startOnBoot || !config.isUsable()) {
            return
        }

        LogStore.append(context, "boot: resuming tracking")
        TrackerService.start(context)
    }
}
