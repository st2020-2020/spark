package cloud.stwqy.spark.feature.workspace

import cloud.stwqy.spark.core.network.ApiError
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

class SystemMediaSaverTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun accountChangeAfterPreparationKeepsMediaPendingAndDiscardsIt() {
        var sameAccount = true
        val events = mutableListOf<String>()
        val error = assertThrows(ApiError::class.java) {
            publishPendingMedia(
                requireCurrent = { if (!sameAccount) throw ApiError.signedOut() },
                prepare = { events += "prepared"; sameAccount = false; "file" },
                publish = { events += "published" },
                discard = { events += "discarded" },
            )
        }
        assertEquals("session_expired", error.code)
        assertEquals(listOf("prepared", "discarded"), events)
    }

    @Test fun switchDuringExternalCommitTriggersCompensatingDeletion() {
        var sameAccount = true
        var discarded = false
        assertThrows(ApiError::class.java) {
            publishPendingMedia(
                requireCurrent = { if (!sameAccount) throw ApiError.signedOut() },
                prepare = { "file" },
                publish = { sameAccount = false },
                discard = { discarded = true },
            )
        }
        assertTrue(discarded)
    }

    @Test fun exportAcceptsExactCapButStopsBeforeWritingAnyBytePastIt() {
        val output = ByteArrayOutputStream()
        val exact = ByteArray(65_536)
        copyExport(exact.inputStream(), output, availableBytes = { Long.MAX_VALUE }, maxBytes = 65_536) {}
        assertEquals(65_536, output.size())

        output.reset()
        val error = assertThrows(ApiError::class.java) {
            copyExport(exact.copyOf(65_537).inputStream(), output, availableBytes = { Long.MAX_VALUE }, maxBytes = 65_536) {}
        }
        assertEquals("export_too_large", error.code)
        assertEquals(65_536, output.size())
    }

    @Test fun changingDiskBudgetStopsTheStreamAndDeletesStaging(): Unit = runBlocking {
        val staging = WorkspaceFileStaging(temporary.root)
        lateinit var file: File
        val error = runCatching {
            staging.withFile { staged ->
                file = staged
                staged.outputStream().use { output ->
                    copyExport(
                        ByteArray(130_000).inputStream(), output,
                        availableBytes = { 100_000 - staged.length() }, reserveBytes = 64,
                    ) {}
                }
            }
        }.exceptionOrNull()
        assertEquals("storage_full", (error as BridgeFailure).code)
        assertFalse(file.exists())
    }

    @Test fun startupCleanupReclaimsAbandonedExportsAndLeavesActiveStagingAlone(): Unit = runBlocking {
        val staging = WorkspaceFileStaging(temporary.root)
        val legacy = temporary.newFile("export-${UUID.randomUUID()}.zip")
        val unrelated = temporary.newFile("unrelated.zip")
        lateinit var active: File
        staging.withFile { staged ->
            active = staged.apply { writeText("active") }
            val abandoned = File(staged.parentFile, UUID.randomUUID().toString()).apply { writeText("abandoned") }
            staging.cleanAbandoned()
            assertTrue(active.isFile)
            assertFalse(abandoned.exists())
            assertFalse(legacy.exists())
            assertTrue(unrelated.isFile)
        }
        assertFalse(active.exists())
    }
}
