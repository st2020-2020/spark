package cloud.stwqy.spark.core.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
internal interface DraftDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(draft: DraftEntity): Long

    @Query("SELECT * FROM draft WHERE id = :id AND scope IN (:scopes)")
    suspend fun find(id: String, scopes: List<String>): DraftEntity?

    @Query("""
        SELECT id, revision, substr(body, 1, 160) AS preview, status, manual_title AS title,
            project_ids_json AS projectIdsJson, tag_ids_json AS tagIdsJson, last_error AS lastError,
            (SELECT COUNT(*) FROM draft_asset WHERE draft_id = draft.id) AS imageCount
        FROM draft
        WHERE scope IN (:scopes) ORDER BY modified DESC, id LIMIT :limit OFFSET :offset
    """)
    suspend fun list(scopes: List<String>, limit: Int, offset: Int): List<DraftPreview>

    @Query("""
        SELECT EXISTS(SELECT 1 FROM draft WHERE status IN ('QUEUED', 'UNCERTAIN', 'UPLOADING_ASSETS', 'SUBMITTING'))
    """)
    suspend fun hasQueue(): Boolean

    @Query("""
        SELECT * FROM draft WHERE scope = :scope AND status IN ('QUEUED', 'UNCERTAIN') AND id > :afterId
        ORDER BY id LIMIT :limit
    """)
    suspend fun queued(scope: String, afterId: String, limit: Int): List<DraftEntity>

    @Query("""
        UPDATE draft SET scope = :scope, revision = revision + 1
        WHERE scope = :fingerprint AND status = 'QUEUED' AND request_id IS NULL
    """)
    suspend fun bindQueued(fingerprint: String, scope: String)

    @Query("""
        UPDATE draft SET status = CASE WHEN request_id IS NULL THEN 'QUEUED' ELSE 'UNCERTAIN' END,
            last_error = CASE WHEN request_id IS NULL THEN NULL ELSE :message END,
            revision = revision + 1
        WHERE scope = :scope AND status IN ('UPLOADING_ASSETS', 'SUBMITTING')
    """)
    suspend fun recoverInterrupted(scope: String, message: String)

    @Query("""
        UPDATE draft SET scope = :scope, body = :body, manual_title = :manualTitle, purpose = :purpose,
            excluded = :excluded, project_ids_json = :projectIdsJson, tag_ids_json = :tagIdsJson,
            status = :status, request_id = :requestId, last_error = :lastError, modified = :modified,
            revision = revision + 1
        WHERE id = :id AND scope = :previousScope AND revision = :revision
    """)
    suspend fun update(
        id: String,
        previousScope: String,
        revision: Long,
        scope: String,
        body: String,
        manualTitle: String,
        purpose: String,
        excluded: Boolean,
        projectIdsJson: String,
        tagIdsJson: String,
        status: DraftStatus,
        requestId: String?,
        lastError: String?,
        modified: Long,
    ): Int

    @Query("DELETE FROM draft WHERE id = :id AND scope = :scope AND revision = :revision")
    suspend fun delete(id: String, scope: String, revision: Long): Int
}

@Dao
internal interface AssetDao {
    @Insert
    suspend fun insert(asset: DraftAssetEntity)

    @Query("""
        SELECT a.* FROM draft_asset AS a JOIN draft AS d ON a.draft_id = d.id
        WHERE a.draft_id = :draftId AND d.scope = :scope ORDER BY a.sort_order, a.id
    """)
    suspend fun list(draftId: String, scope: String): List<DraftAssetEntity>

    @Update
    suspend fun update(asset: DraftAssetEntity): Int

    @Query("DELETE FROM draft_asset WHERE draft_id = :draftId AND id = :assetId")
    suspend fun delete(draftId: String, assetId: String): Int

    @Query("SELECT local_path FROM draft_asset WHERE :draftId IS NULL OR draft_id = :draftId")
    suspend fun paths(draftId: String?): List<String>
}

@Dao
internal interface SessionDao {
    @Query("SELECT * FROM verified_session WHERE slot = 1")
    suspend fun current(): VerifiedSessionEntity?

    @Query("SELECT fingerprint FROM verified_session WHERE slot = 1")
    fun observeFingerprint(): Flow<String?>

    @Upsert
    suspend fun save(session: VerifiedSessionEntity)
}

@Dao
internal interface CatalogDao {
    @Query("SELECT * FROM cached_project WHERE scope = :scope ORDER BY name, id")
    suspend fun projects(scope: String): List<CachedProjectEntity>

    @Query("SELECT * FROM cached_tag WHERE scope = :scope ORDER BY name, id")
    suspend fun tags(scope: String): List<CachedTagEntity>

    @Upsert
    suspend fun insertProjects(projects: List<CachedProjectEntity>)

    @Upsert
    suspend fun insertTags(tags: List<CachedTagEntity>)

    @Query("DELETE FROM cached_project WHERE scope = :scope")
    suspend fun clearProjects(scope: String)

    @Query("DELETE FROM cached_tag WHERE scope = :scope")
    suspend fun clearTags(scope: String)

    @Query("DELETE FROM cached_project WHERE :scope IS NULL OR scope <> :scope")
    suspend fun clearProjectsExcept(scope: String?)

    @Query("DELETE FROM cached_tag WHERE :scope IS NULL OR scope <> :scope")
    suspend fun clearTagsExcept(scope: String?)
}
