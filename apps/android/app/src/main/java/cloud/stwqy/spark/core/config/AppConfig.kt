package cloud.stwqy.spark.core.config

import cloud.stwqy.spark.BuildConfig
import okhttp3.HttpUrl.Companion.toHttpUrl

object AppConfig {
    val ORIGIN: String = BuildConfig.SPARK_ORIGIN.toHttpUrl().toString().removeSuffix("/")
    const val ALLOW_CLEARTEXT_DEV_ORIGIN = BuildConfig.ALLOW_CLEARTEXT_DEV_ORIGIN
    const val USER_AGENT_MARKER = "SparkMobile/1"

    const val MAX_SHARED_TEXT_UNITS = 100_000
    const val MAX_TEXT_CODE_POINTS = 50_000
    const val MAX_TITLE_CODE_POINTS = 200
    const val MAX_URL_CODE_POINTS = 4_096
    const val MAX_DOCUMENT_NODES = 10_000
    const val MAX_REQUEST_BYTES = 1 shl 20
    const val MAX_IMAGES = 9
    const val MAX_COLLECTION_ASSOCIATIONS = 50
    const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
    const val CATALOG_TTL_MILLIS = 10 * 60 * 1000L

    internal val cleartextDevHosts = setOf("10.0.2.2", "127.0.0.1", "localhost")
}

private val uuidPattern = Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")

internal fun isUuid(value: String): Boolean = uuidPattern.matches(value)
