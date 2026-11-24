package cloud.stwqy.spark.core.storage

import android.app.Application
import androidx.room.Room
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.network.InvalidCollectionPayload
import cloud.stwqy.spark.core.network.Project
import cloud.stwqy.spark.core.network.Tag
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class DraftRepositoryTest {
    private lateinit var database: SparkDatabase
    private lateinit var repository: DraftRepository
    private val a = account(1)
    private val b = account(2)
    private val draftId = id(3)

    @Before fun openDatabase() {
        database = Room.inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), SparkDatabase::class.java).build()
        repository = DraftRepository(database)
    }

    @After fun closeDatabase() = database.close()

    @Test fun accountSwitchHidesBoundAndPendingDraftsAndRejectsStaleWrites(): Unit = runBlocking {
        repository.observeSession(a.snapshot)
        val pending = repository.create(a.snapshot, id(4), DraftContent("同一会话的离线草稿"))
        assertEquals(a.snapshot.provisionalScope, pending.scope)
        activate(a)
        val draft = repository.create(a.snapshot, draftId, DraftContent("账号 A 的笔记"))
        assertEquals(a.scope, draft.scope)
        assertEquals(setOf(draft.id, pending.id), repository.list(a.snapshot).map { it.id }.toSet())

        activate(b)
        assertTrue(repository.list(b.snapshot).isEmpty())
        assertNull(repository.read(b.snapshot, draft.id))
        assertNull(repository.read(b.snapshot, pending.id))
        assertNull(repository.read(a.snapshot, draft.id))
        expect<DraftChanged> { repository.edit(b.snapshot, draft.id, draft.revision, DraftContent("异号修改")) }
        expect<DraftChanged> { repository.delete(b.snapshot, draft.id, draft.revision) }
        expect<DraftAccountChanged> { repository.prepareSubmission(a, draft.id, draft.revision) }
        expect<DraftChanged> { repository.create(b.snapshot, draft.id, DraftContent("异号同 ID")) }
        assertFalse(repository.rememberVerified(a))

        activate(a)
        assertEquals(draft, repository.read(a.snapshot, draft.id))
        assertEquals(pending, repository.read(a.snapshot, pending.id))
    }

    @Test fun shareArrivingBeforeSwitchIsSavedToTheOriginalProvisionalScope(): Unit = runBlocking {
        activate(b)
        repository.saveSharedInput(draftId, a.snapshot.provisionalScope, "切换前收到的分享", emptyList())
        assertNull(repository.read(b.snapshot, draftId))
        activate(a)
        assertEquals(a.snapshot.provisionalScope, repository.read(a.snapshot, draftId)?.scope)
    }

    @Test fun explicitLoginHandoffClaimsOnlyItsOneGuestDraft(): Unit = runBlocking {
        repository.observeSession(SessionSnapshot.Guest)
        val guest = repository.create(SessionSnapshot.Guest, draftId, DraftContent("要继续的笔记"))
        val other = repository.create(SessionSnapshot.Guest, id(4), DraftContent("另一条仍在访客目录"))
        val handoff = requireNotNull(repository.beginLogin(SessionSnapshot.Guest, guest.id))

        activate(a)
        assertNull(repository.read(a.snapshot, guest.id))
        val claimed = repository.claimAfterLogin(handoff, a)
        assertEquals(a.scope, claimed.scope)
        assertEquals(guest.body, claimed.body)
        assertEquals(guest.revision + 1, claimed.revision)
        assertEquals(listOf(guest.id), repository.list(a.snapshot).map { it.id })
        assertNull(repository.beginLogin(a.snapshot, guest.id))

        activate(b)
        expect<DraftChanged> { repository.claimAfterLogin(handoff, b) }
        assertNull(repository.read(b.snapshot, guest.id))
        repository.observeSession(SessionSnapshot.Guest)
        assertEquals(listOf(other.id), repository.list(SessionSnapshot.Guest).map { it.id })
    }

    @Test fun loginHandoffCannotClaimADraftEditedAfterTheRoundTripStarted(): Unit = runBlocking {
        repository.observeSession(SessionSnapshot.Guest)
        val draft = repository.create(SessionSnapshot.Guest, draftId, DraftContent("访客笔记"))
        val handoff = requireNotNull(repository.beginLogin(SessionSnapshot.Guest, draft.id))
        repository.edit(SessionSnapshot.Guest, draft.id, draft.revision, DraftContent("其他窗口更新"))
        activate(a)
        expect<DraftChanged> { repository.claimAfterLogin(handoff, a) }
        assertNull(repository.read(a.snapshot, draft.id))
    }

    @Test fun commitsFreezeBeforePostingAndReplaysUncertainPayloadWithSameId(): Unit = runBlocking {
        activate(a)
        val draft = repository.create(a.snapshot, draftId, DraftContent("原文", "用途", excluded = true))
        val frozen = repository.prepareSubmission(a, draft.id, draft.revision)
        assertEquals(frozen.payload.id, repository.read(a.snapshot, draft.id)?.requestId)
        assertEquals(DraftStatus.SUBMITTING, frozen.draft.status)
        assertFalse(frozen.wasFrozen)
        expect<DraftChanged> { repository.edit(a.snapshot, draft.id, frozen.draft.revision, DraftContent("不同正文")) }
        expect<DraftChanged> { repository.prepareSubmission(a, draft.id, draft.revision) }

        val uncertain = repository.failSubmission(a, frozen, null, "响应中断")
        assertEquals(DraftStatus.UNCERTAIN, uncertain.status)
        val replay = repository.prepareSubmission(a, draft.id, uncertain.revision)
        assertTrue(replay.wasFrozen)
        assertEquals(frozen.payload.id, replay.payload.id)
        assertEquals(frozen.payload.json, replay.payload.json)
        repository.finishSubmission(a, replay)
        assertNull(repository.read(a.snapshot, draft.id))
    }

    @Test fun rejectedInputUnfreezesAndCorrectionUsesNewId(): Unit = runBlocking {
        activate(a)
        for (status in listOf(400, 413, 422)) {
            val draft = repository.create(a.snapshot, UUID.randomUUID().toString(), DraftContent("原文"))
            val frozen = repository.prepareSubmission(a, draft.id, draft.revision)
            val rejected = repository.failSubmission(a, frozen, status, "请修正")
            assertEquals(DraftStatus.EDITING, rejected.status)
            assertNull(rejected.requestId)
            val updated = repository.edit(a.snapshot, draft.id, rejected.revision, DraftContent("已修正"))
            val again = repository.prepareSubmission(a, draft.id, updated.revision)
            assertNotEquals(frozen.payload.id, again.payload.id)
        }
        val empty = repository.create(a.snapshot, draftId, DraftContent(""))
        expect<InvalidCollectionPayload> { repository.prepareSubmission(a, empty.id, empty.revision) }
        assertEquals(empty, repository.read(a.snapshot, empty.id))
    }

    @Test fun accountSwitchClearsOldCatalogAndRejectsLateRefresh(): Unit = runBlocking {
        activate(a)
        val project = Project(id(5), "项目", "active")
        val tag = Tag(id(6), "标签", "标签", 2)
        repository.replaceProjects(a, listOf(project))
        repository.replaceTags(a, listOf(tag))
        assertEquals(project.id, repository.cachedProjects(a.snapshot).single().id)
        assertEquals(tag.id, repository.cachedTags(a.snapshot).single().id)
        repository.observeSession(SessionSnapshot.Guest)
        assertTrue(repository.cachedProjects(a.snapshot).isEmpty())
        assertTrue(repository.cachedTags(SessionSnapshot.Guest).isEmpty())
        assertTrue(database.catalog().projects(a.scope).isEmpty())
        assertTrue(database.catalog().tags(a.scope).isEmpty())
        activate(b)
        expect<DraftAccountChanged> { repository.replaceProjects(a, listOf(project)) }
        assertTrue(repository.cachedProjects(b.snapshot).isEmpty())
        assertTrue(repository.cachedTags(b.snapshot).isEmpty())
    }

    private suspend fun activate(account: VerifiedAccount) {
        repository.observeSession(account.snapshot)
        assertTrue(repository.rememberVerified(account))
    }

    private suspend inline fun <reified T : Exception> expect(block: () -> Unit) {
        try {
            block()
            fail("Expected " + T::class.java.simpleName)
        } catch (error: Exception) {
            if (error !is T) throw error
        }
    }

    private fun account(number: Int) = VerifiedAccount(
        id(number), null, "test-csrf-$number", "mint", "system",
        SessionScope.fromCookie("spark_session=test-cookie-$number"),
    )

    private fun id(number: Int) = "00000000-0000-4000-8000-00000000000$number"
}
