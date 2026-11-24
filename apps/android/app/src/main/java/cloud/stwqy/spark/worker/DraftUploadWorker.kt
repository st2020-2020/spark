package cloud.stwqy.spark.worker

import android.content.Context
import android.database.sqlite.SQLiteException
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import cloud.stwqy.spark.SparkApp
import cloud.stwqy.spark.core.auth.WebViewCredentialsUnavailable
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.storage.DraftAccountChanged

class DraftUploadWorker internal constructor(
    context: Context,
    parameters: WorkerParameters,
    private val drain: suspend () -> QueueRun,
) : CoroutineWorker(context, parameters) {
    constructor(context: Context, parameters: WorkerParameters) : this(context, parameters, {
        (context.applicationContext as SparkApp).draftSubmission.drainQueue()
    })

    override suspend fun doWork(): Result = try {
        val run = drain()
        // During an upload quota cooldown no images are sent. The next run checks the persisted deadline.
        if (run.cooldown || run.retry && runAttemptCount < MAX_RETRIES) Result.retry() else Result.success()
    } catch (_: WebViewCredentialsUnavailable) {
        Log.w("Spark", "WebView credentials unavailable in background")
        Result.success()
    } catch (_: DraftAccountChanged) {
        Result.success()
    } catch (error: ApiError) {
        if ((error.code == "network_error" || (error.status ?: 0) >= 500) && runAttemptCount < MAX_RETRIES) {
            Result.retry()
        } else Result.success()
    } catch (_: SQLiteException) {
        Log.w("Spark", "Unable to read the draft queue")
        if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure()
    }

    private companion object {
        const val MAX_RETRIES = 4
    }
}
