package com.trailpin.tracker

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A rotating text log the app can show on screen.
 *
 * Kept in a file rather than in memory on purpose: the interesting failures
 * (no signal, DNS failure, a server that answers 500) usually happen while the
 * service is running in the background, and the user only opens the app
 * afterwards.
 */
object LogStore {

    private const val FILE_NAME = "trailpin.log"
    private const val MAX_LINES = 300
    private val lock = Any()

    private fun file(context: Context) = File(context.applicationContext.filesDir, FILE_NAME)

    fun append(context: Context, message: String) {
        synchronized(lock) {
            try {
                val target = file(context)
                val stamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
                target.appendText("$stamp  $message\n")
                val lines = target.readLines()
                if (lines.size > MAX_LINES) {
                    target.writeText(lines.takeLast(MAX_LINES).joinToString("\n", postfix = "\n"))
                }
            } catch (_: Exception) {
                // Logging must never be the reason a report fails.
            }
        }
    }

    fun read(context: Context): String = synchronized(lock) {
        runCatching { file(context).readText() }.getOrDefault("")
    }

    fun clear(context: Context) = synchronized(lock) {
        runCatching { file(context).delete() }
        Unit
    }
}
