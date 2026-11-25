# Android v0.3 开发实现与交接规范

| 项 | 内容 |
| --- | --- |
| 版本 | Android `0.3.0`（`versionCode = 3`，覆盖升级自 `0.1.0` / `0.2.0`） |
| 状态 | Batch 1–4、审查修复与交互/文案/动效打磨均已完成并获独立复核 `APPROVE`（独立分支 `feat/android-v0.3-foundation`，待真机验收） |
| 上游架构设计 | [docs/design/MOBILE.md](../design/MOBILE.md)（v1.1，唯一架构事实来源） |
| 关联决策 | [D-0018](../DECISIONS.md#d-0018-移动端采用统一契约与双原生轻量工程)、[D-0019](../DECISIONS.md#d-0019-移动工作区只加载同源-get-主文档) |
| 关联契约与规范 | [AGENTS.md](../../AGENTS.md)、[CONTRIBUTING.md](../../CONTRIBUTING.md)、[OpenAPI](../../contracts/openapi.json)、[document.schema.json](../../contracts/document.schema.json)、[API.md](../design/API.md)、[WEB-VISUAL.md](../design/WEB-VISUAL.md)、[tokens.css](../../apps/web/src/styles/tokens.css) |
| 更新日期 | 2026-11-24 |

本文面向接手开发 `apps/android/` 重构与 `apps/web/` 极薄桥接适配的开发者或 AI Agent，提供可直接落地执行的工程结构、数据库迁移、协议细节、状态机边界、分批任务清单与验证标准。架构选型理由与 iOS 远期规划见 [MOBILE.md](../design/MOBILE.md)，本文不重复论述。

---

## 1. 接手前必读与硬性红线

### 1.1 开始前的准备工作

1. 通读 [AGENTS.md](../../AGENTS.md) 与 [docs/design/MOBILE.md](../design/MOBILE.md)。
2. 检查工作区：`git status`，确认基于最新 `main` 切出功能分支（如 `feat/android-v0.3-foundation`），严禁直接推送 `main`。
3. 检查远端参考分支 `origin/feat/android-mobile-shell`（提交 `e8f9b3b`、`df4abdc`），**只吸收其经过验证的思路**（`WebNavigation` 严格路由、`SharedText` 标题合并、`WebActivity.returnAfterLogin` 登录回跳、`DraftsShortcutActivity` 独立快捷方式入口、`shortcuts.xml`），不要直接把旧 Java 代码机械 merge 进来。
4. 确认本机或 CI 具备 **JDK 17** 与 **Android SDK Platform 35**。Windows / PowerShell 环境下提交信息须写入文件后使用 `git commit -F <文件>`，命令中避免依赖 `&&`。

### 1.2 七条不可违背的红线（Hard Invariants）

1. **严禁破坏账号隔离**：草稿与项目/标签本地缓存均绑定 `scope`（`guest` / `pending:<cookie_sha256>` / `user:<uuid>`）。数据库绝不存明文 Cookie 或密码；未登录草稿仅在显式登录往返后认领给新账号；已绑定草稿切换账号不可见、不可改。
2. **严禁跨号错写**：一次校验并提交（或上传图片）流程必须使用同一份不可变凭据快照；提交前核对服务端返回的 `user.id` 与草稿 `scope` 一致。
3. **严禁重复创建收藏或重复消耗上传配额**：发出首次 `POST /collections` 前冻结 `request_id`（同时作为客户端 UUID 与 `Idempotency-Key`）；图片每张持有独立 `upload_idempotency_key` 与 `bytes_transferred`，弱网重试沿用原键。
4. **严禁破坏老版本本机草稿**：`share-drafts.db` 从 v1 升级到 v2 必须走 SQLite 建新表拷贝迁移，**禁止** `fallbackToDestructiveMigration()`。
5. **严禁 `prod` 变体放行明文 HTTP 或宽泛桥接**：`prod` 强制 HTTPS、`allowBackup="false"`；桥接仅允许精确同源 `SparkApi.ORIGIN`，严禁暴露 `@JavascriptInterface` 给任意页面。
6. **严禁破坏旧版 `SparkAndroid/2` 与普通浏览器行为**：`apps/web/` 改动必须向后兼容 `SparkAndroid/2` 与普通浏览器，不引入平台特化分叉，不修改 `apps/web/src/api/schema.d.ts` 等生成文件。
7. **严禁修改后端代码与 OpenAPI 契约**：Android v0.3（Stage 1–3）全部复用现有后端 v0.7.0 接口，**零后端改动**。

---

## 2. 范围定义

| 包含（Android `0.3.0`） | 不包含（留待后续版本） |
| --- | --- |
| Kotlin 2 + Jetpack Compose + Material 3 + Room + OkHttp + WorkManager 工程重构 | iOS 工程（`apps/ios/`）实现 |
| `dev` / `prod` 构建变体、R8 压缩、小瓶子 Adaptive Icon、SplashScreen | Phase 2 设备级可撤销访问令牌与后端改动（Stage 4） |
| `WebActivity` 深度融合：文件/相册选择、Edge-to-Edge 与状态栏配色同步、`SparkMobile/1` 安全桥接（见 §5.1） | 桌面微件（Widget）、下拉快捷磁贴 |
| `apps/web/` 极薄桥接适配层（4 个核心文件 + Vitest 测试） | 离线阅读收件箱与 `/sync/changes` 增量同步（M7） |
| 透明底部弹窗 `ShareCaptureActivity`：文字、网址、`EXTRA_SUBJECT` 标题、单图与多图（≤9 张）、项目纸胶带选择、标签选择、用途、排除 AI、四套主题同步 | 富文本编辑工具栏（加粗/高亮/列表仍由 Web 负责） |
| 全屏 `LocalDraftsActivity` 本机草稿箱、显式草稿状态机、老版 `share-drafts.db` v1→v2 无损迁移、WorkManager 续传与孤儿媒体清理 | 推送通知 |
| JVM 单元测试、`MockWebServer` 集成测试、Room 迁移测试、GitHub Actions Android CI Job | 正式商店上架签名与发版流程 |

---

## 3. Android 工程结构与 Gradle 规范

### 3.1 Gradle 与工具链基线

- **Wrapper**：沿用 [gradle-wrapper.properties](../../apps/android/gradle/wrapper/gradle-wrapper.properties) 中的 Gradle `8.9`（保留 `distributionSha256Sum` 校验）。
- **版本目录**：新建 `apps/android/gradle/libs.versions.toml`，集中锁定版本，禁止在 `app/build.gradle.kts` 散写版本号。建议锁定基线（实施时以 Maven Central 实际可用且兼容 AGP 8.7.3 + Gradle 8.9 的稳定版为准，并写入锁版本）：
  - `agp = "8.7.3"`
  - `kotlin = "2.0.21"`（同步引入 `org.jetbrains.kotlin.plugin.compose`、`org.jetbrains.kotlin.plugin.serialization`）
  - `ksp = "2.0.21-1.0.28"`（用于 Room 编译器）
  - `composeBom`（Material 3 + UI + Preview）、`activityCompose`、`coreKtx`、`coreSplashscreen`、`webkit`
  - `room`（`room-runtime`、`room-ktx`、`room-compiler`、`room-testing`）
  - `work`（`work-runtime-ktx`、`work-testing`）
  - `okhttp`（`okhttp`、`mockwebserver`）、`kotlinxSerializationJson`、`coilCompose`
  - 测试：`junit`、`kotlinxCoroutinesTest`、`robolectric`（按需用于 SQLite/Room JVM 迁移测试）
- **迁移构建脚本**：将 `apps/android/build.gradle`、`settings.gradle`、`app/build.gradle` 统一为 Kotlin DSL（`.kts`）或保持 Groovy DSL 二选一（推荐 `.kts` 配合 `libs.versions.toml`，删除旧文件避免并存）。

### 3.2 构建变体（`dev` / `prod`）与签名安全

- `compileSdk = 35`、`targetSdk = 35`、`minSdk = 24`。
- `defaultConfig`：`applicationId = "cloud.stwqy.spark"`，`versionCode = 3`，`versionName = "0.3.0"`，`buildConfig = true`。
- `flavorDimensions += "env"`：
  - `prod`：
    - `buildConfigField("String", "SPARK_ORIGIN", "\"https://spark.stwqy.cloud\"")`
    - `buildConfigField("Boolean", "ALLOW_CLEARTEXT_DEV_ORIGIN", "false")`
    - `manifestPlaceholders["appPackage"] = "cloud.stwqy.spark"`
    - `manifestPlaceholders["appLabel"] = "Spark 灵光"`
  - `dev`：
    - `applicationIdSuffix = ".dev"`
    - `versionNameSuffix = "-dev"`
    - 从 `apps/android/local.properties`（已忽略）读取 `spark.dev.origin`，缺省为 `"http://10.0.2.2:5173"`
    - `buildConfigField("Boolean", "ALLOW_CLEARTEXT_DEV_ORIGIN", "true")`
    - `manifestPlaceholders["appPackage"] = "cloud.stwqy.spark.dev"`
    - `manifestPlaceholders["appLabel"] = "Spark Dev"`
- **Flavor 独立资源**：
  - `src/prod/res/xml/network_security_config.xml`：`cleartextTrafficPermitted="false"`；
  - `src/dev/res/xml/network_security_config.xml`：仅允许 `10.0.2.2`、`127.0.0.1`、`localhost` 明文；
  - `src/prod/res/xml/shortcuts.xml` 与 `src/dev/res/xml/shortcuts.xml`：分别填写对应 `android:targetPackage`（解决静态快捷方式在 `.dev` 包下打不开的问题）。
- `release` buildType：`isMinifyEnabled = true`、`isShrinkResources = true`，配 `proguard-rules.pro` 保留 `kotlinx.serialization` 生成器、Room 实体与 WebView 桥接回调类。
- Room KSP 配置：`ksp { arg("room.schemaLocation", "$projectDir/schemas") }`，将 `apps/android/app/schemas/` 纳入 Git 追踪。

### 3.3 目标目录与文件职责

```text
apps/android/app/src/main/java/cloud/stwqy/spark/
├── SparkApp.kt                             # Application：初始化容器、WorkManager 配置、启动孤儿清理
├── core/
│   ├── config/
│   │   └── AppConfig.kt                    # ORIGIN、USER_AGENT_MARKER("SparkMobile/1")、常量上限
│   ├── auth/
│   │   ├── SessionCredentialProvider.kt    # 鉴权抽象接口（Phase 1 Cookie / Phase 2 DeviceToken 切换点）
│   │   ├── WebViewCookieCredentialProvider.kt
│   │   └── SessionScope.kt                 # GUEST / pending:<sha256> / user:<uuid> 计算逻辑
│   ├── network/
│   │   ├── SparkApiClient.kt               # OkHttp 封装：session、projects、tags、uploads、complete、collections、export 流式下载
│   │   ├── ApiModels.kt                    # @Serializable DTO（严格对齐 contracts/openapi.json）
│   │   ├── ApiError.kt                     # 统一 HTTP/网络错误模型（含 status、code、message、retryAfterSeconds）
│   │   └── CollectionPayload.kt            # document.schema.json 编码、50,000 码点校验、URL 抽取、纯图空文档
│   ├── storage/
│   │   ├── SparkDatabase.kt                # RoomDatabase (version = 2) + Migration(1, 2)
│   │   ├── Entities.kt                     # DraftEntity、DraftAssetEntity、VerifiedSessionEntity、CachedProjectEntity、CachedTagEntity
│   │   ├── Daos.kt                         # DraftDao、AssetDao、SessionDao、CatalogDao
│   │   ├── DraftRepository.kt              # 账号隔离读写、乐观锁 revision、提交前冻结 requestId、切号清缓存
│   │   └── MediaStorage.kt                 # noBackupFilesDir/draft-media/ 流式限额拷贝(5 MiB+1)、魔数检测、孤儿清理
│   ├── security/
│   │   ├── WebNavigation.kt                # 同源/外链/草稿/拦截纯函数决策器（可 100% JVM 单测）
│   │   └── SharedInputParser.kt            # 解析 ACTION_SEND / ACTION_SEND_MULTIPLE（含 EXTRA_SUBJECT 合并规则）
│   └── designsystem/
│       ├── SparkTokens.kt                  # 4 套配色(mint/sea/matcha/sakura) × 明暗色板 + 6 种项目纸胶带色
│       ├── ProjectTone.kt                  # 64 位安全 abs 哈希映射（1..6，与 Web projectTone.ts 字节级对齐）
│       ├── SparkTheme.kt                   # Material 3 Theme + CompositionLocal 扩展令牌
│       └── Components.kt                   # WashiTapeChip、SparkCard、StatusBanner、PrimaryButton
├── feature/
│   ├── workspace/
│   │   ├── WebActivity.kt                  # 主工作区：WebView、Edge-to-Edge、FileChooser、错误页、登录回跳
│   │   ├── MobileHostBridge.kt             # WebViewCompat.addWebMessageListener 路由、单并发门控、PNG/ZIP 落地与分享
│   │   └── SystemMediaSaver.kt             # MediaStore 存相册/Downloads、FileProvider 系统分享与临时文件清理
│   ├── capture/
│   │   ├── ShareCaptureActivity.kt         # 透明宿主 Activity（禁止固定方向、excludeFromRecents）
│   │   ├── ShareCaptureViewModel.kt        # 单向数据流 StateFlow、自动保存防抖、项目/标签筛选、图片上传与提交
│   │   └── ShareCaptureSheet.kt            # Compose ModalBottomSheet 收集卡片 UI
│   └── drafts/
│       ├── LocalDraftsActivity.kt          # 全屏本机草稿箱与草稿编辑页
│       ├── DraftsShortcutActivity.kt       # 桌面长按快捷方式中转页（防清空主任务栈）
│       ├── LocalDraftsViewModel.kt
│       └── LocalDraftsScreen.kt            # Compose 草稿列表、状态徽标、单条重试/继续编辑/删除
└── worker/
    ├── AssetUploadCoordinator.kt           # 图片三步上传与精确恢复分支（供前台 ViewModel 与后台 Worker 共用）
    ├── DraftSubmissionCoordinator.kt       # 完整提交流程：会话校验 → 图片就绪 → 冻结 → POST /collections → 清理
    ├── DraftUploadWorker.kt                # WorkManager 联网续传（含 Phase 1 CookieManager 异常降级）
    └── OrphanMediaCleanupWorker.kt         # 孤儿媒体文件清理
```

> 删除旧版 6 个 Java 源文件（`CollectionPayload.java`、`ShareActivity.java`、`ShareDrafts.java`、`SharePage.java`、`SparkApi.java`、`WebActivity.java`），保留 `WebActivity` 的 Manifest 组件名（`cloud.stwqy.spark.WebActivity`）以免老用户桌面图标失效；系统分享入口 `ShareCaptureActivity` 同时声明 `<activity-alias android:name=".ShareActivity" android:targetActivity=".feature.capture.ShareCaptureActivity" android:exported="true">` 保持向后兼容（如既有 adb 测试命令 `-n cloud.stwqy.spark/.ShareActivity` 仍可直接生效！）。

### 3.4 `AndroidManifest.xml` 关键配置要点

- 权限：应用声明 `android.permission.INTERNET` 与 `android.permission.ACCESS_NETWORK_STATE`。后者用于切换离线草稿操作。Android 13+ Photo Picker 与 `MediaStore` 写入自身创建的文件均**无需** `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` / `READ_MEDIA_IMAGES`；若需兼容 Android 9 及以下写入公共相册/下载，使用 `maxSdkVersion="28"` 的 `WRITE_EXTERNAL_STORAGE` 或改用 `ACTION_CREATE_DOCUMENT` SAF 零权限落盘——**推荐后者或 Android 10+ `MediaStore` + Android 7–9 `ACTION_CREATE_DOCUMENT` 降级，全程零存储权限申请**。
- `<application>`：
  - `android:name=".SparkApp"`
  - `android:allowBackup="false"`
  - `android:fullBackupContent="false"`
  - `android:dataExtractionRules="@xml/data_extraction_rules"`
  - `android:networkSecurityConfig="@xml/network_security_config"`
  - `android:icon="@mipmap/ic_launcher"`、`android:roundIcon="@mipmap/ic_launcher_round"`
  - `android:enableOnBackInvokedCallback="true"`（接入 AndroidX `OnBackPressedDispatcher`，支持预测性返回）
- Activity 声明：
  - `.WebActivity`：`MAIN` + `LAUNCHER`，主题 `@style/Theme.Spark.Starting`（SplashScreen），`windowSoftInputMode="adjustResize"`，附 `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />`。
  - `.feature.capture.ShareCaptureActivity`（及 `.ShareActivity` alias）：透明主题 `@style/Theme.Spark.TranslucentSheet`，`excludeFromRecents="true"`，**禁止声明 `android:screenOrientation`**，`windowSoftInputMode="adjustResize"`；`intent-filter` 覆盖：
    - `ACTION_SEND` + `text/plain`
    - `ACTION_SEND` + `image/*`
    - `ACTION_SEND_MULTIPLE` + `image/*`
  - `.feature.drafts.LocalDraftsActivity`：标准不透明主题 `@style/Theme.Spark`，`exported="false"`（仅供应用内打开）。
  - `.feature.drafts.DraftsShortcutActivity`：`exported="true"`，`noHistory="true"`，`excludeFromRecents="true"`。
- `FileProvider`：
  - `android:authorities="${applicationId}.fileprovider"`，`exported="false"`，`grantUriPermissions="true"`；
  - `res/xml/file_paths.xml` 仅开放 `<cache-path name="shared_cards" path="shared-cards/" />`，严禁暴露 `files-path` 或 `noBackupFilesDir`。

---

## 4. 数据库 Schema 与 `Migration(1, 2)` 精确实现

### 4.1 数据库路径与版本

- 文件路径：`File(context.noBackupFilesDir, "share-drafts.db").path`（与旧版 `ShareDrafts.java` 完全一致）。
- Room 版本：`version = 2`，`exportSchema = true`。

### 4.2 五张表精确结构（Room v2）

1. **`draft`**（主键 `id`）
   - `id TEXT NOT NULL PRIMARY KEY`
   - `scope TEXT NOT NULL`（`guest` / `pending:<sha256>` / `user:<uuid>`）
   - `body TEXT NOT NULL`
   - `manual_title TEXT NOT NULL DEFAULT ''`
   - `purpose TEXT NOT NULL`
   - `excluded INTEGER NOT NULL`（`0` / `1`）
   - `project_ids_json TEXT NOT NULL DEFAULT '[]'`
   - `tag_ids_json TEXT NOT NULL DEFAULT '[]'`
   - `status TEXT NOT NULL DEFAULT 'EDITING'`（枚举：`EDITING` / `QUEUED` / `UPLOADING_ASSETS` / `SUBMITTING` / `UNCERTAIN`）
   - `request_id TEXT`（可空；非空即代表已冻结的客户端收藏 UUID 与 `Idempotency-Key`）
   - `last_error TEXT`（可空；用户可读中文错误摘要）
   - `revision INTEGER NOT NULL`
   - `modified INTEGER NOT NULL`（毫秒时间戳）
   - 索引：`CREATE INDEX index_draft_scope_modified ON draft(scope, modified)`（Room 标准索引名，避免 `DESC` 校验差异）

2. **`draft_asset`**（主键 `id`，外键 `draft_id REFERENCES draft(id) ON DELETE CASCADE`）
   - `id TEXT NOT NULL PRIMARY KEY`
   - `draft_id TEXT NOT NULL`
   - `local_path TEXT NOT NULL`（相对 `noBackupFilesDir/draft-media/` 的路径）
   - `filename TEXT NOT NULL`
   - `mime_type TEXT NOT NULL`
   - `size_bytes INTEGER NOT NULL`
   - `sort_order INTEGER NOT NULL`
   - `upload_idempotency_key TEXT NOT NULL`
   - `upload_id TEXT`
   - `bytes_transferred INTEGER NOT NULL DEFAULT 0`
   - `upload_state TEXT NOT NULL DEFAULT 'LOCAL'`（`IMPORTING` / `IMPORT_FAILED` / `LOCAL` / `UPLOADING` / `VERIFYING` / `READY` / `FAILED`）
   - `error_code TEXT`
   - `error_message TEXT`
   - 索引：`CREATE INDEX index_draft_asset_draft_id_sort_order ON draft_asset(draft_id, sort_order)`

3. **`verified_session`**（单槽位 `slot = 1`）
   - `slot INTEGER NOT NULL PRIMARY KEY`
   - `fingerprint TEXT NOT NULL`
   - `user_id TEXT`
   - `palette TEXT NOT NULL DEFAULT 'mint'`
   - `theme TEXT NOT NULL DEFAULT 'system'`

4. **`cached_project`**（复合主键 `scope, id`）
   - `scope TEXT NOT NULL`
   - `id TEXT NOT NULL`
   - `name TEXT NOT NULL`
   - `state TEXT NOT NULL`
   - `fetched_at INTEGER NOT NULL`
   - 主键：`PRIMARY KEY(scope, id)`

5. **`cached_tag`**（复合主键 `scope, id`）
   - `scope TEXT NOT NULL`
   - `id TEXT NOT NULL`
   - `name TEXT NOT NULL`
   - `collection_count INTEGER NOT NULL`
   - `fetched_at INTEGER NOT NULL`
   - 主键：`PRIMARY KEY(scope, id)`

### 4.3 `Migration(1, 2)` 精确 SQL 步骤（防崩必遵）

旧版 v1 的建表语句见 [迁移测试](../../apps/android/app/src/test/java/cloud/stwqy/spark/core/storage/ShareDraftsMigrationTest.kt)。其中 `draft.id` 缺 `NOT NULL`、`draft_scope` 带 `DESC`、`verified_session` 带 `CHECK(slot=1)`。迁移**必须**按以下重建表步骤执行（在 Room 事务内）：

```sql
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
);

INSERT INTO draft_new (
  id, scope, body, manual_title, purpose, excluded,
  project_ids_json, tag_ids_json, status, request_id, last_error, revision, modified
)
SELECT
  id, scope, body, '', purpose, excluded,
  '[]', '[]',
  CASE WHEN request_id IS NOT NULL THEN 'UNCERTAIN' ELSE 'EDITING' END,
  request_id, NULL, revision, modified
FROM draft
WHERE id IS NOT NULL;

DROP TABLE draft;
ALTER TABLE draft_new RENAME TO draft;
CREATE INDEX index_draft_scope_modified ON draft(scope, modified);

CREATE TABLE verified_session_new (
  slot INTEGER NOT NULL PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  user_id TEXT,
  palette TEXT NOT NULL DEFAULT 'mint',
  theme TEXT NOT NULL DEFAULT 'system'
);

INSERT INTO verified_session_new (slot, fingerprint, user_id, palette, theme)
SELECT slot, fingerprint, user_id, 'mint', 'system'
FROM verified_session
WHERE slot IS NOT NULL;

DROP TABLE verified_session;
ALTER TABLE verified_session_new RENAME TO verified_session;

-- 随后创建 draft_asset、cached_project、cached_tag 及其索引
```

迁移产生的冻结草稿沿用 v1 的网址提取规则。重试期间保留 `UNCERTAIN` 和 `last_error = NULL`，以便进程重启后仍可用原 UUID 和原载荷回放。新请求进入 `UNCERTAIN` 时写入可读错误摘要。

---

## 5. Web ↔ 移动端桥接协议实现细节

### 5.1 协议契约（双方对齐）

- **User-Agent**：Android 在默认 UA 后追加 ` SparkMobile/1`（**注意空格分隔**，不移除系统自带 Android/Chrome UA）。
- **主文档导航**：工作区只允许同源 GET 主文档留在 WebView。Android 在 `shouldInterceptRequest` 阻断主文档 POST 首跳，包含可能经 307/308 转发的同源 POST。登录及其他表单由 Web 通过 API 请求提交，文件上传沿用子资源请求。
- **Android 注册监听器**：
  - 使用 `WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)` 判断后，调用：
    `WebViewCompat.addWebMessageListener(webView, "sparkMobileHost", setOf(AppConfig.ORIGIN), listener)`
  - 回调函数内部再次校验：`isMainFrame && sourceOrigin.toString() == AppConfig.ORIGIN`；否则静默丢弃。
  - 需回执的动作通过 `replyProxy.postMessage(responseJson)` 回复，JSON 格式：
    - 成功：`{"version":1,"request_id":"...","ok":true,"data":{...}}`
    - 失败：`{"version":1,"request_id":"...","ok":false,"error":{"code":"...","message":"...","status":429,"retry_after":120}}`
- **并发与体量门控**：
  - `saveImage` / `shareImage`：`base64` 长度校验 `<= 5_600_000` 字符、解码后字节 `<= 4 * 1024 * 1024`（4 MiB）、前 8 字节必须为 PNG 魔数 `89 50 4E 47 0D 0A 1A 0A`；`filename` 清洗掉路径分隔符与控制字符并截断至 `<= 64` 字符，强制 `.png` 扩展名；
  - `saveImage` / `shareImage` / `exportData` 共享一个 `AtomicBoolean` 单在途锁，重复连点直接返回 `{"ok":false,"error":{"code":"busy","message":"上一项操作正在进行，请稍候。"}}`。
  - 文件动作在主文档提交后受理。任务按 WebView、文档世代及 `request_id` 绑定。主文档导航、解除桥接或渲染进程退出时取消任务。系统文档选择器或分享面板触发 Activity 暂停时继续等待。

| 文件动作 | 信封 `request_id` | `payload` |
| --- | --- | --- |
| `saveImage` / `shareImage` | 必填 | `{ "expected_user_id": "<uuid>", "mime": "image/png", "filename": "...", "base64": "..." }` |
| `exportData` | 必填 | `{ "expected_user_id": "<uuid>", "format": "markdown\|json" }` |
| `cancelFileAction` | 省略，无回执 | `{ "request_id": "<待取消文件请求 ID>" }` |

- **账号绑定**：Web 从当前页面认证上下文读取 `user.id`。原生按不可变 Cookie 快照调用 `GET /api/v1/auth/session`，核对服务端用户 UUID 和文档世代。该 UUID 仅用于一致性断言。账号不一致返回 `account_mismatch`，未登录或会话失效返回 `session_expired`。
- **取消**：Web 卸载、主动取消或等待超时时发送 `cancelFileAction`，只取消同一文档发出的匹配任务。取消中止导出连接和文件流，释放单并发槽前先完成必要清理。
- **`exportData` 实现细节**：
  - 校验 `payload.format` 仅允许 `"markdown"` 或 `"json"`；
  - 使用当前 WebView Cookie 快照调 `GET /api/v1/auth/session` 取 `csrf_token`；
  - OkHttp 发起 `GET ${ORIGIN}/api/v1/me/export?format=${format}`（携带 `Cookie`、`Origin`、`X-CSRF-Token`）；
  - 若 `200`：从 `Content-Disposition` 提取安全文件名（缺省 `spark-export-${format}.zip`）。流式写入 `cache/export-staging/`，硬上限 256 MiB，逐块检查至少 64 MiB 可用空间余量。超限或空间不足时中止并删除残件。启动与定期清理回收失去持有者的暂存，跳过活跃文件。成功返回 `{"ok":true,"data":{"filename":"..."}}`；
  - 若 `429`：解析 `Retry-After` 头返回给 Web，保持冷却倒计时体验一致；
  - 若 `401`/`403`：返回 `session_expired` 提示重新登录。
- **发布图片与 ZIP**：先完成应用私有暂存。Android 10+ 写入 `MediaStore` 待定条目，在清除 `IS_PENDING` 前后复核，失效时删除条目。Android 7–9 通过 SAF `ACTION_CREATE_DOCUMENT`，在写入前后复核，失效时尝试删除外部文档。SAF 提供者控制写入可见性与删除结果，无法保证原子回滚。

### 5.2 `apps/web/` 极薄适配清单（仅改 4 处，零破坏）

1. **新增 `apps/web/src/lib/mobileBridge.ts`**：
   - `isMobileHost()`：`navigator.userAgent.split(/\s+/).includes('SparkMobile/1')`
   - `hasLocalDraftsEntry()`：`isMobileHost() || navigator.userAgent.split(/\s+/).includes('SparkAndroid/2')`
   - 检测全局 `window.sparkMobileHost?.postMessage`（由 Android `WebViewCompat` 或未来 iOS `WKUserContentController` 注入）；
   - 提供 `notifyMobileAppearance(palette, mode, bgHex)`、`notifyMobileAuthChanged(authenticated)`、`openMobileLocalDrafts()`。三个文件动作接收页面用户 ID 和 `AbortSignal`，由桥接按请求发送取消。
   - 任何超时（如 30s）、解析异常或未注入宿主时返回明确结果，绝不影响普通浏览器路径。
2. **修改 [apps/web/src/lib/appearance.ts](../../apps/web/src/lib/appearance.ts)**：
   - 在 `syncDocument()` 更新 `<meta name="theme-color">` 后调用 `notifyMobileAppearance(palette, mode, bg)`。Web 会话清除后通过同一外观入口发送 `notifyMobileAuthChanged(false)`。
3. **修改 [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx)**：
   - 第 169 行改为使用 `hasLocalDraftsEntry()`；
   - 「本机草稿」导航项在 `isMobileHost()` 且 `sparkMobileHost` 可用时调用 `openMobileLocalDrafts()`，否则保持 `<a href="/android/local-drafts">` 链接（100% 兼容 `SparkAndroid/2`）；
   - 首次确认会话或切换账号时调用 `notifyMobileAuthChanged(true)`。原生收到通知后重新读取 Cookie。
4. **修改 [apps/web/src/components/ShareCard.tsx](../../apps/web/src/components/ShareCard.tsx) 与 [apps/web/src/components/DataExport.tsx](../../apps/web/src/components/DataExport.tsx)**：
   - `ShareCard`：移动宿主支持文件桥接时，把 `ready.file`、`user.id` 和取消信号交给 `requestMobileSaveImage` 或 `requestMobileShareImage`。
   - `DataExport`：移动宿主支持文件桥接时，把 `format`、`user.id` 和取消信号交给 `requestMobileExportData`。返回 `429` 时使用 `retry_after` 显示可再次导出的时间。
5. **Web 单元测试**：在 `apps/web/src/test/` 为 `mobileBridge`、桥接降级与 `SparkMobile/1` + `SparkAndroid/2` 兼容补充 Vitest 用例，确认现有测试全部通过。

---

## 6. 服务端接口调用与核心算法精确规范

### 6.1 使用到的 OpenAPI 端点汇总（严禁提交契约未定义字段）

所有 API 请求统一携带：`Accept: application/json`、`Cookie: <immutableSnapshot>`；所有非 GET 及 `GET /me/export` 额外携带 `Origin: ${AppConfig.ORIGIN}` 与 `X-CSRF-Token: <csrf>`。所有 OkHttp 连接禁止自动跟随重定向（`followRedirects(false)`、`followSslRedirects(false)`）。

| 操作 | 方法与路径 | 必填请求头 | 请求体 / 查询参数 | 期望成功响应 |
| --- | --- | --- | --- | --- |
| 会话与外观校验 | `GET /api/v1/auth/session` | `Cookie` | — | `200`：`user.id`、`user.email`、`user.palette`、`user.theme`、`csrf_token` |
| 进行中项目目录 | `GET /api/v1/projects?state=active&limit=100` | `Cookie` | 可选 `q`、`cursor` | `200`：`ProjectPage { items: [{ id, name, state }], next_cursor? }` |
| 标签目录 | `GET /api/v1/tags?limit=100` | `Cookie` | 可选 `q`、`cursor` | `200`：`TagPage { items: [{ id, name, path, collection_count }], next_cursor? }` |
| 申请图片上传授权 | `POST /api/v1/uploads` | `Cookie`、`Origin`、`X-CSRF-Token`、`Idempotency-Key` | `UploadRequest { filename, size_bytes, mime_type }` | `201`：`UploadGrant { id, method("PUT"), url, headers, expires_at }` |
| 直传图片至 OSS | `PUT <grant.url>` | **仅携带 `grant.headers`**（**严禁带 `Cookie` 或 `X-CSRF-Token`!**） | 原始文件流（固定长度） | `200` / `201` / `204` |
| 确认上传完成 | `POST /api/v1/uploads/{id}/complete` | `Cookie`、`Origin`、`X-CSRF-Token` | 无正文 | `202`：`Upload { id, status, error_code? }` |
| 轮询上传状态 | `GET /api/v1/uploads/{id}` | `Cookie` | — | `200`：`Upload { id, status, size_bytes?, error_code? }` |
| 创建收藏 | `POST /api/v1/collections` | `Cookie`、`Origin`、`X-CSRF-Token`、`Idempotency-Key` | `CollectionCreate { id, document, intent, original_url?, manual_title?, upload_ids, project_ids, tag_ids, ai_excluded }` | `201`（含同键重放） |
| 核对已建收藏 | `GET /api/v1/collections/{id}` | `Cookie` | — | `200`（用于 `attached` 异常恢复核验） |
| 导出个人数据 | `GET /api/v1/me/export?format=markdown\|json` | `Cookie`、`Origin`、`X-CSRF-Token` | `format` | `200`：`application/zip` 二进制流 |

> **关键安全提醒**：PUT 直传 OSS 时使用独立的干净 `OkHttpClient`（不附带 Spark `Cookie`、`Origin`、`X-CSRF-Token`），只附加 `UploadGrant.headers` 中服务端签发所需的精确请求头。

### 6.2 `SessionCredentialProvider` 接口定义（预留 Phase 2 演进点）

```kotlin
sealed interface SessionSnapshot {
    data object Guest : SessionSnapshot
    data class CookieBased(
        val rawCookie: String,
        val provisionalScope: String, // "pending:<base64(sha256(spark_session=...))>"
    ) : SessionSnapshot
}

data class VerifiedAccount(
    val userId: String,
    val email: String?,
    val csrfToken: String,
    val palette: String,
    val theme: String,
    val snapshot: SessionSnapshot,
)

interface SessionCredentialProvider {
    fun currentSnapshot(): SessionSnapshot
    suspend fun verify(snapshot: SessionSnapshot): VerifiedAccount
    fun flush()
}
```

### 6.3 跨端确定性算法精确代码要求

1. **`ProjectTone.kt`**（与 [projectTone.ts](../../apps/web/src/lib/projectTone.ts) 完全一致，杜绝 `Int.MIN_VALUE` 溢出）：
   ```kotlin
   fun projectToneIndex(projectId: String): Int {
       var hash = 0
       for (ch in projectId) {
           hash = hash * 31 + ch.code
       }
       return ((kotlin.math.abs(hash.toLong()) % 6L) + 1L).toInt()
   }
   ```
2. **文件头魔数检测（`MediaStorage.kt`）**：
   - JPEG：前 3 字节 `FF D8 FF` → `image/jpeg`
   - PNG：前 8 字节 `89 50 4E 47 0D 0A 1A 0A` → `image/png`
   - GIF：前 6 字节 `GIF87a` 或 `GIF89a` → `image/gif`
   - WebP：字节 `0..3 == "RIFF"` 且字节 `8..11 == "WEBP"` → `image/webp`
   - 流式拷贝逻辑：从 `ContentResolver.openInputStream(uri)` 按 16 KiB 缓冲区读取，累计超过 `5 * 1024 * 1024`（5,242,880）字节立即关闭流、删除临时文件并返回 `ImageTooLarge`。不信任 `ContentResolver` 返回的 `mimeType` 或文件名扩展名，以实际魔数为准。
3. **`CollectionPayload.kt` 纯图空文档**：
   - 当 `uploadIds.isNotEmpty()` 且 `text` 仅为空白时，`document.content.content` 必须输出单个 `{"type":"paragraph"}`；
   - `original_url` 仅在提取到合法无凭据 HTTP(S) 链接时写入字段，无链接时省略该 key；
   - `manual_title` 仅在非空（trim 后 ≤ 200 码点）时写入字段，为空时省略该 key（避免违反 `additionalProperties: false` 或不必要的空字段）。
4. **颜色令牌单一来源**：`SparkTokens.kt` 的全部色值必须逐字照搬 [apps/web/src/styles/tokens.css](../../apps/web/src/styles/tokens.css)（4 套配色浅/深 + 6 种纸胶带浅/深 + 状态色），不得自行重新取色。

---

## 7. 图片上传与草稿提交协调器状态转换

### 7.1 `AssetUploadCoordinator` 处理矩阵

| 当前状态 / 服务端返回 | 动作 | 数据库持久化变更 |
| --- | --- | --- |
| 已导入且未确认传输，无 `uploadId` 或服务端仍为 `pending` | 调 `POST /uploads`（用 `uploadIdempotencyKey`）→ 流式 PUT OSS → 调 `POST /uploads/{id}/complete` → 轮询 `GET /uploads/{id}`（退避 `400 + tries * 150ms`，最多 15 次） | 取得 `upload_id` 即落盘；PUT 完成置 `bytes_transferred = 1`；`ready` 置 `upload_state = 'READY'` |
| 已有 `uploadId` 且 `bytesTransferred == false` | 先 `GET /uploads/{id}`，`verifying` / `ready` / `attached` 跳过 PUT，`pending` 仍按原键上传。终止状态沿用换键或冻结请求核对规则 | 服务端确认已收到字节时补写 `bytes_transferred = 1` |
| `bytesTransferred == true` 且 `uploadId != null` | 跳过 `POST /uploads` 与 PUT，直接调 `POST /uploads/{id}/complete` 或 `GET /uploads/{id}` | 避免重复上传与重复扣签名次数 |
| `GET /uploads/{id}` 返回 `ready` | 标记就绪 | `upload_state = 'READY'` |
| `GET /uploads/{id}` 返回 `attached` 且所属草稿 `requestId != null` | 不报错，交由 `DraftSubmissionCoordinator` 核对 `GET /collections/{requestId}` 或重放 `POST /collections` | 保持 `upload_id` 与草稿冻结态 |
| `status == rejected` / `expired`，或 HTTP `409 upload_not_pending` / `410` / `404` | **生成新 `upload_idempotency_key`**，重置上传状态，提示用户重试或移除该图 | `upload_id = NULL`, `bytes_transferred = 0`, `upload_state = 'FAILED'`, 写入可读错误 |
| HTTP `429 rate_limited` | **保留原 `upload_idempotency_key`**，解析 `Retry-After` 秒数提示等待后重试 | `upload_state = 'FAILED'`, `error_code = 'rate_limited'` |
| HTTP `503 integration_not_configured` | **停止重试**，提示「当前环境未开启图片上传；移除图片后仍可保存正文或网址」 | `upload_state = 'FAILED'`, `error_code = 'integration_not_configured'` |

### 7.2 `DraftUploadWorker`（WorkManager）防御规则

- 约束：`NetworkType.CONNECTED`，按 `ExistingWorkPolicy.KEEP` 唯一名称调度，避免并发双发。
- Phase 1 兼容防御：调用 `SessionCredentialProvider.currentSnapshot()` 读取 `CookieManager` 时必须 `try/catch (Throwable)`（覆盖 `MissingWebViewPackageException` / ROM 后台初始化失败）；捕获后记录脱敏警告并返回 `Result.success()`（草稿保持 `QUEUED`），待用户打开 App 回到前台时由 `SparkApp` / `WebActivity.onResume` 立即重新触发队列检查。
- 仅处理与当前已验证账号 `scope` 匹配的 `QUEUED` / `UNCERTAIN` 草稿；遇到 401/403 立即停止当前轮次，等待用户重新登录。

---

## 8. 分批次交付计划与完成定义（DoD）

建议接手 Agent 严格按以下 **4 个独立 PR 批次** 依次交付、逐批验证，禁止把四个批次揉成一个巨型 PR。

### Batch 1：工程底座、图标启动页、Room 迁移与核心单测（对应 `MOB-S1-T01`、`MOB-S1-T03`）

2026-11-22 使用 JDK 17、SDK Platform 35 和 Build Tools 34.0.0 通过 33 项 JVM 测试与两个调试包构建。`assembleProdRelease` 通过 R8 与资源压缩，输出未签名 APK。API 35 模拟器验证了应用启动、文字分享别名、本机草稿快捷方式和合成 v1 数据库的原地迁移。工作流已在本地通过 YAML 解析与 Action SHA 检查。远端 CI 和真机验收待执行。

- **建议分支**：`feat/android-v0.3-foundation`
- **任务内容**：
  1. 切换 `apps/android/` 到 Kotlin 2 + Compose + Material 3 + Room + OkHttp + Version Catalog（`libs.versions.toml`），配置 `dev` / `prod` 变体、独立 `network_security_config.xml` 与 `shortcuts.xml`、R8 规则。
  2. 基于 [Brand.tsx](../../apps/web/src/components/Brand.tsx) 的 `JarGlyph` 重绘 Android Adaptive Icon（`ic_launcher` + Monochrome 单色图层）与 Android 12+ `SplashScreen`。
  3. 实现 `core/config`、`core/auth`、`core/network`、`core/storage`（含 `Migration(1, 2)` 与 Schema 导出）、`core/security`（`WebNavigation`、`SharedInputParser`）、`core/designsystem`（`SparkTokens`、`ProjectTone`）。
  4. 编写完整 JVM 单测与 Room `Migration(1, 2)` 迁移测试；在 [.github/workflows/verify.yml](../../.github/workflows/verify.yml) 新增 `android` Job（所有 Actions 锁定 40 位 commit SHA）。
- **验证命令**：
  ```powershell
  cd apps/android
  .\gradlew.bat :app:testProdDebugUnitTest :app:assembleProdDebug :app:assembleDevDebug
  ```
- **DoD**：全部 JVM 单测（含 `ProjectTone`、`CollectionPayload` 纯图空文档、`WebNavigation`、`Migration(1, 2)`）通过；`prodDebug` 与 `devDebug` APK 编译通过；`verify.yml` 语法正确。

### Batch 2：`WebActivity` 深度融合 + `SparkMobile/1` 桥接 + `apps/web` 极薄适配（对应 `MOB-S1-T02`）

2026-11-22 在 `feat/android-v0.3-foundation` 完成实现。JDK 17、SDK Platform 35 和 Build Tools 34.0.0 下通过 43 项 JVM 测试及 `prodDebug`、`devDebug` 构建。Web 类型检查、19 个 Vitest 文件共 179 项测试和生产构建通过。

API 35 模拟器使用合成夹具验证 Photo Picker 取消、单选、多选和 CSV 文件选择上传，PNG 存入相册并可打开系统分享。四套配色的明暗模式均同步到两个系统栏，断网可重试，登录成功后可返回指定草稿。约 2 MiB ZIP 流式写入系统下载目录，核对了文件字节、同一会话的 Cookie、`Origin` 和 CSRF 请求头。导出期间并发保存返回 `busy`，Web 收到 `429 Retry-After: 117`。OrbStack 真实后端、OSS、Android 7–9 的 SAF 保存和远端 CI 待验收。

- **工作分支**：`feat/android-v0.3-foundation`
- **任务内容**：
  1. 重写 `WebActivity`：移除旧版顶部三按钮栏；启用 `enableEdgeToEdge()` 与 `SplashScreen`；追加 `SparkMobile/1` UA；接入 `WebNavigation`，由 `shouldInterceptRequest` 阻断主文档 POST 首跳；补齐顶部进度条、手帐风错误重试页、`WebChromeClient.onShowFileChooser`（Photo Picker + SAF，取消必回调 `null`）、预测性返回栈与 `returnAfterLogin` 登录自动回跳。
  2. 实现 `MobileHostBridge`（`WebViewCompat.addWebMessageListener` 精确同源校验、单并发门控、`syncAppearance`/`openLocalDrafts`/`saveImage`/`shareImage`/`exportData`/`authStateChanged`）与 `SystemMediaSaver`（`MediaStore` + `FileProvider`）。
  3. 按第 5.2 节完成 `apps/web/` 4 处极薄适配与 Vitest 回归测试（验证 `SparkMobile/1`、`SparkAndroid/2` 与普通浏览器三种模式）。
- **验证命令**：
  ```powershell
  # Android
  cd apps/android; .\gradlew.bat :app:testProdDebugUnitTest :app:assembleProdDebug :app:assembleDevDebug
  # Web
  cd apps/web; npm run typecheck; npm run test; npm run build
  ```
- **DoD**：Web 与 Android 自动化检查全绿；真机/模拟器实测相册选图上传、PNG 分享卡存相册与拉起系统分享、ZIP 流式导出、四套配色与明暗状态栏同步全部通过。

### Batch 3：Compose 悬浮收集卡片与本机草稿箱（对应 `MOB-S2-T01`、`MOB-S2-T02`）

2026-11-22 在 `feat/android-v0.3-foundation` 完成悬浮文字与网址收集、本机草稿箱和项目标签目录。Temurin 17.0.20+8、Gradle 8.9、SDK Platform 35、Build Tools 34.0.0 下，`testProdDebugUnitTest`、`assembleProdDebug` 与 `assembleDevDebug` 通过，共 51 项 JVM 测试。

API 35 模拟器使用合成账号及本地协议夹具，验证 Chrome 系统分享带标题链接后打开透明悬浮卡片，选择项目与标签并成功保存一条收藏，随后回到原页面。另验证登录返回并认领原草稿、项目翻页和标签选择、软键盘在防抖保存期间保持开启、POST 载荷、断网选已缓存项目、强制停止后从快捷入口恢复、双账号切换、删除确认与联网手动发送。Android 8 真机及 OrbStack 真实后端仍待验收。

在线目录打开时先展示同会话的本机条目，再按需刷新。在线页面缓存保留十分钟，进程重启后打开目录会重新取得分页游标。断网可从已有目录选项目和标签。待发送草稿可在恢复联网后手动发送。服务端明确拒绝的 409 和 422 允许修订后换键，`operation_in_progress`、结果不明的冲突与断线保留原键和内容。详见 [D-0020](../DECISIONS.md#d-0020-按收藏提交的确定结果解冻草稿)。

- **工作分支** `feat/android-v0.3-foundation`
- **任务内容**
  1. 实现透明宿主 `ShareCaptureActivity`（及 `.ShareActivity` alias）+ `ShareCaptureSheet`（`ModalBottomSheet`）：支持纯文本、网址、`EXTRA_SUBJECT` 合并、用途、可选标题、排除 AI、四套「灵光手帐」配色同步、防抖自动保存（无整树重建）。
  2. 实现活跃项目与标签的账号隔离缓存、纸胶带色选择器与搜索过滤。
  3. 实现独立全屏 `LocalDraftsActivity` 本机草稿箱与 `DraftsShortcutActivity` 桌面快捷方式入口，支持新建、编辑、状态徽标、单条重试、删除确认与登录往返认领。
- **验证命令**：同 Batch 1 + `MockWebServer` 覆盖项目/标签缓存、登录认领、切号隔离、409/422 冲突与超时重放单测。
- **DoD**：浏览器分享带标题链接在原 App 上方以底部卡片滑出，选项目/标签保存后回到原 App；无网存草稿杀进程不丢失；双账号切换草稿与缓存严格隔离。

### Batch 4：系统多图分享、OSS 三步上传与后台续传（对应 `MOB-S3-T01`、`MOB-S3-T02`）

2026-11-22 在 `feat/android-v0.3-foundation` 完成系统单图、多图与图文分享、逐张上传恢复、后台续传和媒体清理。Temurin 17.0.20+8、Gradle 8.9、SDK Platform 35 和 Build Tools 34.0.0 下，14 套共 67 项 JVM 测试全部通过，两个调试包和未签名 `prodRelease` 均构建成功。Robolectric 与 `MockWebServer` 覆盖四种图片签名、损坏文件和超限流、纯图正文、OSS PUT 请求头隔离、上传检查点、冻结重放、过期换键、429 等待、503 降级、切号、队列续传与清理。

API 35 模拟器用 Android Files 分享合成单图及两张图片，按纯图格式完成两次收藏。断网入队后强制停止应用，从快捷入口恢复并回到桌面，联网触发 WorkManager 完成发送。夹具记录每张图片一次 PUT，检查 PUT 请求未携带会话头。同步成功、逐张移除与确认删除后核对了私有文件。另以相同调试签名依次覆盖安装 v0.1.0（`596632b`）、v0.2.0（`df4abdc`）、v0.3.0，Room v2 保留的两条旧草稿均可在离线编辑器中打开。

Web 类型检查、19 个测试文件的 179 项测试和生产构建均通过。首次 Web 测试中有一项既有页面返回用例超时，复跑原命令通过。相对 Batch 3 基线，Web、后端和契约无新增改动。真实后端与 OSS 联调、旧草稿升级后的在线提交、真机分享与续传、正式签名覆盖安装和远端 CI 待验。

- **工作分支** `feat/android-v0.3-foundation`
- **任务内容**：
  1. 放开 `ACTION_SEND` (`image/*`) 与 `ACTION_SEND_MULTIPLE` (`image/*`)；接入 `MediaStorage` 流式 `5 MiB + 1` 限额拷贝、魔数校验与 Coil 缩略图预览条（单张进度、失败原因、重试、移除，最多 9 张）。
  2. 实现 `AssetUploadCoordinator` 与 `DraftSubmissionCoordinator`，打通 OSS 三步上传、纯图空文档保存与全部异常恢复分支（`bytes_transferred`、`attached`、`expired`/`409`/`410`/`429`/`503`）。
  3. 接入 `DraftUploadWorker`（WorkManager 联网续传 + Phase 1 Cookie 防御降级）与 `OrphanMediaCleanupWorker`（孤儿媒体清理）。
  4. 更新 [apps/android/README.md](../../apps/android/README.md)、[ROADMAP.md](../ROADMAP.md) 与 [CHANGELOG.md](../CHANGELOG.md)。
- **验证命令**：
  ```powershell
  cd apps/android
  .\gradlew.bat :app:testProdDebugUnitTest :app:assembleProdDebug :app:assembleDevDebug :app:assembleProdRelease
  ```
- **DoD**：相册/截屏单图与多图（含纯图无文字）分享上传并在收件箱正常展示；弱网中断与 `attached` 恢复无重复收藏、无重复扣上传配额；伪造超 5 MiB 流或损坏图片被立即拒绝且无残留临时文件；老版本 v0.1/v0.2 APK 覆盖安装升级后原有未提交草稿可正常读取并提交。

### 独立审查修复

2026-11-22，完成 `MOB-S1-T02`、`MOB-S3-T01` 和 `MOB-S3-T02` 的审查修复。文件桥接按文档与账号绑定，可取消并在私有暂存后复核发布。导出限制 256 MiB，保留 64 MiB 可用空间，启动与定期任务回收遗留暂存。分享先在 Room 保存正文和图片条目，再限时导入图片。续传对已有上传 ID 先核对服务端状态，CI 补充无签名 R8 生产打包。

Temurin 17.0.20+8、Gradle 8.9、SDK Platform 35、Build Tools 34.0.0 下运行 Batch 4 全量命令。15 套 83 项 JVM 测试及三个 APK 构建通过。JVM 和 MockWebServer 覆盖文档失效与流式取消、账号不匹配、发布前切号、ZIP 字节与磁盘预算、暂存回收、慢分享源与上传状态恢复。Web 的 `npm run typecheck`、`npm run test`（19 个文件、180 项）和 `npm run build` 通过。本轮设备面板超时，实际 WebView 渲染进程退出、Android 7–9 SAF、真实后端与真机待验。独立复审待完成。

---

## 9. 交接汇报要求

接手 Agent 在每个 Batch 完成后，交付说明须按 [AGENTS.md](../../AGENTS.md#12-git版本与交付) 写明：
1. 本批次实际修改的文件与对应 `MOB-*` 任务编号；
2. 实际执行的验证命令与结果（区分 JVM 单测、Web 检查、模拟器/真机验收，未真机验证的项明确标注限制，不把单测写成真机通过）；
3. 若发现契约或设计冲突，先暂停并同步更新 [MOBILE.md](../design/MOBILE.md) 与本文后再继续实施。
