package cloud.stwqy.spark;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Base64;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

final class ShareDrafts extends SQLiteOpenHelper {
    static final String GUEST = "guest";
    static final int PAGE_SIZE = 20;
    private static ShareDrafts instance;

    static synchronized ShareDrafts open(Context context) {
        if (instance == null) instance = new ShareDrafts(context.getApplicationContext());
        return instance;
    }

    private ShareDrafts(Context context) {
        super(context, new File(context.getNoBackupFilesDir(), "share-drafts.db").getPath(), null, 1);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE draft (id TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL,"
                + " purpose TEXT NOT NULL, excluded INTEGER NOT NULL, request_id TEXT,"
                + " revision INTEGER NOT NULL, modified INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX draft_scope ON draft(scope, modified DESC)");
        db.execSQL("CREATE TABLE verified_session (slot INTEGER PRIMARY KEY CHECK(slot=1),"
                + " fingerprint TEXT NOT NULL, user_id TEXT)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Unsupported share draft database version");
    }

    // There is only one offline identity. Observing logout or a new token evicts the old one.
    void observeSession(String fingerprint) {
        SQLiteDatabase db = getWritableDatabase();
        if (fingerprint.equals(GUEST)) {
            db.delete("verified_session", null, null);
            return;
        }
        db.beginTransaction();
        try {
            db.execSQL("INSERT OR IGNORE INTO verified_session(slot, fingerprint) VALUES(1, ?)",
                    new Object[]{fingerprint});
            db.execSQL("UPDATE verified_session SET fingerprint=?, user_id=NULL WHERE fingerprint<>?",
                    new Object[]{fingerprint, fingerprint});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    String offlineUser(String fingerprint) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT user_id FROM verified_session WHERE fingerprint=?",
                new String[]{fingerprint})) {
            return c.moveToFirst() ? c.getString(0) : null;
        }
    }

    void rememberUser(String fingerprint, String userId) {
        getWritableDatabase().execSQL("UPDATE verified_session SET user_id=? WHERE fingerprint=?",
                new Object[]{userId, fingerprint});
    }

    void forgetUser(String fingerprint) {
        getWritableDatabase().delete("verified_session", "fingerprint=?", new String[]{fingerprint});
    }

    // Unverified captures stay with the session that received them, even while offline.
    // The database never stores a usable credential. Account access also requires a verified pairing.
    static String provisionalScope(String cookie) {
        if (cookie == null) return GUEST;
        String token = null;
        for (String part : cookie.split(";")) {
            String value = part.trim();
            if (!value.startsWith("spark_session=")) continue;
            if (token != null || value.equals("spark_session=")) return GUEST;
            token = value;
        }
        if (token == null) return GUEST;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
            return "pending:" + Base64.encodeToString(digest, Base64.NO_WRAP);
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    static final class Draft {
        final String id, scope, text, purpose, requestId;
        final boolean excluded;
        final long revision;

        Draft(String id, String scope, String text, String purpose, boolean excluded,
              String requestId, long revision) {
            this.id = id;
            this.scope = scope;
            this.text = text;
            this.purpose = purpose;
            this.excluded = excluded;
            this.requestId = requestId;
            this.revision = revision;
        }

        boolean frozen() { return requestId != null; }
    }

    static final class Summary {
        final String id, label;
        Summary(String id, String label) { this.id = id; this.label = label; }
    }

    void create(String id, String scope, String text) {
        ContentValues v = values(scope, text, "", false, null, 0);
        v.put("id", id);
        if (read(id, scope, scope) != null) return;
        getWritableDatabase().insertOrThrow("draft", null, v);
    }

    Draft read(String id, String scope, String provisional) {
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT scope, body, purpose, excluded, request_id, revision FROM draft"
                + " WHERE id=? AND scope IN (?,?)", new String[]{id, scope, provisional})) {
            if (!c.moveToFirst()) return null;
            return new Draft(id, c.getString(0), c.getString(1), c.getString(2),
                    c.getInt(3) != 0, c.getString(4), c.getLong(5));
        }
    }

    List<Summary> list(String scope, String provisional, int offset) {
        List<Summary> rows = new ArrayList<>();
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, substr(body,1,64), request_id FROM draft WHERE scope IN (?,?)"
                + " ORDER BY modified DESC, id LIMIT ? OFFSET ?", new String[]{scope, provisional,
                        String.valueOf(PAGE_SIZE + 1), String.valueOf(offset)})) {
            while (c.moveToNext()) {
                String preview = c.getString(1).trim();
                rows.add(new Summary(c.getString(0), (c.isNull(2) ? "" : "待确认 · ")
                        + (preview.isEmpty() ? "空白草稿" : preview)));
            }
        }
        return rows;
    }

    Draft update(Draft old, String scope, String text, String purpose, boolean excluded,
                 String requestId) throws IOException {
        if (old.frozen() && (!scope.equals(old.scope) || !text.equals(old.text)
                || !purpose.equals(old.purpose) || excluded != old.excluded)) {
            throw new IllegalStateException("Frozen share payload");
        }
        if (scope.equals(old.scope) && text.equals(old.text) && purpose.equals(old.purpose)
                && excluded == old.excluded && java.util.Objects.equals(requestId, old.requestId)) {
            return old;
        }
        long revision = old.revision + 1;
        int count = getWritableDatabase().update("draft",
                values(scope, text, purpose, excluded, requestId, revision),
                "id=? AND revision=?", key(old));
        if (count != 1) throw new Changed();
        return new Draft(old.id, scope, text, purpose, excluded, requestId, revision);
    }

    void remove(Draft draft) throws IOException {
        if (getWritableDatabase().delete("draft", "id=? AND revision=?", key(draft)) != 1) {
            throw new Changed();
        }
    }

    static final class Changed extends IOException { }

    private static String[] key(Draft d) { return new String[]{d.id, String.valueOf(d.revision)}; }

    private static ContentValues values(String scope, String text, String purpose, boolean excluded,
                                        String requestId, long revision) {
        ContentValues v = new ContentValues();
        v.put("scope", scope);
        v.put("body", text);
        v.put("purpose", purpose);
        v.put("excluded", excluded);
        v.put("request_id", requestId);
        v.put("revision", revision);
        v.put("modified", System.currentTimeMillis());
        return v;
    }
}
