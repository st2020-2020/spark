package cloud.stwqy.spark.feature.drafts

import android.app.Application
import android.graphics.Bitmap
import androidx.lifecycle.viewModelScope
import androidx.room.Room
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.designsystem.SparkPalette
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.SparkApiClient
import cloud.stwqy.spark.core.security.SharedInput
import cloud.stwqy.spark.core.storage.DraftAccountChanged
import cloud.stwqy.spark.core.storage.AssetUploadState
import cloud.stwqy.spark.core.storage.DraftChanged
import cloud.stwqy.spark.core.storage.DraftContent
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.DraftStatus
import cloud.stwqy.spark.core.storage.MediaStorage
import cloud.stwqy.spark.core.storage.SparkDatabase
import cloud.stwqy.spark.feature.capture.ShareCaptureViewModel
import cloud.stwqy.spark.feature.capture.SharedDraft
import cloud.stwqy.spark.worker.AssetUploadCoordinator
import cloud.stwqy.spark.worker.DraftSubmissionCoordinator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class DraftFlowTest {
    private val server = MockWebServer()
    private val alice = SessionScope.fromCookie("spark_session=fixture-a")
    private val bob = SessionScope.fromCookie("spark_session=fixture-b")
    @Volatile private var active = alice
    private var time = 1_000_000L
    private lateinit var db: SparkDatabase
    private lateinit var disk: DraftRepository
    private lateinit var catalog: DraftCatalog
    private lateinit var media: MediaStorage
    private lateinit var submission: DraftSubmissionCoordinator
    private lateinit var api: SparkApiClient
    private val credentials = object : SessionCredentialProvider {
        override fun currentSnapshot() = active
        override fun flush() = Unit
        override suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount {
            val result = api.session(snapshot)
            return VerifiedAccount(result.user.id, result.user.email, result.csrfToken, result.user.palette, result.user.theme, snapshot)
        }
    }

    @Before fun start() {
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        db = Room.inMemoryDatabaseBuilder(RuntimeEnvironment.getApplication(), SparkDatabase::class.java).build()
        disk = DraftRepository(db, clock = { time }, currentSnapshot = credentials::currentSnapshot)
        api = SparkApiClient(server.url("/").newBuilder().host("127.0.0.1").build(), true)
        catalog = DraftCatalog(disk, api, now = { time })
        val context = RuntimeEnvironment.getApplication()
        media = MediaStorage(context)
        val uploader = AssetUploadCoordinator(disk, media, credentials, api, context.getSharedPreferences("upload-retry", 0))
        submission = DraftSubmissionCoordinator(disk, credentials, api, media, uploader)
    }

    @After fun stop() {
        db.close()
        server.shutdown()
    }

    @Test fun catalogUsesVerifiedScopeTtlPagingSearchAndOfflineCache(): Unit = runBlocking {
        val account = activate(alice, USER_A)
        server.enqueue(json(200, """{"items":[{"id":"$PROJECT","name":"研究","state":"active"}],"next_cursor":"page-2"}"""))
        val page = catalog.page(account, CatalogKind.PROJECT, "")
        assertEquals("page-2", page.nextCursor)
        val first = request()
        assertEquals("/api/v1/projects?state=active&limit=100", first.path)
        assertEquals("spark_session=fixture-a", first.getHeader("Cookie"))
        server.enqueue(json(200, """{"items":[{"id":"$PROJECT_2","name":"手帐","state":"active"}]}"""))
        assertEquals(PROJECT_2, catalog.page(account, CatalogKind.PROJECT, "", page.nextCursor).items.single().id)
        assertTrue(request().path!!.endsWith("cursor=page-2"))
        val cached = catalog.page(account, CatalogKind.PROJECT, "")
        assertNull(cached.nextCursor)
        assertEquals(setOf(PROJECT, PROJECT_2), cached.items.map { it.id }.toSet())
        assertNull(server.takeRequest(120, TimeUnit.MILLISECONDS))

        server.enqueue(json(200, """{"items":[{"id":"$TAG","name":"阅读","path":"阅读","collection_count":3}]}"""))
        assertEquals("阅读", catalog.page(account, CatalogKind.TAG, "读").items.single().name)
        assertEquals("读", request().requestUrl?.queryParameter("q"))
        assertEquals(listOf(CatalogChoice(TAG, "阅读")), catalog.cached(alice, CatalogKind.TAG))

        time += AppConfig.CATALOG_TTL_MILLIS
        server.enqueue(json(200, """{"items":[{"id":"$PROJECT_2","name":"新手帐","state":"active"}]}"""))
        assertEquals("新手帐", catalog.page(account, CatalogKind.PROJECT, "").items.single().name)
        assertEquals("/api/v1/projects?state=active&limit=100", request().path)
        assertEquals(listOf(PROJECT_2), catalog.cached(alice, CatalogKind.PROJECT).map { it.id })
    }

    @Test fun switchRejectsLateCatalogResponsesAndKeepsOtherAccountsDraftsPrivate(): Unit = runBlocking {
        val original = activate(alice, USER_A)
        val draft = disk.create(alice, DRAFT, DraftContent("A 的草稿"))
        server.enqueue(json(200, """{"items":[{"id":"$PROJECT","name":"A","state":"active"}]}""").setBodyDelay(450, TimeUnit.MILLISECONDS))
        val pending = async { runCatching { catalog.page(original, CatalogKind.PROJECT, "") } }
        assertTrue(requestAsync().path!!.startsWith("/api/v1/projects"))

        val next = activate(bob, USER_B)
        assertTrue(pending.await().exceptionOrNull() is DraftAccountChanged)
        assertTrue(catalog.cached(bob, CatalogKind.PROJECT).isEmpty())
        assertTrue(db.catalog().projects(original.scope).isEmpty())
        assertNull(disk.read(bob, draft.id))
        disk.observeSession(alice)
        assertTrue(disk.rememberVerified(next))
        server.enqueue(session(USER_B))
        try {
            submission.send(bob, draft)
            error("Cross-account submission was accepted")
        } catch (_: DraftChanged) {
            assertEquals("/api/v1/auth/session", request().path)
            assertNull(server.takeRequest(120, TimeUnit.MILLISECONDS))
        }
    }

    @Test fun ambiguousPostReplaysIdenticalAssociationPayloadAfterMissingReceipt(): Unit = runBlocking {
        activate(alice, USER_A)
        val content = DraftContent(
            "题目\nhttps://example.invalid/article", "阅读", true, " 手工标题 ", listOf(PROJECT), listOf(TAG),
        )
        val draft = disk.create(alice, DRAFT, content)
        server.enqueue(session(USER_A))
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        val frozen = requireNotNull(submission.send(alice, draft))
        assertEquals(DraftStatus.UNCERTAIN, frozen.status)
        assertEquals("/api/v1/auth/session", request().path)
        val original = request()
        val body = original.body.readUtf8()
        val input = Json.parseToJsonElement(body).jsonObject
        val id = input.getValue("id").jsonPrimitive.content
        assertEquals(id, frozen.requestId)
        assertEquals(id, original.getHeader("Idempotency-Key"))
        assertEquals("fixture-csrf", original.getHeader("X-CSRF-Token"))
        assertEquals("spark_session=fixture-a", original.getHeader("Cookie"))
        assertEquals("手工标题", input.getValue("manual_title").jsonPrimitive.content)
        assertEquals(listOf(PROJECT), input.getValue("project_ids").jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf(TAG), input.getValue("tag_ids").jsonArray.map { it.jsonPrimitive.content })
        assertEquals("https://example.invalid/article", input.getValue("original_url").jsonPrimitive.content)
        try {
            disk.edit(alice, draft.id, frozen.revision, content.copy(manualTitle = "不同标题"))
            error("Frozen draft was editable")
        } catch (_: DraftChanged) {
            assertEquals(content, disk.contentOf(frozen))
        }
        server.enqueue(session(USER_A))
        server.enqueue(problem(404, "not_found"))
        server.enqueue(json(201, """{"id":"$id"}"""))
        assertNull(submission.send(alice, frozen))
        assertEquals("/api/v1/auth/session", request().path)
        assertEquals("/api/v1/collections/$id", request().path)
        val replay = request()
        assertEquals(id, replay.getHeader("Idempotency-Key"))
        assertEquals(body, replay.body.readUtf8())
        assertNull(disk.read(alice, draft.id))
    }

    @Test fun operationInProgressKeepsKeyButDefinitiveConflictAnd422AllowCorrection(): Unit = runBlocking {
        activate(alice, USER_A)
        val draft = disk.create(alice, DRAFT, DraftContent("一条收藏"))
        server.enqueue(session(USER_A))
        server.enqueue(problem(409, "operation_in_progress"))
        val inFlight = requireNotNull(submission.send(alice, draft))
        assertEquals(DraftStatus.UNCERTAIN, inFlight.status)
        request()
        val id = request().getHeader("Idempotency-Key")
        server.enqueue(session(USER_A))
        server.enqueue(problem(404, "not_found"))
        server.enqueue(problem(409, "idempotency_mismatch"))
        val conflict = requireNotNull(submission.send(alice, inFlight))
        assertEquals(DraftStatus.EDITING, conflict.status)
        assertNull(conflict.requestId)
        request()
        request()
        assertEquals(id, request().getHeader("Idempotency-Key"))
        val edited = disk.edit(alice, draft.id, conflict.revision, DraftContent("修正后的内容"))
        server.enqueue(session(USER_A))
        server.enqueue(problem(422, "validation_failed"))
        val invalid = requireNotNull(submission.send(alice, edited))
        assertEquals(DraftStatus.EDITING, invalid.status)
        assertNull(invalid.requestId)
        request()
        val changed = request()
        assertNotEquals(id, changed.getHeader("Idempotency-Key"))
        assertFalse(Json.parseToJsonElement(changed.body.readUtf8()).jsonObject.containsKey("manual_title"))
    }

    @Test fun shareAutosavesOnPauseAndQueuesOfflineThenDraftBoxReopensIt(): Unit = runBlocking {
        runModels {
            active = SessionSnapshot.Guest
            val model = capture()
            try {
                model.resume(online = false)
                await { model.state.value.draft?.id == DRAFT }
                assertTrue(model.edit(DraftContent("编辑后的原文"), composing = true))
                assertEquals("浏览器标题\nhttps://example.invalid/article", disk.read(active, DRAFT)?.body)
                model.pause()
                await { disk.read(active, DRAFT)?.body == "编辑后的原文" }
                model.resume(online = false)
                model.save()
                assertEquals(DraftEffect.Finish("已存为待发送草稿"), withTimeout(5000) { model.effects.first() })
                assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
                val list = LocalDraftsViewModel(disk, credentials, catalog, submission, media, DraftRestore(), DraftIdentity())
                try {
                    list.resume(online = false)
                    await { list.state.value.rows.singleOrNull()?.status == DraftStatus.QUEUED }
                    list.editDraft(DRAFT)
                    await { list.state.value.content.body == "编辑后的原文" }
                    assertTrue(list.state.value.canEdit)
                    list.delete()
                    await { list.state.value.draft == null && list.state.value.rows.isEmpty() }
                    assertNull(disk.read(active, DRAFT))
                } finally {
                    list.viewModelScope.cancel()
                }
            } finally {
                model.viewModelScope.cancel()
            }
        }
    }

    @Test fun confirmedLoginClaimsOnlySelectedShareAndRefreshesTheme(): Unit = runBlocking {
        runModels {
            active = SessionSnapshot.Guest
            val model = capture()
            try {
                model.resume(online = true)
                await { model.state.value.draft?.id == DRAFT }
                disk.create(active, OTHER_DRAFT, DraftContent("未选中的访客草稿"))
                model.login()
                assertEquals(DraftEffect.Login, withTimeout(5000) { model.effects.first() })
                model.pause()
                active = alice
                server.enqueue(session(USER_A))
                model.loginResult(alice.provisionalScope)
                model.resume(online = true)
                await { model.state.value.draft?.scope == SessionScope.user(USER_A) && model.state.value.canEdit }
                assertEquals(DraftIdentity(SparkPalette.SAKURA, "dark"), model.state.value.identity)
                assertEquals("fixture@example.invalid", model.state.value.email)
                assertEquals(listOf(DRAFT), disk.list(alice).map { it.id })
                assertNull(disk.read(alice, OTHER_DRAFT))
            } finally {
                model.viewModelScope.cancel()
            }
        }
    }

    @Test fun reusedShareHostKeepsOldDraftAndOpensNewIntent(): Unit = runBlocking {
        runModels {
            active = SessionSnapshot.Guest
            val model = capture()
            try {
                model.resume(online = false)
                await { model.state.value.draft?.id == DRAFT }
                assertTrue(model.edit(DraftContent("第一条的改动")))
                model.receive(sharedText(OTHER_DRAFT, "第二条"), null, online = false)
                await { model.state.value.draft?.id == OTHER_DRAFT }
                assertEquals("第二条", model.state.value.content.body)
                assertEquals("第一条的改动", disk.read(active, DRAFT)?.body)
            } finally {
                model.viewModelScope.cancel()
            }
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun slowSharedImageLeavesTheTextDurableAndCanBeRetriedOffline(): Unit = runBlocking {
        runModels {
            active = SessionSnapshot.Guest
            val reading = CountDownLatch(1)
            val closed = CountDownLatch(1)
            val attempts = AtomicInteger()
            val stalled = object : InputStream() {
                override fun read(): Int = error("Expected buffered read")
                override fun read(bytes: ByteArray, offset: Int, length: Int): Int {
                    reading.countDown()
                    if (!closed.await(5, TimeUnit.SECONDS)) error("The stalled stream was never closed")
                    throw IOException("Fixture was closed")
                }
                override fun close() = closed.countDown()
            }
            val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
            val png = try {
                ByteArrayOutputStream().also { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }.toByteArray()
            } finally {
                bitmap.recycle()
            }
            val context = RuntimeEnvironment.getApplication()
            val storage = MediaStorage(
                File(context.cacheDir, "shared-fixture-${UUID.randomUUID()}"),
                { _, _ -> if (attempts.incrementAndGet() == 1) stalled else png.inputStream() },
                importTimeoutMillis = 1_500,
            )
            val id = DRAFT
            val shared = SharedDraft(id, active.provisionalScope,
                SharedInput("先保存的正文", listOf("content://fixture/slow"), false))
            val model = ShareCaptureViewModel(disk, credentials, catalog, submission, storage,
                DraftRestore(), shared, DraftIdentity(), null)
            try {
                model.resume(online = false)
                assertTrue(withContext(Dispatchers.IO) { reading.await(5, TimeUnit.SECONDS) })
                assertEquals("先保存的正文", disk.read(active, id)?.body)
                assertFalse(model.restore().incoming)
                assertTrue(model.state.value.canEdit)
                assertTrue(model.edit(DraftContent("读取图片时编辑的正文")))
                model.pause()
                await { disk.read(active, id)?.body == "读取图片时编辑的正文" }
                val reopened = LocalDraftsViewModel(disk, credentials, catalog, submission, storage, DraftRestore(), DraftIdentity())
                try {
                    reopened.resume(online = false)
                    await { reopened.state.value.rows.any { it.id == id } }
                    reopened.editDraft(id)
                    await { reopened.state.value.draft?.id == id }
                    assertEquals("读取图片时编辑的正文", reopened.state.value.content.body)
                } finally {
                    reopened.viewModelScope.cancel()
                }
                assertTrue(withContext(Dispatchers.IO) { closed.await(5, TimeUnit.SECONDS) })
                model.resume(online = false)
                await { model.state.value.images.singleOrNull()?.asset?.uploadState == AssetUploadState.IMPORT_FAILED }
                val failed = model.state.value.images.single().asset
                assertTrue(failed.errorMessage.orEmpty().contains("超时"))
                assertEquals("读取图片时编辑的正文", disk.read(active, id)?.body)
                assertTrue(model.canRetryImport(failed))
                model.retryImage(failed.id)
                await { attempts.get() == 2 && !model.state.value.busy }
                val savedImage = model.state.value.images.single()
                assertTrue(savedImage.asset.errorMessage, savedImage.file?.isFile == true)
                assertEquals(AssetUploadState.LOCAL, disk.readAssets(active, id).single().uploadState)
                assertEquals(2, attempts.get())
            } finally {
                model.viewModelScope.cancel()
            }
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun failedRoomWriteLeavesShareImageInterruptedAndAllowsLoginRetryAndRemoval(): Unit = runBlocking {
        runModels {
            active = SessionSnapshot.Guest
            val body = "图片写回失败时保留的正文"
            val opening = CountDownLatch(1)
            val releaseImage = CountDownLatch(1)
            val attempts = AtomicInteger()
            val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
            val png = try {
                ByteArrayOutputStream().also { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }.toByteArray()
            } finally {
                bitmap.recycle()
            }
            val context = RuntimeEnvironment.getApplication()
            val storage = MediaStorage(File(context.cacheDir, "shared-fixture-${UUID.randomUUID()}")) {
                if (attempts.incrementAndGet() == 1) {
                    opening.countDown()
                    check(releaseImage.await(10, TimeUnit.SECONDS))
                }
                png.inputStream()
            }
            withContext(Dispatchers.IO) {
                db.openHelper.writableDatabase.execSQL(
                    """CREATE TRIGGER fail_import BEFORE INSERT ON draft_asset WHEN NEW.upload_state = 'LOCAL'
                       BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END""",
                )
            }
            val shared = SharedDraft(DRAFT, active.provisionalScope, SharedInput(body, listOf("content://fixture/image"), false))
            val model = ShareCaptureViewModel(disk, credentials, catalog, submission, storage,
                DraftRestore(), shared, DraftIdentity(), null)
            try {
                model.resume(online = true)
                assertTrue(withContext(Dispatchers.IO) { opening.await(5, TimeUnit.SECONDS) })
                val pending = model.state.value.images.single().asset
                assertEquals(DraftImageImport.READING, model.state.value.importStatus(pending))
                assertFalse(model.state.value.canLogin)
                assertEquals(body, disk.read(active, DRAFT)?.body)

                releaseImage.countDown()
                await { model.state.value.error?.contains("无法读写本机草稿") == true }
                val interrupted = model.state.value
                assertEquals(AssetUploadState.IMPORTING, disk.readAssets(active, DRAFT).single().uploadState)
                assertTrue(interrupted.activeImageImports.isEmpty())
                assertEquals(DraftImageImport.INTERRUPTED, interrupted.importStatus(interrupted.images.single().asset))
                assertTrue(interrupted.canLogin)
                assertTrue(interrupted.canEdit)
                assertTrue(model.canRetryImport(pending))
                model.login()
                assertEquals(DraftEffect.Login, withTimeout(5_000) { model.effects.first() })
                await { !model.state.value.busy }

                // Retrying while the write is still failing must turn the spinner off again.
                model.retryImage(pending.id)
                await { attempts.get() == 2 && !model.state.value.busy }
                assertEquals(DraftImageImport.INTERRUPTED, model.state.value.importStatus(pending))
                assertTrue(model.state.value.canLogin)
                model.removeImage(pending.id)
                await { !model.state.value.busy && model.state.value.images.isEmpty() }
                assertTrue(disk.readAssets(active, DRAFT).isEmpty())
                assertEquals(body, disk.read(active, DRAFT)?.body)
            } finally {
                releaseImage.countDown()
                model.viewModelScope.cancel()
            }
        }
    }

    private suspend fun activate(snapshot: SessionSnapshot, user: String): VerifiedAccount {
        active = snapshot
        disk.observeSession(snapshot)
        server.enqueue(session(user))
        return submission.verify(snapshot).also { assertEquals("/api/v1/auth/session", request().path) }
    }

    private fun capture() = ShareCaptureViewModel(
        disk, credentials, catalog, submission, media, DraftRestore(),
        sharedText(DRAFT, "浏览器标题\nhttps://example.invalid/article"), DraftIdentity(), null,
    )

    private fun sharedText(id: String, text: String) = SharedDraft(id, active.provisionalScope, SharedInput(text, emptyList(), false))

    private fun request() = checkNotNull(server.takeRequest(3, TimeUnit.SECONDS))
    private suspend fun requestAsync() = withContext(Dispatchers.IO) { request() }
    private fun session(user: String) =
        json(200, """{"user":{"id":"$user","email":"fixture@example.invalid","palette":"sakura","theme":"dark"},"csrf_token":"fixture-csrf"}""")
    private fun problem(status: Int, code: String) = json(status, """{"error":{"code":"$code","message":"fixture"}}""")
    private fun json(status: Int, body: String) = MockResponse().setResponseCode(status).setBody(body)
        .addHeader("Content-Type", "application/json")
    private suspend fun await(ready: suspend () -> Boolean) = withTimeout(5000) {
        while (!ready()) delay(20)
    }

    private suspend fun runModels(test: suspend () -> Unit) = Dispatchers.Default.limitedParallelism(1).let { main ->
        Dispatchers.setMain(main)
        try {
            withContext(main) { test() }
        } finally {
            Dispatchers.resetMain()
        }
    }

    private companion object {
        const val USER_A = "00000000-0000-4000-8000-000000000001"
        const val USER_B = "00000000-0000-4000-8000-000000000002"
        const val DRAFT = "00000000-0000-4000-8000-000000000003"
        const val OTHER_DRAFT = "00000000-0000-4000-8000-000000000004"
        const val PROJECT = "00000000-0000-4000-8000-000000000005"
        const val PROJECT_2 = "00000000-0000-4000-8000-000000000006"
        const val TAG = "00000000-0000-4000-8000-000000000007"
    }
}
