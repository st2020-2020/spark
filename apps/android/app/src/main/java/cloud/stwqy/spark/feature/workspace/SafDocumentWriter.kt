package cloud.stwqy.spark.feature.workspace

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import cloud.stwqy.spark.core.storage.ProviderIo
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException

/** Owns blocking SAF I/O independently of the WebView and the system picker. */
internal class SafDocumentWriter(
    context: Context,
    private val staging: WorkspaceFileStaging,
    private val timeoutMillis: Long = 120_000,
) {
    private val resolver = context.applicationContext.contentResolver
    private val workers = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val documents = mutableSetOf<DocumentKey>()

    fun requireAvailable() {
        synchronized(documents) {
            if (documents.size >= MAX_WORKERS) throw unavailable()
        }
    }

    suspend fun write(uri: Uri, staged: File, name: String, requireCurrent: () -> Unit): SavedFile {
        val key = documentKey(uri)
        synchronized(documents) {
            if (key in documents) {
                throw BridgeFailure("document_in_use", "系统仍在处理此文档，请选择其他保存位置。")
            }
            if (documents.size >= MAX_WORKERS) throw unavailable()
            documents.add(key)
        }
        val file = staging.retain(staged)
        val io = ProviderIo()
        val result = CompletableDeferred<SavedFile>()
        val accepted = CompletableDeferred<Boolean>()
        // The guard carries the verified session and document lifetime token only.
        // Cancelling the waiter detaches it from result, even if the provider never returns.
        workers.launch {
            var keepDocument = false
            try {
                val saved = file.use {
                    fun checkPublication() {
                        io.requireActive()
                        requireCurrent()
                        io.requireActive()
                    }
                    resolver.writeStagedFile(uri, staged, io, ::checkPublication)
                    checkPublication()
                    val displayName = resolver.displayName(uri, name, io)
                    checkPublication()
                    SavedFile(displayName, "documents")
                }
                result.complete(saved)
                keepDocument = accepted.await()
            } catch (error: Exception) {
                result.completeExceptionally(error)
            } finally {
                // The provider can expose bytes before it returns. Delete only after writing
                // and closing the output have ended, and keep this document reserved through deletion.
                try {
                    if (!keepDocument) discard(uri)
                } finally {
                    release(key)
                }
            }
        }
        var keepDocument = false
        try {
            val saved = withTimeoutOrNull(timeoutMillis) { result.await() }
                ?: throw BridgeFailure("storage_timeout", "系统文件服务响应超时，请选择其他位置或稍后重试。")
            currentCoroutineContext().ensureActive()
            keepDocument = true
            return saved
        } finally {
            if (!keepDocument) io.cancel()
            accepted.complete(keepDocument)
        }
    }

    fun discardAbandoned(uri: Uri) {
        val key = documentKey(uri)
        synchronized(documents) {
            // A late or duplicate picker result must never delete a document owned by a writer.
            if (key in documents) return
            if (documents.size >= MAX_WORKERS) {
                Log.w("Spark", "System document cleanup unavailable: provider workers occupied")
                return
            }
            documents.add(key)
        }
        workers.launch {
            try {
                discard(uri)
            } finally {
                release(key)
            }
        }
    }

    private fun discard(uri: Uri) {
        try {
            if (!DocumentsContract.deleteDocument(resolver, uri)) throw IOException("Provider did not delete incomplete document")
        } catch (error: Exception) {
            Log.w("Spark", "Could not remove incomplete system document (${error.javaClass.simpleName})")
        }
    }

    private fun release(key: DocumentKey) {
        synchronized(documents) { documents.remove(key) }
    }

    private data class DocumentKey(val authority: String?, val id: String)

    private fun documentKey(uri: Uri) = DocumentKey(uri.authority, DocumentsContract.getDocumentId(uri))

    private fun unavailable() = BridgeFailure("storage_unavailable", "系统文件服务响应缓慢，请稍后重试。")

    private companion object {
        const val MAX_WORKERS = 2
    }
}
