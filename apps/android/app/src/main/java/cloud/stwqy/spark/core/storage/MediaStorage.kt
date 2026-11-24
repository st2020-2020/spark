package cloud.stwqy.spark.core.storage

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.util.Log
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.coroutines.resumeWithException

internal class ImageTooLarge : IOException("每张图片最多 5 MiB。")
internal class InvalidImage : IOException("图片已损坏或格式不受支持。支持 JPEG、PNG、GIF 和 WebP。")
internal class ImageImportTimedOut : IOException("读取分享图片超时。请重试或移除这张图片。")

internal class MediaStorage(
    root: File,
    private val open: (String, CancellationSignal) -> InputStream?,
    private val importTimeoutMillis: Long = 15_000,
) {
    constructor(root: File, open: (String) -> InputStream?) : this(root, { value, _ -> open(value) })

    constructor(context: Context) : this(File(context.noBackupFilesDir, "draft-media"), { value, signal ->
        val uri = Uri.parse(value)
        if (uri.scheme != "content" || uri.authority == "${context.packageName}.fileprovider") {
            throw SecurityException("Unsupported share URI")
        }
        context.contentResolver.openAssetFileDescriptor(uri, "r", signal)?.let { descriptor ->
            try {
                descriptor.createInputStream()
            } catch (error: IOException) {
                descriptor.close()
                throw error
            }
        }
    })

    private val root = root.absoluteFile
    private val changes = Mutex()
    private val imports = mutableMapOf<String, Int>()
    private val reads = Semaphore(2)

    suspend fun <T> importing(draftId: String, block: suspend () -> T): T {
        changes.withLock { imports[draftId] = imports.getOrDefault(draftId, 0) + 1 }
        try {
            return block()
        } finally {
            withContext(NonCancellable) {
                changes.withLock {
                    val remaining = imports.getValue(draftId) - 1
                    if (remaining == 0) imports.remove(draftId) else imports[draftId] = remaining
                }
            }
        }
    }

    suspend fun copy(draftId: String, uri: String, order: Int): DraftAssetEntity {
        require(isUuid(draftId))
        val id = UUID.randomUUID().toString()
        return try {
            withTimeoutOrNull(importTimeoutMillis) {
                reads.acquire()
                suspendCancellableCoroutine<DraftAssetEntity> { continuation ->
                    val io = ProviderIo()
                    continuation.invokeOnCancellation { io.cancel() }
                    // A remote provider can ignore cancellation. Keep its read slot occupied
                    // until it returns, while letting the editor honor the deadline immediately.
                    Dispatchers.IO.dispatch(EmptyCoroutineContext) {
                        try {
                            val asset = copyImage(draftId, id, uri, order, io)
                            continuation.resume(asset) { _, abandoned, _ -> discardCopy(abandoned.draftId, abandoned.id) }
                        } catch (error: Exception) {
                            continuation.resumeWithException(error)
                        } finally {
                            reads.release()
                        }
                    }
                }
            } ?: throw ImageImportTimedOut()
        } catch (error: CancellationException) {
            discardCopy(draftId, id)
            throw error
        } catch (error: ImageImportTimedOut) {
            discardCopy(draftId, id)
            throw error
        }
    }

    private fun copyImage(draftId: String, id: String, uri: String, order: Int, io: ProviderIo): DraftAssetEntity {
        io.requireActive()
        val path = "$draftId/$id"
        val destination = checkedFile(path)
        val directory = requireNotNull(destination.parentFile)
        if (!directory.mkdirs() && !directory.isDirectory) {
            throw IOException("无法创建图片草稿目录。")
        }
        var copied = false
        try {
            val input = try {
                open(uri, io.signal) ?: throw IOException("无法打开分享图片。")
            } catch (_: SecurityException) {
                throw IOException("无法读取分享图片，请从原应用重新分享。")
            } catch (error: OperationCanceledException) {
                io.requireActive()
                throw IOException("分享来源已取消读取图片。", error)
            } catch (error: IllegalArgumentException) {
                throw IOException("分享来源无法提供这张图片。", error)
            } catch (error: IllegalStateException) {
                throw IOException("分享来源暂时无法提供这张图片。", error)
            }
            val length = io.useStream(input) { source ->
                destination.outputStream().use { output ->
                    val buffer = ByteArray(16 * 1024)
                    var size = 0
                    while (true) {
                        io.requireActive()
                        val read = source.read(buffer, 0, minOf(buffer.size, AppConfig.MAX_IMAGE_BYTES + 1 - size))
                        io.requireActive()
                        if (read == -1) break
                        if (read == 0) throw IOException("分享来源未能读取图片。")
                        size += read
                        if (size > AppConfig.MAX_IMAGE_BYTES) throw ImageTooLarge()
                        output.write(buffer, 0, read)
                    }
                    size.toLong()
                }
            }
            val signature = ByteArray(minOf(12L, length).toInt())
            destination.inputStream().use { source ->
                if (source.readNBytesCompat(signature) != signature.size) throw InvalidImage()
            }
            val format = ImageFormat.detect(signature) ?: throw InvalidImage()
            validateImage(destination)
            io.requireActive()
            val asset = DraftAssetEntity(id, draftId, path, "图片-${order + 1}.${format.extension}",
                format.mimeType, length, order, UUID.randomUUID().toString())
            copied = true
            return asset
        } finally {
            if (!copied) removeFile(destination)
        }
    }

    private fun discardCopy(draftId: String, id: String) {
        Dispatchers.IO.dispatch(EmptyCoroutineContext) {
            try {
                removeFile(checkedFile("$draftId/$id"))
            } catch (_: IOException) {
                Log.w("Spark", "Unable to remove incomplete image import")
            }
        }
    }

    fun file(asset: DraftAssetEntity): File {
        if (!isUuid(asset.draftId) || !isUuid(asset.id) || asset.localPath != "${asset.draftId}/${asset.id}") {
            throw IOException("本机图片路径无效。")
        }
        return checkedFile(asset.localPath)
    }

    /** Sweep only the two-level private media directory. The reference query and scan share the import lock. */
    suspend fun sweep(draftId: String? = null, references: suspend () -> Set<String>) = changes.withLock {
        if (draftId != null && !isUuid(draftId)) return@withLock
        val paths = references()
        withContext(Dispatchers.IO) {
            val directory = checkedFile("")
            val folders = if (draftId == null) directory.listFiles().orEmpty().asList()
            else listOf(checkedFile(draftId))
            for (folder in folders) {
                if (!isUuid(folder.name) || folder.name in imports || !folder.isDirectory ||
                    folder.canonicalFile != folder.absoluteFile
                ) continue
                for (file in folder.listFiles().orEmpty()) {
                    if ("${folder.name}/${file.name}" !in paths && !file.isDirectory) removeFile(file)
                }
                if (folder.list()?.isEmpty() == true) removeFile(folder)
            }
        }
    }

    private fun checkedFile(path: String): File {
        val directory = File(requireNotNull(root.parentFile).canonicalFile, root.name)
        val candidate = if (path.isEmpty()) directory else File(directory, path)
        if (candidate.canonicalFile != candidate.absoluteFile) throw IOException("本机图片路径无效。")
        return candidate
    }

    private fun removeFile(file: File) {
        if (!file.delete() && file.exists()) Log.w("Spark", "Unable to remove draft media")
    }
}

private fun InputStream.readNBytesCompat(buffer: ByteArray): Int {
    var offset = 0
    while (offset < buffer.size) {
        val read = read(buffer, offset, buffer.size - offset)
        if (read <= 0) break
        offset += read
    }
    return offset
}

internal enum class ImageFormat(val mimeType: String, val extension: String) {
    JPEG("image/jpeg", "jpg"), PNG("image/png", "png"), GIF("image/gif", "gif"), WEBP("image/webp", "webp");

    companion object {
        fun detect(header: ByteArray): ImageFormat? = when {
            header.matches(0, 0xff, 0xd8, 0xff) -> JPEG
            header.matches(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> PNG
            header.matches(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
                header.matches(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61) -> GIF
            header.matches(0, 0x52, 0x49, 0x46, 0x46) && header.matches(8, 0x57, 0x45, 0x42, 0x50) -> WEBP
            else -> null
        }

        private fun ByteArray.matches(offset: Int, vararg bytes: Int) =
            size >= offset + bytes.size && bytes.indices.all { this[offset + it].toInt() and 0xff == bytes[it] }
    }
}

private fun validateImage(file: File) {
    val bitmap: Bitmap = if (Build.VERSION.SDK_INT >= 28) {
        try {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(file)) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                decoder.setTargetSampleSize(imageSampleSize(info.size.width, info.size.height))
            }
        } catch (_: ImageDecoder.DecodeException) {
            throw InvalidImage()
        }
    } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val sample = imageSampleSize(bounds.outWidth, bounds.outHeight)
        BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: throw InvalidImage()
    }
    bitmap.recycle()
}

private fun imageSampleSize(width: Int, height: Int): Int {
    // The server validates the full image against the same size limits before attaching it.
    if (width !in 1..8192 || height !in 1..8192 || width.toLong() * height > 16L * 1024 * 1024) {
        throw InvalidImage()
    }
    var sample = 1
    while (maxOf(width, height) > sample * 512) sample *= 2
    return sample
}
