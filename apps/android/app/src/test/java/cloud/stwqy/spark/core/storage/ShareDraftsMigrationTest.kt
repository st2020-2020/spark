package cloud.stwqy.spark.core.storage

import android.app.Application
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.network.apiJson
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class ShareDraftsMigrationTest {
    @Test fun upgradesOriginalV1DatabaseInPlaceAndKeepsOwnerRevisionAndFrozenPayload(): Unit = runBlocking {
        val context = RuntimeEnvironment.getApplication()
        val file = File(context.noBackupFilesDir, SparkDatabase.DATABASE_NAME)
        val snapshot = SessionScope.fromCookie("spark_session=synthetic-legacy-session")
        val pending = snapshot.provisionalScope
        val userId = "00000000-0000-4000-8000-000000000001"
        val owner = SessionScope.user(userId)
        val requestId = "00000000-0000-4000-8000-000000000003"
        val original = "https://example.com/材料（补记）"

        // Open the same file with the same v1 CREATE statements used by ShareDrafts.java.
        object : SQLiteOpenHelper(context, file.path, null, 1) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL("CREATE TABLE draft (id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL," +
                    " purpose TEXT NOT NULL, excluded INTEGER NOT NULL, request_id TEXT," +
                    " revision INTEGER NOT NULL, modified INTEGER NOT NULL)")
                db.execSQL("CREATE INDEX draft_scope ON draft(scope, modified DESC)")
                db.execSQL("CREATE TABLE verified_session (slot INTEGER PRIMARY KEY CHECK(slot=1)," +
                    " fingerprint TEXT NOT NULL, user_id TEXT)")
            }

            override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) =
                error("The v1 helper must never migrate to v2")
        }.use { legacy ->
            val db = legacy.writableDatabase
            db.execSQL("INSERT INTO draft VALUES ('ordinary', ?, '文档', '备忘', 0, NULL, 3, 1234)", arrayOf(pending))
            db.execSQL("INSERT INTO draft VALUES ('frozen', ?, ?, '用途', 1, ?, 7, 5678)",
                arrayOf(owner, original, requestId))
            db.execSQL("INSERT INTO draft VALUES (NULL, 'guest', '无效行', '', 0, NULL, 0, 1)")
            db.execSQL("INSERT INTO verified_session VALUES (1, ?, ?)", arrayOf(pending, userId))
        }

        assertTrue(file.isFile)
        val migrated = SparkDatabase.open(context)
        try {
            // All reads go through the actual Room database and its schema validation.
            assertEquals(2, migrated.openHelper.writableDatabase.version)
            val ordinary = requireNotNull(migrated.drafts().find("ordinary", listOf(pending)))
            assertEquals(
                DraftEntity("ordinary", pending, "文档", "备忘", false, 3, 1234),
                ordinary,
            )
            val frozen = requireNotNull(migrated.drafts().find("frozen", listOf(owner)))
            assertEquals(
                DraftEntity(
                    "frozen", owner, original, "用途", true, 7, 5678,
                    status = DraftStatus.UNCERTAIN, requestId = requestId,
                ),
                frozen,
            )
            assertNull(migrated.drafts().find("frozen", listOf(pending)))
            assertTrue(migrated.drafts().list(listOf(SessionScope.GUEST), 10, 0).isEmpty())
            assertEquals(VerifiedSessionEntity(fingerprint = pending, userId = userId), migrated.sessions().current())
            val repository = DraftRepository(migrated)
            val account = VerifiedAccount(userId, null, "test-csrf", "mint", "system", snapshot)
            val first = repository.prepareSubmission(account, frozen.id, frozen.revision)
            val request = apiJson.parseToJsonElement(first.payload.json).jsonObject
            assertEquals("https://example.com/材料", request["original_url"]?.jsonPrimitive?.content)
            assertEquals(requestId, first.payload.id)
            val failed = repository.failSubmission(account, first, null, "响应中断")
            val second = repository.prepareSubmission(account, failed.id, failed.revision)
            assertEquals(first.payload.json, second.payload.json)
            assertTrue(migrated.catalog().projects(owner).isEmpty())
            assertTrue(migrated.catalog().tags(owner).isEmpty())
            migrated.assets().insert(
                DraftAssetEntity("asset", ordinary.id, "asset.png", "图.png", "image/png", 8, 0, "stable-key"),
            )
            val asset = migrated.assets().list(ordinary.id, pending).single()
            assertFalse(asset.bytesTransferred)
            assertEquals(AssetUploadState.LOCAL, asset.uploadState)
            assertEquals(1, migrated.drafts().delete(ordinary.id, pending, ordinary.revision))
            migrated.openHelper.writableDatabase.query("SELECT count(*) FROM draft_asset").use { rows ->
                assertTrue(rows.moveToFirst())
                assertEquals(0, rows.getInt(0))
            }
        } finally {
            migrated.close()
        }
    }
}
