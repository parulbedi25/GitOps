package com.trailpin.tracker

import java.util.Locale
import java.net.URLEncoder

/**
 * Turns a [TrackerConfig] plus one [Position] into the exact URL that is called.
 *
 * This is deliberately the simplest thing that can work, because that is the
 * requirement: the server URL, the API path, the token and the coordinates are
 * concatenated into a single query string.
 *
 * ```
 * https://example.com/api/location?token=s3cret&lat=31.326000&lon=75.576000
 *                               &tid=tp-1a2b3c4d&tst=1762040000&acc=8.0&batt=87&prov=gps
 * ```
 *
 * Both schemes are supported. When the user types a bare host we pick one:
 * `http` for LAN / loopback / `.local` names (where TLS certificates are rarely
 * available), `https` for public hosts. An explicit scheme in the URL is always
 * respected unless the protocol switch forces one.
 *
 * Nothing here touches Android, so the whole class is unit-testable on the JVM.
 */
object UrlFactory {

    /** Builds `scheme://host[:port][/path]`, or null when [serverUrl] is empty. */
    fun normalizeBase(serverUrl: String, protocol: Protocol): String? {
        var base = serverUrl.trim()
        if (base.isEmpty()) return null
        base = base.trimEnd('/', '?', '#', ' ')
        if (base.isEmpty()) return null

        val lower = base.lowercase(Locale.US)
        val explicitScheme = when {
            lower.startsWith("http://") -> "http://"
            lower.startsWith("https://") -> "https://"
            else -> null
        }

        val host = if (explicitScheme != null) base.substring(explicitScheme.length) else base
        if (host.isEmpty()) return null

        val scheme = when {
            explicitScheme == null -> protocol.scheme.ifEmpty { if (looksLocal(host)) "http" else "https" }
            protocol == Protocol.AUTO -> explicitScheme.removeSuffix("://")
            else -> protocol.scheme
        }
        return "$scheme://$host"
    }

    /** Makes sure the API path starts with exactly one slash (or is empty). */
    fun normalizePath(apiPath: String): String {
        val path = apiPath.trim()
        return when {
            path.isEmpty() -> ""
            path.startsWith("/") -> path
            else -> "/$path"
        }
    }

    /** The token query parameter name, defaulting to `token` when left blank. */
    fun tokenParam(config: TrackerConfig): String =
        config.tokenParam.trim().ifEmpty { ConfigStore.DEFAULT_TOKEN_PARAM }

    /**
     * The complete report URL, or null when the configuration has no server.
     * This is what [ReportSender] calls and what the settings screen previews.
     */
    fun endpointUrl(config: TrackerConfig, position: Position): String? {
        val base = normalizeBase(config.serverUrl, config.protocol) ?: return null
        val path = normalizePath(config.apiPath)
        return base + path + "?" + queryString(config, position)
    }

    /** `token=…&lat=…&lon=…` — token first so it is easy to spot in a log. */
    fun queryString(config: TrackerConfig, position: Position): String {
        val params = LinkedHashMap<String, String>()
        if (config.token.isNotBlank()) {
            params[tokenParam(config)] = config.token
        }
        params.putAll(reportFields(config, position))
        return encode(params)
    }

    /** The coordinate fields, without the token. */
    fun reportFields(config: TrackerConfig, position: Position): Map<String, String> {
        val fields = LinkedHashMap<String, String>()
        fields["lat"] = formatDouble(position.latitude, 6)
        fields["lon"] = formatDouble(position.longitude, 6)
        fields["tid"] = config.deviceId.trim()
        fields["tst"] = (position.timestampMs / 1000L).toString()
        position.accuracy?.let { fields["acc"] = formatDouble(it.toDouble(), 1) }
        position.altitude?.let { fields["alt"] = formatDouble(it, 1) }
        position.speed?.let { fields["vel"] = formatDouble(it.toDouble(), 2) }
        position.bearing?.let { fields["bear"] = formatDouble(it.toDouble(), 1) }
        position.battery?.let { fields["batt"] = it.toString() }
        position.provider?.takeIf { it.isNotBlank() }?.let { fields["prov"] = it }
        return fields
    }

    /** Body for `POST` with `Content-Type: application/x-www-form-urlencoded`. */
    fun formBody(config: TrackerConfig, position: Position): String =
        encode(reportFields(config, position))

    /** Body for `POST` with `Content-Type: application/json`. */
    fun jsonBody(config: TrackerConfig, position: Position): String {
        val json = position.toJson()
        json.put("tid", config.deviceId.trim())
        json.put(tokenParam(config), config.token)
        return json.toString()
    }

    /**
     * True for hosts that are almost certainly on a local network: loopback,
     * RFC1918 ranges, link-local, `.local` / `.lan` / `.internal` names.
     */
    fun looksLocal(value: String): Boolean {
        var host = value.trim()
        if (host.contains("://")) host = host.substringAfter("://")
        host = host.substringBefore('/').substringBefore('?').substringBefore('#')
        host = host.substringAfterLast('@') // strip credentials
        if (host.startsWith("[")) {
            host = host.substringAfter("[").substringBefore("]")
        } else {
            host = host.substringBefore(':') // strip port
        }
        val name = host.lowercase(Locale.US)
        if (name.isEmpty()) return false
        if (name == "localhost" || name == "::1" || name == "0.0.0.0") return true
        if (name.endsWith(".local") || name.endsWith(".lan") || name.endsWith(".internal")) return true
        if (name.endsWith(".home.arpa")) return true

        val parts = name.split('.')
        if (parts.size == 4 && parts.all { it.toIntOrNull() != null }) {
            val first = parts[0].toInt()
            val second = parts[1].toInt()
            return when {
                first == 10 || first == 127 -> true
                first == 192 && second == 168 -> true
                first == 172 && second in 16..31 -> true
                first == 169 && second == 254 -> true
                else -> false
            }
        }
        // A raw IPv6 literal (contains ':') is local or unusual — prefer http.
        return name.contains(':')
    }

    fun encode(params: Map<String, String>): String =
        params.entries.joinToString("&") { (key, value) -> "${urlEncode(key)}=${urlEncode(value)}" }

    fun urlEncode(value: String): String = URLEncoder.encode(value, "UTF-8")

    fun formatDouble(value: Double, decimals: Int): String =
        String.format(Locale.US, "%.${decimals}f", value)
}
