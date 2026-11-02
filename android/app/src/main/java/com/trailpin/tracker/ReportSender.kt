package com.trailpin.tracker

import java.net.HttpURLConnection
import java.net.URL

/**
 * Performs exactly one report: build the URL, open the connection, read the
 * status code, done. No retries here — the service owns retry policy because it
 * owns the queue.
 *
 * Plain [HttpURLConnection] is used on purpose. It speaks both `http://` and
 * `https://`, it is part of the platform, and it adds no dependency to an app
 * whose whole job is "put a string on the wire".
 */
object ReportSender {

    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 20_000
    private const val MAX_BODY_CHARS = 400
    private const val USER_AGENT = "TrailPin/1.0 (Android)"

    /**
     * @param success 2xx — the point can leave the queue.
     * @param permanent 4xx other than 408/429 — retrying the same point will
     *   never succeed, so drop it instead of blocking the queue forever.
     */
    data class Result(
        val success: Boolean,
        val code: Int,
        val url: String,
        val message: String,
        val permanent: Boolean,
    )

    fun send(config: TrackerConfig, position: Position): Result {
        val url = UrlFactory.endpointUrl(config, position)
            ?: return Result(
                success = false,
                code = 0,
                url = "",
                message = "No server URL configured",
                permanent = true,
            )

        var connection: HttpURLConnection? = null
        return try {
            val http = URL(url).openConnection() as HttpURLConnection
            connection = http

            http.requestMethod = if (config.method == HttpMethod.GET) "GET" else "POST"
            http.connectTimeout = CONNECT_TIMEOUT_MS
            http.readTimeout = READ_TIMEOUT_MS
            http.instanceFollowRedirects = true
            http.useCaches = false
            http.setRequestProperty("User-Agent", USER_AGENT)
            http.setRequestProperty("Accept", "application/json, text/plain, */*")

            if (config.method != HttpMethod.GET) {
                val contentType: String
                val body: String
                when (config.method) {
                    HttpMethod.POST_FORM -> {
                        contentType = "application/x-www-form-urlencoded; charset=utf-8"
                        body = UrlFactory.formBody(config, position)
                    }
                    HttpMethod.POST_JSON -> {
                        contentType = "application/json; charset=utf-8"
                        body = UrlFactory.jsonBody(config, position)
                    }
                    HttpMethod.GET -> {
                        contentType = ""
                        body = ""
                    }
                }
                val bytes = body.toByteArray(Charsets.UTF_8)
                http.doOutput = true
                http.setRequestProperty("Content-Type", contentType)
                http.setFixedLengthStreamingMode(bytes.size)
                http.outputStream.use { stream -> stream.write(bytes) }
            }

            val code = http.responseCode
            val stream = if (code in 200..299) http.inputStream else http.errorStream
            val body = try {
                stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            } catch (_: Exception) {
                ""
            }

            val success = code in 200..299
            Result(
                success = success,
                code = code,
                url = url,
                message = describe(code, body),
                permanent = !success && code in 400..499 && code != 408 && code != 429,
            )
        } catch (error: Exception) {
            Result(
                success = false,
                code = 0,
                url = url,
                message = "${error.javaClass.simpleName}: ${error.message ?: "no details"}",
                permanent = false,
            )
        } finally {
            connection?.disconnect()
        }
    }

    /** Compact, log-friendly description of what the server said. */
    fun describe(code: Int, body: String): String {
        val collapsed = body.trim().replace(Regex("\\s+"), " ")
        val clipped = if (collapsed.length > MAX_BODY_CHARS) {
            collapsed.take(MAX_BODY_CHARS) + "…"
        } else {
            collapsed
        }
        return if (clipped.isEmpty()) "HTTP $code" else "HTTP $code — $clipped"
    }
}
