package cloud.stwqy.spark.core.security

import android.content.Intent
import cloud.stwqy.spark.core.config.AppConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedInputParserTest {
    private val link = "https://example.com/story"

    @Test fun mergesOnlyShortSingleLineTitleWithStandaloneLink() {
        assertEquals("文章标题\n$link", text(link, " 文章标题 "))
        assertEquals(link, text(link, "标题\n另起一行"))
        assertEquals(link, text(link, "标题\u2028另起一行"))
        assertEquals(link, text(link, "来自 https://example.com"))
        assertEquals(link, text(link, "甲".repeat(201)))
        assertEquals("见 $link", text("见 $link", "文章标题"))
        assertEquals("$link。", text("$link。", "文章标题"))
        val emojiTitle = "💡".repeat(200)
        assertEquals("$emojiTitle\n$link", text(link, emojiTitle))
    }

    @Test fun textLimitIsInUtf16UnitsAndBlankExtraCanFallBackToClipText() {
        val atLimit = "💡".repeat(AppConfig.MAX_SHARED_TEXT_UNITS / 2)
        assertEquals(atLimit, text(atLimit))
        assertThrows(InvalidShare::class.java) { text(atLimit + "字") }
        assertThrows(InvalidShare::class.java) { text("\uD800") }
        assertThrows(InvalidShare::class.java) { text("\u0000") }
        assertThrows(InvalidShare::class.java) { text("\u3000") }
        assertEquals(link, text("\u3000", fallback = link))
        assertEquals("正文", text(StringBuilder("正文")))
    }

    @Test fun imageInputsKeepTextAndOnlyUniqueContentUrisUpToTheLimit() {
        val images = (0..10).map { "content://example.media/image/$it" }
        val result = SharedInputParser.parse(
            Intent.ACTION_SEND_MULTIPLE, "image/png", "笔记",
            streams = listOf("file:///data/secret", images.first()) + images,
        )
        assertEquals("笔记", result.text)
        assertEquals(images.take(9), result.images)
        assertTrue(result.hasMoreImages)
        val imageOnly = SharedInputParser.parse(Intent.ACTION_SEND, "image/jpeg", null, streams = images.take(1))
        assertEquals("", imageOnly.text)
        assertEquals(images.take(1), imageOnly.images)
        assertFalse(imageOnly.hasMoreImages)
    }

    @Test fun rejectsUnrelatedActionsAndImageIntentsWithoutUsableContent() {
        assertThrows(InvalidShare::class.java) { SharedInputParser.parse(Intent.ACTION_VIEW, "text/plain", link) }
        assertThrows(InvalidShare::class.java) {
            SharedInputParser.parse(Intent.ACTION_SEND_MULTIPLE, "text/plain", link)
        }
        assertThrows(InvalidShare::class.java) {
            SharedInputParser.parse(Intent.ACTION_SEND, "image/png", null, streams = listOf("https://example.com/a"))
        }
    }

    private fun text(body: CharSequence, subject: CharSequence? = null, fallback: CharSequence? = null) =
        SharedInputParser.parse(Intent.ACTION_SEND, "text/plain", body, subject, fallback).text
}
