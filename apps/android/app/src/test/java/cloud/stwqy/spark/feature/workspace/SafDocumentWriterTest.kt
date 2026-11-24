package cloud.stwqy.spark.feature.workspace

import android.app.Application
import android.content.pm.ProviderInfo
import android.database.MatrixCursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26], application = Application::class)
class SafDocumentWriterTest {
    @get:Rule val temporary = TemporaryFolder()

    private val slot = AtomicBoolean()
    private lateinit var staging: WorkspaceFileStaging
    private lateinit var provider: FixtureDocuments

    @Before fun setup() {
        val app = RuntimeEnvironment.getApplication()
        staging = WorkspaceFileStaging(temporary.newFolder("cache"))
        provider = FixtureDocuments(temporary.newFolder("provider"))
        provider.attachInfo(app, ProviderInfo().apply {
            authority = AUTHORITY
            applicationInfo = app.applicationInfo
            packageName = app.packageName
            exported = true
            grantUriPermissions = true
            readPermission = android.Manifest.permission.MANAGE_DOCUMENTS
            writePermission = android.Manifest.permission.MANAGE_DOCUMENTS
        })
        ShadowContentResolver.registerProviderInternal(AUTHORITY, provider)
    }

    @Test fun cancellingBlockedSafWriteReleasesBridgeSlotAndKeepsStageUntilTheWorkerReturns(): Unit = runBlocking {
        val writer = SafDocumentWriter(RuntimeEnvironment.getApplication(), staging)
        val opening = CountDownLatch(1)
        val signalled = CountDownLatch(1)
        val releaseOpen = CountDownLatch(1)
        val deleted = CountDownLatch(1)
        provider.onOpen = { id, signal ->
            if (id == STALLED) {
                signal?.setOnCancelListener { signalled.countDown() }
                opening.countDown()
                releaseOpen.awaitProvider()
            }
        }
        provider.onDeleted = { if (it == STALLED) deleted.countDown() }
        lateinit var staged: File
        val request = launch { save(writer, STALLED) { staged = it } }
        try {
            opening.awaitTest("provider entered the write open")
            withTimeout(5_000) { request.cancelAndJoin() }
            signalled.awaitTest("provider was signalled while still blocked")
            staging.cleanAbandoned()
            assertTrue(staged.isFile)
            assertEquals(1L, releaseOpen.count)
            assertEquals(1L, deleted.count)
            assertOtherDocumentSaved(writer)
        } finally {
            request.cancel()
            releaseOpen.countDown()
        }
        deleted.awaitTest("the worker compensated after the provider returned")
        assertFalse(staged.exists())
        assertFalse(provider.file(STALLED).exists())
    }

    @Test fun timedOutSafRequestReleasesBridgeSlotWhileCompensatingDeleteIsBlocked(): Unit = runBlocking {
        val writer = SafDocumentWriter(RuntimeEnvironment.getApplication(), staging, timeoutMillis = 3_000)
        val querying = CountDownLatch(1)
        val releaseQuery = CountDownLatch(1)
        val deleting = CountDownLatch(1)
        val releaseDelete = CountDownLatch(1)
        val deleted = CountDownLatch(1)
        provider.onQuery = { id ->
            if (id == STALLED) {
                querying.countDown()
                releaseQuery.awaitProvider()
            }
        }
        provider.onDelete = { id ->
            if (id == STALLED) {
                deleting.countDown()
                releaseDelete.awaitProvider()
            }
        }
        provider.onDeleted = { if (it == STALLED) deleted.countDown() }
        val request = async { runCatching { save(writer, STALLED) }.exceptionOrNull() }
        try {
            querying.awaitTest("provider was queried after writing")
            assertEquals(BYTES, provider.file(STALLED).readText())
            val failure = withTimeout(5_000) { request.await() } as BridgeFailure
            assertEquals("storage_timeout", failure.code)
            releaseQuery.countDown()
            deleting.awaitTest("provider entered compensating delete")

            // Another URI for the same document must stay reserved until deletion ends.
            val same = DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(AUTHORITY, "folder"), STALLED,
            )
            val inUse = runCatching { save(writer, STALLED, uri = same) }.exceptionOrNull() as BridgeFailure
            assertEquals("document_in_use", inUse.code)
            assertOtherDocumentSaved(writer)
            assertEquals(1L, deleted.count)
            assertTrue(provider.file(STALLED).isFile)
        } finally {
            request.cancel()
            releaseQuery.countDown()
            releaseDelete.countDown()
        }
        deleted.awaitTest("provider finished the deferred deletion")
        assertFalse(provider.file(STALLED).exists())
    }

    private suspend fun assertOtherDocumentSaved(writer: SafDocumentWriter) {
        val saved = withTimeout(5_000) { save(writer, "other.zip") }
        assertEquals(SavedFile("other.zip", "documents"), saved)
        assertEquals(BYTES, provider.file("other.zip").readText())
    }

    private suspend fun save(
        writer: SafDocumentWriter,
        name: String,
        uri: Uri = DocumentsContract.buildDocumentUri(AUTHORITY, name),
        observeStaging: (File) -> Unit = {},
    ): SavedFile = withFileOperation(slot) {
        staging.withFile { file ->
            file.writeText(BYTES)
            observeStaging(file)
            writer.write(uri, file, name) {}
        }
    }

    private suspend fun CountDownLatch.awaitTest(description: String) = withContext(Dispatchers.IO) {
        assertTrue(description, await(5, TimeUnit.SECONDS))
    }

    private class FixtureDocuments(private val directory: File) : DocumentsProvider() {
        var onOpen: (String, CancellationSignal?) -> Unit = { _, _ -> }
        var onQuery: (String) -> Unit = {}
        var onDelete: (String) -> Unit = {}
        var onDeleted: (String) -> Unit = {}

        fun file(id: String) = File(directory, id)

        override fun onCreate() = true

        override fun queryRoots(projection: Array<out String>?) = MatrixCursor(emptyArray())

        override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?) =
            MatrixCursor(emptyArray())

        // Robolectric's resolver shadow calls this overload directly instead of building query arguments.
        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
            cancellationSignal: CancellationSignal?,
        ) = queryDocument(DocumentsContract.getDocumentId(uri), projection)

        override fun queryDocument(documentId: String, projection: Array<out String>?): MatrixCursor {
            onQuery(documentId)
            return MatrixCursor(arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME)).apply {
                addRow(arrayOf(documentId))
            }
        }

        override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
            onOpen(documentId, signal)
            return ParcelFileDescriptor.open(file(documentId), ParcelFileDescriptor.parseMode(mode))
        }

        override fun deleteDocument(documentId: String) {
            onDelete(documentId)
            val item = file(documentId)
            if (item.exists() && !item.delete()) throw IOException("Fixture could not delete $documentId")
            onDeleted(documentId)
        }
    }

    private companion object {
        const val AUTHORITY = "cloud.stwqy.spark.test.documents"
        const val STALLED = "stalled.zip"
        const val BYTES = "staged export bytes"

        fun CountDownLatch.awaitProvider() {
            if (!await(15, TimeUnit.SECONDS)) throw IOException("Fixture provider was not released")
        }
    }
}
