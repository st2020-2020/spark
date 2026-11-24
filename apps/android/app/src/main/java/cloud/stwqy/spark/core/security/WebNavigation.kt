package cloud.stwqy.spark.core.security

import cloud.stwqy.spark.core.config.AppConfig
import java.net.URI
import java.net.URISyntaxException

class WebNavigation(
    origin: String = AppConfig.ORIGIN,
    allowCleartextDevOrigin: Boolean = AppConfig.ALLOW_CLEARTEXT_DEV_ORIGIN,
) {
    enum class Destination { WEB, LOCAL_DRAFTS, BROWSER, BLOCK }

    private val origin = URI(origin).also {
        require(it.host != null && it.rawUserInfo == null && it.rawPath.isEmpty() &&
            it.rawQuery == null && it.rawFragment == null &&
            (it.scheme == "https" || it.scheme == "http" && allowCleartextDevOrigin &&
                it.host.lowercase() in AppConfig.cleartextDevHosts)) { "Invalid WebView origin" }
    }

    fun decide(
        currentUrl: String?,
        targetUrl: String?,
        method: String,
        mainFrame: Boolean,
        gesture: Boolean,
        redirect: Boolean,
    ): Destination {
        val target = parse(targetUrl) ?: return Destination.BLOCK
        val clicked = mainFrame && gesture && !redirect && method == "GET" && isSameOrigin(currentUrl)
        if (isSameOrigin(target)) {
            if (mainFrame && method != "GET") return Destination.BLOCK
            if (target.rawPath !in draftsPaths) return Destination.WEB
            return if (clicked && target.rawQuery == null && target.rawFragment == null) {
                Destination.LOCAL_DRAFTS
            } else Destination.BLOCK
        }
        return if (clicked && target.host != null && target.rawUserInfo == null &&
            (target.scheme.equals("https", true) || target.scheme.equals("http", true)) &&
            !(target.scheme.equals("http", true) && origin.scheme == "https" &&
                target.host.equals(origin.host, ignoreCase = true))
        ) Destination.BROWSER else Destination.BLOCK
    }

    fun allowsMainDocument(url: String?, method: String): Boolean = parse(url)?.let {
        method == "GET" && isSameOrigin(it) && it.rawPath !in draftsPaths
    } == true

    fun isSameOrigin(url: String?): Boolean = parse(url)?.let(::isSameOrigin) == true

    fun isInbox(url: String?): Boolean = parse(url)?.let { isSameOrigin(it) && it.rawPath == INBOX } == true

    private fun isSameOrigin(url: URI): Boolean =
        url.host != null && url.scheme.equals(origin.scheme, ignoreCase = true) &&
            url.rawAuthority.equals(origin.rawAuthority, ignoreCase = true)

    private fun parse(url: String?): URI? {
        if (url == null) return null
        return try {
            URI(url)
        } catch (_: URISyntaxException) {
            null
        }
    }

    companion object {
        const val INBOX = "/inbox"
        const val LOGIN = "/login"
        private val draftsPaths = setOf("/mobile/local-drafts", "/android/local-drafts")
    }
}
