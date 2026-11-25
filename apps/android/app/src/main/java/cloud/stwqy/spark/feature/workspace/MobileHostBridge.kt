package cloud.stwqy.spark.feature.workspace

import android.content.ActivityNotFoundException
import android.os.OperationCanceledException
import android.util.Log
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import cloud.stwqy.spark.core.designsystem.SparkPalette
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.ExportFormat
import cloud.stwqy.spark.core.network.SparkApiClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

internal class MobileHostBridge(
    private val owner: LifecycleOwner,
    private val credentials: SessionCredentialProvider,
    private val api: SparkApiClient,
    private val mediaSaver: SystemMediaSaver,
    private val fileOperationActive: AtomicBoolean,
    private val appearanceChanged: (WorkspaceAppearance) -> Unit,
    private val openDrafts: () -> Unit,
    private val authChanged: () -> Unit,
) {
    private val fileActions = DocumentFileActions(owner.lifecycleScope)

    fun attach(web: WebView): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        fileActions.attach(web)
        WebViewCompat.addWebMessageListener(web, NAME, setOf(AppConfig.ORIGIN)) { view, message, sourceOrigin, isMainFrame, reply ->
            if (!fileActions.isAttached(view) || !acceptsSource(sourceOrigin.toString(), isMainFrame, AppConfig.ORIGIN) ||
                message.type != WebMessageCompat.TYPE_STRING
            ) return@addWebMessageListener
            receive(message.data, reply) { reply.postMessage(it) }
        }
        return true
    }

    fun navigationStarted(web: WebView) = fileActions.navigationStarted(web)

    fun documentCommitted(web: WebView) = fileActions.documentCommitted(web)

    fun detach(web: WebView) {
        if (fileActions.detach(web)) WebViewCompat.removeWebMessageListener(web, NAME)
    }

    private fun receive(text: String?, source: Any, reply: (String) -> Unit) {
        if (!owner.lifecycle.currentState.isAtLeast(Lifecycle.State.CREATED)) return
        val envelope = MobileMessage.parse(text) ?: return
        fun respond(error: BridgeFailure? = null, file: SavedFile? = null) {
            envelope.requestId?.let { reply(bridgeResponse(it, error, file)) }
        }
        val action = try {
            envelope.action()
        } catch (error: BridgeFailure) {
            respond(error)
            return
        }
        when (action) {
            is MobileAction.Appearance -> appearanceChanged(action.value)
            MobileAction.OpenDrafts -> {
                if (!owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    respond(BridgeFailure("inactive", "请返回 Spark 后重试。"))
                    return
                }
                openDrafts()
            }
            MobileAction.AuthChanged -> authChanged()
            is MobileAction.CancelFile -> {
                fileActions.cancel(source, action.requestId)
                return
            }
            is MobileAction.FileAction -> {
                val requestId = envelope.requestId ?: return
                if (!fileActions.accepting || !owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    respond(BridgeFailure("inactive", "请返回 Spark 后重试。"))
                    return
                }
                val started = fileActions.start(source, requestId) { requireDocument ->
                    try {
                        val file = withFileOperation(fileOperationActive) {
                            val session = verifyFileSession(credentials, action.expectedUserId, requireDocument)
                            val requireCurrent = session.requireCurrent
                            when (action) {
                                is MobileAction.Image -> {
                                    val bytes = withContext(Dispatchers.Default) { decodePng(action.base64) }
                                    if (action.share) {
                                        mediaSaver.shareImage(action.filename, bytes, requireCurrent)
                                        null
                                    } else {
                                        mediaSaver.saveImage(action.filename, bytes, requireCurrent)
                                    }
                                }
                                is MobileAction.Export -> mediaSaver.saveExport(action.format, requireCurrent) { write ->
                                    api.export(session.account, action.format, write)
                                }
                            }
                        }
                        requireDocument()
                        respond(file = file)
                    } catch (error: BridgeFailure) {
                        requireDocument()
                        respond(error)
                    } catch (error: ApiError) {
                        requireDocument()
                        respond(error.asBridgeFailure())
                    } catch (_: ActivityNotFoundException) {
                        requireDocument()
                        respond(BridgeFailure("unavailable", "设备上没有可处理此文件的应用。"))
                    } catch (error: CancellationException) {
                        throw error
                    } catch (_: OperationCanceledException) {
                        requireDocument()
                        respond(BridgeFailure("cancelled", "系统已取消文件操作。"))
                    } catch (error: IOException) {
                        requireDocument()
                        Log.w("Spark", "System file operation failed (${error.javaClass.simpleName})")
                        respond(BridgeFailure("storage_error", "文件操作失败，请检查可用空间后重试。"))
                    } catch (error: IllegalStateException) {
                        requireDocument()
                        Log.w("Spark", "System file operation unavailable (${error.javaClass.simpleName})")
                        respond(BridgeFailure("unavailable", "系统文件服务暂不可用，请稍后重试。"))
                    } catch (_: SecurityException) {
                        requireDocument()
                        respond(BridgeFailure("storage_error", "无法访问所选文件位置，请重新选择。"))
                    }
                }
                if (!started) respond(fileOperationBusy())
                return
            }
        }
        respond()
    }

    companion object {
        private const val NAME = "sparkMobileHost"

        internal fun acceptsSource(source: String, isMainFrame: Boolean, origin: String): Boolean =
            isMainFrame && source == origin
    }
}

/** The WebView thread owns the active request. File I/O reads only its lifetime token. */
internal class DocumentFileActions(private val scope: CoroutineScope) {
    private var generation = 0L
    private var attachedView: Any? = null
    var accepting = false
        private set

    // The provider may outlive both the coroutine and the WebView. This token holds neither.
    private class DocumentLifetime {
        @Volatile var valid = true

        fun requireActive() {
            if (!valid) throw CancellationException("Web document changed")
        }
    }

    private data class Active(
        val generation: Long, val source: Any, val requestId: String, val lifetime: DocumentLifetime, val job: Job,
    ) {
        fun cancel() {
            lifetime.valid = false
            job.cancel()
        }
    }
    private var active: Active? = null

    fun attach(view: Any) {
        check(attachedView == null)
        attachedView = view
    }

    fun isAttached(view: Any) = view === attachedView

    fun documentCommitted(view: Any) {
        if (isAttached(view)) accepting = true
    }

    fun navigationStarted(view: Any) {
        if (isAttached(view)) invalidate()
    }

    fun detach(view: Any): Boolean {
        if (!isAttached(view)) return false
        attachedView = null
        invalidate()
        return true
    }

    private fun invalidate() {
        accepting = false
        generation++
        active?.cancel()
    }

    fun cancel(source: Any, requestId: String) {
        val action = active ?: return
        // WebKit supplies a reply proxy tied to the calling JavaScript object.
        if (action.generation == generation && action.source === source && action.requestId == requestId) {
            action.cancel()
        }
    }

    fun start(source: Any, requestId: String, run: suspend (requireDocument: () -> Unit) -> Unit): Boolean {
        if (!accepting || active?.job?.isCompleted == false) return false
        val lifetime = DocumentLifetime()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                run(lifetime::requireActive)
            } finally {
                lifetime.valid = false
                active = null
            }
        }
        active = Active(generation, source, requestId, lifetime, job)
        job.start()
        return true
    }
}

internal class FileSession(val account: VerifiedAccount, val requireCurrent: () -> Unit)

internal suspend fun verifyFileSession(
    credentials: SessionCredentialProvider,
    expectedUserId: String,
    requireDocument: () -> Unit,
): FileSession {
    requireDocument()
    val snapshot = credentials.currentSnapshot()
    if (snapshot == SessionSnapshot.Guest) throw ApiError.signedOut()
    fun requireCurrent() {
        requireDocument()
        val current = credentials.currentSnapshot()
        if (current == SessionSnapshot.Guest) throw ApiError.signedOut()
        if (current != snapshot) throw accountMismatch()
        requireDocument()
    }
    val account = credentials.verify(snapshot)
    requireCurrent()
    if (account.snapshot != snapshot || !account.userId.equals(expectedUserId, ignoreCase = true)) throw accountMismatch()
    return FileSession(account, ::requireCurrent)
}

private fun accountMismatch() = BridgeFailure("account_mismatch", "登录账号已变更，请重新打开页面后重试。")

private fun fileOperationBusy() = BridgeFailure("busy", "上一项操作正在进行，请稍候。")

internal suspend fun <T> withFileOperation(active: AtomicBoolean, run: suspend () -> T): T {
    if (!active.compareAndSet(false, true)) throw fileOperationBusy()
    try {
        return run()
    } finally {
        active.set(false)
    }
}

internal class BridgeFailure(
    val code: String,
    override val message: String,
    val status: Int? = null,
    val retryAfter: Long? = null,
) : Exception(message)

internal fun ApiError.asBridgeFailure(): BridgeFailure = when {
    isSessionExpired -> BridgeFailure("session_expired", "登录已过期，重新登录后即可保存或导出。", status)
    status == 429 -> BridgeFailure("rate_limited", "导出过于频繁，请稍后重试。", status, retryAfterSeconds)
    code == "network_error" || code == "export_too_large" -> BridgeFailure(code, message)
    else -> BridgeFailure(code, "无法完成文件操作，请稍后重试。", status)
}

internal fun bridgeResponse(requestId: String, error: BridgeFailure?, file: SavedFile? = null): String = buildJsonObject {
    put("version", 1)
    put("request_id", requestId)
    put("ok", error == null)
    if (error != null) {
        put("error", buildJsonObject {
            put("code", error.code)
            put("message", error.message)
            error.status?.let { put("status", it) }
            error.retryAfter?.let { put("retry_after", it) }
        })
    } else {
        put("data", buildJsonObject {
            if (file != null) {
                put("filename", file.name)
                put("destination", file.destination)
            }
        })
    }
}.toString()

internal data class WorkspaceAppearance(val palette: SparkPalette, val dark: Boolean, val background: Int)

internal sealed interface MobileAction {
    data class Appearance(val value: WorkspaceAppearance) : MobileAction
    data object OpenDrafts : MobileAction
    data object AuthChanged : MobileAction
    data class CancelFile(val requestId: String) : MobileAction
    sealed interface FileAction : MobileAction { val expectedUserId: String }
    data class Image(val filename: String, val base64: String, val share: Boolean, override val expectedUserId: String) : FileAction
    data class Export(val format: ExportFormat, override val expectedUserId: String) : FileAction
}

internal class MobileMessage private constructor(private val message: JsonObject, val requestId: String?) {
    fun action(): MobileAction {
        if (message["version"] != JsonPrimitive(1) || message.keys.any { it !in envelopeKeys } ||
            ("request_id" in message && requestId == null)
        ) invalidMessage()
        val payload = message["payload"] as? JsonObject ?: invalidMessage()
        return when (val action = message.string("action")) {
            "syncAppearance" -> {
                payload.requireKeys("palette", "mode", "bg_hex")
                val palette = SparkPalette.entries.firstOrNull { it.wireValue == payload.string("palette") } ?: invalidMessage()
                val dark = when (payload.string("mode")) {
                    "light" -> false
                    "dark" -> true
                    else -> invalidMessage()
                }
                val hex = payload.string("bg_hex")?.takeIf { backgroundHex.matches(it) } ?: invalidMessage()
                MobileAction.Appearance(WorkspaceAppearance(palette, dark, hex.drop(1).toInt(16) or 0xff000000.toInt()))
            }
            "openLocalDrafts" -> {
                payload.requireKeys()
                MobileAction.OpenDrafts
            }
            "authStateChanged" -> {
                payload.requireKeys("authenticated")
                val authenticated = payload["authenticated"] as? JsonPrimitive ?: invalidMessage()
                if (authenticated.isString || authenticated.booleanOrNull == null) invalidMessage()
                // The notification is only a signal to read the actual WebView session.
                MobileAction.AuthChanged
            }
            "cancelFileAction" -> {
                payload.requireKeys("request_id")
                if (requestId != null) invalidMessage()
                val target = payload.string("request_id")?.takeIf(requestIdPattern::matches) ?: invalidMessage()
                MobileAction.CancelFile(target)
            }
            "saveImage", "shareImage" -> {
                payload.requireKeys("mime", "filename", "base64", "expected_user_id")
                if (requestId == null) invalidMessage()
                if (payload.string("mime") != "image/png") invalidMessage()
                val filename = payload.string("filename") ?: invalidMessage()
                val encoded = payload.string("base64") ?: invalidMessage()
                MobileAction.Image(safeFileName(filename, ".png", "Spark"), encoded, action == "shareImage", payload.expectedUser())
            }
            "exportData" -> {
                payload.requireKeys("format", "expected_user_id")
                if (requestId == null) invalidMessage()
                val format = ExportFormat.entries.firstOrNull { it.wireValue == payload.string("format") } ?: invalidMessage()
                MobileAction.Export(format, payload.expectedUser())
            }
            else -> throw BridgeFailure("unsupported_action", "当前版本暂不支持这项操作，升级 Spark 后再试。")
        }
    }

    companion object {
        private val envelopeKeys = setOf("version", "request_id", "action", "payload")
        private val requestIdPattern = Regex("[A-Za-z0-9_-]{1,80}")
        private val backgroundHex = Regex("#[0-9A-Fa-f]{6}")

        fun parse(text: String?): MobileMessage? {
            if (text.isNullOrBlank() || text.length > MAX_BASE64_LENGTH + 4096) return null
            val message = try {
                Json.parseToJsonElement(text) as? JsonObject ?: return null
            } catch (_: SerializationException) {
                return null
            }
            return MobileMessage(message, message.string("request_id")?.takeIf(requestIdPattern::matches))
        }
    }
}

private fun JsonObject.string(key: String): String? =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.expectedUser(): String = string("expected_user_id")?.takeIf(::isUuid) ?: invalidMessage()

private fun JsonObject.requireKeys(vararg names: String) {
    if (size != names.size || !keys.containsAll(names.toList())) invalidMessage()
}

private fun invalidMessage(): Nothing = throw BridgeFailure("invalid_request", "无法识别这项操作的参数。")

private const val MAX_BASE64_LENGTH = 5_600_000
private const val MAX_PNG_BYTES = 4 * 1024 * 1024
private val pngSignature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

@OptIn(ExperimentalEncodingApi::class)
internal fun decodePng(encoded: String): ByteArray {
    if (encoded.length > MAX_BASE64_LENGTH || encoded.length > ((MAX_PNG_BYTES + 2) / 3) * 4) {
        throw BridgeFailure("image_too_large", "PNG 超过 4 MiB，请减少卡片中的图片后重试。")
    }
    val bytes = try {
        Base64.decode(encoded)
    } catch (_: IllegalArgumentException) {
        throw BridgeFailure("invalid_image", "无法读取这张 PNG 图片。")
    }
    if (bytes.size > MAX_PNG_BYTES) throw BridgeFailure("image_too_large", "PNG 超过 4 MiB，请减少卡片中的图片后重试。")
    if (bytes.size < pngSignature.size || pngSignature.indices.any { bytes[it] != pngSignature[it] }) {
        throw BridgeFailure("invalid_image", "无法读取这张 PNG 图片。")
    }
    return bytes
}
