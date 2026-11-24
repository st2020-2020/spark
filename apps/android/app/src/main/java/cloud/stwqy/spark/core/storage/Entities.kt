package cloud.stwqy.spark.core.storage

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

enum class DraftStatus { EDITING, QUEUED, UPLOADING_ASSETS, SUBMITTING, UNCERTAIN }

@Entity(tableName = "draft", indices = [Index(value = ["scope", "modified"])])
data class DraftEntity(
    @PrimaryKey val id: String,
    val scope: String,
    val body: String,
    val purpose: String,
    val excluded: Boolean,
    val revision: Long,
    val modified: Long,
    @ColumnInfo(name = "manual_title", defaultValue = "''") val manualTitle: String = "",
    @ColumnInfo(name = "project_ids_json", defaultValue = "'[]'") val projectIdsJson: String = "[]",
    @ColumnInfo(name = "tag_ids_json", defaultValue = "'[]'") val tagIdsJson: String = "[]",
    @ColumnInfo(defaultValue = "'EDITING'") val status: DraftStatus = DraftStatus.EDITING,
    @ColumnInfo(name = "request_id") val requestId: String? = null,
    @ColumnInfo(name = "last_error") val lastError: String? = null,
) {
    val frozen: Boolean get() = requestId != null
}

enum class AssetUploadState {
    LOCAL, UPLOADING, VERIFYING, READY, FAILED, IMPORTING, IMPORT_FAILED;

    internal val importIncomplete: Boolean get() = this == IMPORTING || this == IMPORT_FAILED
}

@Entity(
    tableName = "draft_asset",
    foreignKeys = [ForeignKey(
        entity = DraftEntity::class,
        parentColumns = ["id"],
        childColumns = ["draft_id"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index(value = ["draft_id", "sort_order"])],
)
data class DraftAssetEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "draft_id") val draftId: String,
    @ColumnInfo(name = "local_path") val localPath: String,
    val filename: String,
    @ColumnInfo(name = "mime_type") val mimeType: String,
    @ColumnInfo(name = "size_bytes") val sizeBytes: Long,
    @ColumnInfo(name = "sort_order") val sortOrder: Int,
    @ColumnInfo(name = "upload_idempotency_key") val uploadIdempotencyKey: String,
    @ColumnInfo(name = "upload_id") val uploadId: String? = null,
    @ColumnInfo(name = "bytes_transferred", defaultValue = "0") val bytesTransferred: Boolean = false,
    @ColumnInfo(name = "upload_state", defaultValue = "'LOCAL'") val uploadState: AssetUploadState = AssetUploadState.LOCAL,
    @ColumnInfo(name = "error_code") val errorCode: String? = null,
    @ColumnInfo(name = "error_message") val errorMessage: String? = null,
)

@Entity(tableName = "verified_session")
internal data class VerifiedSessionEntity(
    @PrimaryKey val slot: Int = 1,
    val fingerprint: String,
    @ColumnInfo(name = "user_id") val userId: String? = null,
    @ColumnInfo(defaultValue = "'mint'") val palette: String = "mint",
    @ColumnInfo(defaultValue = "'system'") val theme: String = "system",
)

@Entity(tableName = "cached_project", primaryKeys = ["scope", "id"])
data class CachedProjectEntity(
    val scope: String,
    val id: String,
    val name: String,
    val state: String,
    @ColumnInfo(name = "fetched_at") val fetchedAt: Long,
)

@Entity(tableName = "cached_tag", primaryKeys = ["scope", "id"])
data class CachedTagEntity(
    val scope: String,
    val id: String,
    val name: String,
    @ColumnInfo(name = "collection_count") val collectionCount: Long,
    @ColumnInfo(name = "fetched_at") val fetchedAt: Long,
)

internal data class DraftPreview(
    val id: String,
    val revision: Long,
    val preview: String,
    val status: DraftStatus,
    val title: String,
    val projectIdsJson: String,
    val tagIdsJson: String,
    val lastError: String?,
    val imageCount: Int,
)

data class DraftSummary(
    val id: String,
    val revision: Long,
    val preview: String,
    val status: DraftStatus,
    val title: String,
    val projectIds: List<String>,
    val tagIds: List<String>,
    val lastError: String?,
    val imageCount: Int,
)
