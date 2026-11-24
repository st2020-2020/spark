package cloud.stwqy.spark.core.storage

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import cloud.stwqy.spark.core.config.AppConfig
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MediaStorageTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun importsEachImageByItsBytesDespiteAMisleadingUri(): Unit = runBlocking {
        val fixtures = listOf(
            ImageFormat.JPEG to encode(Bitmap.CompressFormat.JPEG),
            ImageFormat.PNG to encode(Bitmap.CompressFormat.PNG),
            ImageFormat.GIF to Base64.getDecoder().decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
            ImageFormat.WEBP to encode(Bitmap.CompressFormat.WEBP_LOSSLESS),
        )
        val root = temp.newFolder()
        val draft = id()
        for ((index, fixture) in fixtures.withIndex()) {
            val (format, bytes) = fixture
            val storage = MediaStorage(root) { bytes.inputStream() }
            val saved = storage.copy(draft, "content://fixture/not-an-image.txt", index)
            assertEquals(format.mimeType, saved.mimeType)
            assertTrue(saved.filename.endsWith(".${format.extension}"))
            assertEquals(index, saved.sortOrder)
            assertArrayEquals(bytes, storage.file(saved).readBytes())
        }
        assertEquals(ImageFormat.GIF, ImageFormat.detect("GIF87a".toByteArray()))
    }

    @Test fun rejectsUnknownAndTruncatedImagesAndRemovesTheirPartialFiles(): Unit = runBlocking {
        val root = temp.newFolder()
        val draft = id()
        val png = encode(Bitmap.CompressFormat.PNG)
        val fixtures = listOf("not an image".toByteArray(), png.copyOf(8), png.copyOf(png.size / 2))
        for (bytes in fixtures) {
            val storage = MediaStorage(root) { bytes.inputStream() }
            expectImportFailure<InvalidImage> { storage.copy(draft, "content://fixture/image.png", 1) }
            assertTrue(root.walkTopDown().none(File::isFile))
        }
    }

    @Test fun oversizedReaderStopsAtFiveMiBPlusOneAndOtherImagesStillImport(): Unit = runBlocking {
        val root = temp.newFolder()
        var read = 0
        var closed = false
        val endlessImage = object : InputStream() {
            override fun read(): Int = error("Use the bounded buffer")
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                assertTrue(length in 1..16 * 1024)
                assertTrue(read + length <= AppConfig.MAX_IMAGE_BYTES + 1)
                read += length
                return length
            }
            override fun close() { closed = true }
        }
        val png = encode(Bitmap.CompressFormat.PNG)
        val storage = MediaStorage(root) { uri ->
            if (uri.endsWith("large")) endlessImage else png.inputStream()
        }
        val draft = id()
        val first = storage.copy(draft, "content://fixture/first", 0)
        expectImportFailure<ImageTooLarge> { storage.copy(draft, "content://fixture/large", 1) }
        val third = storage.copy(draft, "content://fixture/third", 2)
        assertEquals(AppConfig.MAX_IMAGE_BYTES + 1, read)
        assertTrue(closed)
        assertEquals(setOf(storage.file(first), storage.file(third)), root.walkTopDown().filter(File::isFile).toSet())
    }

    @Test fun sweepPreservesInProgressImportsAndReferencedFiles(): Unit = runBlocking {
        val root = temp.newFolder()
        val png = encode(Bitmap.CompressFormat.PNG)
        val storage = MediaStorage(root) { png.inputStream() }
        val draft = id()
        val orphanDraft = id()
        val unrelated = File(root, "unrelated").apply { mkdir() }
        File(unrelated, "entry").writeText("fixture")
        val orphan = storage.copy(orphanDraft, "content://fixture/orphan", 0)
        lateinit var removed: DraftAssetEntity
        val recorded = storage.importing(draft) {
            val asset = storage.copy(draft, "content://fixture/recorded", 0)
            removed = storage.copy(draft, "content://fixture/removed", 1)
            storage.sweep { emptySet() }
            assertTrue(storage.file(asset).exists())
            assertTrue(storage.file(removed).exists())
            assertFalse(storage.file(orphan).exists())
            asset
        }
        storage.sweep { setOf(recorded.localPath) }
        assertTrue(storage.file(recorded).isFile)
        assertFalse(storage.file(removed).exists())
        assertFalse(File(root, orphanDraft).exists())
        assertTrue(File(unrelated, "entry").isFile)
        storage.sweep(draft) { emptySet() }
        assertFalse(File(root, draft).exists())
    }

    @Test fun blockedProviderOpensTimeOutAndKeepTheirConcurrencySlotsUntilTheyReturn(): Unit = runBlocking {
        val root = temp.newFolder()
        val opening = CountDownLatch(2)
        val cancelled = CountDownLatch(2)
        val release = CountDownLatch(1)
        val returned = CountDownLatch(2)
        val opens = AtomicInteger()
        val storage = MediaStorage(root, { _, signal ->
            opens.incrementAndGet()
            signal.setOnCancelListener { cancelled.countDown() }
            opening.countDown()
            try {
                check(release.await(5, SECONDS)) { "Provider fixture was not released" }
                null
            } finally {
                returned.countDown()
            }
        }, importTimeoutMillis = 400)
        val draft = id()
        try {
            val first = List(2) { index ->
                async { expectImportFailure<ImageImportTimedOut> { storage.copy(draft, "content://fixture/$index", index) } }
            }
            assertTrue(withContext(Dispatchers.IO) { opening.await(4, SECONDS) })
            first.forEach { it.await() }
            assertTrue(withContext(Dispatchers.IO) { cancelled.await(4, SECONDS) })
            expectImportFailure<ImageImportTimedOut> { storage.copy(draft, "content://fixture/third", 2) }
            assertEquals(2, opens.get())
            assertTrue(root.walkTopDown().none(File::isFile))
        } finally {
            release.countDown()
            assertTrue(withContext(Dispatchers.IO) { returned.await(4, SECONDS) })
        }
    }

    private inline fun <reified E : Exception> expectImportFailure(copy: () -> Unit) {
        try {
            copy()
        } catch (failure: Exception) {
            if (failure is E) return
            throw failure
        }
        throw AssertionError("Expected ${E::class.simpleName}")
    }

    private fun encode(format: Bitmap.CompressFormat): ByteArray {
        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.MAGENTA)
        return try {
            ByteArrayOutputStream().also { assertTrue(bitmap.compress(format, 90, it)) }.toByteArray()
        } finally {
            bitmap.recycle()
        }
    }

    private fun id() = UUID.randomUUID().toString()
}
