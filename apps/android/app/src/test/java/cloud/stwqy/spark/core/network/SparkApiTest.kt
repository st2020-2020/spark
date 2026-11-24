package cloud.stwqy.spark.core.network

import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.WebViewCookieCredentialProvider
import cloud.stwqy.spark.feature.workspace.BridgeFailure
import cloud.stwqy.spark.feature.workspace.copyExport
import cloud.stwqy.spark.feature.workspace.DocumentFileActions
import cloud.stwqy.spark.feature.workspace.verifyFileSession
import cloud.stwqy.spark.feature.workspace.withFileOperation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.net.InetAddress
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicBoolean

class SparkApiTest {
    private val server = MockWebServer()
    @get:Rule val temporary = TemporaryFolder()
    private val origin by lazy { server.url("/").newBuilder().host("127.0.0.1").build() }
    private val client by lazy { SparkApiClient(origin, allowCleartext = true) }

    @Before fun startServer() = server.start(InetAddress.getByName("127.0.0.1"), 0)

    @After fun stopServer() = server.shutdown()

    @Test fun writesUseTheSameCookieThatVerifiedSessionAndUuidForIdempotency(): Unit = runBlocking {
        val account = verify()
        val replacement = SessionScope.fromCookie("spark_session=test-replacement")
        assertEquals("spark_session=test-replacement", replacement.requestHeaders["Cookie"])
        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"id":"$key"}"""))

        val result = client.createCollection(account, CollectionPayload.encode(key, "正文"))
        assertEquals(key, result.id)
        val request = requireNotNull(server.takeRequest(5, SECONDS))
        assertEquals("POST", request.method)
        assertEquals("/api/v1/collections", request.path)
        assertEquals("application/json", request.getHeader("Accept"))
        assertEquals("spark_session=test-session", request.getHeader("Cookie"))
        assertEquals("test-csrf", request.getHeader("X-CSRF-Token"))
        assertEquals(origin.toString().removeSuffix("/"), request.getHeader("Origin"))
        assertEquals(key, request.getHeader("Idempotency-Key"))
        assertEquals(key, Json.parseToJsonElement(request.body.readUtf8()).jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test fun apiDoesNotFollowRedirects(): Unit = runBlocking {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/unexpected"))
        server.enqueue(MockResponse().setResponseCode(500))
        val error = apiFailure { client.session(SessionScope.fromCookie("spark_session=synthetic")) }
        assertEquals(302, error.status)
        assertEquals(1, server.requestCount)
    }

    @Test fun uploadSendsGrantHeadersAndBytesWithoutSparkCredentials(): Unit = runBlocking {
        val account = verify()
        val signedUrl = origin.resolve("/signed")
        val grantBody = """
            {
                "id":"$key", "method":"PUT", "url":"$signedUrl",
                "headers":{"Content-Type":"image/png","X-Test-Grant":"only-for-object-storage"},
                "expires_at":"2026-11-23T00:00:00Z"
            }
        """.trimIndent()
        server.enqueue(MockResponse().setResponseCode(201).setBody(grantBody))
        val grant = client.requestUpload(account, key, UploadRequest("图.png", 8, "image/png"))
        val reservation = requireNotNull(server.takeRequest(5, SECONDS))
        assertEquals("/api/v1/uploads", reservation.path)
        assertEquals(key, reservation.getHeader("Idempotency-Key"))
        assertEquals("test-csrf", reservation.getHeader("X-CSRF-Token"))
        assertEquals(
            setOf("filename", "size_bytes", "mime_type"),
            Json.parseToJsonElement(reservation.body.readUtf8()).jsonObject.keys,
        )
        val bytes = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
        val file = temporary.newFile().apply { writeBytes(bytes) }
        server.enqueue(MockResponse().setResponseCode(204))
        client.putUpload(grant, file)

        val put = requireNotNull(server.takeRequest(5, SECONDS))
        assertEquals("PUT", put.method)
        assertEquals("/signed", put.path)
        assertEquals("image/png", put.getHeader("Content-Type"))
        assertEquals("only-for-object-storage", put.getHeader("X-Test-Grant"))
        assertEquals("8", put.getHeader("Content-Length"))
        for (name in listOf("Cookie", "Origin", "X-CSRF-Token", "Idempotency-Key")) {
            assertNull(put.getHeader(name))
        }
        assertArrayEquals(bytes, put.body.readByteArray())
        val unsafe = UploadGrant(grant.id, "PUT", grant.url, mapOf("Cookie" to "test-only"), grant.expiresAt)
        assertEquals("invalid_response", apiFailure { client.putUpload(unsafe, file) }.code)
        assertEquals(3, server.requestCount)
    }

    @Test fun exportStreamsZipAndReturnsRetryAfterWithoutWritingOnFailure(): Unit = runBlocking {
        val account = verify()
        val bytes = ByteArray(128 * 1024) { it.toByte() }
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/zip")
                .setHeader("Content-Disposition", "attachment; filename=test.zip")
                .setChunkedBody(Buffer().write(bytes), 4096),
        )
        val output = temporary.newFile()
        client.export(account, ExportFormat.JSON) { input, header ->
            assertEquals("attachment; filename=test.zip", header)
            output.outputStream().use { copyExport(input, it, availableBytes = { Long.MAX_VALUE }) {} }
        }
        assertArrayEquals(bytes, output.readBytes())
        val export = requireNotNull(server.takeRequest(5, SECONDS))
        assertEquals("/api/v1/me/export?format=json", export.path)
        assertEquals("GET", export.method)
        assertEquals("spark_session=test-session", export.getHeader("Cookie"))
        assertEquals("test-csrf", export.getHeader("X-CSRF-Token"))
        assertEquals(origin.toString().removeSuffix("/"), export.getHeader("Origin"))

        server.enqueue(MockResponse().setResponseCode(429).setHeader("Retry-After", "120")
            .setBody("""{"error":{"code":"rate_limited","message":"请稍后再试。","request_id":"test"}}"""))
        val error = apiFailure { client.export(account, ExportFormat.MARKDOWN) { _, _ -> fail("Unexpected write") } }
        assertEquals(429, error.status)
        assertEquals("rate_limited", error.code)
        assertEquals(120L, error.retryAfterSeconds)
        assertEquals("/api/v1/me/export?format=markdown", requireNotNull(server.takeRequest(5, SECONDS)).path)
    }

    @Test fun interruptedExportFailsDuringStreamingAndDoesNotRetry(): Unit = runBlocking {
        val account = verify()
        val bytes = ByteArray(64 * 1024) { it.toByte() }
        server.enqueue(MockResponse().setHeader("Content-Type", "application/zip")
            .setBody(Buffer().write(bytes)).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val output = temporary.newFile()
        val error = apiFailure {
            client.export(account, ExportFormat.JSON) { input, _ ->
                output.outputStream().use { copyExport(input, it, availableBytes = { Long.MAX_VALUE }) {} }
            }
        }
        assertEquals("network_error", error.code)
        assertTrue(output.length() in 1 until bytes.size.toLong())
        assertEquals(2, server.requestCount)
    }

    @Test fun navigationCancelsAStalledZipReadBeforeReleasingTheFileSlot(): Unit = runBlocking {
        val account = verify()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/zip")
            .setBody("zip fixture").setBodyDelay(4, SECONDS))
        val actions = DocumentFileActions(this)
        val webView = Any()
        actions.attach(webView)
        actions.documentCommitted(webView)
        val slot = AtomicBoolean()
        val reading = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<Unit>()
        val streamClosed = AtomicBoolean()
        assertTrue(actions.start(Any(), "zip") { requireDocument ->
            try {
                withFileOperation(slot) {
                    client.export(account, ExportFormat.JSON) { input, _ ->
                        input.use {
                            try {
                                reading.complete(Unit)
                                it.read()
                            } finally {
                                streamClosed.set(true)
                            }
                        }
                        requireDocument()
                    }
                }
            } finally {
                finished.complete(Unit)
            }
        })
        withTimeout(5000) { reading.await() }
        actions.navigationStarted(webView)
        withTimeout(2000) { finished.await() }
        assertTrue(streamClosed.get())
        assertFalse(slot.get())
    }

    @Test fun rejectsAnOversizedDeclaredZipBeforeCallingTheWriter(): Unit = runBlocking {
        val account = verify()
        server.enqueue(MockResponse().setHeader("Content-Type", "application/zip")
            .setBody("zip fixture").setHeader("Content-Length", MAX_EXPORT_BYTES + 1))
        val error = apiFailure { client.export(account, ExportFormat.JSON) { _, _ -> fail("Unexpected write") } }
        assertEquals("export_too_large", error.code)
    }

    @Test fun rejectsAnOldPagesExportWhenTheServerVerifiesTheReplacementAccount(): Unit = runBlocking {
        val previousUserId = "00000000-0000-4000-8000-000000000002"
        val snapshot = SessionScope.fromCookie("spark_session=replacement")
        val credentials = object : SessionCredentialProvider by WebViewCookieCredentialProvider(client) {
            override fun currentSnapshot() = snapshot
        }
        server.enqueue(MockResponse().setBody(
            """{"user":{"id":"$key","email":"fixture@example.invalid"},"csrf_token":"fixture-csrf"}""",
        ))
        val failure = runCatching {
            val session = verifyFileSession(credentials, previousUserId) {}
            client.export(session.account, ExportFormat.JSON) { _, _ -> fail("Unexpected export") }
        }.exceptionOrNull()
        assertEquals("account_mismatch", (failure as BridgeFailure).code)
        val verification = requireNotNull(server.takeRequest(3, SECONDS))
        assertEquals("/api/v1/auth/session", verification.path)
        assertEquals("spark_session=replacement", verification.getHeader("Cookie"))
        assertEquals(1, server.requestCount)
    }

    private suspend fun verify() = WebViewCookieCredentialProvider(client).let { provider ->
        server.enqueue(MockResponse().setBody(
            """{"user":{"id":"$key","email":"test@example.com","palette":"sea","theme":"dark"},
                "csrf_token":"test-csrf","expires_at":"2026-11-23T00:00:00Z"}""",
        ))
        val account = provider.verify(SessionScope.fromCookie("other=unused; spark_session=test-session"))
        assertEquals("sea", account.palette)
        assertEquals("dark", account.theme)
        val request = requireNotNull(server.takeRequest(5, SECONDS))
        assertEquals("/api/v1/auth/session", request.path)
        assertEquals("spark_session=test-session", request.getHeader("Cookie"))
        assertNull(request.getHeader("X-CSRF-Token"))
        account
    }

    private suspend fun apiFailure(block: suspend () -> Unit): ApiError {
        try {
            block()
        } catch (error: ApiError) {
            return error
        }
        error("Expected Spark API failure")
    }

    private companion object {
        const val key = "00000000-0000-4000-8000-000000000001"
    }
}
