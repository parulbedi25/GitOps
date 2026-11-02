package com.trailpin.tracker

import android.content.Context
import org.json.JSONArray
import java.io.File

/**
 * A small on-disk queue of fixes that have not reached the server yet.
 *
 * Phones lose signal, servers restart, tokens get rotated — when a report fails
 * the fix has to survive the failure, so it is written to a JSON file and
 * retried on the next tick. The queue is capped at [MAX_POINTS]; the oldest
 * points are dropped first, because a trail is only useful while it is recent.
 */
class PendingQueue(context: Context) {

    private val file = File(context.applicationContext.filesDir, FILE_NAME)
    private val lock = Any()

    fun snapshot(): List<Position> = synchronized(lock) { load() }

    fun size(): Int = synchronized(lock) { load().size }

    fun add(position: Position) = synchronized(lock) {
        val items = load().toMutableList()
        items.add(position)
        while (items.size > MAX_POINTS) {
            items.removeAt(0)
        }
        save(items)
    }

    fun removeAll(ids: Collection<String>) = synchronized(lock) {
        if (ids.isEmpty()) return@synchronized
        val keep = load().filterNot { it.id in ids }
        save(keep)
    }

    fun clear() = synchronized(lock) {
        runCatching { file.delete() }
    }

    private fun load(): List<Position> {
        if (!file.exists()) return emptyList()
        return try {
            val array = JSONArray(file.readText())
            (0 until array.length()).mapNotNull { index ->
                Position.fromJson(array.optJSONObject(index))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun save(items: List<Position>) {
        try {
            val array = JSONArray()
            items.forEach { array.put(it.toJson()) }
            file.writeText(array.toString())
        } catch (_: Exception) {
            // A full disk must never take the tracker down; the next fix retries.
        }
    }

    companion object {
        private const val FILE_NAME = "pending-reports.json"
        private const val MAX_POINTS = 500
    }
}
