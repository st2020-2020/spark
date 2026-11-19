package cloud.stwqy.spark;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.Intent;
import android.database.sqlite.SQLiteException;
import android.os.BadParcelableException;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.Toast;
import java.io.IOException;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class ShareActivity extends Activity {
    private static final ExecutorService DISK = Executors.newSingleThreadExecutor();
    private static final ExecutorService NETWORK = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable autosave = this::flushEdits;
    private ShareDrafts store;
    private SharePage page;
    private String id, newText, initialScope, loginFromScope, inputError;
    private String cookie, scope, provisional, authMessage, notice;
    private boolean authenticated, needsLogin, active, dirty;
    private int generation, offset;
    private Editor editor;
    private EditText body, purpose;
    private CheckBox excluded;

    // All access to stored is serialized on DISK, including edits queued just before a pause.
    private static final class Editor {
        ShareDrafts.Draft stored;
        final boolean frozen;
        boolean leaving, conflict;
        Editor(ShareDrafts.Draft draft) { stored = draft; frozen = draft.frozen(); }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        store = ShareDrafts.open(this);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::leave);
        }
        if (state == null) {
            receive(getIntent());
        } else {
            id = state.getString("draft");
            initialScope = state.getString("initialScope");
            loginFromScope = state.getString("loginFrom");
            inputError = state.getString("error");
            if (state.getBoolean("creating")) {
                if (state.getBoolean("blank")) newText = "";
                else if (Intent.ACTION_SEND.equals(getIntent().getAction())) readSharedText(getIntent());
            }
        }
    }

    @Override public void onBackPressed() { leave(); }

    private void leave() { persistThen(this::finish); }

    private void receive(Intent launch) {
        String action = launch.getAction();
        if (action == null || Intent.ACTION_MAIN.equals(action)) return; // Never inspect manual extras.
        if (!Intent.ACTION_SEND.equals(action) || !"text/plain".equalsIgnoreCase(launch.getType())) {
            inputError = "此分享入口支持纯文字或网址。";
            return;
        }
        readSharedText(launch);
        if (newText != null) {
            id = UUID.randomUUID().toString();
            initialScope = ShareDrafts.provisionalScope(currentCookie());
        }
    }

    private void readSharedText(Intent launch) {
        try {
            CharSequence shared = launch.getCharSequenceExtra(Intent.EXTRA_TEXT);
            ClipData clip = launch.getClipData();
            if (shared == null && clip != null && clip.getItemCount() == 1) {
                shared = clip.getItemAt(0).getText();
            }
            if (shared == null || shared.length() == 0 || shared.length() > 100000) {
                inputError = "未收到可保存的文字，或分享内容过长。";
            } else {
                newText = shared.toString(); // Drop sender-supplied spans.
            }
        } catch (BadParcelableException | ClassCastException e) {
            inputError = "无法读取分享内容，请重新分享纯文字。";
        }
    }

    @Override protected void onNewIntent(Intent launch) {
        super.onNewIntent(launch);
        flushEdits();
        setIntent(launch);
        id = newText = initialScope = loginFromScope = inputError = notice = null;
        offset = 0;
        receive(launch);
        if (active) refresh();
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("draft", id);
        out.putBoolean("creating", newText != null);
        out.putBoolean("blank", "".equals(newText));
        out.putString("initialScope", initialScope);
        out.putString("loginFrom", loginFromScope);
        out.putString("error", inputError);
    }

    @Override protected void onResume() {
        super.onResume();
        active = true;
        refresh();
    }

    @Override protected void onPause() {
        flushEdits();
        active = false;
        generation++;
        screen("本机草稿", "");
        super.onPause();
    }

    private static String currentCookie() {
        return CookieManager.getInstance().getCookie(SparkApi.ORIGIN);
    }

    private void screen(String title, String message) {
        main.removeCallbacks(autosave);
        editor = null;
        dirty = false;
        body = purpose = null;
        excluded = null;
        page = new SharePage(this, title);
        page.status.setText(message);
    }

    private interface Work<T> { T run() throws IOException; }

    private <T> void run(ExecutorService queue, Work<T> work, Consumer<T> done,
                         Consumer<Exception> failed) {
        int token = generation;
        queue.execute(() -> {
            try {
                T result = work.run();
                main.post(() -> { if (current(token)) done.accept(result); });
            } catch (IOException | SQLiteException e) {
                main.post(() -> { if (current(token)) failed.accept(e); });
            }
        });
    }

    private boolean current(int token) {
        if (!active || generation != token || isFinishing()) return false;
        if (Objects.equals(cookie, currentCookie())) return true;
        flushEdits();
        refresh();
        return false;
    }

    private void refresh() {
        generation++;
        cookie = currentCookie();
        provisional = ShareDrafts.provisionalScope(cookie);
        authenticated = false;
        needsLogin = false;
        scope = provisional;
        authMessage = "";
        screen("本机草稿", "正在读取…");
        String fingerprint = provisional, draftId = id, captureScope = initialScope, text = newText;
        run(DISK, () -> {
            store.observeSession(fingerprint);
            if (text != null) store.create(draftId, captureScope, text);
            return true;
        }, ok -> {
            newText = null;
            if (inputError != null) {
                page.status.setText(inputError);
                page.button("查看本机草稿", () -> { inputError = null; refresh(); });
            } else {
                verify();
            }
        }, this::storageFailure);
    }

    private void verify() {
        if (provisional.equals(ShareDrafts.GUEST)) {
            needsLogin = true;
            authMessage = "未登录草稿保存在本机。登录后可保存到收件箱。";
            load();
            return;
        }
        String snapshot = cookie, fingerprint = provisional;
        run(NETWORK, () -> verifiedSession(snapshot, fingerprint), session -> {
            scope = "user:" + session[0];
            authenticated = true;
            load();
        }, e -> {
            if (e instanceof SQLiteException) { storageFailure(e); return; }
            needsLogin = isAuthError(e);
            if (needsLogin) {
                authMessage = "请重新登录后保存。";
                load();
                return;
            }
            run(DISK, () -> store.offlineUser(fingerprint), user -> {
                if (user != null) scope = "user:" + user;
                authMessage = "当前仅可编辑本机草稿，联网验证后可保存到收件箱。";
                load();
            }, this::storageFailure);
        });
    }

    private String[] verifiedSession(String snapshot, String fingerprint) throws IOException {
        try {
            String[] session = SparkApi.session(snapshot);
            store.rememberUser(fingerprint, session[0]);
            return session;
        } catch (SparkApi.HttpError e) {
            if (isAuthError(e)) store.forgetUser(fingerprint);
            throw e;
        }
    }

    private static boolean isAuthError(Exception e) {
        if (!(e instanceof SparkApi.HttpError)) return false;
        int status = ((SparkApi.HttpError) e).status;
        return status == 401 || status == 403;
    }

    private void load() {
        if (id == null) { list(); return; }
        String draftId = id, owner = scope, pending = provisional;
        // Only this particular unbound draft can follow an explicit login round trip.
        String handoff = authenticated ? loginFromScope : null;
        boolean bind = owner.startsWith("user:");
        run(DISK, () -> {
            ShareDrafts.Draft d = store.read(draftId, owner, pending);
            if (d == null && handoff != null && !handoff.startsWith("user:")) {
                d = store.read(draftId, handoff, handoff);
            }
            if (d != null && bind && !owner.equals(d.scope)) {
                d = store.update(d, owner, d.text, d.purpose, d.excluded, null);
            }
            return d;
        }, draft -> {
            if (draft == null) {
                screen("本机草稿", authMessage.isEmpty() ? "当前账号无法打开这条草稿，或草稿已移除。" : authMessage);
                accountActions();
                page.button("查看其他草稿", this::openList);
                return;
            }
            if (authenticated) loginFromScope = null;
            edit(draft);
        }, this::storageFailure);
    }

    private void list() {
        String owner = scope, pending = provisional;
        int start = offset;
        run(DISK, () -> store.list(owner, pending, start), rows -> showList(rows, start), this::storageFailure);
    }

    private void showList(List<ShareDrafts.Summary> rows, int start) {
        screen("本机草稿", notice != null ? notice : authMessage);
        notice = null;
        page.button("记一条", () -> {
            id = UUID.randomUUID().toString();
            initialScope = scope;
            newText = "";
            refresh();
        });
        if (rows.isEmpty()) page.label("此处暂无草稿", 16);
        for (int i = 0; i < Math.min(rows.size(), ShareDrafts.PAGE_SIZE); i++) {
            ShareDrafts.Summary row = rows.get(i);
            page.button(row.label, () -> { id = row.id; refresh(); });
        }
        if (start > 0) page.button("上一页", () -> { offset -= ShareDrafts.PAGE_SIZE; refresh(); });
        if (rows.size() > ShareDrafts.PAGE_SIZE) {
            page.button("下一页", () -> { offset += ShareDrafts.PAGE_SIZE; refresh(); });
        }
        if (!authenticated) accountActions();
    }

    private void openList() {
        id = loginFromScope = null;
        offset = 0;
        refresh();
    }

    private void edit(ShareDrafts.Draft draft) {
        screen("收藏到 Spark", notice != null ? notice : authenticated && draft.frozen()
                ? "上次保存结果待确认，可用原内容重试。" : authMessage);
        notice = null;
        editor = new Editor(draft);
        body = page.field("文字或网址", draft.text, draft.frozen(), 4);
        purpose = page.field("补一句用途（可选）", draft.purpose, draft.frozen(), 2);
        excluded = new CheckBox(this);
        excluded.setText("不参与 AI 整理");
        excluded.setChecked(draft.excluded);
        excluded.setEnabled(!draft.frozen());
        page.column.addView(excluded);
        TextWatcher watcher = new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { }
            public void afterTextChanged(Editable s) { changed(); }
        };
        body.addTextChangedListener(watcher);
        purpose.addTextChangedListener(watcher);
        excluded.setOnCheckedChangeListener((button, checked) -> changed());
        if (authenticated) page.button(draft.frozen() ? "重试保存" : "保存到收件箱", () -> persistThen(this::save));
        else accountActions();
        page.button("本机草稿", () -> persistThen(this::openList));
        page.button("删除本机草稿", () -> confirmDelete(draft));
    }

    private void accountActions() {
        if (needsLogin || authenticated) page.button("打开 Spark 登录或切换账号", () -> {
            // Bound drafts always require their original account, including after login.
            persistThen(() -> {
                loginFromScope = id != null && editor != null && !authenticated ? provisional : null;
                startActivity(new Intent(this, WebActivity.class));
            });
        });
        page.button("重新验证账号", () -> persistThen(this::refresh));
    }

    private void changed() {
        dirty = true;
        page.status.setText("正在保存本机草稿…");
        main.removeCallbacks(autosave);
        main.postDelayed(autosave, 300);
    }

    private void flushEdits() { persistThen(null); }

    private void persistThen(Runnable next) {
        main.removeCallbacks(autosave);
        Editor target = editor;
        if (target != null && target.leaving) return;
        if (target == null || target.frozen || (!dirty && next == null)) {
            if (next != null) next.run();
            return;
        }
        String text = body.getText().toString(), note = purpose.getText().toString();
        boolean skip = excluded.isChecked();
        dirty = false;
        if (next != null) {
            target.leaving = true;
            page.enableControls(false);
        }
        run(DISK, () -> {
            ShareDrafts.Draft d = target.stored;
            target.stored = store.update(d, d.scope, text, note, skip, null);
            return true;
        }, ok -> {
            if (editor != target || (target.leaving && next == null)) return;
            target.leaving = false;
            if (dirty) { if (next != null) persistThen(next); return; }
            page.enableControls(true);
            if (next != null) next.run();
            else page.status.setText("已保存本机草稿");
        }, e -> {
            if (editor != target || (target.leaving && next == null)) return;
            target.leaving = false;
            dirty = true;
            page.enableControls(true);
            if (e instanceof ShareDrafts.Changed) {
                page.status.setText("其他窗口已更改这条草稿。可先复制当前输入，再重新打开。");
                if (!target.conflict) page.button("重新打开草稿", this::refresh);
                target.conflict = true;
            } else page.status.setText("本机草稿写入失败，请检查剩余空间并重试。");
        });
    }

    private void confirmDelete(ShareDrafts.Draft draft) {
        new AlertDialog.Builder(this).setMessage(draft.frozen()
                ? "删除本机草稿？如果上次已保存到收件箱，那条收藏将保留。" : "删除这条本机草稿？")
                .setNegativeButton("取消", null).setPositiveButton("删除", (dialog, which) -> {
                    Editor target = editor;
                    if (target == null) return;
                    screen("本机草稿", "正在删除…");
                    run(DISK, () -> { store.remove(target.stored); return true; },
                            ok -> openList(), this::storageFailure);
                }).show();
    }

    private void save() {
        if (!current(generation)) return;
        Editor target = editor;
        if (target == null) return;
        String snapshot = cookie, owner = scope;
        screen("收藏到 Spark", "正在保存…");
        run(DISK, () -> target.stored, draft -> submit(snapshot, owner, draft), this::storageFailure);
    }

    private static final class InvalidContent extends IOException { }

    private void submit(String snapshot, String owner, ShareDrafts.Draft draft) {
        run(NETWORK, () -> {
            String uuid = draft.frozen() ? draft.requestId : UUID.randomUUID().toString();
            if (!draft.frozen()) {
                try {
                    CollectionPayload.encode(uuid, draft.text, draft.purpose, draft.excluded);
                } catch (IOException e) {
                    throw new InvalidContent();
                }
            }
            String fingerprint = ShareDrafts.provisionalScope(snapshot);
            String[] session = verifiedSession(snapshot, fingerprint);
            if (!owner.equals("user:" + session[0]) || !owner.equals(draft.scope)) {
                store.forgetUser(fingerprint);
                throw new AccountChanged();
            }
            ShareDrafts.Draft latest = store.read(draft.id, owner, owner);
            if (latest == null || latest.revision != draft.revision) throw new ShareDrafts.Changed();
            // Freeze only after authentication, immediately before the first possible POST.
            ShareDrafts.Draft frozen = store.update(draft, owner, draft.text, draft.purpose, draft.excluded, uuid);
            // Both requests use the very same immutable Cookie header, even if WebView switches users.
            try {
                SparkApi.save(snapshot, session[1], frozen.requestId, frozen.text, frozen.purpose, frozen.excluded);
            } catch (SparkApi.HttpError e) {
                if (isAuthError(e)) store.forgetUser(fingerprint);
                if (e.status == 400 || e.status == 413 || e.status == 422) {
                    store.update(frozen, owner, frozen.text, frozen.purpose, frozen.excluded, null);
                }
                throw e;
            }
            store.remove(frozen);
            return true;
        }, ok -> {
            Toast.makeText(this, "已保存到收件箱", Toast.LENGTH_SHORT).show();
            finish();
        }, e -> {
            if (e instanceof SQLiteException || e instanceof ShareDrafts.Changed) {
                storageFailure(e);
                return;
            }
            if (e instanceof InvalidContent) {
                notice = "请填写有效的文字或网址。正文与用途合计最多 50,000 字；过长内容请分段收藏。";
            } else if (isAuthError(e) || e instanceof AccountChanged) {
                notice = "请验证原账号后重试。";
            } else if (e instanceof SparkApi.HttpError && !retryable((SparkApi.HttpError) e)) {
                notice = "服务端未接受保存，请检查草稿或查看收件箱。";
            } else {
                notice = "未能确认保存，本机草稿已保留。请稍后重试。";
            }
            refresh();
        });
    }

    private static final class AccountChanged extends IOException { }

    private static boolean retryable(SparkApi.HttpError e) {
        return e.status == 408 || e.status == 409 || e.status == 429 || e.status >= 500;
    }

    private void storageFailure(Exception e) {
        screen("本机草稿", e instanceof ShareDrafts.Changed
                ? "这条草稿已在其他窗口更改，请重新打开。"
                : "无法读写本机草稿，请检查剩余空间并重试。");
        page.button("重试", this::refresh);
    }
}
