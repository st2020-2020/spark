package cloud.stwqy.spark.worker

import android.content.Context
import android.database.sqlite.SQLiteException
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.await
import cloud.stwqy.spark.core.storage.DraftRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

internal class DraftWorkScheduler(context: Context, private val drafts: DraftRepository) {
    private val appContext = context.applicationContext
    private val work by lazy { WorkManager.getInstance(appContext) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val requests = Channel<Unit>(Channel.CONFLATED)

    fun start() {
        scope.launch {
            work.enqueueUniqueWork("draft-media-cleanup-startup", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<OrphanMediaCleanupWorker>().build())
            work.enqueueUniquePeriodicWork("draft-media-cleanup", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<OrphanMediaCleanupWorker>(1, TimeUnit.DAYS).build())
            for (request in requests) {
                try {
                    enqueueSend()
                } catch (_: SQLiteException) {
                    Log.w("Spark", "Unable to schedule local drafts")
                }
            }
        }
        requestSend()
    }

    fun requestSend() {
        requests.trySend(Unit)
    }

    private suspend fun enqueueSend() {
        if (!drafts.hasQueue()) return
        val request = draftUploadRequest()
        work.enqueueUniqueWork(UPLOAD_QUEUE, ExistingWorkPolicy.KEEP, request).await()
        if (work.getWorkInfoByIdFlow(request.id).first() != null) return
        // KEEP can discard a wake-up while the current run is finishing its last page.
        val running = work.getWorkInfosForUniqueWorkFlow(UPLOAD_QUEUE).first()
            .firstOrNull { !it.state.isFinished }
        if (running?.state == WorkInfo.State.RUNNING) {
            val next = work.getWorkInfoByIdFlow(running.id).first { it?.state != WorkInfo.State.RUNNING }
            if (next == null || next.state.isFinished) requestSend()
        } else if (running == null) {
            requestSend()
        }
    }

    private companion object {
        const val UPLOAD_QUEUE = "draft-upload-queue"
    }
}

internal fun draftUploadRequest() = OneTimeWorkRequestBuilder<DraftUploadWorker>()
    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
    .build()
