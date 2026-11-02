package com.trailpin.tracker

import org.json.JSONObject
import java.util.UUID

/**
 * One location fix, in the shape the server expects:
 * `lat`, `lon`, `tst` (epoch seconds) plus whatever accuracy the device could
 * give us. The extra `id` only exists so the offline queue can deduplicate what
 * it already delivered — it is never sent to the server.
 */
data class Position(
    val latitude: Double,
    val longitude: Double,
    val timestampMs: Long,
    val accuracy: Float? = null,
    val altitude: Double? = null,
    val speed: Float? = null,
    val bearing: Float? = null,
    val battery: Int? = null,
    val provider: String? = null,
    val id: String = UUID.randomUUID().toString(),
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
        json.put("lat", latitude)
        json.put("lon", longitude)
        json.put("tst", timestampMs / 1000L)
        accuracy?.let { json.put("acc", it) }
        altitude?.let { json.put("alt", it) }
        speed?.let { json.put("vel", it) }
        bearing?.let { json.put("bear", it) }
        battery?.let { json.put("batt", it) }
        provider?.takeIf { it.isNotBlank() }?.let { json.put("prov", it) }
        json.put("id", id)
        return json
    }

    companion object {
        fun fromJson(json: JSONObject?): Position? {
            if (json == null || !json.has("lat") || !json.has("lon")) return null
            return try {
                Position(
                    latitude = json.getDouble("lat"),
                    longitude = json.getDouble("lon"),
                    timestampMs = json.optLong("tst", 0L) * 1000L,
                    accuracy = json.optFloatOrNull("acc"),
                    altitude = json.optDoubleOrNull("alt"),
                    speed = json.optFloatOrNull("vel"),
                    bearing = json.optFloatOrNull("bear"),
                    battery = json.optIntOrNull("batt"),
                    provider = json.optStringOrNull("prov"),
                    id = json.optString("id", UUID.randomUUID().toString()),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}

internal fun JSONObject.optFloatOrNull(key: String): Float? =
    if (has(key) && !isNull(key)) optDouble(key).toFloat() else null

internal fun JSONObject.optDoubleOrNull(key: String): Double? =
    if (has(key) && !isNull(key)) optDouble(key) else null

internal fun JSONObject.optIntOrNull(key: String): Int? =
    if (has(key) && !isNull(key)) optInt(key) else null

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotBlank() } else null
