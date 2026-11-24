package cloud.stwqy.spark.worker

import android.content.SharedPreferences
import android.util.Log
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.auth.WebViewCredentialsUnavailable
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.SparkApiClient
import cloud.stwqy.spark.core.network.UploadRequest
import cloud.stwqy.spark.core.network.UploadStatus
import cloud.stwqy.spark.core.storage.AssetUploadState
import cloud.stwqy.spark.core.storage.DraftAccountChanged
import cloud.stwqy.spark.core.storage.DraftAssetEntity
import cloud.stwqy.spark.core.storage.DraftChanged
import cloud.stwqy.spark.core.storage.DraftEntity
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.MediaStorage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

internal const val IMAGE_STORAGE_UNAVAILABLE = "当前环境未开启图片上传。移除图片后仍可保存正文或网址。"

internal data class AssetProgress(val assetId: String, val state: AssetUploadState, val fraction: Float? = null)

internal class AssetUploadFailure(
    val code: String,
    message: String,
    val retryInBackground: Boolean = false,
    val replaceGrant: Boolean = false,
) : IOException(message)

internal class AssetUploadCoordinator(
    private val drafts: DraftRepository,
    private val media: MediaStorage,
    private val credentials: SessionCredentialProvider,
    private val api: SparkApiClient,
    private val retryAfter: SharedPreferences,
    private val clock: () -> Long = System::currentTimeMillis,
    private val waitForVerification: suspend (Long) -> Unit = { delay(it) },
) {
    fun cooldownRemaining(scope: String): Long =
        (retryAfter.getLong(scope, 0L) - clock()).coerceAtLeast(0L)

    suspend fun upload(
        account: VerifiedAccount,
        draft: DraftEntity,
        original: DraftAssetEntity,
        progress: (AssetProgress) -> Unit,
    ) {
        var asset = original
        suspend fun save(updated: DraftAssetEntity) {
            drafts.updateAsset(account, draft, updated)
            asset = updated
            progress(AssetProgress(asset.id, asset.uploadState))
        }

        try {
            val remaining = cooldownRemaining(account.scope)
            if (remaining > 0) throw rateLimited((remaining - 1) / 1000 + 1)
            var id = asset.uploadId
            val confirmed = if (id != null && (!asset.bytesTransferred || asset.uploadState == AssetUploadState.READY)) {
                requireCurrent(account)
                api.upload(account, id)
            } else null
            val upload = if (confirmed != null && confirmed.status != UploadStatus.PENDING) {
                if (!asset.bytesTransferred && confirmed.status in setOf(UploadStatus.VERIFYING, UploadStatus.READY, UploadStatus.ATTACHED)) {
                    save(asset.copy(bytesTransferred = true, uploadState = AssetUploadState.VERIFYING))
                }
                confirmed
            } else {
                if (!asset.bytesTransferred || id == null) {
                    val file = withContext(Dispatchers.IO) {
                        media.file(asset).takeIf { it.isFile && it.length() == asset.sizeBytes }
                    } ?: throw AssetUploadFailure("missing_local_image", "本机图片已无法读取，请移除后重新分享。")
                    save(asset.copy(uploadState = AssetUploadState.UPLOADING, errorCode = null, errorMessage = null))
                    requireCurrent(account)
                    val grant = api.requestUpload(account, asset.uploadIdempotencyKey,
                        UploadRequest(asset.filename, asset.sizeBytes, asset.mimeType))
                    // A replayed key must still refer to the same object.
                    if (id != null && !id.equals(grant.id, ignoreCase = true)) throw ApiError.invalidResponse()
                    id = grant.id
                    save(asset.copy(uploadId = id, bytesTransferred = false))
                    requireCurrent(account)
                    api.putUpload(grant, file) { bytes ->
                        progress(AssetProgress(original.id, AssetUploadState.UPLOADING, bytes.toFloat() / original.sizeBytes))
                    }
                    // Record the acknowledged PUT before cancellation or confirmation can interrupt us.
                    withContext(NonCancellable) {
                        save(asset.copy(bytesTransferred = true, uploadState = AssetUploadState.VERIFYING))
                    }
                } else {
                    save(asset.copy(uploadState = AssetUploadState.VERIFYING, errorCode = null, errorMessage = null))
                }
                requireCurrent(account)
                api.completeUpload(account, id ?: throw ApiError.invalidResponse())
            }
            var status = upload.status
            for (index in 0 until 15) {
                if (status.isFinal()) break
                waitForVerification(400L + index * 150L)
                requireCurrent(account)
                status = api.upload(account, upload.id).status
            }
            when (status) {
                UploadStatus.READY -> save(asset.copy(uploadState = AssetUploadState.READY, errorCode = null, errorMessage = null))
                UploadStatus.PENDING, UploadStatus.VERIFYING ->
                    throw AssetUploadFailure("upload_verifying", "服务器仍在确认图片，稍后可以继续。", retryInBackground = true)
                // Frozen submissions are handled by collection reconciliation before calling this uploader.
                UploadStatus.ATTACHED -> throw grantEnded("upload_attached", "图片已用于另一条收藏，请重试上传。")
                UploadStatus.REJECTED -> throw grantEnded("upload_rejected", "服务器无法确认这张图片，请重试或移除。")
                UploadStatus.EXPIRED -> throw grantEnded("upload_expired", "图片上传已过期，请重试。")
            }
        } catch (error: IOException) {
            if (error is DraftAccountChanged || error is DraftChanged ||
                error is WebViewCredentialsUnavailable ||
                error is ApiError && error.isSessionExpired
            ) throw error
            requireCurrent(account)
            val failure = when (error) {
                is AssetUploadFailure -> error
                is ApiError -> translate(account, error)
                else -> AssetUploadFailure("local_image_error", "无法读取本机图片，请检查存储后重试。")
            }
            val saved = if (failure.replaceGrant) {
                asset.copy(uploadIdempotencyKey = UUID.randomUUID().toString(), uploadId = null, bytesTransferred = false)
            } else asset
            save(saved.copy(uploadState = AssetUploadState.FAILED, errorCode = failure.code, errorMessage = failure.message))
            // A storage refusal is terminal for this run, but does not invalidate the Spark session.
            if (error is ApiError && (error.status == 401 || error.status == 403)) throw error
            throw failure
        }
    }

    private fun requireCurrent(account: VerifiedAccount) {
        if (credentials.currentSnapshot() != account.snapshot) throw DraftAccountChanged()
    }

    private suspend fun translate(account: VerifiedAccount, error: ApiError): AssetUploadFailure = when {
        error.status == 429 -> {
            val seconds = error.retryAfterSeconds ?: 60
            val now = clock()
            val deadline = now + seconds.coerceAtMost((Long.MAX_VALUE - now) / 1000) * 1000
            withContext(Dispatchers.IO) {
                if (!retryAfter.edit().putLong(account.scope, deadline).commit()) {
                    Log.w("Spark", "Unable to persist the upload retry time")
                }
            }
            rateLimited(seconds)
        }
        error.status == 503 && error.code == "integration_not_configured" -> AssetUploadFailure(
            error.code, IMAGE_STORAGE_UNAVAILABLE,
        )
        error.status == 404 || error.status == 410 || error.status == 409 && error.code == "upload_not_pending" ->
            grantEnded("upload_expired", "图片上传已失效，请重试。")
        error.status == 401 || error.status == 403 ->
            AssetUploadFailure("object_upload_refused", "图片存储拒绝了上传，请重试。")
        error.code == "operation_in_progress" -> AssetUploadFailure(
            error.code, "上次图片上传仍在处理中，请稍后重试。", retryInBackground = true,
        )
        error.code == "network_error" || (error.status ?: 0) >= 500 -> AssetUploadFailure(
            error.code, "图片上传中断，联网后可以继续。", retryInBackground = true,
        )
        else -> AssetUploadFailure(error.code, "图片上传失败，请重试或移除。")
    }

    private fun grantEnded(code: String, message: String) = AssetUploadFailure(code, message, replaceGrant = true)

    private fun rateLimited(seconds: Long) = AssetUploadFailure(
        "rate_limited", "图片上传过于频繁，请在 $seconds 秒后重试。", retryInBackground = true,
    )

    private fun UploadStatus.isFinal() = this != UploadStatus.PENDING && this != UploadStatus.VERIFYING
}
