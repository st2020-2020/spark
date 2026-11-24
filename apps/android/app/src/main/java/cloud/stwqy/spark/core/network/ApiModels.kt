package cloud.stwqy.spark.core.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

internal val apiJson = Json { ignoreUnknownKeys = true }

@Serializable
internal class SessionResult(
    val user: SessionUser,
    @SerialName("csrf_token") val csrfToken: String,
)

@Serializable
internal class SessionUser(
    val id: String,
    val email: String,
    val palette: String = "mint",
    val theme: String = "system",
)

@Serializable
data class CatalogPage<T>(
    val items: List<T>,
    @SerialName("next_cursor") val nextCursor: String? = null,
)

@Serializable
data class Project(
    val id: String,
    val name: String,
    val state: String,
)

@Serializable
data class Tag(
    val id: String,
    val name: String,
    val path: String,
    @SerialName("collection_count") val collectionCount: Long,
)

@Serializable
data class UploadRequest(
    val filename: String,
    @SerialName("size_bytes") val sizeBytes: Long,
    @SerialName("mime_type") val mimeType: String,
)

@Serializable
class UploadGrant(
    val id: String,
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    @SerialName("expires_at") val expiresAt: String,
)

@Serializable
enum class UploadStatus {
    @SerialName("pending") PENDING,
    @SerialName("verifying") VERIFYING,
    @SerialName("ready") READY,
    @SerialName("attached") ATTACHED,
    @SerialName("rejected") REJECTED,
    @SerialName("expired") EXPIRED,
}

@Serializable
data class Upload(
    val id: String,
    val status: UploadStatus,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("size_bytes") val sizeBytes: Long? = null,
    @SerialName("mime_type") val mimeType: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
)

@Serializable
data class CollectionReceipt(val id: String)

@Serializable
internal data class CollectionCreate(
    val id: String,
    val document: JsonObject,
    val intent: String,
    @SerialName("upload_ids") val uploadIds: List<String>,
    @SerialName("project_ids") val projectIds: List<String>,
    @SerialName("tag_ids") val tagIds: List<String>,
    @SerialName("ai_excluded") val aiExcluded: Boolean,
    @SerialName("original_url") val originalUrl: String? = null,
    @SerialName("manual_title") val manualTitle: String? = null,
)

@Serializable
internal class ApiErrorEnvelope(val error: Detail) {
    @Serializable
    class Detail(val code: String, val message: String)
}

enum class ExportFormat(val wireValue: String) {
    MARKDOWN("markdown"),
    JSON("json"),
}
