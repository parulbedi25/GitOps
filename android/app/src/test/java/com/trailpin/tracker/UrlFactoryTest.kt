package com.trailpin.tracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The request URL is the contract between this app and the user's server, so it
 * is pinned down here, character for character.
 */
class UrlFactoryTest {

    private val config = TrackerConfig(
        serverUrl = "https://example.com",
        apiPath = "/api/location",
        token = "s3cret",
        deviceId = "tp-abc12345",
    )

    private val position = Position(
        latitude = 31.326,
        longitude = 75.576,
        timestampMs = 1_762_040_000_000L,
        accuracy = 8f,
        battery = 87,
        provider = "gps",
    )

    @Test
    fun `explicit scheme is respected in auto mode`() {
        assertEquals("https://example.com", UrlFactory.normalizeBase("https://example.com/", Protocol.AUTO))
        assertEquals("http://example.com", UrlFactory.normalizeBase("http://example.com", Protocol.AUTO))
    }

    @Test
    fun `bare public host defaults to https`() {
        assertEquals("https://example.com", UrlFactory.normalizeBase("example.com", Protocol.AUTO))
        assertEquals("https://track.example.org:8443", UrlFactory.normalizeBase("track.example.org:8443", Protocol.AUTO))
    }

    @Test
    fun `bare local host defaults to http`() {
        assertEquals("http://192.168.1.10:8080", UrlFactory.normalizeBase("192.168.1.10:8080", Protocol.AUTO))
        assertEquals("http://localhost:3000", UrlFactory.normalizeBase("localhost:3000", Protocol.AUTO))
        assertEquals("http://my-nas.local", UrlFactory.normalizeBase("my-nas.local", Protocol.AUTO))
    }

    @Test
    fun `protocol switch overrides whatever was typed`() {
        assertEquals("http://example.com", UrlFactory.normalizeBase("https://example.com", Protocol.HTTP))
        assertEquals("https://192.168.1.10:8080", UrlFactory.normalizeBase("192.168.1.10:8080", Protocol.HTTPS))
    }

    @Test
    fun `empty input produces no url`() {
        assertNull(UrlFactory.normalizeBase("", Protocol.AUTO))
        assertNull(UrlFactory.normalizeBase("   ", Protocol.AUTO))
        assertNull(UrlFactory.normalizeBase("/", Protocol.AUTO))
        assertNull(UrlFactory.endpointUrl(config.copy(serverUrl = ""), position))
    }

    @Test
    fun `api path gets exactly one leading slash`() {
        assertEquals("/api/location", UrlFactory.normalizePath("api/location"))
        assertEquals("/api/location", UrlFactory.normalizePath("/api/location"))
        assertEquals("", UrlFactory.normalizePath("   "))
    }

    @Test
    fun `report url carries token and coordinates`() {
        assertEquals(
            "https://example.com/api/location?token=s3cret&lat=31.326000&lon=75.576000" +
                "&tid=tp-abc12345&tst=1762040000&acc=8.0&batt=87&prov=gps",
            UrlFactory.endpointUrl(config, position),
        )
    }

    @Test
    fun `token parameter name is configurable`() {
        val renamed = config.copy(tokenParam = "key")
        val url = UrlFactory.endpointUrl(renamed, position).orEmpty()
        assertTrue(url.startsWith("https://example.com/api/location?key=s3cret&"))
    }

    @Test
    fun `blank token parameter falls back to token`() {
        assertEquals("token", UrlFactory.tokenParam(config.copy(tokenParam = "  ")))
    }

    @Test
    fun `values are url encoded`() {
        val awkward = config.copy(token = "a b&c/d", deviceId = "phone one")
        val url = UrlFactory.endpointUrl(awkward, position).orEmpty()
        assertTrue(url.contains("token=a+b%26c%2Fd"))
        assertTrue(url.contains("tid=phone+one"))
    }

    @Test
    fun `server path is kept when the url has one`() {
        val prefixed = config.copy(serverUrl = "https://example.com/tracker", apiPath = "api/location")
        assertEquals(
            "https://example.com/tracker/api/location",
            UrlFactory.endpointUrl(prefixed, position).orEmpty().substringBefore('?'),
        )
    }

    @Test
    fun `post form body has coordinates but not the token`() {
        val body = UrlFactory.formBody(config, position)
        assertEquals("lat=31.326000&lon=75.576000&tid=tp-abc12345&tst=1762040000&acc=8.0&batt=87&prov=gps", body)
        assertFalse(body.contains("s3cret"))
    }

    @Test
    fun `local detection covers the usual private ranges`() {
        listOf(
            "localhost",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.0.2",
            "172.16.4.4",
            "172.31.255.1",
            "169.254.1.2",
            "printer.local",
            "server.lan",
            "box.internal",
        ).forEach { host ->
            assertTrue("$host should be local", UrlFactory.looksLocal(host))
        }

        listOf("example.com", "8.8.8.8", "172.32.0.1", "track.example.org").forEach { host ->
            assertFalse("$host should be public", UrlFactory.looksLocal(host))
        }
    }
}
