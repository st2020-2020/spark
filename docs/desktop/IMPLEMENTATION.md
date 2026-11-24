# Spark macOS 桌面端架构与开发实现手册

- **版本**：v0.8（`apps/desktop/` 完整开发交接蓝图）
- **更新日期**：2026-11-22
- **对接后端/Web 固定基线**：直登提交 `d2686d8f`，初版设备会话提交 `f979ac1e`（分支 `feat/v0.8.0-desktop-device-session`，基于 `v0.7.3` `e89a56c4`）
- **配套文档**：视觉规范见 [DESIGN.md](DESIGN.md)，交互契约见 [UX-CONTRACT.md](UX-CONTRACT.md)，总览见 [README.md](README.md)

本文面向从零接手的开发者或 AI Agent，提供可直接落地的目录结构、原生 AppKit/Carbon/Keychain 规格、后端接口与错误码契约、OSS 直传规则、SQLite DDL、离线发件箱状态机、进程内桥接 API 以及完整的测试与实机验收清单。

---

## 1. 技术栈与运行边界

| 层 | 选型与锁定版本 | 说明 |
| --- | --- | --- |
| 桌面宿主语言 | Go `1.27.3`（独立模块 `apps/desktop/go.mod`） | 与仓库后端一致；与根目录旧版 MyGo 模块完全隔离 |
| 窗口与 WebView 框架 | `github.com/wailsapp/wails/v3 v3.0.0` | 调用 macOS 系统原生 `WKWebView` 与 `NSStatusItem`，不打包 Chromium |
| macOS 原生能力 | `cgo` + Objective-C（`Cocoa` / `Carbon` / `WebKit` / `Security`） | 仅放薄胶水层在 `internal/native/` 与 `internal/auth/keychain_darwin.go`，最低目标 `macOS 13.0`（`-mmacosx-version-min=13.0`） |
| 本地持久化 | `modernc.org/sqlite v1.62.0`（WAL + `synchronous=FULL`）+ 原子文件落盘 | 纯 Go SQLite，存独立目录 `os.UserConfigDir()/SparkDesktop`（或 `SPARK_DESKTOP_DATA_DIR`） |
| 前端 UI | React `19` + TypeScript `5.7` + Vite `6` + `lucide-react` | 构建产物嵌入 Go 二进制（`//go:embed`）；复用 `apps/web/src/styles/tokens.css` 与 `contracts/document.schema.json` |
| 构建约束 | macOS arm64 / amd64，需 Xcode Command Line Tools (`clang`) | 若宿主默认 `GOMODCACHE` 只读，测试/构建须指定用户可写 `GOMODCACHE` |

### 绝对安全与工程红线（实现时不可违反）
1. **凭据边界**：本地 WKWebView 将邮箱和密码提交到进程内接口，Go 宿主仅发往固定第一方登录 API。密码不写入钥匙串、SQLite、偏好、日志、遥测或 URL。登录请求不附 Cookie、Bearer 或幂等键，也不跟随重定向。
2. **设备会话**：钥匙串会话保存签发服务的规范化地址。每次附加 Bearer 前核对当前服务。默认生产地址沿用既有钥匙串服务名，其他地址使用独立服务名。缺少签发地址的旧会话需要重新登录。WebView 只接收公开状态。
3. **固定 HTTPS API**：生产构建固定编译时 HTTPS 源（`-ldflags "-X spark/apps/desktop/internal/config.DefaultAPIBaseURL=https://..."`），不向用户暴露自由填写服务器地址输入框；仅在显式测试环境变量下允许 `http://127.0.0.1` / `http://localhost` 用于隔离联调。
4. **不绑本地 TCP 端口**：WebView 与 Go 宿主通信通过 Wails v3 进程内 `AssetHandler`（`/local/*`）完成，避免本机其他网页或进程访问本地接口。
5. **不碰旧版与真实数据**：根目录旧 MyGo 代码（`main.go`、`mygo.json`、`internal/`）暂保留；真实 `data/` 目录严禁读取、写入或迁移。

---

## 2. 按代码定位

| 从哪里开始 | 职责 |
| --- | --- |
| [main.go](../../apps/desktop/main.go) | 配置、单实例、组装 Host、注册原生窗口与菜单、关闭主窗口后的生命周期。后台同步与剪贴板计数监听从 Wails `ApplicationStarted` 启动；退出时关闭捕获入口、取消截屏并等待子进程回收，已接收的拖入和桥接写入完成后关闭 SQLite。 |
| [配置](../../apps/desktop/internal/config/config.go)、[打包](../../apps/desktop/Makefile) | 固定 API 源、临时回环模式、独立数据目录。打包资源位于 `packaging/Info.plist` 和 `packaging/tray.png`，标准包输出到 `build/Spark.app`。 |
| [配对](../../apps/desktop/internal/auth/pair.go)、[钥匙串](../../apps/desktop/internal/auth/keychain_darwin.go) | 旧配对结构用于既有协议兼容。启动时载入系统钥匙串，会话更新通过 `session.go` 持久化。 |
| [API](../../apps/desktop/internal/api/client.go)、[内容协议](../../apps/desktop/internal/api/document.go) | 独立 Spark 与对象存储 HTTP 客户端、固定路由、创建回执和过期处理、纯文本到文档、图片校验。 |
| [SQLite](../../apps/desktop/internal/store/db.go)、[发件箱](../../apps/desktop/internal/store/outbox.go)、[读缓存](../../apps/desktop/internal/store/cache.go) | 数据表、图片暂存与 fsync、账号隔离的队列与搜索。 |
| [同步引擎](../../apps/desktop/internal/syncer/engine.go) | 先完成图片三步上传及校验，再冻结创建请求。收到匹配的回执后缓存并标为已同步。 |
| [原生桥](../../apps/desktop/internal/native/macos_darwin.go)、[AppKit 实现](../../apps/desktop/internal/native/desktop_darwin.m) | 剪贴板、前台应用、截图、状态栏拖放及提示点。 |
| [本地接口](../../apps/desktop/internal/gui/server.go)、[前端请求封装](../../apps/desktop/frontend/src/bridge.ts) | Go 进程中使用 Wails AssetHandler 承接请求，UI 只获得公开会话信息。 |
| [随手记](../../apps/desktop/frontend/src/Panel.tsx)、[快搜](../../apps/desktop/frontend/src/Search.tsx)、[主窗口](../../apps/desktop/frontend/src/Book.tsx) | `main.tsx` 根据窗口入口挂载组件；`shared.tsx` 提供登录表单、工具按钮和预览；`desktop.css` 引用 Web 令牌。 |

## 3. 后端与 Web 对接契约

### 3.1 应用内登录与设备会话

宿主向 `POST /api/v1/desktop/login` 发送 JSON `{email,password}`。邮箱去除首尾空白，密码保持原样。成功返回 200 和 `{token,account_id,account_label,expires_at}`，无 Set-Cookie。宿主校验会话字段后写入钥匙串，唤醒当前账号队列并通知窗口。并发提交串行处理，过时表单不能覆盖已有活动会话。既有 v19 设备白名单、30 天期限及单台设备撤销语义继续生效。旧客户端仍可使用服务端配对端点。

| 登录响应 | 桌面行为 |
| --- | --- |
| 401 authentication_failed | 统一提示邮箱或密码不正确，避免区分账号存在性与禁用状态。 |
| 422 validation_failed | 提示检查两项输入的格式。 |
| 429 rate_limited | 提示稍后重试；有 Retry-After 时显示等待秒数。 |
| 404、405、501 或旧服务的 401 session_expired | 提示当前服务端尚未开放桌面登录。 |
| 连接失败 | 提示检查网络；保留原账号待同步队列。 |

### 3.2 首批桌面 Bearer 允许的业务白名单（精确 11 个）

后端 `desktopBusinessAllowed` 按 **HTTP 方法 + Gin 路由模板**严格放行下列 11 个接口（跳过 Cookie/Origin/CSRF，其余全部返回 `403 desktop_scope_forbidden`）：

| 类别 | 允许的方法与路径 | 关键请求/响应契约要点 |
| --- | --- | --- |
| 收藏创建 | `POST /api/v1/collections` | 必填 `Idempotency-Key`（16–128 字符）。JSON `additionalProperties: false`，**必填字段**：`id`（客户端 UUID）、`document`（`Document v1`）、`intent`（无内容也必须传 `""`，不可省略）、`upload_ids`（数组，无图传 `[]`）、`project_ids`（`[]`）、`tag_ids`（`[]`）。可选省略：`original_url`、`manual_title`、`ai_excluded`、`source_collection_id`。按普通收藏写入，不伪装 `extension`。成功 `201`（重放带 `Idempotent-Replayed: true`） |
| 收藏浏览 | `GET /api/v1/collections` | 支持 `scope=active`、`project_id`、`tag_id`、`cursor`、`limit`（默认 30，最大 100） |
| 收藏详情 | `GET /api/v1/collections/{id}` | 用于详情阅读、查看 AI 整理进展、以及超 7 天已发未知记录的按 ID 核对 |
| 项目与标签 | `GET /api/v1/projects`<br>`GET /api/v1/tags` | **注意**：`GET /api/v1/projects/{id}` 不在首批白名单中，项目信息统一从 `GET /projects` 缓存获取 |
| 搜索 | `GET /api/v1/search` | 支持 `q`、`project_id`、`tag_id`、`cursor`、`limit`；命中正文、标题、网页提取、OCR、画面描述与标签 |
| 上传三步 | `POST /api/v1/uploads`<br>`GET /api/v1/uploads/{id}`<br>`POST /api/v1/uploads/{id}/complete` | `POST /uploads` 必填 `Idempotency-Key` 与 `{filename, size_bytes, mime_type}`，返回 `201 UploadGrant{id, method:"PUT", url, headers, expires_at}`；`complete` 返回 `202 Upload{id, status, expires_at}`，轮询 `GET /uploads/{id}` 至 `status == "ready"` |
| 附件取回 | `GET /api/v1/attachments/{id}/download`<br>`GET /api/v1/attachments/{id}/thumbnail` | `download` 返回 `200 DownloadGrant{url, expires_at}`（5 分钟有效）；`thumbnail` 直接返回私有 JPEG 字节流 |

> **明确不在首批白名单的接口（严禁桌面端调用，调用会收到 `403 desktop_scope_forbidden`）**：
> - 所有 `/admin/*` 管理接口、`/desktop/grants`、`/extension/*`；
> - `GET /api/v1/organization/events`（SSE，此批不开放；需查看整理进展时对最近同步的收藏做温和的 `GET /api/v1/collections/{id}` 刷新）；
> - 收藏编辑/删除/恢复/清理/改归类、项目/标签写操作、偏好设置、导出与回访接口（主窗口统一提供「在网页版打开 ↗」跳转）。

### 3.3 `Document v1` 构造规则（对齐 `contracts/document.schema.json`）

- 顶层：`{"schema_version": 1, "content": {"type": "doc", "content": [...]}}`（`additionalProperties: false`）。
- 空白正文（例如纯图片收藏）：必须构造为单个空段落 `[{"type": "paragraph"}]`（不可带空的 `"content": []`）。
- 多行纯文本：按 `\n` 拆分为多个 `paragraph`；非空行含 `[{"type": "text", "text": "<行内容>"}]`，空行用 `{"type": "paragraph"}`。

### 3.4 OSS 直传硬性规范

执行对象存储上传（`api.Client.UploadObjectToOSS`）必须使用独立于 Spark API 的 `http.Client`：
1. **URL 校验**：仅接受 `https://`（隔离测试显式开启 loopback 时才允许 `http://127.0.0.1` / `localhost`），拒绝含 `userinfo` 的 URL。
2. **方法与请求头**：严格使用 `UploadGrant.Method`（`"PUT"`）与 `UploadGrant.Headers`（包含签名要求的 `Content-Type` MIME 等）；**严禁附带 Spark `Cookie`、Spark `Authorization: Bearer` 或伪造 `Origin`**。
3. **显式长度，禁用分块传输**：必须显式设置 `req.ContentLength = int64(len(rawBytes))`、`req.TransferEncoding = nil`，传入 `bytes.NewReader(rawBytes)`。
4. **禁止重定向**：`CheckRedirect` 必须返回 `http.ErrUseLastResponse`；收到 `3xx` 视为错误直接拒绝。

---

## 4. 本地存储与原子落盘设计（SQLite + 文件系统）

### 4.1 独立目录布局

- 数据根目录优先级：`SPARK_DESKTOP_DATA_DIR` > `os.UserConfigDir()/SparkDesktop`（macOS 为 `~/Library/Application Support/SparkDesktop`）。
- 当前服务的数据保存在根目录的 `origins/<规范化地址的 SHA-256>` 下。旧根目录没有服务标记，升级时原样保留旧数据库及暂存图片。
- 每个服务的文件结构：
  - `spark-desktop.sqlite`（WAL 模式，`synchronous=FULL`，`busy_timeout=5000`，`foreign_keys=ON`，`SetMaxOpenConns(1)`）
  - `staging/<account_id>/<collection_id>/<att_id>.bin`（目录权限 `0700`，文件权限 `0600`）

### 4.2 原子文件落盘流程（防断电/强杀损坏图片）

每张待同步附件落盘必须执行：
1. 在目标同级目录 `os.CreateTemp(dir, ".tmp-*")`；
2. `tmp.Chmod(0o600)` → 写入全部原始字节 → `tmp.Sync()` → `tmp.Close()`；
3. `os.Rename(tmpPath, finalPath)` 原子替换；
4. 打开父目录句柄执行 `dir.Sync()`；
5. 全部附件原子落盘成功后，再在单个 SQLite 事务中插入 `outbox_items` 与全部 `outbox_attachments` 并 `Commit()`；事务失败则立即清理本次新建的暂存文件。只有 `Commit()` 成功后，界面才提示「本机已收下」并收起面板。

### 4.3 完整 SQLite DDL（可直接执行）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS outbox_items (
    id TEXT PRIMARY KEY,                              -- 客户端 UUID，首次出站前冻结
    account_id TEXT NOT NULL,                         -- 严格账号隔离主键
    raw_text TEXT NOT NULL,
    intent TEXT NOT NULL DEFAULT '',
    original_url TEXT NOT NULL DEFAULT '',
    manual_title TEXT NOT NULL DEFAULT '',
    project_ids_json TEXT NOT NULL DEFAULT '[]',
    tag_ids_json TEXT NOT NULL DEFAULT '[]',
    idempotency_key TEXT NOT NULL,                    -- 首次出站前冻结，16-128 字符随机键
    frozen_request_json TEXT NOT NULL DEFAULT '',     -- 所有附件 ready 后、首次 POST 前冻结的精确请求体
    state TEXT NOT NULL CHECK(state IN ('local_saved', 'syncing', 'synced', 'needs_review', 'auth_paused')),
    ever_sent INTEGER NOT NULL DEFAULT 0,             -- 0=从未出站（跨7天仍可首发）；1=已发过
    first_sent_at TEXT NOT NULL DEFAULT '',           -- 首次出站 RFC3339 时间，用于 7 天回放窗判断
    last_attempt_at TEXT NOT NULL DEFAULT '',
    next_retry_at TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT NOT NULL DEFAULT '',
    last_error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_account_state ON outbox_items(account_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_attachments (
    id TEXT PRIMARY KEY,
    outbox_id TEXT NOT NULL REFERENCES outbox_items(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    local_path TEXT NOT NULL,                         -- 相对 staging/ 的路径
    upload_idempotency_key TEXT NOT NULL,             -- 同次上传登记复用补签；24h 到期轮换新键
    upload_id TEXT NOT NULL DEFAULT '',               -- 服务端签发的上传 UUID
    stage TEXT NOT NULL DEFAULT 'pending_local'
        CHECK(stage IN ('pending_local', 'grant_issued', 'uploaded_oss', 'verifying', 'ready', 'failed')),
    upload_registered_at TEXT NOT NULL DEFAULT '',
    upload_expires_at TEXT NOT NULL DEFAULT '',       -- 24 小时登记到期时间
    grant_url TEXT NOT NULL DEFAULT '',
    grant_method TEXT NOT NULL DEFAULT '',
    grant_headers_json TEXT NOT NULL DEFAULT '{}',
    grant_expires_at TEXT NOT NULL DEFAULT '',        -- 临时 PUT 签名到期时间
    last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_outbox_att_item ON outbox_attachments(outbox_id, ord ASC);

CREATE TABLE IF NOT EXISTS cached_collections (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    display_title TEXT NOT NULL DEFAULT '',
    plain_text TEXT NOT NULL DEFAULT '',
    intent TEXT NOT NULL DEFAULT '',
    original_url TEXT NOT NULL DEFAULT '',
    primary_type TEXT NOT NULL DEFAULT 'text',
    read_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    searchable_text TEXT NOT NULL DEFAULT '',         -- 小写聚合检索列（标题/正文/用途/网址/项目/标签/摘要）
    summary_json TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_cached_col_account_created ON cached_collections(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cached_projects (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'active',
    collection_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS cached_tags (
    account_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    collection_count INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS local_prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

PRAGMA user_version = 1;
```

---

## 5. 离线发件箱（Outbox）同步引擎状态机

`internal/syncer/engine.go` 在应用启动及后台周期（每 8 秒、写入后立即唤醒）执行 `SyncOnce`，每轮严格按以下步骤推进：

### 5.1 启动恢复与账号守卫
1. 启动时将当前账号遗留的 `syncing` 复位为 `local_saved`（恢复上次强杀/重启打断的任务）。
2. 每轮开始从宿主会话管理器读取当前活动 `StoredSession`；无会话则空转；若本地已过 `expires_at`，将当前账号 `local_saved/syncing` 批量置为 `auth_paused` 并停止。
3. 仅查询 `WHERE account_id = session.AccountID` 的到期任务；每处理下一条前再次核对会话管理器当前 `AccountID`，确保换号瞬间绝不串队。

### 5.2 附件三步上传子状态机（仅在 `frozen_request_json == ""` 时执行）

```text
pending_local ──(POST /uploads)──▶ grant_issued ──(OSS PUT)──▶ uploaded_oss
      ▲                                  │                          │
      │ (登记距 24h 到期 ≤15m 或 409     │ (PUT 403/400 签名过期     │ (POST /uploads/{id}/complete → 202)
      │  upload_not_pending 且未冻结:     │  且距24h >15m: 清 grant   ▼
      │  轮换新 upload_idempotency_key)  │  按原键补签)          verifying ──(GET /uploads/{id})──▶ ready
      └──────────────────────────────────┘                          │
                                                                    └─(rejected)──▶ failed → outbox needs_review
```

- **24 小时与 15 分钟停止补签规则**：服务端上传登记保留 24 小时，最后 15 分钟拒绝补签。客户端落盘 `upload_id`、`stage`、`upload_expires_at` 与 `grant_expires_at`；在距离 `upload_expires_at` 不足 15 分钟时，不再用原键补签，而是因为收藏尚未冻结，调用 `RotateExpiredAttachmentRegistration` 生成新的 `upload_idempotency_key` 重新登记。
- **`complete 202` 轮询**：提交 `complete` 后立刻将 `stage` 持久化为 `verifying`，按 2 秒间隔轮询 `GET /api/v1/uploads/{id}` 直到 `ready`（或 `attached`）。

### 5.3 冻结请求与 7 天幂等窗口决策树

1. **首次出站前冻结**：当条目所有附件均 `ready`（或无附件）且 `frozen_request_json == ""` 时，构造最终 `CollectionCreate` JSON 并持久化到 `frozen_request_json`。此后该条目的 `id`（UUID）、`idempotency_key` 与 `frozen_request_json` **永不修改**。
2. **从未发送过（`ever_sent == 0`）**：
   - 即使本机离线存放已超过 7 天，仍允许按冻结后的 UUID + 原键 + 原 JSON 执行首次 `POST /api/v1/collections`。
   - **发送前先落盘 `ever_sent = 1, first_sent_at = now`**（确保请求发出后进程崩溃仍能准确记录首次发送时刻）。
3. **曾经发过且结果未知（`ever_sent == 1`）**：
   - **7 天窗口内（`now - first_sent_at < 7d`）**：使用原冻结 `idempotency_key` 与 `frozen_request_json` 重放 `POST /api/v1/collections`。
   - **超过 7 天窗口（`now - first_sent_at >= 7d`）**：**禁止盲目重试或换新 ID**！必须先以同一账号调用 `GET /api/v1/collections/{id}` 核对：
     - 返回 `200`：确认云端已有该记录 → 写入读缓存并标记 `synced`（清理暂存文件）；
     - 返回 `404` / `409` / `403`：标记 `needs_review`，保留本地原稿与文件供用户核对；
     - 网络超时/5xx：保持 `local_saved` 退避重试核对，绝不换 ID。
4. **响应码处置表**：

| 服务端响应 | 同步引擎动作 |
| --- | --- |
| `201 Created`（含 `Idempotent-Replayed: true`） | 写入 `cached_collections` → 标记 `synced` → 删除 `staging/` 对应原图文件 |
| `401 desktop_session_expired` | **立即将当前账号全部 `local_saved/syncing` 置为 `auth_paused`**，中止本轮队列 |
| `409 operation_in_progress` | 按 `Retry-After`（默认 3s）退避重试 |
| `409 duplicate_resource` / 墓碑 / `idempotency_mismatch` | 标记 `needs_review`，保留原稿，**严禁换 ID、严禁覆盖、严禁复活** |
| `400` / `403` / `404` / `413` / `422` | 标记 `needs_review`，展示服务端脱敏说明，停止自动重试 |
| `429` / `503` / `5xx` / 网络中断 / 响应丢失 | 保留 `local_saved`，按 `Retry-After` 或指数退避（3s→6s→12s…上限 2m）重试 |

---

## 6. macOS 原生桥接实现规格（`internal/native/` & `keychain_darwin.go`）

所有 AppKit / UI 调用必须通过 `dispatch_async(dispatch_get_main_queue(), ...)` 或 Wails `application.InvokeSync` 在主线程执行。

| 能力 | 依赖框架与关键原生 API | 实现要点 |
| --- | --- | --- |
| 悬浮随手记面板 | `Cocoa` (`NSWindow` / `NSPanel`) | `win.level = NSFloatingWindowLevel`；`collectionBehavior = CanJoinAllSpaces \| FullScreenAuxiliary \| Transient`；`opaque = NO` + `backgroundColor = clearColor`；隐藏三个 `standardWindowButton`；呼出前记录 `[NSWorkspace sharedWorkspace].frontmostApplication`，收起时若原应用未退出则通过 AppKit 交还激活权并重新激活原应用 |
| 主窗口顶栏与生命周期 | Cocoa + WebKit | `MacTitleBarHiddenInset` 和 52pt 顶栏，Wails 负责系统交通灯与窗口销毁。在全屏关闭时先退出全屏，收到完成事件再关闭。重新打开时新建 WKWebView。缩放、Sheet 及内存实测属于系统验收项。 |
| Dock 显隐切换 | `Cocoa` (`NSApp`) | 主窗口打开 → `NSApplicationActivationPolicyRegular`；主窗口关闭 → `NSApplicationActivationPolicyAccessory`（配合 `Info.plist` `LSUIElement = true`） |
| 全局快捷键 | `Carbon` (`RegisterEventHotKey`) | `InstallApplicationEventHandler` 监听 `kEventHotKeyPressed`：ID 1 注册 `kVK_Space (0x31) + optionKey`（`⌥Space`），ID 2 注册 `kVK_ANSI_4 (0x15) + optionKey\|shiftKey`（`⌥⇧4`）；回调内切回 Go goroutine 触发窗口动作 |
| 剪贴板 20s 建议 | `Cocoa` (`NSPasteboard`) | 面板呼出前及轻量定时（如 1.5s）读取 `generalPasteboard.changeCount`；首次只记录基线；检测 `types` 含 `org.nspasteboard.ConcealedType` / `AutoGeneratedType` / `TransientType` / `com.agilebits.onepassword*` 时立即清零建议；优先读 PNG，其次 TIFF 转 PNG（≤ 5 MiB），否则读字符串/URL |
| 原生选区截屏 | `/usr/sbin/screencapture` | 创建临时目录，执行 `screencapture -i -x -t png <outPath>`；优先读取生成的 PNG 并校验魔数与 ≤ 5 MiB 限制。无文件且无诊断的正常退出或非零退出视为 `Esc` 取消。无图且有系统诊断时再请求录屏权限，进程无法启动、上下文中止或无效图片分别报错。退出时清理临时目录 |
| 菜单栏图标拖拽 | `Cocoa` (`NSDraggingDestination`) | 在 `NSStatusBarWindow` 的 `contentView` 上叠透明子视图，注册 `FileURL / URL / String / PNG / TIFF`；`hitTest:` 返回 `nil` 以把普通点击透传给原状态栏按钮；`draggingEntered:` 起 `0.4s NSTimer` 触发悬停展开面板；`performDragOperation:` 取消计时器并将文件/文本回调给 Go 直接入队 |
| 钥匙串凭据存储 | `Security.framework` | `SecItemAdd` / `SecItemCopyMatching` / `SecItemDelete`，默认生产服务名 `com.spark.desktop.session`，其他地址追加 `.origin.<规范化地址的 SHA-256>`，属性固定 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（不跨设备同步到 iCloud 钥匙串） |

---

## 7. Wails 宿主 ↔ 前端进程内接口契约（`/local/*`）

请求使用 `X-Spark-Desktop: 1`，账号数据接口还需发送本窗的 `X-Spark-Account`。账号切换后，旧窗的请求返回 409。设备 Bearer、verifier、签名上传 URL 均保留在宿主侧。下表路径以 `/local/` 为前缀。

| 方法与路径 | 约定 |
| --- | --- |
| `GET state` | 返回 `session`、分状态数量 `counts`、`origin`、`palette`、`mode`、两个快捷键值。 |
| `POST session/login`、`POST session/disconnect` | 登录输入为邮箱和密码。设备会话保存后返回 204，前端读取新的公开状态。断开时撤销设备会话并清钥匙串。 |
| `POST capture` | 输入 `raw_text, intent, original_url, suppress_url, manual_title, project_ids, tag_ids, attachments`。图片为 `{filename,data_b64}`。本机事务提交后即返回 `201 {item}`。 |
| `GET outbox`、`DELETE outbox/{id}` | 待同步或需核对的本机项。删除只允许当前账号明确确认的需核对项。 |
| `GET projects`、`GET tags` | 读取本机账号目录。登录、启动或呼出浮窗时在后台检查目录，成功后缓存 5 分钟，失败后 15 秒内复用本机结果。手动同步可立即刷新。 |
| `GET search/local?q=`、`GET search/remote?q=` | 先显示本机结果，云端搜索延迟 180 ms 发出。输入变化取消旧请求，按收藏 ID 去重。 |
| `GET collections?project_id=`、`GET collections/page` | 前者返回本机摘要数组，后者按项目、标签、cursor 读取在线页，回写本机摘要缓存。 |
| `GET collections/{id}` | 本机未同步记录返回 `{item}`；在线详情返回 `{collection}`；会话过期、`?local=1` 或可恢复网络错误时读取缓存，并带 `offline:true`。云端明确返回 404 或删除时间时移除该账号对应的云端缓存，保留本机发件箱原稿。 |
| `GET image/{id}` | 云端缩略图经 Go 中转；本机暂存图另传 `?outbox=<收藏ID>`。返回 `{mime,data}`，data 为 Base64。 |
| `GET clipboard`、`POST clipboard/dismiss` | 当前账号在可见面板查询最近 20 秒的内容，有效建议返回 `{available,change_count,text,image}`。接受、忽略或开始打字时提交 `{change_count}`，仅消隐对应建议。 |
| `POST clipboard/copy`、`POST clipboard/copy-image?id=` | 分别写入选中文字、收藏的第一张原图。文字写入成功返回 204，系统拒绝写入时返回 503。 |
| `POST sync/now` | 唤醒发件箱，刷新最近收藏、活跃项目及标签。成功返回 202。 |
| `PUT prefs`、`PUT shortcut` | 保存 `{palette,mode}` 或 `{key,value}`。快捷键注册成功后再替换原组合。 |
| `POST window/{action}` | `panel,hide,main,web,screenshot,settings,resize`。主窗口与网页可传 `?id=`；高度调整用 `?height=`；截屏通过本窗事件将图片带回原草稿。 |

## 8. 推荐分步开发顺序（供新接手 AI 按批次推进）

1. **批次 1（核心无界面闭环 + 全套单元测试）**：
   实现 `config` → `auth`（登录 + Keychain）→ `api`（严格白名单 + OSS PUT）→ `store`（SQLite DDL + 原子文件写）→ `syncer`（状态机）；使用 `httptest` 合成 Spark API + 合成 OSS 跑通全部单测与故障注入测试。
2. **批次 2（进程内 `/local/*` + React 前端双视图）**：
   搭建 `apps/desktop/frontend/`（复用 `tokens.css` 四套配色与深浅色），完成 `QuickCapturePanel`、`QuickSearchView`、`MainWindow`、`Login`，通过实际 WKWebView、前端 `typecheck / build` 和宿主测试校验。
3. **批次 3（Wails v3 宿主 + macOS 原生精修）**：
   接入 `internal/native/macos_darwin.go` 与 `main.go`（菜单栏、`NSPanel`、全局快捷键、剪贴板监听、原生截屏、菜单栏拖拽、主窗口交通灯与关闭释放 WebView），打包出可运行的 `Spark.app`。
4. **批次 4（隔离栈联合验收 + macOS 真机验收）**：
   对接隔离 OrbStack 的 `v0.8.0` 候选栈（`f979ac1e`）完成全链路联调与真机交互实测。

---

## 9. 验证与实机验收清单

### 9.1 已验证的在线底座能力（事实记录，依据 `f979ac1e`）
以下服务端与 Web 能力已在 `feat/v0.8.0-desktop-device-session` 隔离环境验证通过（尚未合并上线生产）：
- 迁移 `v18 → v19` 保留既有 Web 与扩展会话；
- 5 分钟单次配对批准与并发兑换、域分隔防串换、30 天绝对有效期、密码重置/禁用与单设备撤销；
- `POST /desktop/token` 拒绝携带 Cookie 或 Authorization；桌面 Bearer 混用 Cookie 返回 `400 mixed_credentials`，越权请求返回 `403 desktop_scope_forbidden`；
- 首批 11 个白名单路由、同键离线重放、合成 OSS 三步上传与本人缩略图/签名下载、跨账号隔离；
- Web `/desktop/pair` 页面片段解析、4+4 短码核对、设置页桌面设备展示与撤销。

### 9.2 原生端必须通过的自动化测试（实现后必跑）
- `auth_test.go`：`spark-desktop-pair-v1:` 域分隔结果与服务端逐字节一致、`PairURL` 不含 `verifier`、4+4 大小写敏感。
- `client_test.go`：API 客户端拒绝 `3xx` 重定向不泄漏 Bearer、绝不发送 Cookie；OSS PUT 显式 `Content-Length`、无 `Transfer-Encoding: chunked`、保留返回 MIME 头、无 Spark Cookie/Bearer/Origin、拒绝重定向；`CollectionCreate` 必填字段与 `Document v1` 严格匹配 Schema。
- `store_test.go`：原子文件写 + SQLite 事务落盘、重启后队列与原图完整恢复、双账号队列与本地搜索零串扰、同步完成后暂存文件自动清理。
- `engine_test.go`（合成 API + 合成 OSS）：
  1. 断网记录（文字+截图）→ 退出重启 → 恢复网络 → 模拟首次 `201` 响应丢失 → 同键重放 → 云端**恰好 1 条收藏、1 次 OSS PUT**；
  2. 离线从未发出的草稿存放 **> 7 天**后联网 → 首次发送成功；
  3. 已发出且结果未知的条目超过 **7 天** → 先 `GET /collections/{id}` 核对；查到转 `synced`，`404`/冲突转 `needs_review` 且**绝不换 ID / 不复活**；
  4. `409 duplicate_resource` → 转 `needs_review` 保留本地原稿；
  5. `401 desktop_session_expired` → 整队立刻停传置为 `auth_paused`；切换账号 B 后账号 A 队列绝不串发；
  6. 上传登记 24h 到期前 15 分钟停止补签并安全轮换新登记、`complete 202` 轮询 `ready`。
- `native_test.go`：剪贴板启动基线忽略、20 秒过期、`ConcealedType` / 密码管理器项目立刻清空过滤。
- 前端与构建：`npm run typecheck`、`npm run build`、`go vet ./...`、`go test -v ./...`、`make app-bundle` 生成 `.app` 产物。

### 9.3 macOS 真机复验场景

本轮实测结果、驱动方式和仍需物理设备验证的项目见 [候选运行与验证记录](README.md)。
1. **登录与钥匙串实机联调**：连接隔离 OrbStack v19 栈，在本地表单使用合成邮箱和密码登录，重启 `Spark.app` 验证从 macOS Keychain 自动恢复会话；在 Web 设置页撤销该设备后，验证桌面端立刻进入 `401` 暂停态且未发原稿完好。
2. **全屏与多 Space 焦点验收**：在全屏浏览器 / 全屏 IDE 中按 `⌥Space` 呼出悬浮面板（确认**不切换 Space**）→ 输入文字 + `⌘↵` → 确认面板消失且**键盘焦点精准回到原应用光标处**；在独立收件箱网页验证仅出现 1 条收藏。
3. **离线重启闭环实机验收**：断开本机网络 → `⌥Space` 粘贴文字与截图 → `⌘↵` 确认提示「本机已收下」→ 完全退出并重启 `Spark.app` → 恢复网络 → 验证图片经受控 OSS 三步上传并同步成功，云端仅 1 条且暂存文件已清理。
4. **四大收集交互真机手测**：
   - 复制链接/截图后 20 秒内呼出，验证 `Tab` 一键填入；从密码管理器复制密码后呼出，验证**绝不出现建议胶囊**；
   - `⌥⇧4` 选区截屏（验证录屏权限按需提示、Esc 取消无残留、截完自动带图弹回）；
   - 拖图片/链接到菜单栏小瓶子（直接松手静默直收 + 悬停 0.4 秒展开面板）；
   - 同面板 `⌘K` 快搜中文与 OCR 结果，`⌘C` 复制后 `Esc` 直接贴回文档。
5. **主窗口与常驻资源实机核对**：验证四套配色 × 深浅色、一体式 `52px` 顶栏与交通灯对齐（含窗口缩放与全屏切换）、关闭主窗口后退出 Dock 并释放 WebView 后的实际内存占用；记录所用 Xcode / Go / macOS 版本、系统权限项及打包签名状态。
