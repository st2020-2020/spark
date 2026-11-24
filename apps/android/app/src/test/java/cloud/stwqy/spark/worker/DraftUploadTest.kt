package cloud.stwqy.spark.worker

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.TestListenableWorkerBuilder
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.auth.WebViewCredentialsUnavailable
import cloud.stwqy.spark.core.network.SparkApiClient
import cloud.stwqy.spark.core.storage.AssetUploadState
import cloud.stwqy.spark.core.storage.DraftAccountChanged
import cloud.stwqy.spark.core.storage.DraftAssetEntity
import cloud.stwqy.spark.core.storage.DraftEntity
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.DraftStatus
import cloud.stwqy.spark.core.storage.MediaStorage
import cloud.stwqy.spark.core.storage.SparkDatabase
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.io.File
import java.net.InetAddress
import java.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit.SECONDS

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class DraftUploadTest {
    @get:Rule val temp = TemporaryFolder()
    private val server = MockWebServer()
    private val oss = MockWebServer()
    private val alice = SessionScope.fromCookie("spark_session=upload-test-a")
    private val bob = SessionScope.fromCookie("spark_session=upload-test-b")
    @Volatile private var current = alice
    private var unavailable = false
    private var now = 1_000L
    private lateinit var db: SparkDatabase
    private lateinit var drafts: DraftRepository
    private lateinit var api: SparkApiClient
    private lateinit var context: Context
    private lateinit var root: File
    private lateinit var media: MediaStorage
    private lateinit var uploader: AssetUploadCoordinator
    private lateinit var submission: DraftSubmissionCoordinator
    private val waits = mutableListOf<Long>()
    private val png = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv1sAAAAASUVORK5CYII=",
    )
    private val account = VerifiedAccount(USER_A, null, "test-csrf", "mint", "system", alice)
    private val credentials = object : SessionCredentialProvider {
        override fun currentSnapshot(): SessionSnapshot {
            if (unavailable) throw WebViewCredentialsUnavailable(IllegalStateException("WebView unavailable in test"))
            return current
        }
        override fun flush() = Unit
        override suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount {
            val response = api.session(snapshot)
            return VerifiedAccount(response.user.id, response.user.email, response.csrfToken, "mint", "system", snapshot)
        }
    }

    @Before fun setUp() {
        for (endpoint in listOf(server, oss)) endpoint.start(InetAddress.getByName("127.0.0.1"), 0)
        api = SparkApiClient(server.loopbackUrl("/"), true)
        context = RuntimeEnvironment.getApplication()
        db = Room.inMemoryDatabaseBuilder(context, SparkDatabase::class.java).build()
        drafts = DraftRepository(db, newId = { REQUEST_ID }, currentSnapshot = credentials::currentSnapshot)
        root = temp.newFolder()
        media = MediaStorage(root) { null }
        uploader = AssetUploadCoordinator(drafts, media, credentials, api,
            context.getSharedPreferences("upload-cooldown-test", Context.MODE_PRIVATE), { now }, { waits += it })
        submission = DraftSubmissionCoordinator(drafts, credentials, api, media, uploader)
        runBlocking { activate(account) }
    }

    @After fun tearDown() {
        if (::db.isInitialized) db.close()
        server.shutdown()
        oss.shutdown()
    }

    private fun MockWebServer.loopbackUrl(path: String) = url(path).newBuilder().host("127.0.0.1").build()

    @Test fun sendsPureImagesInOrderWithIsolatedPutAndRemovesLocalFiles(): Unit = runBlocking {
        val (draft, images) = createDraft(imageCount = 2)
        session()
        grant(UPLOAD_A)
        oss.enqueue(MockResponse().setResponseCode(204).setHeader("Set-Cookie", "object=tiny-fixture"))
        status(202, "verifying", UPLOAD_A)
        status(200, "verifying", UPLOAD_A)
        status(200, "ready", UPLOAD_A)
        grant(UPLOAD_B)
        oss.enqueue(MockResponse().setResponseCode(200))
        status(202, "ready", UPLOAD_B)
        receipt(201)
        val updates = mutableListOf<AssetProgress>()
        assertNull(submission.send(alice, draft) { updates += it })

        assertEquals("/api/v1/auth/session", request().path)
        for ((index, image) in images.withIndex()) {
            val uploadId = listOf(UPLOAD_A, UPLOAD_B)[index]
            val reservation = request()
            assertEquals("POST", reservation.method)
            assertEquals("/api/v1/uploads", reservation.path)
            assertEquals(image.uploadIdempotencyKey, reservation.getHeader("Idempotency-Key"))
            assertEquals("spark_session=upload-test-a", reservation.getHeader("Cookie"))
            assertEquals(server.loopbackUrl("/").toString().trimEnd('/'), reservation.getHeader("Origin"))
            assertEquals("test-csrf", reservation.getHeader("X-CSRF-Token"))
            assertEquals(Json.parseToJsonElement(
                """{"filename":"image-${index + 1}.png","size_bytes":${png.size},"mime_type":"image/png"}""",
            ), Json.parseToJsonElement(reservation.body.readUtf8()))

            val put = checkNotNull(oss.takeRequest(3, SECONDS))
            assertEquals("PUT", put.method)
            assertEquals("/objects/$uploadId", put.path)
            assertEquals("image/png", put.getHeader("Content-Type"))
            assertEquals("signed", put.getHeader("x-oss-test"))
            assertEquals(png.size.toString(), put.getHeader("Content-Length"))
            for (header in listOf("Cookie", "Origin", "X-CSRF-Token", "Idempotency-Key")) {
                assertNull(put.getHeader(header))
            }
            assertArrayEquals(png, put.body.readByteArray())
            assertEquals("/api/v1/uploads/$uploadId/complete", request().path)
            if (index == 0) repeat(2) {
                val poll = request()
                assertEquals("GET", poll.method)
                assertEquals("/api/v1/uploads/$uploadId", poll.path)
                assertEquals("spark_session=upload-test-a", poll.getHeader("Cookie"))
            }
        }
        val post = request()
        assertEquals("POST", post.method)
        assertEquals("/api/v1/collections", post.path)
        assertEquals(REQUEST_ID, post.getHeader("Idempotency-Key"))
        val payload = Json.parseToJsonElement(post.body.readUtf8()).jsonObject
        assertEquals(Json.parseToJsonElement("""["$UPLOAD_A","$UPLOAD_B"]"""), payload["upload_ids"])
        assertEquals(Json.parseToJsonElement(
            """{"schema_version":1,"content":{"type":"doc","content":[{"type":"paragraph"}]}}""",
        ), payload["document"])
        assertEquals(listOf(400L, 550L), waits)
        assertTrue(images.all { image -> updates.any { it.assetId == image.id && it.fraction == 1f } })
        assertNull(drafts.read(alice, draft.id))
        assertFalse(File(root, draft.id).exists())
    }

    @Test fun resumesAcknowledgedPutFromQueueWithoutRequestingAnotherGrant(): Unit = runBlocking {
        val (draft, images) = createDraft()
        session()
        grant(UPLOAD_A)
        oss.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(MockResponse().setResponseCode(202).setBody("x".repeat(128))
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val queued = checkNotNull(submission.send(alice, draft))
        assertEquals(DraftStatus.QUEUED, queued.status)
        val checkpoint = draftImage(draft)
        assertTrue(checkpoint.bytesTransferred)
        assertEquals(UPLOAD_A, checkpoint.uploadId)
        assertEquals(images.single().uploadIdempotencyKey, checkpoint.uploadIdempotencyKey)
        assertEquals(listOf("/api/v1/auth/session", "/api/v1/uploads", "/api/v1/uploads/$UPLOAD_A/complete"),
            List(3) { request().path })

        session()
        status(202, "ready", UPLOAD_A)
        receipt(201)
        assertEquals(NetworkType.CONNECTED, draftUploadRequest().workSpec.constraints.requiredNetworkType)
        assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
        assertEquals(listOf("/api/v1/auth/session", "/api/v1/uploads/$UPLOAD_A/complete", "/api/v1/collections"),
            List(3) { request().path })
        assertEquals(1, oss.requestCount)
        assertNull(drafts.read(alice, draft.id))
    }

    @Test fun verifiesAnExistingGrantBeforeRepeatingACompletedPut(): Unit = runBlocking {
        for (state in listOf("verifying", "ready")) {
            val (draft, images) = createDraft(uploadId = UPLOAD_A)
            session()
            status(200, state, UPLOAD_A)
            if (state == "verifying") status(200, "ready", UPLOAD_A)
            receipt(201)
            assertNull(submission.send(alice, draft))
            assertEquals("/api/v1/auth/session", request().path)
            repeat(if (state == "verifying") 2 else 1) {
                val lookup = request()
                assertEquals("GET", lookup.method)
                assertEquals("/api/v1/uploads/$UPLOAD_A", lookup.path)
            }
            val submitted = request()
            assertTrue(submitted.body.readUtf8().contains(UPLOAD_A))
            assertFalse(images.single().bytesTransferred)
        }
        assertEquals(0, oss.requestCount)
    }

    @Test fun pendingExistingGrantStillSendsTheBytesUsingTheOriginalKey(): Unit = runBlocking {
        val (draft, images) = createDraft(uploadId = UPLOAD_A)
        session()
        status(200, "pending", UPLOAD_A)
        grant(UPLOAD_A)
        oss.enqueue(MockResponse().setResponseCode(204))
        status(202, "ready", UPLOAD_A)
        receipt(201)
        assertNull(submission.send(alice, draft))
        assertEquals("/api/v1/auth/session", request().path)
        val lookup = request()
        assertEquals("GET", lookup.method)
        assertEquals("/api/v1/uploads/$UPLOAD_A", lookup.path)
        assertEquals(images.single().uploadIdempotencyKey, request().getHeader("Idempotency-Key"))
        assertEquals("/api/v1/uploads/$UPLOAD_A/complete", request().path)
        assertEquals("/api/v1/collections", request().path)
        assertArrayEquals(png, checkNotNull(oss.takeRequest(3, SECONDS)).body.readByteArray())
    }

    @Test fun finishedExistingGrantsDoNotRepeatPutAndRotateWhenUnusable(): Unit = runBlocking {
        for (state in listOf("attached", "expired", "rejected")) {
            val (draft, images) = createDraft(uploadId = UPLOAD_A)
            session()
            status(200, state, UPLOAD_A)
            val failed = checkNotNull(submission.send(alice, draft))
            assertEquals(DraftStatus.EDITING, failed.status)
            assertEquals("/api/v1/auth/session", request().path)
            assertEquals("/api/v1/uploads/$UPLOAD_A", request().path)
            val image = draftImage(draft)
            assertEquals("upload_$state", image.errorCode)
            assertNull(image.uploadId)
            assertNotEquals(images.single().uploadIdempotencyKey, image.uploadIdempotencyKey)
        }
        assertEquals(0, oss.requestCount)
    }

    @Test fun confirmsAlreadyAttachedCollectionWithoutRepeatingUploadsOrPost(): Unit = runBlocking {
        val (draft, _) = createDraft(ready = true)
        val original = loseReceipt(draft)
        session()
        receipt(200)
        assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
        assertEquals("/api/v1/auth/session", request().path)
        assertEquals("/api/v1/collections/${original.getHeader("Idempotency-Key")}", request().path)
        assertEquals(5, server.requestCount)
        assertEquals(0, oss.requestCount)
        assertFalse(File(root, draft.id).exists())
    }

    @Test fun missingCollectionReceiptReplaysTheOriginalKeyAndImageIds(): Unit = runBlocking {
        val (draft, _) = createDraft(ready = true, body = "fixture note")
        val original = loseReceipt(draft)
        session()
        problem(404, "not_found")
        receipt(201)
        assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
        assertEquals("/api/v1/auth/session", request().path)
        assertEquals("/api/v1/collections/$REQUEST_ID", request().path)
        val replay = request()
        assertEquals("/api/v1/collections", replay.path)
        assertEquals(original.getHeader("Idempotency-Key"), replay.getHeader("Idempotency-Key"))
        assertEquals(original.body.readUtf8(), replay.body.readUtf8())
        assertEquals(0, oss.requestCount)
        assertNull(drafts.read(alice, draft.id))
    }

    @Test fun terminalUploadStatesAndResponsesReplaceOnlyTheUploadKey(): Unit = runBlocking {
        val failures = listOf(
            upload(200, "rejected", UPLOAD_A), upload(200, "expired", UPLOAD_A),
            error(409, "upload_not_pending"), error(410, "upload_expired"), error(404, "not_found"),
        )
        for (failure in failures) {
            val (draft, images) = createDraft(ready = true)
            session()
            server.enqueue(failure)
            val remaining = checkNotNull(submission.send(alice, draft))
            val saved = draftImage(draft)
            assertEquals(DraftStatus.EDITING, remaining.status)
            assertNull(remaining.requestId)
            assertEquals(AssetUploadState.FAILED, saved.uploadState)
            assertNotEquals(images.single().uploadIdempotencyKey, saved.uploadIdempotencyKey)
            assertNull(saved.uploadId)
            assertFalse(saved.bytesTransferred)
            assertTrue(media.file(saved).isFile)
            assertEquals("/api/v1/auth/session", request().path)
            assertEquals("/api/v1/uploads/$UPLOAD_A", request().path)
        }
        assertEquals(0, oss.requestCount)
    }

    @Test fun rateLimitKeepsKeyAndSkipsImageWorkUntilRetryAfter(): Unit = runBlocking {
        val (draft, images) = createDraft()
        session()
        server.enqueue(error(429, "rate_limited").setHeader("Retry-After", "45"))
        val queued = checkNotNull(submission.send(alice, draft))
        assertEquals(DraftStatus.QUEUED, queued.status)
        assertTrue(queued.lastError.orEmpty().contains("45 秒"))
        assertEquals("rate_limited", draftImage(draft).errorCode)
        assertEquals(images.single().uploadIdempotencyKey, draftImage(draft).uploadIdempotencyKey)
        request()
        request()

        session()
        assertEquals(ListenableWorker.Result.retry(), uploadWorker(attempt = 5).doWork())
        assertEquals(45_000L, uploader.cooldownRemaining(account.scope))
        assertEquals(0L, uploader.cooldownRemaining(SessionScope.user(USER_B)))
        assertEquals("/api/v1/auth/session", request().path)
        assertEquals(3, server.requestCount)

        now += 45_000L
        session()
        grant(UPLOAD_A)
        oss.enqueue(MockResponse().setResponseCode(204))
        status(202, "ready", UPLOAD_A)
        receipt(201)
        assertEquals(ListenableWorker.Result.success(), uploadWorker(attempt = 6).doWork())
        request()
        assertEquals(images.single().uploadIdempotencyKey, request().getHeader("Idempotency-Key"))
        assertNull(drafts.read(alice, draft.id))
    }

    @Test fun missingImageStorageStopsWorkerAndAllowsTextOnlySave(): Unit = runBlocking {
        val (draft, images) = createDraft(body = "fixture note")
        submission.queue(alice, draft)
        session()
        problem(503, "integration_not_configured")
        assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
        val remaining = checkNotNull(drafts.read(alice, draft.id))
        assertEquals(DraftStatus.EDITING, remaining.status)
        assertEquals(IMAGE_STORAGE_UNAVAILABLE, remaining.lastError)
        assertEquals("integration_not_configured", draftImage(draft).errorCode)
        assertEquals(images.single().uploadIdempotencyKey, draftImage(draft).uploadIdempotencyKey)
        assertEquals(0, oss.requestCount)
        request()
        request()

        val edited = submission.removeImage(alice, remaining, images.single().id)
        assertFalse(File(root, draft.id).exists())
        session()
        receipt(201)
        assertNull(submission.send(alice, edited))
        request()
        assertEquals(Json.parseToJsonElement("[]"), Json.parseToJsonElement(request().body.readUtf8()).jsonObject["upload_ids"])
    }

    @Test fun missingImageStorageAtCollectionPostUnfreezesForRemoval(): Unit = runBlocking {
        val (draft, _) = createDraft(ready = true, body = "fixture note")
        session()
        status(200, "ready", UPLOAD_A)
        problem(503, "integration_not_configured")
        val remaining = checkNotNull(submission.send(alice, draft))
        assertEquals(DraftStatus.EDITING, remaining.status)
        assertNull(remaining.requestId)
        assertEquals(IMAGE_STORAGE_UNAVAILABLE, remaining.lastError)
        assertEquals(UPLOAD_A, draftImage(draft).uploadId)
    }

    @Test fun workerLeavesQueueIntactIfCookieManagerIsUnavailableOrAccountDiffers(): Unit = runBlocking {
        val (draft, images) = createDraft()
        submission.queue(alice, draft)
        unavailable = true
        assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
        assertEquals(0, server.requestCount)
        unavailable = false
        current = bob
        session(USER_B)
        assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
        assertEquals("spark_session=upload-test-b", request().getHeader("Cookie"))
        assertEquals(1, server.requestCount)
        assertNull(drafts.read(bob, draft.id))
        activate(account)
        val pending = checkNotNull(drafts.read(alice, draft.id))
        assertEquals(DraftStatus.QUEUED, pending.status)
        assertEquals(images.single(), draftImage(draft))
    }

    @Test fun switchingAccountsDuringVerificationCancelsPollAndPreservesUploadCheckpoint(): Unit = runBlocking {
        val (draft, _) = createDraft()
        session()
        grant(UPLOAD_A)
        oss.enqueue(MockResponse().setResponseCode(204))
        server.enqueue(upload(202, "verifying", UPLOAD_A).setBodyDelay(2, SECONDS))
        val result = async { runCatching { submission.send(alice, draft) } }
        withTimeout(6_000) {
            repeat(3) {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { request() }
            }
            val secondary = VerifiedAccount(USER_B, null, "test-csrf", "mint", "system", bob)
            activate(secondary)
            assertTrue(result.await().exceptionOrNull() is DraftAccountChanged)
        }
        assertEquals(3, server.requestCount)
        assertEquals(1, oss.requestCount)
        assertNull(drafts.read(bob, draft.id))
        activate(account)
        assertTrue(draftImage(draft).bytesTransferred)
        assertEquals(UPLOAD_A, draftImage(draft).uploadId)
    }

    @Test fun unauthorizedOrForbiddenResponseEndsTheCurrentQueueRun(): Unit = runBlocking {
        val (draft, _) = createDraft(id = "00000000-0000-4000-8000-000000000011")
        val (next, _) = createDraft(id = "00000000-0000-4000-8000-000000000022")
        submission.queue(alice, draft)
        submission.queue(alice, next)
        for (code in listOf(401, 403)) {
            session()
            problem(code, "session_expired")
            assertEquals(ListenableWorker.Result.success(), uploadWorker().doWork())
            assertEquals("/api/v1/auth/session", request().path)
            assertEquals("/api/v1/uploads", request().path)
            assertNull(drafts.verifiedSession(alice))
            activate(account)
            assertEquals(DraftStatus.QUEUED, drafts.read(alice, draft.id)?.status)
            assertEquals(DraftStatus.QUEUED, drafts.read(alice, next.id)?.status)
        }
        assertEquals(4, server.requestCount)
        assertEquals(0, oss.requestCount)
    }

    @Test fun cleanerUsesRoomReferencesAndDeletionClearsTheRemainingDirectory(): Unit = runBlocking {
        val (draft, images) = createDraft()
        val directory = media.file(images.single()).parentFile!!
        val orphan = File(directory, UUID.randomUUID().toString()).apply { writeBytes(png) }
        val cleaner = TestListenableWorkerBuilder<OrphanMediaCleanupWorker>(context)
            .setWorkerFactory(factory { appContext, params ->
                OrphanMediaCleanupWorker(appContext, params, submission::cleanOrphans)
            }).build()
        assertEquals(ListenableWorker.Result.success(), cleaner.doWork())
        assertTrue(media.file(images.single()).isFile)
        assertFalse(orphan.exists())
        submission.delete(alice, draft)
        assertFalse(directory.exists())
    }

    private fun uploadWorker(attempt: Int = 0) = TestListenableWorkerBuilder<DraftUploadWorker>(context)
        .setRunAttemptCount(attempt)
        .setWorkerFactory(factory { appContext, params -> DraftUploadWorker(appContext, params, submission::drainQueue) })
        .build()

    private fun factory(create: (Context, WorkerParameters) -> ListenableWorker) = object : WorkerFactory() {
        override fun createWorker(appContext: Context, workerClassName: String, workerParameters: WorkerParameters) =
            create(appContext, workerParameters)
    }

    private suspend fun activate(account: VerifiedAccount) {
        current = account.snapshot
        drafts.observeSession(current)
        assertTrue(drafts.rememberVerified(account))
    }

    private suspend fun createDraft(
        imageCount: Int = 1,
        ready: Boolean = false,
        body: String = "",
        id: String = UUID.randomUUID().toString(),
        uploadId: String? = if (ready) UPLOAD_A else null,
    ): Pair<DraftEntity, List<DraftAssetEntity>> {
        val images = List(imageCount) { index ->
            val asset = UUID.randomUUID().toString()
            DraftAssetEntity(asset, id, "$id/$asset", "image-${index + 1}.png", "image/png", png.size.toLong(),
                index, UUID.randomUUID().toString(), uploadId = uploadId, bytesTransferred = ready,
                uploadState = if (ready) AssetUploadState.READY else AssetUploadState.LOCAL)
        }
        val draft = media.importing(id) {
            for (image in images) media.file(image).apply { parentFile?.mkdirs(); writeBytes(png) }
            drafts.saveSharedInput(id, account.scope, body, images)
        }
        return draft to images
    }

    private suspend fun loseReceipt(draft: DraftEntity): okhttp3.mockwebserver.RecordedRequest {
        session()
        status(200, "ready", UPLOAD_A)
        server.enqueue(MockResponse().setResponseCode(201).setBody("x".repeat(128))
            .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val uncertain = checkNotNull(submission.send(alice, draft))
        assertEquals(DraftStatus.UNCERTAIN, uncertain.status)
        assertEquals(REQUEST_ID, uncertain.requestId)
        assertEquals(UPLOAD_A, draftImage(draft).uploadId)
        assertEquals("/api/v1/auth/session", request().path)
        assertEquals("/api/v1/uploads/$UPLOAD_A", request().path)
        return request().also { assertEquals("/api/v1/collections", it.path) }
    }

    private suspend fun draftImage(draft: DraftEntity) = drafts.readAssets(alice, draft.id).single()

    private fun request() = checkNotNull(server.takeRequest(3, SECONDS))
    private fun session(userId: String = USER_A) = server.enqueue(json(200,
        """{"user":{"id":"$userId","email":"example@fixture.invalid"},"csrf_token":"test-csrf"}"""))
    private fun grant(id: String) = server.enqueue(json(201, """
        {"id":"$id","method":"PUT","url":"${oss.loopbackUrl("/objects/$id")}","headers":{"Content-Type":"image/png",
        "x-oss-test":"signed"},"expires_at":"$EXPIRES"}
    """.trimIndent()))
    private fun upload(status: Int, state: String, id: String) = json(status,
        """{"id":"$id","status":"$state","expires_at":"$EXPIRES"}""")
    private fun status(status: Int, state: String, id: String) = server.enqueue(upload(status, state, id))
    private fun receipt(status: Int) = server.enqueue(json(status, """{"id":"$REQUEST_ID"}"""))
    private fun error(status: Int, code: String) = json(status, """{"error":{"code":"$code","message":"fixture"}}""")
    private fun problem(status: Int, code: String) = server.enqueue(error(status, code))
    private fun json(status: Int, body: String) = MockResponse().setResponseCode(status).setBody(body)

    private companion object {
        const val USER_A = "00000000-0000-4000-8000-000000000001"
        const val USER_B = "00000000-0000-4000-8000-000000000002"
        const val UPLOAD_A = "00000000-0000-4000-8000-000000000003"
        const val UPLOAD_B = "00000000-0000-4000-8000-000000000004"
        const val REQUEST_ID = "00000000-0000-4000-8000-000000000005"
        const val EXPIRES = "2030-01-01T00:00:00Z"
    }
}
