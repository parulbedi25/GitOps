package com.trailpin.tracker

import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

/**
 * Which scheme the report URL should use.
 *
 * [AUTO] is the default: whatever the user typed wins, and when the URL has no
 * scheme at all we guess — plain `http` for LAN addresses and `localhost`,
 * `https` for everything else.
 */
enum class Protocol(val scheme: String) {
    AUTO(""),
    HTTP("http"),
    HTTPS("https"),
    ;

    companion object {
        fun fromName(value: String?): Protocol = values().firstOrNull { it.name == value } ?: AUTO
    }
}

/** How a report is handed to the server. */
enum class HttpMethod(val label: String) {
    GET("GET — query string"),
    POST_FORM("POST — form encoded"),
    POST_JSON("POST — JSON body"),
    ;

    companion object {
        fun fromName(value: String?): HttpMethod = values().firstOrNull { it.name == value } ?: GET
    }
}

/**
 * Everything the tracker needs to turn a GPS fix into one HTTP request.
 *
 * The whole point of this class is that it is plain data: it can be built from
 * the settings screen, from [ConfigStore], or from a unit test without touching
 * Android at all.
 */
data class TrackerConfig(
    val serverUrl: String = "",
    val apiPath: String = "/api/location",
    val token: String = "",
    val tokenParam: String = "token",
    val method: HttpMethod = HttpMethod.GET,
    val protocol: Protocol = Protocol.AUTO,
    val deviceId: String = "",
    val intervalSeconds: Int = 60,
    val distanceMeters: Int = 25,
    val heartbeat: Boolean = true,
    val startOnBoot: Boolean = false,
) {
    /** True when there is enough configuration to actually report something. */
    fun isUsable(): Boolean = serverUrl.isNotBlank() && token.isNotBlank()

    /** Interval clamped to something a battery can survive. */
    fun effectiveIntervalSeconds(): Int = intervalSeconds.coerceIn(MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)

    /** Distance filter clamped to something a GPS receiver understands. */
    fun effectiveDistanceMeters(): Float = distanceMeters.coerceIn(0, MAX_DISTANCE_METERS).toFloat()

    companion object {
        const val MIN_INTERVAL_SECONDS = 5
        const val MAX_INTERVAL_SECONDS = 3600
        const val MAX_DISTANCE_METERS = 100_000

        fun newDeviceId(): String =
            "tp-" + UUID.randomUUID().toString().replace("-", "").take(8)
    }
}

/**
 * Tiny SharedPreferences wrapper.
 *
 * Preferences are the only state the tracker keeps: the configuration, whether
 * tracking is supposed to be running, and the result of the last report (so the
 * UI still has something to show after the service is killed).
 */
class ConfigStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun load(): TrackerConfig {
        val deviceId = prefs.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() }
            ?: TrackerConfig.newDeviceId().also { prefs.edit().putString(KEY_DEVICE_ID, it).apply() }

        return TrackerConfig(
            serverUrl = prefs.getString(KEY_SERVER_URL, "") ?: "",
            apiPath = prefs.getString(KEY_API_PATH, DEFAULT_API_PATH) ?: DEFAULT_API_PATH,
            token = prefs.getString(KEY_TOKEN, "") ?: "",
            tokenParam = prefs.getString(KEY_TOKEN_PARAM, DEFAULT_TOKEN_PARAM) ?: DEFAULT_TOKEN_PARAM,
            method = HttpMethod.fromName(prefs.getString(KEY_METHOD, null)),
            protocol = Protocol.fromName(prefs.getString(KEY_PROTOCOL, null)),
            deviceId = deviceId,
            intervalSeconds = prefs.getInt(KEY_INTERVAL, DEFAULT_INTERVAL_SECONDS),
            distanceMeters = prefs.getInt(KEY_DISTANCE, DEFAULT_DISTANCE_METERS),
            heartbeat = prefs.getBoolean(KEY_HEARTBEAT, true),
            startOnBoot = prefs.getBoolean(KEY_START_ON_BOOT, false),
        )
    }

    fun save(config: TrackerConfig) {
        prefs.edit()
            .putString(KEY_SERVER_URL, config.serverUrl.trim())
            .putString(KEY_API_PATH, config.apiPath.trim())
            .putString(KEY_TOKEN, config.token.trim())
            .putString(KEY_TOKEN_PARAM, config.tokenParam.trim().ifEmpty { DEFAULT_TOKEN_PARAM })
            .putString(KEY_METHOD, config.method.name)
            .putString(KEY_PROTOCOL, config.protocol.name)
            .putString(KEY_DEVICE_ID, config.deviceId.trim().ifEmpty { TrackerConfig.newDeviceId() })
            .putInt(KEY_INTERVAL, config.effectiveIntervalSeconds())
            .putInt(KEY_DISTANCE, config.distanceMeters.coerceIn(0, TrackerConfig.MAX_DISTANCE_METERS))
            .putBoolean(KEY_HEARTBEAT, config.heartbeat)
            .putBoolean(KEY_START_ON_BOOT, config.startOnBoot)
            .apply()
    }

    /** Whether tracking *should* be running; the service flips this off on stop. */
    var trackingEnabled: Boolean
        get() = prefs.getBoolean(KEY_TRACKING, false)
        set(value) {
            prefs.edit().putBoolean(KEY_TRACKING, value).apply()
        }

    fun recordResult(success: Boolean, summary: String, atMs: Long) {
        prefs.edit()
            .putBoolean(KEY_LAST_SUCCESS, success)
            .putString(KEY_LAST_SUMMARY, summary)
            .putLong(KEY_LAST_AT, atMs)
            .apply()
    }

    fun lastSummary(): String = prefs.getString(KEY_LAST_SUMMARY, "") ?: ""

    fun lastSucceeded(): Boolean = prefs.getBoolean(KEY_LAST_SUCCESS, false)

    fun lastAtMs(): Long = prefs.getLong(KEY_LAST_AT, 0L)

    companion object {
        const val DEFAULT_API_PATH = "/api/location"
        const val DEFAULT_TOKEN_PARAM = "token"
        const val DEFAULT_INTERVAL_SECONDS = 60
        const val DEFAULT_DISTANCE_METERS = 25

        private const val PREFS_NAME = "trailpin"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_API_PATH = "api_path"
        private const val KEY_TOKEN = "token"
        private const val KEY_TOKEN_PARAM = "token_param"
        private const val KEY_METHOD = "method"
        private const val KEY_PROTOCOL = "protocol"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_INTERVAL = "interval_seconds"
        private const val KEY_DISTANCE = "distance_meters"
        private const val KEY_HEARTBEAT = "heartbeat"
        private const val KEY_START_ON_BOOT = "start_on_boot"
        private const val KEY_TRACKING = "tracking"
        private const val KEY_LAST_SUCCESS = "last_success"
        private const val KEY_LAST_SUMMARY = "last_summary"
        private const val KEY_LAST_AT = "last_at"
    }
}
