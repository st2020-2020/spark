package cloud.stwqy.spark.core.auth

import cloud.stwqy.spark.core.config.isUuid
import okio.ByteString.Companion.encodeUtf8

object SessionScope {
    const val GUEST = "guest"
    private const val PENDING_PREFIX = "pending:"
    private const val USER_PREFIX = "user:"
    private const val COOKIE_NAME = "spark_session="

    fun user(userId: String): String {
        require(isUuid(userId)) { "Invalid account ID" }
        return USER_PREFIX + userId.lowercase()
    }

    internal fun isUnbound(scope: String): Boolean = scope == GUEST || scope.startsWith(PENDING_PREFIX)

    internal fun fromCookie(cookieHeader: String?): SessionSnapshot {
        if (cookieHeader == null || cookieHeader.length > 8192) return SessionSnapshot.Guest
        val cookie = cookieHeader.splitToSequence(';')
            .map(String::trim)
            .filter { it.startsWith(COOKIE_NAME) }
            .take(2)
            .toList()
            .singleOrNull() ?: return SessionSnapshot.Guest
        val value = cookie.removePrefix(COOKIE_NAME)
        if (value.isEmpty() || value.any { it !in '!'..'~' || it == '"' || it == ',' || it == '\\' }) {
            return SessionSnapshot.Guest
        }
        // v1 hashed this exact pair with padded Base64. Pending drafts rely on that format.
        return SessionSnapshot.CookieBased(cookie, PENDING_PREFIX + cookie.encodeUtf8().sha256().base64())
    }
}
