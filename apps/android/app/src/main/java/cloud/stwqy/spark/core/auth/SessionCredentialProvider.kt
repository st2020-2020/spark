package cloud.stwqy.spark.core.auth

sealed interface SessionSnapshot {
    val provisionalScope: String
    val requestHeaders: Map<String, String>

    data object Guest : SessionSnapshot {
        override val provisionalScope = SessionScope.GUEST
        override val requestHeaders = emptyMap<String, String>()
    }

    @ConsistentCopyVisibility
    data class CookieBased internal constructor(
        val rawCookie: String,
        override val provisionalScope: String,
    ) : SessionSnapshot {
        override val requestHeaders: Map<String, String>
            get() = mapOf("Cookie" to rawCookie)

        override fun toString() = "CookieBased([redacted])"
    }
}

class VerifiedAccount internal constructor(
    val userId: String,
    val email: String?,
    val csrfToken: String,
    val palette: String,
    val theme: String,
    val snapshot: SessionSnapshot,
) {
    val scope: String get() = SessionScope.user(userId)

    override fun toString() = "VerifiedAccount([redacted])"
}

interface SessionCredentialProvider {
    fun currentSnapshot(): SessionSnapshot
    suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount
    fun flush()
}
