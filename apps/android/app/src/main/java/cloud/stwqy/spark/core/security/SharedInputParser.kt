package cloud.stwqy.spark.core.security

import android.content.Intent
import android.net.Uri
import android.os.BadParcelableException
import androidx.core.content.IntentCompat
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.network.CollectionPayload
import cloud.stwqy.spark.core.network.hasValidUnicode
import cloud.stwqy.spark.core.network.isSparkWhitespace
import java.net.URI
import java.net.URISyntaxException

data class SharedInput(val text: String, val images: List<String>, val hasMoreImages: Boolean)

class InvalidShare(message: String, cause: Exception? = null) : Exception(message, cause)

object SharedInputParser {
    fun read(intent: Intent): SharedInput {
        val multiple = intent.action == Intent.ACTION_SEND_MULTIPLE
        val imageShare = isImageType(intent.type)
        requireSupported(intent.action, intent.type)
        try {
            val clip = intent.clipData
            val streams = if (imageShare) {
                val extras = if (multiple) {
                    IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                        .orEmpty().take(AppConfig.MAX_IMAGES + 1)
                } else listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
                val clipStreams = (0 until minOf(clip?.itemCount ?: 0, AppConfig.MAX_IMAGES + 1))
                    .mapNotNull { clip?.getItemAt(it)?.uri }
                (extras + clipStreams).map(Uri::toString)
            } else emptyList()
            return parse(
                action = intent.action,
                mimeType = intent.type,
                text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
                subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT),
                fallbackText = clip?.takeIf { it.itemCount == 1 }?.getItemAt(0)?.text,
                streams = streams,
            )
        } catch (error: BadParcelableException) {
            throw InvalidShare("无法读取分享内容，请重新分享。", error)
        } catch (error: ClassCastException) {
            throw InvalidShare("无法读取分享内容，请重新分享。", error)
        }
    }

    internal fun parse(
        action: String?,
        mimeType: String?,
        text: CharSequence?,
        subject: CharSequence? = null,
        fallbackText: CharSequence? = null,
        streams: List<String> = emptyList(),
    ): SharedInput {
        requireSupported(action, mimeType)
        val original = if (text == null || text.length <= AppConfig.MAX_SHARED_TEXT_UNITS &&
            text.all(Char::isSparkWhitespace)) fallbackText else text
        if ((original?.length ?: 0) > AppConfig.MAX_SHARED_TEXT_UNITS) {
            throw InvalidShare("分享的文字太长，请分段收藏。")
        }
        val body = original?.toString().orEmpty() // Discard any sender-supplied spans.
        if (!body.hasValidUnicode()) throw InvalidShare("分享的文字含有无法保存的字符。")
        val imageLimit = if (action == Intent.ACTION_SEND_MULTIPLE) AppConfig.MAX_IMAGES else 1
        val images = if (isImageType(mimeType)) {
            streams.asSequence().filter(::isContentUri).distinct().take(imageLimit + 1).toList()
        } else emptyList()
        if (body.all(Char::isSparkWhitespace) && images.isEmpty()) {
            throw InvalidShare("未收到可保存的文字或图片。")
        }
        return SharedInput(withLinkTitle(body, subject), images.take(imageLimit), images.size > imageLimit)
    }

    private fun requireSupported(action: String?, mimeType: String?) {
        val images = isImageType(mimeType)
        if (!(action == Intent.ACTION_SEND && (images || mimeType.equals("text/plain", true)) ||
                action == Intent.ACTION_SEND_MULTIPLE && images)
        ) {
            throw InvalidShare("此分享入口支持纯文字、网址和图片。")
        }
    }

    private fun isImageType(type: String?): Boolean =
        type?.startsWith("image/", ignoreCase = true) == true && type.length > 6

    private fun withLinkTitle(body: String, subject: CharSequence?): String {
        if (subject == null || subject.length > 2 * AppConfig.MAX_TITLE_CODE_POINTS) return body
        val title = subject.toString().trim(Char::isSparkWhitespace)
        if (title.isEmpty() || !title.hasValidUnicode() || title.any { it in "\r\n\u0085\u2028\u2029" } ||
            title.codePointCount(0, title.length) > AppConfig.MAX_TITLE_CODE_POINTS ||
            title.length + 1L + body.length > AppConfig.MAX_SHARED_TEXT_UNITS ||
            CollectionPayload.firstHttpUrl(title) != null
        ) return body
        val url = body.trim(Char::isSparkWhitespace)
        return if (CollectionPayload.firstHttpUrl(url) == url) "$title\n$body" else body
    }

    private fun isContentUri(value: String): Boolean {
        val uri = try {
            URI(value)
        } catch (_: URISyntaxException) {
            return false
        }
        return uri.scheme == "content" && !uri.rawAuthority.isNullOrEmpty() &&
            uri.rawUserInfo == null && uri.rawFragment == null
    }
}
