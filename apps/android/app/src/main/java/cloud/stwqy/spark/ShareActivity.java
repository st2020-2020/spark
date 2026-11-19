package cloud.stwqy.spark;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.database.sqlite.SQLiteException;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.widget.Button;
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
    private static final int LOGIN_REQUEST = 1;
    private static final ExecutorService DISK = Executors.newSingleThreadExecutor();
    private static final ExecutorService NETWORK = Executors.newFixedThreadPool(2);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable autosave = this::autosaveEdits;
    private ShareDrafts store;
    private SharePage page;
    private String id, newText, initialScope, loginFromScope, inputError;
    private String cookie, scope, provisional, authMessage, notice;
    private boolean authenticated, needsLogin, active, dirty, openedFromList, reloadAfterLogin, creatingDraft;
    private int generation, offset;
    private Editor editor;
    private EditText body, purpose;
    private CheckBox excluded;
    private Button retryLocal;
    private Bundle editorPosition;

    // Queued writes chain revisions on DISK, even if rotation destroys the old UI.
    private static final class Editor {
        volatile ShareDrafts.Draft stored;
        int writeSequence;
        boolean writing, conflict, submitting;
        Runnable afterWrite;
        Editor(ShareDrafts.Draft draft) { stored = draft; }
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        store = ShareDrafts.open(this);
        if (state == null) {
            receive(getIntent());
        } else {
            id = state.getString("draft");
            initialScope = state.getString("initialScope");
            loginFromScope = state.getString("loginFrom");
            inputError = state.getString("error");
            notice = state.getString("notice");
            openedFromList = state.getBoolean("openedFromList");
            offset = state.getInt("offset");
            editorPosition = state.getBundle("editorPosition");
            if (state.getBoolean("creating")) {
                if (state.getBoolean("blank")) newText = "";
                else if (Intent.ACTION_SEND.equals(getIntent().getAction())) readSharedText(getIntent());
            }
        }
    }

    @Override public void onBackPressed() {
        if (creatingDraft) {
            page.status.setText("正在将分享内容存入本机…");
            return;
        }
        if (newText != null) {
            new AlertDialog.Builder(this).setMessage("内容尚未存入本机。要退出这次分享吗？")
                    .setNegativeButton("继续编辑", null)
                    .setPositiveButton("退出", (dialog, which) -> finish()).show();
            return;
        }
        persistThen(openedFromList ? this::openList : this::finish);
    }

    private void receive(Intent launch) {
        String action = launch.getAction();
        if (action == null || Intent.ACTION_MAIN.equals(action)) return; // Never inspect manual extras.
        readSharedText(launch);
        if (newText != null) {
            id = UUID.randomUUID().toString();
            initialScope = ShareDrafts.provisionalScope(currentCookie());
        }
    }

    private void readSharedText(Intent launch) {
        try {
            newText = SharedText.read(launch);
        } catch (SharedText.InvalidShare e) {
            inputError = e.getMessage();
        }
    }

    @Override protected void onNewIntent(Intent launch) {
        super.onNewIntent(launch);
        // Even if the sender asks to reuse the top activity, keep its share
        // independent of the current draft and any outstanding local write.
        Intent separate = new Intent(this, ShareActivity.class)
                .setAction(launch.getAction()).setType(launch.getType());
        if (Intent.ACTION_SEND.equals(launch.getAction())) {
            try {
                separate.putExtra(Intent.EXTRA_TEXT, SharedText.read(launch));
            } catch (SharedText.InvalidShare invalid) {
                separate.setType("text/plain"); // Render the ordinary invalid-share state.
            }
        }
        startActivity(separate);
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("draft", id);
        out.putBoolean("creating", newText != null);
        out.putBoolean("blank", "".equals(newText));
        out.putString("initialScope", initialScope);
        out.putString("loginFrom", loginFromScope);
        out.putString("error", inputError);
        out.putString("notice", notice);
        out.putBoolean("openedFromList", openedFromList);
        out.putInt("offset", offset);
        rememberEditorPosition();
        out.putBundle("editorPosition", editorPosition);
    }

    @Override protected void onResume() {
        super.onResume();
        active = true;
        if (page == null || reloadAfterLogin || !Objects.equals(cookie, currentCookie())) {
            reloadAfterLogin = false;
            refresh();
        } else {
            page.root.setVisibility(View.VISIBLE);
            if (editor != null && !editor.submitting) restoreEditorPosition(editor.stored);
        }
    }

    @Override protected void onPause() {
        active = false;
        rememberEditorPosition();
        flushEdits();
        page.root.setVisibility(View.INVISIBLE);
        super.onPause();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == LOGIN_REQUEST) {
            reloadAfterLogin = result == RESULT_OK;
            if (!reloadAfterLogin) loginFromScope = null;
        }
    }

    private static String currentCookie() {
        return CookieManager.getInstance().getCookie(WebNavigation.ORIGIN);
    }

    private void screen(String title, String message) {
        main.removeCallbacks(autosave);
        editor = null;
        dirty = false;
        body = purpose = null;
        excluded = null;
        retryLocal = null;
        page = new SharePage(this, title);
        page.status.setText(message);
        if (!active) page.root.setVisibility(View.INVISIBLE);
        setContentView(page.root);
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
        if (generation != token || isFinishing() || isDestroyed()) return false;
        if (Objects.equals(cookie, currentCookie())) return true;
        flushEdits();
        if (active) refresh();
        return false;
    }

    private void refresh() {
        rememberEditorPosition();
        generation++;
        cookie = currentCookie();
        provisional = ShareDrafts.provisionalScope(cookie);
        authenticated = false;
        needsLogin = false;
        scope = provisional;
        authMessage = "";
        screen("本机草稿", "正在读取…");
        String fingerprint = provisional, draftId = id, captureScope = initialScope, text = newText;
        creatingDraft = text != null;
        run(DISK, () -> {
            store.observeSession(fingerprint);
            if (text != null) store.create(draftId, captureScope, text);
            return true;
        }, ok -> {
            creatingDraft = false;
            newText = null;
            if (inputError != null) {
                page.status.setText(inputError);
                page.button("查看本机草稿", () -> { inputError = null; refresh(); });
            } else {
                verify();
            }
        }, error -> {
            creatingDraft = false;
            storageFailure(error);
        });
    }

    private void verify() {
        if (provisional.equals(ShareDrafts.GUEST)) {
            needsLogin = true;
            authMessage = "未登录草稿保存在本机。登录后可保存到收件箱。";
            load();
            return;
        }
        String snapshot = cookie, fingerprint = provisional;
        ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        Network network = connectivity.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : connectivity.getNetworkCapabilities(network);
        if (capabilities == null || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            loadOffline(fingerprint);
            return;
        }
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
            loadOffline(fingerprint);
        });
    }

    private void loadOffline(String fingerprint) {
        run(DISK, () -> store.offlineUser(fingerprint), user -> {
            if (user != null) scope = "user:" + user;
            authMessage = "当前可以编辑本机草稿。恢复联网后，重新检查网络和账号即可保存。";
            load();
        }, this::storageFailure);
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
        if (rows.isEmpty() && start > 0) {
            offset -= ShareDrafts.PAGE_SIZE;
            list();
            return;
        }
        screen("本机草稿", notice != null ? notice : authMessage);
        notice = null;
        page.primaryButton("记一条", () -> {
            id = UUID.randomUUID().toString();
            initialScope = scope;
            newText = "";
            openedFromList = true;
            refresh();
        });
        if (rows.isEmpty()) page.label("此处暂无草稿", 16);
        for (int i = 0; i < Math.min(rows.size(), ShareDrafts.PAGE_SIZE); i++) {
            ShareDrafts.Summary row = rows.get(i);
            page.draftRow(row.label, () -> {
                if (!current(generation)) return;
                id = row.id;
                openedFromList = true;
                screen("本机草稿", "正在读取…");
                load();
            });
        }
        if (start > 0) page.button("上一页", () -> { offset -= ShareDrafts.PAGE_SIZE; refresh(); });
        if (rows.size() > ShareDrafts.PAGE_SIZE) {
            page.button("下一页", () -> { offset += ShareDrafts.PAGE_SIZE; refresh(); });
        }
        if (!authenticated) accountActions();
    }

    private void openList() {
        id = loginFromScope = null;
        editorPosition = null;
        openedFromList = false;
        hideKeyboard();
        refresh();
    }

    private void edit(ShareDrafts.Draft draft) {
        screen("收藏到 Spark", notice != null ? notice : authenticated && draft.frozen()
                ? "上次保存结果待确认，可用原内容重试。" : authMessage);
        notice = null;
        editor = new Editor(draft);
        body = page.field("文字或网址", draft.text, draft.frozen(), 3);
        purpose = page.field("补一句用途（可选）", draft.purpose, draft.frozen(), 2);
        excluded = page.aiExclusion(draft.excluded, draft.frozen());
        page.placeEditorStatus();
        retryLocal = page.button("重试保存本机草稿", this::flushEdits);
        retryLocal.setVisibility(View.GONE);
        TextWatcher watcher = new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { }
            public void afterTextChanged(Editable s) { changed(); }
        };
        body.addTextChangedListener(watcher);
        purpose.addTextChangedListener(watcher);
        excluded.setOnCheckedChangeListener((button, checked) -> changed());
        if (authenticated) page.primaryButton(draft.frozen() ? "重试保存到收件箱" : "保存到收件箱",
                () -> persistThen(this::save));
        else accountActions();
        page.button("本机草稿", () -> persistThen(this::openList));
        page.button("删除本机草稿", () -> persistThen(this::confirmDelete));
        restoreEditorPosition(draft);
    }

    private void accountActions() {
        if (needsLogin || authenticated) page.primaryButton("打开 Spark 登录或切换账号", () -> {
            // Bound drafts always require their original account, including after login.
            persistThen(() -> {
                if (!current(generation)) return;
                loginFromScope = editor != null && !editor.stored.scope.startsWith("user:")
                        ? editor.stored.scope : null;
                rememberEditorPosition();
                hideKeyboard();
                startActivityForResult(new Intent(this, WebActivity.class), LOGIN_REQUEST);
            });
        });
        page.button("重新检查网络和账号", () -> persistThen(this::refresh));
    }

    private void changed() {
        dirty = true;
        main.removeCallbacks(autosave);
        main.postDelayed(autosave, 300);
    }

    private void autosaveEdits() {
        if (editor == null || !dirty) return;
        if (BaseInputConnection.getComposingSpanStart(body.getText()) >= 0
                || BaseInputConnection.getComposingSpanStart(purpose.getText()) >= 0) {
            main.postDelayed(autosave, 300);
            return;
        }
        flushEdits();
    }

    private void flushEdits() { persistThen(null); }

    private void persistThen(Runnable next) {
        main.removeCallbacks(autosave);
        Editor target = editor;
        if (target != null && (target.submitting || (next != null && target.afterWrite != null))) return;
        if (target == null || (!dirty && !target.writing)) {
            if (next != null) next.run();
            return;
        }
        if (next != null) {
            target.afterWrite = next;
            rememberEditorPosition();
            page.setBusy(true);
        }
        if (!dirty) return;
        String text = body.getText().toString();
        String note = purpose.getText().toString();
        boolean skip = excluded.isChecked();
        dirty = false;
        target.writing = true;
        int sequence = ++target.writeSequence;
        retryLocal.setVisibility(View.GONE);
        DISK.execute(() -> {
            try {
                ShareDrafts.Draft previous = target.stored;
                target.stored = store.update(previous, previous.scope, text, note, skip, null);
                main.post(() -> draftWritten(target, sequence));
            } catch (IOException | SQLiteException error) {
                main.post(() -> draftWriteFailed(target, sequence, error));
            }
        });
    }

    private void draftWritten(Editor target, int sequence) {
        if (editor != target || target.writeSequence != sequence || isDestroyed()) return;
        target.writing = false;
        Runnable next = target.afterWrite;
        target.afterWrite = null;
        if (dirty && next != null) {
            persistThen(next);
            return;
        }
        page.setBusy(false);
        if (!dirty) page.status.setText("已保存本机草稿");
        if (active && next != null) next.run();
    }

    private void draftWriteFailed(Editor target, int sequence, Exception error) {
        if (editor != target || target.writeSequence != sequence || isDestroyed()) return;
        target.writing = false;
        target.afterWrite = null;
        dirty = true;
        page.setBusy(false);
        if (error instanceof ShareDrafts.Changed) {
            page.status.setText("其他窗口已更改这条草稿。可先复制当前输入，再重新打开。");
            if (!target.conflict) page.button("重新打开草稿", () ->
                    new AlertDialog.Builder(this).setMessage("重新打开会舍弃本窗口未写入的修改。")
                            .setNegativeButton("取消", null)
                            .setPositiveButton("重新打开", (dialog, which) -> refresh()).show());
            target.conflict = true;
        } else {
            page.status.setText("本机草稿写入失败，请检查剩余空间并重试。");
            retryLocal.setVisibility(View.VISIBLE);
        }
    }

    private void confirmDelete() {
        if (!current(generation) || editor == null) return;
        ShareDrafts.Draft draft = editor.stored;
        new AlertDialog.Builder(this).setMessage(draft.frozen()
                ? "删除本机草稿？如果上次已保存到收件箱，那条收藏将保留。" : "删除这条本机草稿？")
                .setNegativeButton("取消", null).setPositiveButton("删除", (dialog, which) -> {
                    if (!current(generation) || editor == null || editor.stored != draft) return;
                    screen("本机草稿", "正在删除…");
                    run(DISK, () -> { store.remove(draft); return true; },
                            ok -> openList(), this::storageFailure);
                }).show();
    }

    private void save() {
        if (!current(generation)) return;
        Editor target = editor;
        if (target == null || target.submitting || !authenticated) return;
        rememberEditorPosition();
        hideKeyboard();
        target.submitting = true;
        page.setBusy(true);
        page.status.setText("正在保存到收件箱…");
        submit(cookie, scope, target.stored);
    }

    private static final class InvalidContent extends IOException { }

    private void submit(String snapshot, String owner, ShareDrafts.Draft draft) {
        run(NETWORK, () -> {
            String uuid = draft.frozen() ? draft.requestId : UUID.randomUUID().toString();
            byte[] payload;
            try {
                payload = CollectionPayload.encode(uuid, draft.text, draft.purpose, draft.excluded);
            } catch (IOException e) {
                throw new InvalidContent();
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
                SparkApi.save(snapshot, session[1], frozen.requestId, payload);
            } catch (SparkApi.HttpError e) {
                if (isAuthError(e)) store.forgetUser(fingerprint);
                if (!draft.frozen() && (e.status == 400 || e.status == 413 || e.status == 422)) {
                    store.update(frozen, owner, frozen.text, frozen.purpose, frozen.excluded, null);
                }
                throw e;
            }
            store.remove(frozen);
            return true;
        }, ok -> {
            if (openedFromList) {
                notice = "已保存到收件箱";
                openList();
            } else {
                Toast.makeText(this, "已保存到收件箱", Toast.LENGTH_SHORT).show();
                finish();
            }
        }, e -> {
            if (e instanceof InvalidContent) {
                editor.submitting = false;
                page.setBusy(false);
                page.status.setText("请检查文字或网址。正文与用途合计最多 50,000 字，过长内容请分段收藏。");
                if (!draft.frozen() && !CollectionPayload.hasNonWhitespace(draft.text)) {
                    body.setError("请输入文字或网址");
                    body.requestFocus();
                }
            } else if (isAuthError(e) || e instanceof AccountChanged) {
                notice = "请验证原账号后重试。";
                refresh();
            } else if (e instanceof SQLiteException || e instanceof ShareDrafts.Changed) {
                storageFailure(e);
            } else {
                notice = e instanceof SparkApi.HttpError && !retryable((SparkApi.HttpError) e)
                        ? "服务端未接受保存，请检查草稿或查看收件箱。"
                        : "未能确认保存，本机草稿已保留。请稍后重试。";
                // A transport failure may have happened after the server committed.
                // Read back the frozen draft before allowing editing or another attempt.
                load();
            }
        });
    }

    private void hideKeyboard() {
        if (page == null) return;
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(page.root.getWindowToken(), 0);
    }

    private void rememberEditorPosition() {
        if (editor == null || !editor.stored.id.equals(id)) return;
        EditText focused = body.hasFocus() ? body : purpose.hasFocus() ? purpose : null;
        if (focused == null && editorPosition != null && id.equals(editorPosition.getString("draft"))) return;
        Bundle position = new Bundle();
        position.putString("draft", id);
        position.putInt("scroll", page.root.getScrollY());
        if (focused != null) {
            position.putBoolean("body", focused == body);
            position.putInt("start", focused.getSelectionStart());
            position.putInt("end", focused.getSelectionEnd());
        }
        editorPosition = position;
    }

    private void restoreEditorPosition(ShareDrafts.Draft draft) {
        Bundle position = editorPosition;
        editorPosition = null;
        if (position == null || !draft.id.equals(position.getString("draft"))) return;
        if (position.containsKey("start") && !draft.frozen()) {
            EditText selected = position.getBoolean("body") ? body : purpose;
            int length = selected.length();
            selected.requestFocus();
            selected.setSelection(Math.max(0, Math.min(length, position.getInt("start"))),
                    Math.max(0, Math.min(length, position.getInt("end"))));
        }
        SharePage restored = page;
        restored.root.post(() -> restored.root.scrollTo(0, position.getInt("scroll")));
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
