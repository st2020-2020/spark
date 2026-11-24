package cloud.stwqy.spark.feature.workspace

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.util.UUID

/** Shared by the workspace and the startup/periodic cleanup worker in this process. */
internal class WorkspaceFileStaging(private val cache: File) {
    private val directory = File(cache, "export-staging")
    private val active = mutableMapOf<File, Int>()

    suspend fun <T> withFile(write: suspend (File) -> T): T {
        val name = UUID.randomUUID().toString()
        val staged = File(directory, name)
        synchronized(active) { active[staged] = 1 }
        try {
            withContext(Dispatchers.IO) {
                if ((!directory.mkdirs() && !directory.isDirectory) || !isPrivateDirectory()) {
                    throw IOException("Cannot open private workspace staging")
                }
            }
            return write(staged)
        } finally {
            withContext(NonCancellable + Dispatchers.IO) { release(staged) }
        }
    }

    /** The detached provider worker holds its own reference until it stops reading this file. */
    fun retain(staged: File): Closeable {
        synchronized(active) { active[staged] = active.getValue(staged) + 1 }
        return Closeable { release(staged) }
    }

    private fun release(staged: File) {
        synchronized(active) {
            val references = active.getValue(staged)
            if (references > 1) {
                active[staged] = references - 1
                return
            }
            try {
                if (isPrivateDirectory()) deleteStagedFile(staged)
            } catch (_: IOException) {
                Log.w("Spark", "Could not resolve private workspace staging")
            } finally {
                active.remove(staged)
            }
        }
    }

    suspend fun cleanAbandoned() = withContext(Dispatchers.IO) {
        synchronized(active) {
            if (isPrivateDirectory()) {
                directory.listFiles().orEmpty().filter { stagedName.matches(it.name) && it !in active && !it.isDirectory }
                    .forEach(::deleteStagedFile)
            }
            // Early builds staged low-API exports directly in cache.
            cache.listFiles().orEmpty().filter { legacyExportName.matches(it.name) && !it.isDirectory }
                .forEach(::deleteStagedFile)
        }
    }

    private fun isPrivateDirectory() = directory.canonicalFile == File(cache.canonicalFile, directory.name)

    private companion object {
        val stagedName = Regex("[0-9a-f-]{36}")
        val legacyExportName = Regex("export-[0-9a-f-]{36}\\.zip")
    }
}

internal fun deleteStagedFile(file: File): Boolean {
    val deleted = file.delete() || !file.exists()
    if (!deleted) Log.w("Spark", "Could not remove temporary file")
    return deleted
}
