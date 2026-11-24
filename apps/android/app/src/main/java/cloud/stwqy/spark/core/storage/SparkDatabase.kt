package cloud.stwqy.spark.core.storage

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.File

@Database(
    entities = [
        DraftEntity::class, DraftAssetEntity::class, VerifiedSessionEntity::class,
        CachedProjectEntity::class, CachedTagEntity::class,
    ],
    version = 2,
    exportSchema = true,
)
internal abstract class SparkDatabase : RoomDatabase() {
    abstract fun drafts(): DraftDao
    abstract fun assets(): AssetDao
    abstract fun sessions(): SessionDao
    abstract fun catalog(): CatalogDao

    companion object {
        const val DATABASE_NAME = "share-drafts.db"

        fun open(context: Context): SparkDatabase =
            Room.databaseBuilder(
                context.applicationContext,
                SparkDatabase::class.java,
                File(context.noBackupFilesDir, DATABASE_NAME).path,
            ).addMigrations(MIGRATION_1_2).build()
    }
}

internal val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        // Rebuild both v1 tables so nullability, defaults and index order match Room's schema.
        db.execSQL("""
            CREATE TABLE draft_new (
                id TEXT NOT NULL PRIMARY KEY,
                scope TEXT NOT NULL,
                body TEXT NOT NULL,
                manual_title TEXT NOT NULL DEFAULT '',
                purpose TEXT NOT NULL,
                excluded INTEGER NOT NULL,
                project_ids_json TEXT NOT NULL DEFAULT '[]',
                tag_ids_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'EDITING',
                request_id TEXT,
                last_error TEXT,
                revision INTEGER NOT NULL,
                modified INTEGER NOT NULL
            )
        """.trimIndent())
        db.execSQL("""
            INSERT INTO draft_new (
                id, scope, body, manual_title, purpose, excluded,
                project_ids_json, tag_ids_json, status, request_id, last_error, revision, modified
            )
            SELECT id, scope, body, '', purpose, excluded, '[]', '[]',
                CASE WHEN request_id IS NOT NULL THEN 'UNCERTAIN' ELSE 'EDITING' END,
                request_id, NULL, revision, modified
            FROM draft WHERE id IS NOT NULL
        """.trimIndent())
        db.execSQL("DROP TABLE draft")
        db.execSQL("ALTER TABLE draft_new RENAME TO draft")
        db.execSQL("CREATE INDEX index_draft_scope_modified ON draft(scope, modified)")

        db.execSQL("""
            CREATE TABLE verified_session_new (
                slot INTEGER NOT NULL PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                user_id TEXT,
                palette TEXT NOT NULL DEFAULT 'mint',
                theme TEXT NOT NULL DEFAULT 'system'
            )
        """.trimIndent())
        db.execSQL("""
            INSERT INTO verified_session_new (slot, fingerprint, user_id, palette, theme)
            SELECT slot, fingerprint, user_id, 'mint', 'system'
            FROM verified_session WHERE slot IS NOT NULL
        """.trimIndent())
        db.execSQL("DROP TABLE verified_session")
        db.execSQL("ALTER TABLE verified_session_new RENAME TO verified_session")

        db.execSQL("""
            CREATE TABLE draft_asset (
                id TEXT NOT NULL PRIMARY KEY,
                draft_id TEXT NOT NULL,
                local_path TEXT NOT NULL,
                filename TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sort_order INTEGER NOT NULL,
                upload_idempotency_key TEXT NOT NULL,
                upload_id TEXT,
                bytes_transferred INTEGER NOT NULL DEFAULT 0,
                upload_state TEXT NOT NULL DEFAULT 'LOCAL',
                error_code TEXT,
                error_message TEXT,
                FOREIGN KEY(draft_id) REFERENCES draft(id) ON DELETE CASCADE
            )
        """.trimIndent())
        db.execSQL("CREATE INDEX index_draft_asset_draft_id_sort_order ON draft_asset(draft_id, sort_order)")

        db.execSQL("""
            CREATE TABLE cached_project (
                scope TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                state TEXT NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY(scope, id)
            )
        """.trimIndent())
        db.execSQL("""
            CREATE TABLE cached_tag (
                scope TEXT NOT NULL,
                id TEXT NOT NULL,
                name TEXT NOT NULL,
                collection_count INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY(scope, id)
            )
        """.trimIndent())
    }
}
