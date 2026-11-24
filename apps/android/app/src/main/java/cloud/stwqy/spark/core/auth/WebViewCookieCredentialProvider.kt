package cloud.stwqy.spark.core.auth

import android.webkit.CookieManager
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.SparkApiClient
import java.io.IOException

class WebViewCookieCredentialProvider(
    private val api: SparkApiClient,
) : SessionCredentialProvider {
    override fun currentSnapshot(): SessionSnapshot = try {
        SessionScope.fromCookie(CookieManager.getInstance().getCookie(AppConfig.ORIGIN))
    } catch (error: Throwable) {
        // Some devices cannot initialize the WebView provider from a background Worker.
        throw WebViewCredentialsUnavailable(error)
    }

    override suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount {
        val session = api.session(snapshot)
        if (!isUuid(session.user.id) || session.csrfToken.isBlank() ||
            session.csrfToken.length > 1024 || session.csrfToken.any { it !in '!'..'~' }
        ) {
            throw ApiError.invalidResponse()
        }
        return VerifiedAccount(
            userId = session.user.id.lowercase(),
            email = session.user.email,
            csrfToken = session.csrfToken,
            palette = session.user.palette,
            theme = session.user.theme,
            snapshot = snapshot,
        )
    }

    override fun flush() = CookieManager.getInstance().flush()
}

internal class WebViewCredentialsUnavailable(cause: Throwable) : IOException("暂时无法读取登录状态。", cause)
