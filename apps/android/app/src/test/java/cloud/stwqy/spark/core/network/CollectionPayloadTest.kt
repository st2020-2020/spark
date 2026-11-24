package cloud.stwqy.spark.core.network

import cloud.stwqy.spark.core.config.AppConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class CollectionPayloadTest {
    @Test fun imageOnlyEncodesTheContractEmptyDocumentAndOmitsOptionalFields() {
        val request = payload(CollectionPayload.encode(id, " \r\n\u3000", uploadIds = listOf(uploadId)))
        assertEquals(
            Json.parseToJsonElement("""{"schema_version":1,"content":{"type":"doc","content":[{"type":"paragraph"}]}}"""),
            request["document"],
        )
        assertEquals(Json.parseToJsonElement("""["$uploadId"]"""), request["upload_ids"])
        assertFalse(request.containsKey("original_url"))
        assertFalse(request.containsKey("manual_title"))
        assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encode(id, "\u00a0") }
    }

    @Test fun supplementaryCharactersCountAsOneAndIntentSharesTheLimit() {
        val body = "💡".repeat(49_999)
        CollectionPayload.encode(id, body, "字")
        assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encode(id, body, "字💡") }
    }

    @Test fun invalidUtf16AndNulAreRejectedInEveryInputField() {
        for (invalid in listOf("\u0000", "\uD800", "\uDC00")) {
            assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encode(id, "文$invalid") }
            assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encode(id, "文", invalid) }
            assertThrows(InvalidCollectionPayload::class.java) {
                CollectionPayload.encode(id, "文", manualTitle = invalid)
            }
        }
    }

    @Test fun normalizesNewlinesInTheDocumentAndKeepsBlankParagraphs() {
        val document = payload(CollectionPayload.encode(id, "甲\r\n\r乙\n"))["document"]!!.jsonObject
        assertEquals(
            Json.parseToJsonElement(
                """[{"type":"paragraph","content":[{"type":"text","text":"甲"}]},{"type":"paragraph"},""" +
                    """{"type":"paragraph","content":[{"type":"text","text":"乙"}]},{"type":"paragraph"}]""",
            ),
            document["content"]!!.jsonObject["content"]!!.jsonArray,
        )
    }

    @Test fun countsRootParagraphsAndTextRunsTowardNodeLimit() {
        val atLimit = "甲" + "\n".repeat(9_997)
        CollectionPayload.encode(id, atLimit)
        assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encode(id, "$atLimit\n") }
    }

    @Test fun wireSizeLimitCountsUtf8Bytes() {
        fun request(text: String) = CollectionCreate(
            id,
            buildJsonObject { put("text", text) },
            "",
            emptyList(),
            emptyList(),
            emptyList(),
            false,
        )
        val overhead = CollectionPayload.encodeRequest(request("")).json.toByteArray().size
        val room = AppConfig.MAX_REQUEST_BYTES - overhead
        val text = "字".repeat(room / 3) + "x".repeat(room % 3)
        assertEquals(AppConfig.MAX_REQUEST_BYTES, CollectionPayload.encodeRequest(request(text)).json.toByteArray().size)
        assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encodeRequest(request(text + "x")) }
    }

    @Test fun extractsFirstLegalLinkAndPreservesBalancedDelimiters() {
        val url = "https://example.com/p（甲）/a(b)"
        assertEquals(url, CollectionPayload.firstHttpUrl("https://name:pass@example.net/x $url）。"))
        assertEquals("http://[::1]:8042/a", CollectionPayload.firstHttpUrl("（http://[::1]:8042/a!）"))
        assertEquals("https://例子.测试/资料", CollectionPayload.firstHttpUrl("资料 https://例子.测试/资料。"))
        assertNull(CollectionPayload.firstHttpUrl("file:///sdcard/a https://@example.net"))
    }

    @Test fun urlLimitCountsCodePointsAndSkipsOversizeCandidate() {
        val prefix = "https://example.com/"
        val limit = prefix + "🌱".repeat(AppConfig.MAX_URL_CODE_POINTS - prefix.length)
        assertEquals(limit, CollectionPayload.firstHttpUrl(limit))
        assertEquals("https://example.org", CollectionPayload.firstHttpUrl("$limit🌱 https://example.org"))
    }

    @Test fun encodesOnlyContractFieldsAndTrimsOptionalTitle() {
        val title = "💡".repeat(200)
        val request = payload(CollectionPayload.encode(id, "见 https://example.com。", manualTitle = " $title "))
        assertEquals(Json.parseToJsonElement("\"$title\""), request["manual_title"])
        assertEquals(Json.parseToJsonElement("\"https://example.com\""), request["original_url"])
        assertThrows(InvalidCollectionPayload::class.java) { CollectionPayload.encode(id, "文", manualTitle = title + "x") }
        assertThrows(InvalidCollectionPayload::class.java) {
            CollectionPayload.encode(id, "文", uploadIds = listOf(uploadId, uploadId))
        }
    }

    private fun payload(value: CollectionPayload): JsonObject = Json.parseToJsonElement(value.json).jsonObject

    private companion object {
        const val id = "00000000-0000-4000-8000-000000000001"
        const val uploadId = "00000000-0000-4000-8000-000000000002"
    }
}
