package cloud.stwqy.spark.worker

import android.content.Context
import android.database.sqlite.SQLiteException
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import cloud.stwqy.spark.SparkApp
import java.io.IOException

class OrphanMediaCleanupWorker internal constructor(
    context: Context,
    parameters: WorkerParameters,
    private val clean: suspend () -> Unit,
) : CoroutineWorker(context, parameters) {
    constructor(context: Context, parameters: WorkerParameters) : this(context, parameters, {
        val app = context.applicationContext as SparkApp
        try {
            app.draftSubmission.cleanOrphans()
        } finally {
            app.workspaceStaging.cleanAbandoned()
        }
    })

    override suspend fun doWork(): Result = try {
        clean()
        Result.success()
    } catch (_: IOException) {
        Log.w("Spark", "Unable to clean up private media")
        Result.failure()
    } catch (_: SQLiteException) {
        Log.w("Spark", "Unable to read private media references")
        Result.failure()
    }
}
