package cloud.stwqy.spark.core.storage

import androidx.room.withTransaction
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import cloud.stwqy.spark.core.network.CollectionPayload
import cloud.stwqy.spark.core.network.InvalidCollectionPayload
import cloud.stwqy.spark.core.network.Project
import cloud.stwqy.spark.core.network.Tag
import cloud.stwqy.spark.core.network.apiJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import java.io.IOException
import java.util.UUID

class DraftChanged : IOException("这条草稿无法打开或已变更，请重新打开。")
class DraftAccountChanged : IOException("请验证草稿所属账号后重试。")

data class DraftContent(
    val body: String,
    val purpose: String = "",
    val excluded: Boolean = false,
    val manualTitle: String = "",
    val projectIds: List<String> = emptyList(),
    val tagIds: List<String> = emptyList(),
)

class DraftLoginHandoff internal constructor(val draftId: String, val fromScope: String, val revision: Long)

class PreparedSubmission internal constructor(
    val draft: DraftEntity,
    val payload: CollectionPayload,
    val wasFrozen: Boolean,
)

class DraftRepository internal constructor(
    private val db: SparkDatabase,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val currentSnapshot: (() -> SessionSnapshot)? = null,
) {
    private val drafts = db.drafts()
    private val assets = db.assets()
    private val sessions = db.sessions()
    private val catalog = db.catalog()

    suspend fun observeSession(snapshot: SessionSnapshot) = db.withTransaction {
        val previous = sessions.current()
        if (!matchesCurrent(snapshot)) return@withTransaction
        if (previous?.fingerprint != snapshot.provisionalScope) {
            clearCatalogExcept(null)
            sessions.save(VerifiedSessionEntity(fingerprint = snapshot.provisionalScope))
        }
    }

    internal fun observeFingerprint() = sessions.observeFingerprint()

    internal suspend fun verifiedSession(snapshot: SessionSnapshot): VerifiedSessionEntity? = db.withTransaction {
        sessionFor(snapshot)?.takeIf { it.userScope() != null }
    }

    suspend fun rememberVerified(account: VerifiedAccount): Boolean = db.withTransaction {
        val current = sessionFor(account.snapshot)
        if (current == null || account.snapshot == SessionSnapshot.Guest) return@withTransaction false
        if (current.userId != null && !current.userId.equals(account.userId, ignoreCase = true)) {
            clearCatalogExcept(null)
            sessions.save(VerifiedSessionEntity(fingerprint = current.fingerprint))
            return@withTransaction false
        }
        clearCatalogExcept(account.scope)
        sessions.save(
            current.copy(userId = account.userId, palette = account.palette, theme = account.theme),
        )
        drafts.bindQueued(current.fingerprint, account.scope)
        true
    }

    suspend fun forgetVerification(snapshot: SessionSnapshot) = db.withTransaction {
        val current = sessionFor(snapshot) ?: return@withTransaction
        clearCatalogExcept(null)
        sessions.save(VerifiedSessionEntity(fingerprint = current.fingerprint))
    }

    suspend fun read(snapshot: SessionSnapshot, id: String): DraftEntity? = db.withTransaction {
        val current = sessionFor(snapshot) ?: return@withTransaction null
        drafts.find(id, current.scopes())
    }

    suspend fun list(snapshot: SessionSnapshot, offset: Int = 0, limit: Int = 20): List<DraftSummary> =
        db.withTransaction {
            require(offset >= 0 && limit in 1..100)
            val current = sessionFor(snapshot) ?: return@withTransaction emptyList()
            drafts.list(current.scopes(), limit, offset).map {
                DraftSummary(it.id, it.revision, it.preview, it.status, it.title,
                    readIds(it.projectIdsJson), readIds(it.tagIdsJson), it.lastError, it.imageCount)
            }
        }

    suspend fun create(snapshot: SessionSnapshot, id: String, content: DraftContent): DraftEntity = db.withTransaction {
        val current = sessionFor(snapshot) ?: throw DraftAccountChanged()
        insert(id, current.scopes(), content)
    }

    internal suspend fun sharedInputScope(snapshot: SessionSnapshot, captureScope: String): String {
        require(SessionScope.isUnbound(captureScope))
        if (snapshot.provisionalScope != captureScope) return captureScope
        return verifiedSession(snapshot)?.userScope() ?: captureScope
    }

    internal suspend fun saveSharedInput(
        id: String,
        captureScope: String,
        body: String,
        images: List<DraftAssetEntity>,
    ) = db.withTransaction {
        require(images.size <= AppConfig.MAX_IMAGES && images.all { it.draftId == id })
        val draft = newDraft(id, captureScope, DraftContent(body))
        if (drafts.insert(draft) == -1L) {
            return@withTransaction drafts.find(id, listOf(captureScope)) ?: throw DraftChanged()
        }
        images.forEach { assets.insert(it) }
        draft
    }

    internal fun observeDraftChanges() = db.invalidationTracker.createFlow("draft", "draft_asset")

    internal suspend fun finishSharedImage(
        snapshot: SessionSnapshot,
        draftId: String,
        pendingId: String,
        imported: DraftAssetEntity?,
        errorMessage: String?,
    ) = db.withTransaction {
        val draft = requireDraft(snapshot, draftId)
        if (draft.frozen || draft.status != DraftStatus.EDITING) throw DraftChanged()
        val pending = assets.list(draft.id, draft.scope).firstOrNull { it.id == pendingId && it.uploadState.importIncomplete }
            ?: throw DraftChanged()
        if (imported == null) {
            assets.update(pending.copy(uploadState = AssetUploadState.IMPORT_FAILED, errorMessage = errorMessage))
        } else {
            require(imported.draftId == draftId && imported.sortOrder == pending.sortOrder)
            assets.delete(draftId, pendingId)
            assets.insert(imported)
        }
    }

    internal suspend fun readAssets(snapshot: SessionSnapshot, id: String): List<DraftAssetEntity> = db.withTransaction {
        val current = sessionFor(snapshot) ?: return@withTransaction emptyList()
        val draft = drafts.find(id, current.scopes()) ?: return@withTransaction emptyList()
        assets.list(draft.id, draft.scope)
    }

    internal suspend fun mediaReferences(draftId: String?) = assets.paths(draftId).toSet()

    internal suspend fun openEditor(snapshot: SessionSnapshot, id: String): DraftEntity = db.withTransaction {
        val draft = requireDraft(snapshot, id)
        if (draft.status == DraftStatus.QUEUED) save(draft, draft.copy(status = DraftStatus.EDITING)) else draft
    }

    internal suspend fun removeAsset(snapshot: SessionSnapshot, target: DraftEntity, assetId: String): DraftEntity =
        db.withTransaction {
            val draft = editableDraft(snapshot, target.id, target.revision)
            if (assets.delete(draft.id, assetId) != 1) throw DraftChanged()
            save(draft, draft.copy(status = DraftStatus.EDITING, lastError = null))
        }

    internal suspend fun beginUpload(account: VerifiedAccount, target: DraftEntity, sendAfter: Boolean): DraftEntity =
        db.withTransaction {
            requireCurrentAccount(account)
            val draft = checkedDraft(account.snapshot, target.id, target.revision)
            if (draft.frozen) throw DraftChanged()
            val status = if (sendAfter) DraftStatus.UPLOADING_ASSETS else DraftStatus.EDITING
            save(draft, draft.copy(scope = account.scope, status = status, lastError = null))
        }

    internal suspend fun updateAsset(account: VerifiedAccount, target: DraftEntity, asset: DraftAssetEntity) =
        db.withTransaction {
            requireUploadDraft(account, target)
            if (asset.draftId != target.id || assets.update(asset) != 1) throw DraftChanged()
        }

    internal suspend fun finishUpload(
        account: VerifiedAccount,
        target: DraftEntity,
        queued: Boolean,
        message: String?,
    ): DraftEntity = db.withTransaction {
        val draft = requireUploadDraft(account, target)
        save(draft, draft.copy(status = if (queued) DraftStatus.QUEUED else DraftStatus.EDITING, lastError = message))
    }

    internal suspend fun rejectContent(account: VerifiedAccount, target: DraftEntity, message: String) = db.withTransaction {
        requireCurrentAccount(account)
        val draft = checkedDraft(account.snapshot, target.id, target.revision)
        if (draft.frozen) throw InvalidCollectionPayload(message)
        save(draft, draft.copy(status = DraftStatus.EDITING, lastError = message))
    }

    internal suspend fun hasQueue() = drafts.hasQueue()

    internal suspend fun recoverInterrupted(snapshot: SessionSnapshot) = db.withTransaction {
        val scope = sessionFor(snapshot)?.userScope() ?: return@withTransaction
        drafts.recoverInterrupted(scope, "上次保存结果待确认，将使用原内容重试。")
    }

    internal suspend fun queued(account: VerifiedAccount, afterId: String, limit: Int) = db.withTransaction {
        requireCurrentAccount(account)
        drafts.queued(account.scope, afterId, limit)
    }

    private suspend fun requireUploadDraft(account: VerifiedAccount, target: DraftEntity): DraftEntity {
        requireCurrentAccount(account)
        val draft = checkedDraft(account.snapshot, target.id, target.revision)
        if (draft.frozen || draft.scope != account.scope) throw DraftChanged()
        return draft
    }

    suspend fun edit(snapshot: SessionSnapshot, id: String, revision: Long, content: DraftContent): DraftEntity =
        db.withTransaction {
            val draft = editableDraft(snapshot, id, revision)
            val updated = draft.withContent(content)
            if (draft == updated) draft else save(draft, updated.copy(status = DraftStatus.EDITING, lastError = null))
        }

    suspend fun queue(snapshot: SessionSnapshot, id: String, revision: Long): DraftEntity = db.withTransaction {
        val draft = editableDraft(snapshot, id, revision)
        validateContent(draft, assets.list(draft.id, draft.scope))
        if (draft.status == DraftStatus.QUEUED) draft
        else save(draft, draft.copy(status = DraftStatus.QUEUED, lastError = null))
    }

    suspend fun delete(snapshot: SessionSnapshot, id: String, revision: Long) = db.withTransaction {
        val draft = checkedDraft(snapshot, id, revision)
        delete(draft)
    }

    suspend fun beginLogin(snapshot: SessionSnapshot, draftId: String): DraftLoginHandoff? = db.withTransaction {
        val session = sessionFor(snapshot) ?: return@withTransaction null
        if (session.userId != null || !SessionScope.isUnbound(session.fingerprint)) return@withTransaction null
        val draft = drafts.find(draftId, listOf(session.fingerprint)) ?: return@withTransaction null
        if (draft.frozen) null else DraftLoginHandoff(draft.id, draft.scope, draft.revision)
    }

    suspend fun claimAfterLogin(handoff: DraftLoginHandoff, account: VerifiedAccount): DraftEntity = db.withTransaction {
        requireCurrentAccount(account)
        if (!SessionScope.isUnbound(handoff.fromScope) || handoff.fromScope == account.snapshot.provisionalScope) {
            throw DraftAccountChanged()
        }
        val draft = drafts.find(handoff.draftId, listOf(handoff.fromScope))
        if (draft == null || draft.revision != handoff.revision || draft.frozen) throw DraftChanged()
        save(draft, draft.copy(scope = account.scope, status = DraftStatus.EDITING))
    }

    suspend fun prepareSubmission(account: VerifiedAccount, id: String, revision: Long): PreparedSubmission =
        db.withTransaction {
            requireCurrentAccount(account)
            val draft = checkedDraft(account.snapshot, id, revision)
            if (draft.scope != account.scope && (draft.frozen || draft.scope != account.snapshot.provisionalScope)) {
                throw DraftAccountChanged()
            }
            val requestId = draft.requestId ?: newId()
            val uploadIds = assets.list(draft.id, draft.scope).map {
                if (it.uploadState != AssetUploadState.READY || it.uploadId == null) {
                    throw InvalidCollectionPayload("请先完成图片上传。")
                }
                it.uploadId
            }
            val payload = payload(draft, requestId, uploadIds)
            val frozen = save(
                draft,
                draft.copy(
                    scope = account.scope,
                    requestId = requestId,
                    status = if (draft.isV1Frozen()) DraftStatus.UNCERTAIN else DraftStatus.SUBMITTING,
                    lastError = null,
                ),
            )
            PreparedSubmission(frozen, payload, wasFrozen = draft.frozen)
        }

    suspend fun finishSubmission(account: VerifiedAccount, submission: PreparedSubmission) = db.withTransaction {
        delete(currentSubmission(account, submission))
    }

    suspend fun failSubmission(
        account: VerifiedAccount,
        submission: PreparedSubmission,
        status: Int?,
        message: String,
        code: String? = null,
    ): DraftEntity = db.withTransaction {
        val draft = currentSubmission(account, submission)
        // An in-progress or ambiguous conflict can still produce the original collection.
        val missingImageStorage = status == 503 && code == "integration_not_configured" &&
            assets.list(draft.id, draft.scope).isNotEmpty()
        val rejected = status == 400 || status == 413 || status == 422 || missingImageStorage ||
            status == 404 && code == "not_found" ||
            status == 409 && (code == "duplicate_resource" || code == "idempotency_mismatch")
        save(
            draft,
            draft.copy(
                requestId = if (rejected) null else draft.requestId,
                status = if (rejected) DraftStatus.EDITING else DraftStatus.UNCERTAIN,
                lastError = if (!rejected && draft.isV1Frozen()) null else message,
            ),
        )
    }

    suspend fun replaceProjects(account: VerifiedAccount, projects: List<Project>, append: Boolean = false) = db.withTransaction {
        requireCurrentAccount(account)
        val fetchedAt = clock()
        if (!append) catalog.clearProjects(account.scope)
        catalog.insertProjects(projects.map { CachedProjectEntity(account.scope, it.id, it.name, it.state, fetchedAt) })
    }

    suspend fun replaceTags(account: VerifiedAccount, tags: List<Tag>, append: Boolean = false) = db.withTransaction {
        requireCurrentAccount(account)
        val fetchedAt = clock()
        if (!append) catalog.clearTags(account.scope)
        catalog.insertTags(tags.map { CachedTagEntity(account.scope, it.id, it.name, it.collectionCount, fetchedAt) })
    }

    suspend fun cachedProjects(snapshot: SessionSnapshot): List<CachedProjectEntity> = db.withTransaction {
        val scope = sessionFor(snapshot)?.userScope() ?: return@withTransaction emptyList()
        catalog.projects(scope)
    }

    suspend fun cachedTags(snapshot: SessionSnapshot): List<CachedTagEntity> = db.withTransaction {
        val scope = sessionFor(snapshot)?.userScope() ?: return@withTransaction emptyList()
        catalog.tags(scope)
    }

    internal fun validateContent(draft: DraftEntity, images: List<DraftAssetEntity>) {
        if (images.any { it.uploadState.importIncomplete }) {
            throw InvalidCollectionPayload("请先完成图片导入，或移除未导入的图片。")
        }
        payload(draft, draft.id, images.map { it.id })
    }

    private fun payload(draft: DraftEntity, requestId: String, uploadIds: List<String>) = CollectionPayload.encode(
        requestId, draft.body, draft.purpose, draft.excluded, draft.manualTitle, uploadIds,
        readIds(draft.projectIdsJson), readIds(draft.tagIdsJson), replayV1 = draft.isV1Frozen(),
    )

    internal fun contentOf(draft: DraftEntity) = DraftContent(
        draft.body, draft.purpose, draft.excluded, draft.manualTitle,
        readIds(draft.projectIdsJson), readIds(draft.tagIdsJson),
    )

    private suspend fun insert(id: String, scopes: List<String>, content: DraftContent): DraftEntity {
        val draft = newDraft(id, scopes.first(), content)
        if (drafts.insert(draft) != -1L) return draft
        return drafts.find(id, scopes) ?: throw DraftChanged()
    }

    private fun newDraft(id: String, scope: String, content: DraftContent): DraftEntity {
        require(isUuid(id)) { "Invalid draft ID" }
        return DraftEntity(id, scope, "", "", false, 0, clock()).withContent(content)
    }

    private suspend fun sessionFor(snapshot: SessionSnapshot): VerifiedSessionEntity? =
        sessions.current()?.takeIf { it.fingerprint == snapshot.provisionalScope && matchesCurrent(snapshot) }

    private fun matchesCurrent(snapshot: SessionSnapshot) = currentSnapshot?.invoke()?.let { it == snapshot } ?: true

    private suspend fun requireCurrentAccount(account: VerifiedAccount) {
        if (account.snapshot == SessionSnapshot.Guest || sessionFor(account.snapshot)?.userScope() != account.scope) {
            throw DraftAccountChanged()
        }
    }

    private fun VerifiedSessionEntity.userScope(): String? =
        userId?.takeIf(::isUuid)?.let(SessionScope::user)

    private fun VerifiedSessionEntity.scopes(): List<String> = listOfNotNull(userScope(), fingerprint)

    // The migration is the only source of a frozen UNCERTAIN row without a failure message.
    // Preserve that distinction through retries so a restart still uses the v1 encoder.
    private fun DraftEntity.isV1Frozen(): Boolean =
        requestId != null && status == DraftStatus.UNCERTAIN && lastError == null

    private suspend fun requireDraft(snapshot: SessionSnapshot, id: String): DraftEntity {
        val current = sessionFor(snapshot) ?: throw DraftAccountChanged()
        return drafts.find(id, current.scopes()) ?: throw DraftChanged()
    }

    private suspend fun checkedDraft(snapshot: SessionSnapshot, id: String, revision: Long): DraftEntity =
        requireDraft(snapshot, id).also { if (it.revision != revision) throw DraftChanged() }

    private suspend fun editableDraft(snapshot: SessionSnapshot, id: String, revision: Long): DraftEntity =
        checkedDraft(snapshot, id, revision).also {
            if (it.frozen || it.status == DraftStatus.UPLOADING_ASSETS) throw DraftChanged()
        }

    private suspend fun currentSubmission(account: VerifiedAccount, submission: PreparedSubmission): DraftEntity {
        requireCurrentAccount(account)
        val draft = checkedDraft(account.snapshot, submission.draft.id, submission.draft.revision)
        if (draft.scope != account.scope || draft.requestId != submission.payload.id) throw DraftChanged()
        return draft
    }

    private suspend fun delete(draft: DraftEntity) {
        if (drafts.delete(draft.id, draft.scope, draft.revision) != 1) throw DraftChanged()
    }

    private suspend fun save(previous: DraftEntity, updated: DraftEntity): DraftEntity {
        val modified = clock()
        val rows = drafts.update(
            previous.id, previous.scope, previous.revision, updated.scope, updated.body, updated.manualTitle,
            updated.purpose, updated.excluded, updated.projectIdsJson, updated.tagIdsJson, updated.status,
            updated.requestId, updated.lastError, modified,
        )
        if (rows != 1) throw DraftChanged()
        return updated.copy(revision = previous.revision + 1, modified = modified)
    }

    private suspend fun clearCatalogExcept(scope: String?) {
        catalog.clearProjectsExcept(scope)
        catalog.clearTagsExcept(scope)
    }

    private fun DraftEntity.withContent(content: DraftContent) = copy(
        body = content.body,
        purpose = content.purpose,
        excluded = content.excluded,
        manualTitle = content.manualTitle,
        projectIdsJson = apiJson.encodeToString(idsSerializer, content.projectIds),
        tagIdsJson = apiJson.encodeToString(idsSerializer, content.tagIds),
    )

    private fun readIds(json: String): List<String> = try {
        apiJson.decodeFromString(idsSerializer, json)
    } catch (error: SerializationException) {
        throw IOException("无法读取草稿的项目或标签。", error)
    }

    private companion object {
        val idsSerializer = ListSerializer(String.serializer())
    }
}
