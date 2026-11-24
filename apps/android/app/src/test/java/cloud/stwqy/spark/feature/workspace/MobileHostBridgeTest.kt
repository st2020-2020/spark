package cloud.stwqy.spark.feature.workspace

import cloud.stwqy.spark.core.designsystem.SparkPalette
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.ExportFormat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

class MobileHostBridgeTest {
    @Test fun onlyTheExactOriginInTheMainFrameCanCallTheBridge() {
        val origin = "https://spark.example"
        assertTrue(MobileHostBridge.acceptsSource(origin, true, origin))
        assertFalse(MobileHostBridge.acceptsSource(origin, false, origin))
        for (source in listOf("http://spark.example", "https://spark.example:8443", "https://other.spark.example", "null")) {
            assertFalse(MobileHostBridge.acceptsSource(source, true, origin))
        }
    }

    @Test fun parsesOnlyTheVersionOneActionsAndTheirRequiredFields() {
        assertEquals(
            MobileAction.Appearance(WorkspaceAppearance(SparkPalette.SEA, true, 0xff102030.toInt())),
            message("syncAppearance", """{"palette":"sea","mode":"dark","bg_hex":"#102030"}""").action(),
        )
        assertEquals(MobileAction.OpenDrafts, message("openLocalDrafts", "{}").action())
        assertEquals(MobileAction.AuthChanged, message("authStateChanged", """{"authenticated":false}""").action())
        assertEquals(MobileAction.Export(ExportFormat.MARKDOWN, userId),
            message("exportData", """{"format":"markdown","expected_user_id":"$userId"}""").action())
        assertEquals(MobileAction.Export(ExportFormat.JSON, userId),
            message("exportData", """{"format":"json","expected_user_id":"$userId"}""").action())
        val image = """{"mime":"image/png","filename":"test.PNG","base64":"$encodedSignature","expected_user_id":"$userId"}"""
        assertEquals(MobileAction.Image("test.png", encodedSignature, false, userId), message("saveImage", image).action())
        assertEquals(MobileAction.Image("test.png", encodedSignature, true, userId), message("shareImage", image).action())
        assertEquals(MobileAction.CancelFile("req-1"), requireNotNull(MobileMessage.parse(
            """{"version":1,"action":"cancelFileAction","payload":{"request_id":"req-1"}}""",
        )).action())
    }

    @Test fun rejectsUnknownActionsAndInvalidPayloads() {
        assertNull(MobileMessage.parse("[1]"))
        assertNull(MobileMessage.parse("{"))
        assertNull(MobileMessage.parse("a".repeat(5_604_097)))
        assertEquals("unsupported_action", failure { message("download", "{}").action() })
        val invalid = listOf(
            """{"version":2,"action":"openLocalDrafts","payload":{}}""",
            """{"version":"1","action":"openLocalDrafts","payload":{}}""",
            """{"version":1,"request_id":"bad id","action":"openLocalDrafts","payload":{}}""",
            """{"version":1,"action":"openLocalDrafts","payload":{},"extra":true}""",
            """{"version":1,"action":"exportData","payload":{"format":"xml"}}""",
            """{"version":1,"request_id":"req-1","action":"exportData","payload":{"format":"json"}}""",
            """{"version":1,"request_id":"req-1","action":"exportData","payload":{"format":"json","expected_user_id":"guest"}}""",
            """{"version":1,"request_id":"req-1","action":"cancelFileAction","payload":{"request_id":"req-1"}}""",
            """{"version":1,"action":"cancelFileAction","payload":{"request_id":"bad id"}}""",
            """{"version":1,"action":"exportData","payload":{"format":"json","url":"https://other.example"}}""",
            """{"version":1,"action":"authStateChanged","payload":{"authenticated":"true"}}""",
            """{"version":1,"action":"syncAppearance","payload":{"palette":"mint","mode":"light","bg_hex":"red"}}""",
            """{"version":1,"action":"saveImage","payload":{"mime":"image/jpeg","filename":"test.png","base64":"AA=="}}""",
        )
        for (text in invalid) {
            assertEquals(text, "invalid_request", failure { requireNotNull(MobileMessage.parse(text)).action() })
        }
    }

    @Test fun validatesPngMagicAndBothSizeLimits() {
        assertArrayEquals(signature, decodePng(encodedSignature))
        assertEquals("invalid_image", failure { decodePng("not valid base64") })
        assertEquals("invalid_image", failure { decodePng(encode(signature.copyOf(7))) })
        assertEquals("invalid_image", failure { decodePng(encode(signature.copyOf().also { it[7] = 0 })) })
        val atLimit = signature.copyOf(4 * 1024 * 1024)
        assertArrayEquals(atLimit, decodePng(encode(atLimit)))
        // The first byte over the decoded cap still has the same encoded length.
        assertEquals("image_too_large", failure { decodePng(encode(atLimit.copyOf(atLimit.size + 1))) })
        assertEquals("image_too_large", failure { decodePng("A".repeat(5_600_001)) })
    }

    @Test fun oneFileOperationAtATimeAndCancellationReleasesTheSlot(): Unit = runBlocking {
        val active = AtomicBoolean()
        val started = CompletableDeferred<Unit>()
        val inFlight = launch {
            withFileOperation(active) {
                started.complete(Unit)
                awaitCancellation()
            }
        }
        started.await()
        assertEquals("busy", runCatching { withFileOperation(active) { error("Unexpected operation") } }
            .exceptionOrNull().let { (it as BridgeFailure).code })
        inFlight.cancelAndJoin()
        assertFalse(active.get())
        val firstFailure = runCatching { withFileOperation(active) { throw ApiError.signedOut() } }
        assertTrue(firstFailure.exceptionOrNull() is ApiError)
        assertEquals("saved", withFileOperation(active) { "saved" })
        assertFalse(active.get())
    }

    @Test fun onlyMatchingDocumentAndRequestCanCancelTheNativeJob(): Unit = runBlocking {
        val webView = Any()
        val document = Any()
        val actions = DocumentFileActions(this)
        val slot = AtomicBoolean()
        val entered = CompletableDeferred<Unit>()
        val cleaned = CompletableDeferred<Unit>()
        actions.attach(webView)
        actions.documentCommitted(webView)
        assertTrue(actions.start(document, "first") {
            try {
                withFileOperation(slot) {
                    entered.complete(Unit)
                    awaitCancellation()
                }
            } finally {
                cleaned.complete(Unit)
            }
        })
        entered.await()
        actions.cancel(Any(), "first")
        actions.cancel(document, "other")
        yield()
        assertTrue(slot.get())
        actions.cancel(document, "first")
        cleaned.await()
        assertFalse(slot.get())
        assertTrue(actions.start(document, "next") { withFileOperation(slot) {} })
    }

    @Test fun navigationAndRendererDetachCancelTheirJobsUntilAReplacementDocumentCommits(): Unit = runBlocking {
        val actions = DocumentFileActions(this)
        val webView = Any()
        val previous = Any()
        val next = Any()
        val slot = AtomicBoolean()
        suspend fun invalidateDuringAction(source: Any, invalidate: () -> Unit) {
            val started = CompletableDeferred<Unit>()
            val stopped = CompletableDeferred<Unit>()
            assertTrue(actions.start(source, "request") { requireDocument ->
                try {
                    withFileOperation(slot) {
                        requireDocument()
                        started.complete(Unit)
                        awaitCancellation()
                    }
                } finally {
                    assertTrue(runCatching(requireDocument).exceptionOrNull() is kotlinx.coroutines.CancellationException)
                    stopped.complete(Unit)
                }
            })
            started.await()
            invalidate()
            assertFalse(actions.start(source, "late") { error("Old document started a file action") })
            stopped.await()
            assertFalse(slot.get())
        }
        actions.attach(webView)
        actions.documentCommitted(webView)
        invalidateDuringAction(previous) { actions.navigationStarted(webView) }
        actions.documentCommitted(webView)
        invalidateDuringAction(next) { assertTrue(actions.detach(webView)) }

        val replacement = Any()
        actions.attach(replacement)
        actions.documentCommitted(webView)
        assertFalse(actions.start(Any(), "too-early") { error("Detached WebView committed") })
        actions.documentCommitted(replacement)
        assertFalse(actions.detach(webView))
        assertTrue(actions.start(Any(), "new") { withFileOperation(slot) {} })
    }

    @Test fun verificationRefusesAnOldPagesAccountAndStopsOnCookieReplacement(): Unit = runBlocking {
        val original = SessionScope.fromCookie("spark_session=old")
        val replacement = SessionScope.fromCookie("spark_session=new")
        var current = original
        var duringVerify: () -> Unit = {}
        val credentials = object : SessionCredentialProvider {
            override fun currentSnapshot() = current
            override fun flush() = Unit
            override suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount {
                duringVerify()
                return VerifiedAccount(userId, null, "csrf", "mint", "light", snapshot)
            }
        }
        val oldPage = runCatching {
            verifyFileSession(credentials, "00000000-0000-4000-8000-000000000002") {}
        }.exceptionOrNull() as BridgeFailure
        assertEquals("account_mismatch", oldPage.code)

        duringVerify = { current = replacement }
        val changed = runCatching { verifyFileSession(credentials, userId) {} }.exceptionOrNull() as BridgeFailure
        assertEquals("account_mismatch", changed.code)

        current = original
        duringVerify = {}
        val session = verifyFileSession(credentials, userId) {}
        current = SessionSnapshot.Guest
        assertEquals("session_expired", assertThrows(ApiError::class.java) { session.requireCurrent() }.code)
    }

    @Test fun repliesPreserveRequestIdRateLimitAndSessionStatus() {
        val error = ApiError(429, "rate_limited", "Limited", 117).asBridgeFailure()
        assertEquals(
            Json.parseToJsonElement("""{"version":1,"request_id":"req-1","ok":false,"error":{"code":"rate_limited","message":"导出过于频繁，请稍后重试。","status":429,"retry_after":117}}"""),
            Json.parseToJsonElement(bridgeResponse("req-1", error)),
        )
        assertEquals("session_expired", ApiError(403, "csrf_failed", "Expired").asBridgeFailure().code)
        assertEquals(
            Json.parseToJsonElement("""{"filename":"test.png","destination":"gallery"}"""),
            Json.parseToJsonElement(bridgeResponse("req-2", null, SavedFile("test.png", "gallery"))).jsonObject["data"],
        )
    }

    @Test fun acceptedNamesCannotChooseAPathOrExceedTheLimit() {
        assertEquals("share.png", safeFileName("../sha\\re\n.PNG", ".png", "Spark"))
        assertEquals("Spark.png", safeFileName("/..\\\t", ".png", "Spark"))
        assertEquals("a".repeat(60) + ".png", safeFileName("a".repeat(90) + ".png", ".png", "Spark"))
        assertEquals("a".repeat(59) + ".png", safeFileName("a".repeat(59) + "😀", ".png", "Spark"))
        assertEquals("spark-export-20261122.zip",
            exportFileName("attachment; filename=\"spark-export-20261122.zip\"", ExportFormat.JSON))
        assertEquals("spark-export-markdown.zip",
            exportFileName("attachment; filename=\"../../private.zip\"", ExportFormat.MARKDOWN))
        assertEquals("spark-export-json.zip", exportFileName(null, ExportFormat.JSON))
    }

    @Test fun streamingStopsWritingWhenTheAccountChanges() {
        val input = ByteArray(128 * 1024) { it.toByte() }
        val output = ByteArrayOutputStream()
        val error = assertThrows(ApiError::class.java) {
            input.inputStream().use { stream ->
                copyExport(stream, output, availableBytes = { Long.MAX_VALUE }) {
                    if (output.size() > 0) throw ApiError.signedOut()
                }
            }
        }
        assertEquals("session_expired", error.code)
        assertTrue(output.size() in 1 until input.size)
        assertArrayEquals(input.copyOf(output.size()), output.toByteArray())
    }

    private fun message(action: String, payload: String) = requireNotNull(MobileMessage.parse(
        """{"version":1,"request_id":"req-1","action":"$action","payload":$payload}""",
    ))

    private fun failure(block: () -> Unit): String = assertThrows(BridgeFailure::class.java, block).code

    private fun encode(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)

    private val signature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    private val encodedSignature = encode(signature)
    private val userId = "00000000-0000-4000-8000-000000000001"
}
