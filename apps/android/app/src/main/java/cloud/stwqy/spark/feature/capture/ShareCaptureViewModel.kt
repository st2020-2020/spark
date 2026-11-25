package cloud.stwqy.spark.feature.capture

import androidx.lifecycle.viewModelScope
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.security.SharedInput
import cloud.stwqy.spark.core.storage.AssetUploadState
import cloud.stwqy.spark.core.storage.DraftAssetEntity
import cloud.stwqy.spark.core.storage.DraftChanged
import cloud.stwqy.spark.core.storage.DraftEntity
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.ImageTooLarge
import cloud.stwqy.spark.core.storage.ImageImportTimedOut
import cloud.stwqy.spark.core.storage.InvalidImage
import cloud.stwqy.spark.core.storage.MediaStorage
import cloud.stwqy.spark.feature.drafts.DraftCatalog
import cloud.stwqy.spark.feature.drafts.DraftIdentity
import cloud.stwqy.spark.feature.drafts.DraftRestore
import cloud.stwqy.spark.worker.DraftSubmissionCoordinator
import cloud.stwqy.spark.feature.drafts.DraftViewModel
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.coroutineContext

internal data class SharedDraft(val id: String, val scope: String, val input: SharedInput)

internal class ShareCaptureViewModel(
    private val drafts: DraftRepository,
    credentials: SessionCredentialProvider,
    catalog: DraftCatalog,
    private val submission: DraftSubmissionCoordinator,
    private val media: MediaStorage,
    restored: DraftRestore,
    private var incoming: SharedDraft?,
    initialIdentity: DraftIdentity,
    inputError: String?,
) : DraftViewModel(
    drafts, credentials, catalog, submission, media, capture = true,
    restored = restored.copy(draftId = incoming?.id ?: restored.draftId),
    initialIdentity = initialIdentity,
    initialShareError = inputError,
) {
    private var incomingSaved = false
    private var initialImportsStarted = false

    fun receive(shared: SharedDraft?, error: String?, online: Boolean) {
        replaceCapture(shared?.id, error, online) {
            incoming = shared
            incomingSaved = false
            initialImportsStarted = false
        }
    }

    override fun restore(): DraftRestore {
        val unsaved = incoming?.takeUnless { incomingSaved }
        return super.restore().copy(captureScope = unsaved?.scope, incoming = unsaved != null)
    }

    override suspend fun initialDraft(snapshot: SessionSnapshot): DraftEntity? {
        val shared = incoming ?: return null
        val existing = drafts.read(snapshot, shared.id)
        if (existing == null && !incomingSaved) {
            val scope = drafts.sharedInputScope(snapshot, shared.scope)
            val pending = shared.input.images.mapIndexed { index, _ ->
                val id = UUID.randomUUID().toString()
                DraftAssetEntity(
                    id, shared.id, "${shared.id}/$id", "图片-${index + 1}", "", 0, index,
                    UUID.randomUUID().toString(), uploadState = AssetUploadState.IMPORTING,
                )
            }
            drafts.saveSharedInput(shared.id, scope, shared.input.text, pending)
        } else if (existing != null && !incomingSaved) {
            // After process death the launch Intent may differ from the share that created this row.
            incoming = null
        }
        incomingSaved = true
        setShareNotice(if (shared.input.hasMoreImages) "一次最多带 9 张图，已保留前 9 张，其余可分批收藏。" else null)
        return existing ?: drafts.read(snapshot, shared.id)
    }

    override fun afterSelection(snapshot: SessionSnapshot, draft: DraftEntity) {
        if (initialImportsStarted) return
        val shared = incoming?.takeIf { it.id == draft.id } ?: return
        val pending = state.value.images.filter { it.asset.uploadState == AssetUploadState.IMPORTING }
        if (pending.isEmpty()) {
            if (shared.input.images.isEmpty()) incoming = null
            return
        }
        initialImportsStarted = true
        val ids = pending.map { it.asset.id }
        viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            setImageImportsActive(ids, true)
            try {
                withDraftFailures {
                    for (image in pending) {
                        if (credentials.currentSnapshot() != snapshot) break
                        val asset = image.asset
                        val source = shared.input.images.getOrNull(asset.sortOrder)
                        importImage(snapshot, asset, source)
                    }
                }
            } finally {
                setImageImportsActive(ids, false)
                if (incoming === shared && state.value.draft?.id == draft.id &&
                    state.value.images.none { it.asset.uploadState.importIncomplete }
                ) {
                    incoming = null
                }
            }
        }
    }

    override fun canRetryImport(asset: DraftAssetEntity): Boolean =
        incoming?.takeIf { it.id == asset.draftId }?.input?.images?.getOrNull(asset.sortOrder) != null

    override suspend fun retryImport(snapshot: SessionSnapshot, asset: DraftAssetEntity) {
        val source = incoming?.takeIf { it.id == asset.draftId }?.input?.images?.getOrNull(asset.sortOrder)
        setImageImportsActive(listOf(asset.id), true)
        importImage(snapshot, asset, source)
    }

    private suspend fun importImage(snapshot: SessionSnapshot, asset: DraftAssetEntity, source: String?) {
        try {
            if (drafts.readAssets(snapshot, asset.draftId).none { it.id == asset.id }) return
            media.importing(asset.draftId) {
                var error = "原图已失效，移除后可重新分享"
                val imported = if (source == null) null else try {
                    media.copy(asset.draftId, source, asset.sortOrder)
                } catch (failure: IOException) {
                    error = when (failure) {
                        is ImageTooLarge, is InvalidImage, is ImageImportTimedOut ->
                            failure.message.orEmpty()
                        else -> "这张图没读出来，可重试或重新分享"
                    }
                    null
                }
                coroutineContext.ensureActive()
                drafts.finishSharedImage(snapshot, asset.draftId, asset.id, imported, error)
            }
        } catch (_: DraftChanged) {
            // The attachment or draft was removed while the provider was reading.
        } finally {
            setImageImportsActive(listOf(asset.id), false)
            submission.cleanDraftMedia(asset.draftId)
        }
    }

    companion object {
        fun sharedDraft(restored: DraftRestore, scope: String, input: SharedInput) =
            SharedDraft(restored.draftId ?: UUID.randomUUID().toString(), restored.captureScope ?: scope, input)
    }
}
