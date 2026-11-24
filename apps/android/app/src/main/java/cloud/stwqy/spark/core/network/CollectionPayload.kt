package cloud.stwqy.spark.core.network

import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.net.MalformedURLException
import java.net.URI
import java.net.URISyntaxException

class InvalidCollectionPayload(message: String) : IOException(message)

class CollectionPayload private constructor(val id: String, internal val json: String) {
    companion object {
        private val links = Regex("""https?://[^\s\p{Z}\p{Cc}<>"'“”‘’「」。，；！？、]+""", RegexOption.IGNORE_CASE)
        private val v1Links = Regex("""https?://[^\s\p{Z}\p{Cc}<>"'“”‘’「」《》，。；！？（）]+""", RegexOption.IGNORE_CASE)
        private val delimiters = listOf('(' to ')', '[' to ']', '{' to '}', '（' to '）', '【' to '】', '《' to '》')

        fun encode(
            id: String,
            text: String,
            intent: String = "",
            aiExcluded: Boolean = false,
            manualTitle: String = "",
            uploadIds: List<String> = emptyList(),
            projectIds: List<String> = emptyList(),
            tagIds: List<String> = emptyList(),
            replayV1: Boolean = false,
        ): CollectionPayload {
            if (!isUuid(id)) throw InvalidCollectionPayload("收藏编号无效。")
            validateIds(uploadIds, AppConfig.MAX_IMAGES)
            validateIds(projectIds, AppConfig.MAX_COLLECTION_ASSOCIATIONS)
            validateIds(tagIds, AppConfig.MAX_COLLECTION_ASSOCIATIONS)
            if (text.length.toLong() + intent.length > 2L * AppConfig.MAX_TEXT_CODE_POINTS) {
                throw InvalidCollectionPayload("正文和用途合计最多 50,000 字。")
            }
            val body = text.replace("\r\n", "\n").replace('\r', '\n')
            val title = manualTitle.trim(Char::isSparkWhitespace)
            if (!body.hasValidUnicode() || !intent.hasValidUnicode() || !manualTitle.hasValidUnicode()) {
                throw InvalidCollectionPayload("输入含有无法保存的字符。")
            }
            if (collectionCharacterCount(body, intent) > AppConfig.MAX_TEXT_CODE_POINTS) {
                throw InvalidCollectionPayload("正文和用途合计最多 50,000 字。")
            }
            if (title.codePointCount(0, title.length) > AppConfig.MAX_TITLE_CODE_POINTS) {
                throw InvalidCollectionPayload("标题最多 200 字。")
            }
            val hasText = body.any { !it.isSparkWhitespace() }
            if (!hasText && uploadIds.isEmpty()) {
                throw InvalidCollectionPayload("请填写文字、有效网址或添加图片。")
            }
            val document = if (hasText) document(body) else document("")
            return encodeRequest(
                CollectionCreate(
                    id = id,
                    document = document,
                    intent = intent,
                    uploadIds = uploadIds,
                    projectIds = projectIds,
                    tagIds = tagIds,
                    aiExcluded = aiExcluded,
                    originalUrl = if (replayV1) v1OriginalUrl(body) else firstHttpUrl(body),
                    manualTitle = title.ifEmpty { null },
                ),
            )
        }

        internal fun encodeRequest(request: CollectionCreate): CollectionPayload {
            val json = apiJson.encodeToString(CollectionCreate.serializer(), request)
            if (json.toByteArray(Charsets.UTF_8).size > AppConfig.MAX_REQUEST_BYTES) {
                throw InvalidCollectionPayload("收藏内容超过 1 MiB，请分段收藏。")
            }
            return CollectionPayload(request.id, json)
        }

        fun firstHttpUrl(text: String): String? = links.findAll(text)
            .map { stripTrailingPunctuation(it.value, delimiters, ".,;!?") }
            .firstOrNull { isHttpLink(it, replayV1 = false) }

        // v1 froze the derived original_url as part of the request digest. Keep its exact extraction on replay.
        private fun v1OriginalUrl(text: String): String? = v1Links.findAll(text)
            .map { stripTrailingPunctuation(it.value, delimiters.take(2), ".,;!?}") }
            .firstOrNull { isHttpLink(it, replayV1 = true) }

        private fun isHttpLink(candidate: String, replayV1: Boolean): Boolean {
            if (candidate.codePointCount(0, candidate.length) > AppConfig.MAX_URL_CODE_POINTS) return false
            val uri = try {
                URI(candidate)
            } catch (_: URISyntaxException) {
                return false
            }
            val authority = uri.rawAuthority ?: return false
            if ('@' in authority || '%' in authority) return false
            if (!replayV1) return candidate.toHttpUrlOrNull() != null
            return try {
                uri.toURL().host.isNotEmpty() && (uri.host != null || ':' !in authority)
            } catch (_: MalformedURLException) {
                false
            }
        }

        private fun stripTrailingPunctuation(link: String, pairs: List<Pair<Char, Char>>, punctuation: String): String {
            val remainingOpen = IntArray(pairs.size)
            for (char in link) {
                for ((index, pair) in pairs.withIndex()) {
                    if (char == pair.first) remainingOpen[index]++
                    if (char == pair.second) remainingOpen[index]--
                }
            }
            var end = link.length
            while (end > 0) {
                val char = link[end - 1]
                val index = pairs.indexOfFirst { it.second == char }
                if (index >= 0) {
                    if (remainingOpen[index] >= 0) break
                    remainingOpen[index]++
                } else if (char !in punctuation) {
                    break
                }
                end--
            }
            return link.substring(0, end)
        }

        private fun document(text: String) = buildJsonObject {
            put("schema_version", 1)
            put("content", buildJsonObject {
                put("type", "doc")
                put("content", buildJsonArray {
                    var nodes = 1
                    for (line in text.lineSequence()) {
                        nodes += if (line.isEmpty()) 1 else 2
                        if (nodes > AppConfig.MAX_DOCUMENT_NODES) {
                            throw InvalidCollectionPayload("正文段落太多，请分段收藏。")
                        }
                        add(buildJsonObject {
                            put("type", "paragraph")
                            if (line.isNotEmpty()) {
                                put("content", buildJsonArray {
                                    add(buildJsonObject {
                                        put("type", JsonPrimitive("text"))
                                        put("text", line)
                                    })
                                })
                            }
                        })
                    }
                })
            })
        }

        private fun validateIds(ids: List<String>, limit: Int) {
            if (ids.size > limit || ids.any { !isUuid(it) } || ids.map(String::lowercase).toSet().size != ids.size) {
                throw InvalidCollectionPayload("所选图片、项目或标签无效。")
            }
        }
    }
}

internal fun collectionCharacterCount(text: String, intent: String): Int {
    val body = text.replace("\r\n", "\n")
    return body.codePointCount(0, body.length) + intent.codePointCount(0, intent.length)
}

internal fun Char.isSparkWhitespace(): Boolean =
    Character.isSpaceChar(this) || this in '\t'..'\r' || this == '\u0085'

internal fun String.hasValidUnicode(): Boolean {
    var index = 0
    while (index < length) {
        val codePoint = codePointAt(index)
        if (codePoint == 0 || codePoint in 0xd800..0xdfff) return false
        index += Character.charCount(codePoint)
    }
    return true
}
