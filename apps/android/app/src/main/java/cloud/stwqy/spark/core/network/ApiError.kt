package cloud.stwqy.spark.core.network

import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Locale

class ApiError internal constructor(
    val status: Int?,
    val code: String,
    override val message: String,
    val retryAfterSeconds: Long? = null,
    cause: IOException? = null,
    private val fromSpark: Boolean = true,
) : IOException(message, cause) {
    val isSessionExpired: Boolean get() = fromSpark && (status == 401 || status == 403)

    // Server messages can contain user input. Keep the diagnostic representation scoped.
    override fun toString(): String = "Spark API error ($status, $code)"

    companion object {
        internal fun invalidResponse() = ApiError(null, "invalid_response", "无法读取 Spark 的响应。")
        internal fun signedOut() = ApiError(401, "session_expired", "请重新登录 Spark。")
        internal fun exportTooLarge() = ApiError(null, "export_too_large", "导出文件超过 256 MiB，已停止保存。")
        internal fun network(cause: IOException) = ApiError(null, "network_error", "网络连接中断，请稍后重试。", cause = cause)
    }
}

internal fun retryAfterSeconds(header: String?, nowMillis: Long = System.currentTimeMillis()): Long? {
    val value = header?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    value.toLongOrNull()?.let { return it.takeIf { seconds -> seconds >= 0 } }
    val parser = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { isLenient = false }
    val date = parser.parse(value, java.text.ParsePosition(0)) ?: return null
    return (date.time - nowMillis).coerceAtLeast(0).let { (it + 999) / 1000 }
}
