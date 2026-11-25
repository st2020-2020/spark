package cloud.stwqy.spark.worker

import android.database.sqlite.SQLiteException
import android.util.Log
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.InvalidCollectionPayload
import cloud.stwqy.spark.core.network.SparkApiClient
import cloud.stwqy.spark.core.storage.DraftAccountChanged
import cloud.stwqy.spark.core.storage.DraftChanged
import cloud.stwqy.spark.core.storage.DraftEntity
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.DraftStatus
import cloud.stwqy.spark.core.storage.MediaStorage
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException

internal data class QueueRun(val retry: Boolean = false, val cooldown: Boolean = false)

internal class DraftSubmissionCoordinator(
    private val drafts: DraftRepository,
    private val credentials: SessionCredentialProvider,
    private val api: SparkApiClient,
    private val media: MediaStorage,
    private val uploader: AssetUploadCoordinator,
    private val scheduleQueue: () -> Unit = {},
) {
    private val inFlight = Mutex()

    suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount {
        requireCurrent(snapshot)
        val account = try {
            credentials.verify(snapshot)
        } catch (error: ApiError) {
            if (error.isSessionExpired) drafts.forgetVerification(snapshot)
            throw error
        }
        requireCurrent(snapshot)
        if (account.snapshot != snapshot || !drafts.rememberVerified(account)) throw DraftAccountChanged()
        return account
    }

    /** A null result means the server confirmed the collection and the local draft was removed. */
    suspend fun send(
        snapshot: SessionSnapshot,
        target: DraftEntity,
        progress: (AssetProgress) -> Unit = {},
    ): DraftEntity? = exclusive {
        val account = verify(snapshot)
        var scheduled = false
        whileCurrent(snapshot) {
            sendVerified(account, target, progress) {
                if (!scheduled) {
                    // Arrange recovery as soon as the foreground send has a durable checkpoint.
                    scheduleQueue()
                    scheduled = true
                }
            }
        }
    }

    suspend fun retryImage(snapshot: SessionSnapshot, target: DraftEntity, assetId: String, progress: (AssetProgress) -> Unit) =
        exclusive {
            val account = verify(snapshot)
            whileCurrent(snapshot) {
                val asset = drafts.readAssets(snapshot, target.id).singleOrNull { it.id == assetId } ?: throw DraftChanged()
                val uploading = drafts.beginUpload(account, target, sendAfter = false)
                try {
                    uploader.upload(account, uploading, asset, progress)
                    uploading
                } catch (error: AssetUploadFailure) {
                    drafts.finishUpload(account, uploading, queued = false, message = error.message)
                } catch (error: ApiError) {
                    if (error.isSessionExpired) drafts.forgetVerification(snapshot)
                    throw error
                }
            }
        }

    suspend fun queue(snapshot: SessionSnapshot, target: DraftEntity) {
        drafts.queue(snapshot, target.id, target.revision)
        scheduleQueue()
    }

    suspend fun delete(snapshot: SessionSnapshot, target: DraftEntity) = exclusive {
        requireCurrent(snapshot)
        drafts.delete(snapshot, target.id, target.revision)
        cleanDraftMedia(target.id)
    }

    suspend fun removeImage(snapshot: SessionSnapshot, target: DraftEntity, assetId: String) = exclusive {
        requireCurrent(snapshot)
        drafts.removeAsset(snapshot, target, assetId).also { cleanDraftMedia(target.id) }
    }

    suspend fun cleanOrphans() = media.sweep(references = { drafts.mediaReferences(null) })

    suspend fun recoverInEditor(snapshot: SessionSnapshot) {
        if (!inFlight.tryLock()) return
        try {
            drafts.recoverInterrupted(snapshot)
        } finally {
            inFlight.unlock()
        }
    }

    suspend fun drainQueue(): QueueRun {
        val snapshot = credentials.currentSnapshot()
        drafts.observeSession(snapshot)
        if (snapshot == SessionSnapshot.Guest || !drafts.hasQueue()) return QueueRun()
        val account = verify(snapshot)
        inFlight.withLock { drafts.recoverInterrupted(snapshot) }
        var afterId = ""
        var retry = false
        var cooldown = false
        while (true) {
            val page = drafts.queued(account, afterId, limit = 8)
            if (page.isEmpty()) return QueueRun(retry, cooldown)
            for (target in page) {
                afterId = target.id
                try {
                    val result = inFlight.withLock {
                        requireCurrent(snapshot)
                        // A row may have been opened in the editor while we waited for the foreground sender.
                        if (drafts.read(snapshot, target.id)?.revision != target.revision) throw DraftChanged()
                        if (!target.frozen && uploader.cooldownRemaining(account.scope) > 0 &&
                            drafts.readAssets(snapshot, target.id).isNotEmpty()
                        ) {
                            cooldown = true
                            return@withLock null
                        }
                        whileCurrent(snapshot) { sendVerified(account, target, progress = {}) }
                    }
                    when (result?.status) {
                        DraftStatus.QUEUED -> if (uploader.cooldownRemaining(account.scope) > 0) cooldown = true else retry = true
                        DraftStatus.UNCERTAIN -> retry = true
                        else -> Unit
                    }
                } catch (_: DraftChanged) {
                    // Refreshed, edited or removed in the foreground. Continue with the next queued row.
                }
            }
        }
    }

    private suspend fun sendVerified(
        account: VerifiedAccount,
        target: DraftEntity,
        progress: (AssetProgress) -> Unit,
        onCheckpoint: () -> Unit = {},
    ): DraftEntity? {
        val snapshot = account.snapshot
        val images = if (target.frozen) emptyList() else drafts.readAssets(snapshot, target.id)
        var current = target
        if (!target.frozen) {
            try {
                drafts.validateContent(target, images)
            } catch (error: InvalidCollectionPayload) {
                return drafts.rejectContent(account, target, error.message.orEmpty())
            }
        }
        try {
            if (images.isNotEmpty()) {
                current = drafts.beginUpload(account, target, sendAfter = true)
                onCheckpoint()
                for (asset in images) uploader.upload(account, current, asset, progress)
            }
        } catch (error: AssetUploadFailure) {
            return drafts.finishUpload(account, current, queued = error.retryInBackground, message = error.message)
        } catch (error: ApiError) {
            if (error.isSessionExpired) {
                drafts.finishUpload(account, current, queued = true, message = "登录已过期，请用原账号重新登录后再试。")
                drafts.forgetVerification(snapshot)
            } else {
                drafts.finishUpload(account, current, queued = false, message = "图片暂时传不上去，请稍后重试。")
            }
            throw error
        }
        val submission = try {
            drafts.prepareSubmission(account, current.id, current.revision)
        } catch (error: InvalidCollectionPayload) {
            // Flag local validation failures for editing instead of keeping them eligible for a Worker.
            return drafts.rejectContent(account, current, error.message.orEmpty())
        }
        onCheckpoint()
        var posting = false
        try {
            requireCurrent(snapshot)
            val alreadySaved = submission.wasFrozen && exists(account, submission.payload.id)
            if (!alreadySaved) {
                requireCurrent(snapshot)
                posting = true
                api.createCollection(account, submission.payload)
            }
        } catch (error: ApiError) {
            requireCurrent(snapshot)
            val saved = drafts.failSubmission(
                account, submission, error.status.takeIf { posting }, collectionMessage(error, posting), error.code,
            )
            if (error.isSessionExpired) {
                drafts.forgetVerification(snapshot)
                throw error
            }
            return saved
        }
        requireCurrent(snapshot)
        withContext(NonCancellable) {
            drafts.finishSubmission(account, submission)
            cleanDraftMedia(current.id)
        }
        return null
    }

    suspend fun cleanDraftMedia(id: String) = withContext(NonCancellable) {
        try {
            media.sweep(id) { drafts.mediaReferences(id) }
        } catch (_: IOException) {
            Log.w("Spark", "Unable to clean up private media")
        } catch (_: SQLiteException) {
            Log.w("Spark", "Unable to read private media references")
        }
    }

    private suspend fun <T> exclusive(block: suspend () -> T): T {
        if (!inFlight.tryLock()) throw IOException("另一条草稿正在发送，请稍后重试。")
        try {
            return block()
        } finally {
            inFlight.unlock()
        }
    }

    private suspend fun <T> whileCurrent(snapshot: SessionSnapshot, block: suspend () -> T): T = coroutineScope {
        val watcher = launch {
            drafts.observeFingerprint().collect {
                if (it != snapshot.provisionalScope) throw DraftAccountChanged()
            }
        }
        try {
            block()
        } finally {
            watcher.cancel()
        }
    }

    private fun requireCurrent(snapshot: SessionSnapshot) {
        if (credentials.currentSnapshot() != snapshot) throw DraftAccountChanged()
    }

    private suspend fun exists(account: VerifiedAccount, id: String): Boolean = try {
        api.collection(account, id)
        true
    } catch (error: ApiError) {
        if (error.status != 404) throw error
        false
    }

    private fun collectionMessage(error: ApiError, posting: Boolean) = when {
        error.isSessionExpired -> "登录已过期，请用原账号重新登录后再试。"
        !posting -> "暂时无法核对上次保存结果，请稍后重试。"
        error.status == 404 && error.code == "not_found" -> "所选项目或标签已不可用，请重新选择。"
        error.code == "operation_in_progress" -> "上次保存仍在处理中，请稍后重试。"
        error.status == 429 -> "保存过于频繁，请稍后重试。"
        error.status == 503 && error.code == "integration_not_configured" -> IMAGE_STORAGE_UNAVAILABLE
        error.status == 409 && error.code == "duplicate_resource" -> "这条记录可能已在别处保存或删除，请核对后再试。"
        error.status == 409 && error.code == "idempotency_mismatch" -> "草稿内容与上次提交不一致，请核对后再保存。"
        error.status == 409 -> "暂时无法确认保存冲突的结果，请稍后重试。"
        error.status == 413 -> "收藏内容太大，请分段保存。"
        error.status == 422 && error.code == "invalid_attachment" -> "有图片已无法用于收藏，请重试上传或移除。"
        error.status == 400 || error.status == 422 -> "内容格式不符合要求，请检查后再试。"
        else -> "未能确认保存，本机草稿已保留，请稍后重试。"
    }
}
