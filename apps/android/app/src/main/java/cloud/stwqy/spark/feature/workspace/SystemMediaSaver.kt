package cloud.stwqy.spark.feature.workspace

import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Process
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.await
import androidx.work.workDataOf
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.ExportFormat
import cloud.stwqy.spark.core.network.MAX_EXPORT_BYTES
import cloud.stwqy.spark.core.storage.ProviderIo
import cloud.stwqy.spark.core.storage.withProviderIo
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resumeWithException

internal data class SavedFile(val name: String, val destination: String)

internal class SystemMediaSaver(
    private val activity: ComponentActivity,
    private val staging: WorkspaceFileStaging,
    private val documents: SafDocumentWriter,
) {
    private val resolver = activity.contentResolver
    private var documentInFlight = false
    private val documentResult = AtomicReference<CancellableContinuation<Uri?>?>()
    // A stable key lets a recreated Activity discard an abandoned document result.
    private val createDocument = activity.activityResultRegistry.register(
        "workspace.saveDocument", activity, ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        documentInFlight = false
        val continuation = documentResult.getAndSet(null)
        val uri = result.data?.data?.takeIf {
            result.resultCode == Activity.RESULT_OK && it.scheme == "content" &&
                DocumentsContract.isDocumentUri(activity, it) &&
                activity.checkUriPermission(it, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) ==
                PackageManager.PERMISSION_GRANTED
        }
        val writer = documents
        if (continuation != null && continuation.isActive) {
            continuation.resume(uri) { _, abandoned, _ -> if (abandoned != null) writer.discardAbandoned(abandoned) }
        } else if (uri != null) {
            writer.discardAbandoned(uri)
        }
    }

    suspend fun saveImage(name: String, bytes: ByteArray, requireCurrent: () -> Unit): SavedFile =
        staging.withFile { staged ->
            withContext(Dispatchers.IO) {
                requireCurrent()
                staged.writeBytes(bytes)
            }
            publish(staged, name, "image/png", gallery = true, requireCurrent)
        }

    suspend fun saveExport(
        format: ExportFormat,
        requireCurrent: () -> Unit,
        download: suspend ((InputStream, String?) -> String) -> String,
    ): SavedFile = staging.withFile { staged ->
        val name = download { input, disposition ->
            requireCurrent()
            staged.outputStream().use {
                copyExport(input, it, availableBytes = { staged.parentFile?.usableSpace ?: 0 }, requireCurrent = requireCurrent)
            }
            exportFileName(disposition, format)
        }
        if (Build.VERSION.SDK_INT >= 29) withContext(Dispatchers.IO) {
            // Downloads and private cache can share a volume and briefly hold both copies.
            requireExportSpace(staged.parentFile?.usableSpace ?: 0, staged.length())
        }
        publish(staged, name, "application/zip", gallery = false, requireCurrent)
    }

    private suspend fun publish(staged: File, name: String, mime: String, gallery: Boolean, requireCurrent: () -> Unit): SavedFile =
        if (Build.VERSION.SDK_INT >= 29) withProviderIo { io ->
            withContext(Dispatchers.IO) {
                writeMedia(staged, name, mime, gallery, requireCurrent, io)
            }
        } else saveDocument(staged, name, mime, requireCurrent)

    suspend fun shareImage(name: String, bytes: ByteArray, requireCurrent: () -> Unit) {
        val directory = File(activity.cacheDir, SHARED_CARDS)
        val file = File(directory, "${UUID.randomUUID()}.png")
        var launched = false
        try {
            // A recipient may open the stream after the chooser closes. Persist cleanup before writing
            // so Spark can reclaim the file even if its process dies before or after launching the chooser.
            val cleanup = OneTimeWorkRequestBuilder<SharedCardCleanupWorker>()
                .setInitialDelay(1, TimeUnit.HOURS)
                .setInputData(workDataOf(CARD_CACHE_NAME to file.name))
                .build()
            requireCurrent()
            WorkManager.getInstance(activity).enqueue(cleanup).await()
            withContext(Dispatchers.IO) {
                requireCurrent()
                if (!directory.mkdirs() && !directory.isDirectory) throw IOException("Cannot create share cache")
                file.writeBytes(bytes)
            }
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file, name)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newUri(resolver, name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            requireForeground()
            requireCurrent()
            activity.startActivity(Intent.createChooser(send, "分享 Spark 卡片"))
            launched = true
        } finally {
            if (!launched) withContext(NonCancellable + Dispatchers.IO) { deleteStagedFile(file) }
        }
    }

    @RequiresApi(29)
    private fun writeMedia(
        staged: File,
        name: String,
        mime: String,
        gallery: Boolean,
        requireCurrent: () -> Unit,
        io: ProviderIo,
    ): SavedFile {
        requireCurrent()
        val collection = if (gallery) MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val metadata = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (gallery) "${Environment.DIRECTORY_PICTURES}/Spark" else Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, metadata) ?: throw IOException("Cannot create MediaStore item")
        return publishPendingMedia(
            requireCurrent,
            prepare = {
                resolver.writeStagedFile(uri, staged, io, requireCurrent)
                SavedFile(resolver.displayName(uri, name, io), if (gallery) "gallery" else "downloads")
            },
            publish = {
                val ready = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
                if (resolver.update(uri, ready, null, null) != 1) throw IOException("Cannot publish MediaStore item")
            },
            discard = { discard(uri) { resolver.delete(it, null, null) } },
        )
    }

    private suspend fun saveDocument(
        staged: File,
        name: String,
        mime: String,
        requireCurrent: () -> Unit,
    ): SavedFile {
        requireCurrent()
        requireForeground()
        documents.requireAvailable()
        val uri = chooseDocument(name, mime) ?: throw BridgeFailure("cancelled", "已取消保存。")
        return documents.write(uri, staged, name, requireCurrent)
    }

    private suspend fun chooseDocument(name: String, mime: String): Uri? = suspendCancellableCoroutine { continuation ->
        if (documentInFlight) {
            continuation.resumeWithException(BridgeFailure("busy", "上一项操作正在进行，请稍候。"))
            return@suspendCancellableCoroutine
        }
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mime
            putExtra(Intent.EXTRA_TITLE, name)
        }
        documentResult.set(continuation)
        continuation.invokeOnCancellation { documentResult.compareAndSet(continuation, null) }
        if (!continuation.isActive) return@suspendCancellableCoroutine
        documentInFlight = true
        try {
            createDocument.launch(intent)
        } catch (error: RuntimeException) {
            documentResult.set(null)
            documentInFlight = false
            continuation.resumeWithException(error)
        }
    }

    private fun requireForeground() {
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            throw BridgeFailure("inactive", "请返回 Spark 后重试。")
        }
    }

    private inline fun discard(uri: Uri, delete: (Uri) -> Unit) {
        try {
            delete(uri)
        } catch (error: Exception) {
            Log.w("Spark", "Could not remove incomplete system file (${error.javaClass.simpleName})")
        }
    }
}

internal fun ContentResolver.writeStagedFile(uri: Uri, staged: File, io: ProviderIo, requireCurrent: () -> Unit) {
    requireCurrent()
    val descriptor = openAssetFileDescriptor(uri, "w", io.signal) ?: throw IOException("Cannot open system output")
    val output = try {
        descriptor.createOutputStream()
    } catch (error: IOException) {
        descriptor.close()
        throw error
    }
    io.useStream(output) {
        staged.inputStream().use { input -> copyChecked(input, it, requireCurrent) }
    }
}

internal fun ContentResolver.displayName(uri: Uri, fallback: String, io: ProviderIo): String =
    query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null, io.signal)?.let { cursor ->
        io.useStream(cursor) { if (it.moveToFirst()) it.getString(0) else null }
    } ?: fallback

class SharedCardCleanupWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val name = inputData.getString(CARD_CACHE_NAME)?.takeIf(cardCacheName::matches) ?: return Result.failure()
        val file = File(File(applicationContext.cacheDir, SHARED_CARDS), name)
        if (!file.exists()) return Result.success()
        val uri = FileProvider.getUriForFile(applicationContext, "${applicationContext.packageName}.fileprovider", file)
        applicationContext.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return if (deleteStagedFile(file)) Result.success() else if (runAttemptCount < 2) Result.retry() else Result.failure()
    }
}

private const val SHARED_CARDS = "shared-cards"
private const val CARD_CACHE_NAME = "cardCacheName"
private val cardCacheName = Regex("[0-9a-f-]{36}\\.png")
private val exportDisposition = Regex("attachment;\\s*filename=\"(spark-export-\\d{8}\\.zip)\"", RegexOption.IGNORE_CASE)
private const val EXPORT_FREE_SPACE_RESERVE = 64L * 1024 * 1024

internal fun exportFileName(disposition: String?, format: ExportFormat): String =
    disposition?.let { exportDisposition.matchEntire(it.trim())?.groupValues?.get(1) }
        ?: "spark-export-${format.wireValue}.zip"

internal fun safeFileName(value: String, extension: String, fallback: String): String {
    val clean = value.filterNot { it in "/\\:*?\"<>|" || it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }
        .trim { it.isWhitespace() || it == '.' }
    val stem = if (clean.endsWith(extension, ignoreCase = true)) clean.dropLast(extension.length) else clean
    val clipped = stem.take(64 - extension.length).dropLastWhile(Char::isHighSurrogate)
        .trim { it.isWhitespace() || it == '.' }
    return clipped.ifEmpty { fallback } + extension
}

private inline fun <T> publishCurrent(requireCurrent: () -> Unit, publish: () -> T): T {
    requireCurrent()
    val result = publish()
    requireCurrent()
    return result
}

internal inline fun <T> publishPendingMedia(
    requireCurrent: () -> Unit,
    prepare: () -> T,
    publish: () -> Unit,
    discard: () -> Unit,
): T {
    var published = false
    try {
        val result = prepare()
        publishCurrent(requireCurrent, publish)
        published = true
        return result
    } finally {
        if (!published) discard()
    }
}

internal fun copyExport(
    input: InputStream,
    output: OutputStream,
    availableBytes: () -> Long,
    maxBytes: Long = MAX_EXPORT_BYTES,
    reserveBytes: Long = EXPORT_FREE_SPACE_RESERVE,
    requireCurrent: () -> Unit,
) {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    requireCurrent()
    requireExportSpace(availableBytes(), 0, reserveBytes)
    while (true) {
        requireCurrent()
        val count = try {
            input.read(buffer, 0, minOf(buffer.size.toLong(), maxBytes - total + 1).toInt())
        } catch (error: IOException) {
            throw ApiError.network(error)
        }
        requireCurrent()
        if (count < 0) return
        if (count == 0) throw ApiError.network(IOException("Export stream returned no data"))
        if (count > maxBytes - total) throw ApiError.exportTooLarge()
        requireExportSpace(availableBytes(), count.toLong(), reserveBytes)
        output.write(buffer, 0, count)
        total += count
    }
}

private fun requireExportSpace(available: Long, next: Long, reserve: Long = EXPORT_FREE_SPACE_RESERVE) {
    if (available < reserve + next) {
        throw BridgeFailure("storage_full", "设备可用空间不足，已停止保存导出文件。")
    }
}

private fun copyChecked(input: InputStream, output: OutputStream, requireCurrent: () -> Unit) {
    val buffer = ByteArray(64 * 1024)
    while (true) {
        requireCurrent()
        val count = input.read(buffer)
        if (count < 0) return
        requireCurrent()
        output.write(buffer, 0, count)
    }
}
