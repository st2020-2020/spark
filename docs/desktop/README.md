# Spark macOS 桌面端文档

更新于 2026-11-22。本文是 Spark macOS 桌面端设计与开发交接的总入口，版本规划总览见 [版本规划](../releases/README.md)（v0.8 服务端/Web 规划与契约目前位于候选分支 `feat/v0.8.0-desktop-device-session`；桌面直登 API 候选为 `d2686d8f`）。

## 1. 当前状态（事实与目标区分）

| 部分 | 当前状态 | 依据与说明 |
| --- | --- | --- |
| 服务端桌面会话与业务白名单（v0.8-T01） | 已在功能分支完成隔离后端验证，尚未合并发布 | 固定候选 `f979ac1e3164a5845cf086e975848e10455f2144`（分支 `feat/v0.8.0-desktop-device-session`），显式迁移 `v18 → v19`，覆盖 5 分钟配对、30 天 `desktop` Bearer、白名单路由、双账号隔离、撤权与合成 OSS 三步上传；尚未执行生产发布 |
| 桌面账号登录 | 客户端与服务端已在同一隔离环境验证 | 服务端 `d2686d8f` 增加 `POST /api/v1/desktop/login`，沿用 v19 和原有设备会话。在线首次登录依赖此接口。 |
| Web `/desktop/pair` 授权页与设备管理（v0.8-T02） | 已在功能分支完成前端测试与类型生成，尚未合并发布 | 同上固定候选 `f979ac1e3164a5845cf086e975848e10455f2144`，页面支持 `#challenge=` 片段解析、4+4 比对码展示、固定设备名「Spark macOS 桌面端」与设置页单独撤销 |
| 新版 macOS 客户端（v0.8-T03 / T04） | 本地 Apple Silicon 直登候选 `e60413a6`，首批收集链路通过真机联调 | 独立 Go/Wails 模块位于 `apps/desktop/`。菜单栏随手记、离线发件箱、账号登录与钥匙串会话、手帐浏览与快搜已接通。真机证据和待验项目见下文 |
| 旧版单机 MyGo 桌面端 | **过渡保留，不作为新版基础** | 根目录 `main.go`、`mygo.json`、`internal/` 暂保留给现有用户与回退；新版桌面端不得读取、改写或自动迁移根目录真实 `data/` 目录 |

## 2. 文档地图

本目录按单一职责拆分为四份文档，互不重复；新接手开发者或 AI Agent 按下表顺序阅读即可完整复现：

| 顺序 | 文档 | 职责范围 |
| --- | --- | --- |
| 1 | 本文（`README.md`） | 定位、现状边界、文档地图与旧版 MyGo 过渡说明 |
| 2 | [DESIGN.md](DESIGN.md) | 像素级 UI 视觉规范：四套「灵光手帐」配色令牌、字号圆角阴影、菜单栏图标、悬浮随手记面板、`⌘K` 快搜、主窗口、登录表单的完整样式与状态 |
| 3 | [UX-CONTRACT.md](UX-CONTRACT.md) | 全量交互契约：隐身菜单栏、跨 Space 原地浮现与焦点归还、快捷键与中文输入法防护、剪贴板 20 秒轻建议、原生截屏、菜单栏拖拽、快搜直用、离线无感反馈与权限引导 |
| 4 | [IMPLEMENTATION.md](IMPLEMENTATION.md) | 可执行架构与开发手册：技术栈、`apps/desktop/` 目录树、安全红线、后端白名单与错误码契约、OSS 直传约束、SQLite DDL 与原子落盘、Outbox 离线状态机、AppKit/Carbon/Keychain 规格、本地 `/local/*` 桥接契约与完整测试/真机验收清单 |

关联事实来源：

- 产品定位与主线：[docs/PRODUCT.md](../PRODUCT.md)、[CONTEXT.md](../../CONTEXT.md)
- 富文本正文协议：[contracts/document.schema.json](../../contracts/document.schema.json)
- Web 视觉令牌基准：[docs/design/WEB-VISUAL.md](../design/WEB-VISUAL.md)、[apps/web/src/styles/tokens.css](../../apps/web/src/styles/tokens.css)
- 接口契约与错误语义：[docs/design/API.md](../design/API.md)、[contracts/openapi.json](../../contracts/openapi.json)

## 3. 构建并运行联网桌面候选

在 macOS 上准备 Go 1.27.3、Node.js、npm、Xcode Command Line Tools 和可写的 Go 模块缓存。本轮使用 Apple Silicon、macOS 27.2.1、Apple Clang 21、Node 23.11.0、npm 10.9.2。产物面向当前构建机架构。Go 链接器最低目标为 macOS 13.0。

从仓库根目录执行：

```sh
cd apps/desktop
make app-bundle
go vet ./...
make test
codesign --verify --deep --strict build/Spark.app
```

`make app-bundle` 先用 npm 锁文件安装桌面依赖、执行 TypeScript 检查、构建前端，再将资源嵌入 Go 程序并做本机签名。`make test` 会准备嵌入资源并运行带竞态检测的 Go 测试，其中钥匙串用例会创建、读回和清除自己的随机测试项。若系统 Go 缓存为只读，可先设置 `GOMODCACHE` 为当前用户可写目录。

联调由部署负责人提供同一 Web/API 回环源，并在使用时提供合成账号。先设置 `SPARK_TEST_ORIGIN` 为当轮提供的完整地址，再从上述模块目录启动：

```sh
export SPARK_DESKTOP_DATA_DIR="$(mktemp -d)"
export SPARK_DESKTOP_ALLOW_LOOPBACK_HTTP=1
export SPARK_DESKTOP_API_URL="${SPARK_TEST_ORIGIN:?请指定当轮隔离栈地址}"
./build/Spark.app/Contents/MacOS/Spark
```

重启恢复测试应复用第一次创建的临时目录。测试凭据按回环主机及端口使用独立 Keychain 服务。在线端需部署 `POST /api/v1/desktop/login`（后端候选 `d2686d8f`，schema v19）。首次使用在 Spark 中输入邮箱和密码，点击「登录」直接进入随手记。已有有效设备会话自动沿用。日常从菜单栏瓶子或 `⌥Space` 打开随手记，`⌘↵` 本机保存，`⌘K` 快搜，`⌘O` 打开手帐。

如有正在使用的旧包，使用 `make BUILD_DIR=build/account-login app-bundle` 将新包构建到独立目录。

## 4. 2026-11-22 验证结果

### 应用内账号登录

Apple Silicon 客户端 `e60413a6` 对接后端 `d2686d8f`。交付包位于 `apps/desktop/build/account-login/Spark-account-login-macOS-arm64.zip`。解压后校验本机临时签名，通过 `Spark.app/Contents/MacOS/Spark` 启动，macOS 枚举到随手记窗口。表单交互在同一候选源码、同一套前端资源的 Wails 测试构建上执行，使用专用数据目录与按回环端口区分的系统钥匙串。

| 情景 | 观察到的结果 |
| --- | --- |
| 首次打开、断网与错误密码 | 空目录首屏只有邮箱、密码与「登录」按钮。回环地址不可达时提示检查网络，保留邮箱、清空密码。在真实服务输入错误密码，表单提示「邮箱或密码不正确」，可在原处重试。 |
| 登录与重启 | 合成账号 A 在随手记登录，直接看到编辑器。第一条文字同步后，彻底退出测试进程再启动，系统钥匙串自动恢复 A 的随手记。 |
| 撤销与切换账号 | 独立 Web 设置撤销 A 的桌面会话返回 204。随后从桌面保存的第二条文字收到 401 并停在 A 的发件箱。改登 B 后，编辑器为空，发件箱和快搜均看不到 A 的内容，同时云端 A 有一条、B 为零。 |
| 返回原账号 | 从手帐设置断开 B，登录 A 后自动打开随手记，第二条恢复同步。部署侧核对 PostgreSQL，A 最终两条，B 为零，每条恰有一份 201 创建回执。 |
| 自动化与交付范围 | Go 竞态测试、`go vet`、TypeScript 检查和 Vite 构建通过。宿主自动化覆盖服务版本未开放、表单校验、限流等待秒数和过时表单。正式 ZIP 使用生产构建标签和 ad hoc 签名，Developer ID、公证及生产服务上的登录留待分发阶段。 |

部署侧确认三次成功直登均返回 200，未签发 Cookie。另以独立合成地址从 HTTP 直测限流，第 11 次请求返回 429 和 `Retry-After: 60`。测试应用已退出，专用钥匙串项、SQLite 目录、浏览器凭据及当轮 OrbStack 资源均已清除。

### 首批菜单栏采集与网页配对

以下配对测试记录对应先前的收集候选 `7acd1034` / `e183e70c`。

| 情景 | 实际结果 |
| --- | --- |
| 原生窗口与外观 | 标准构建通过签名和 plist 校验，使用独立空目录启动后，macOS 枚举到随手记窗口。测试构建从 AppKit 状态栏按钮动作唤出隐藏面板。实际 WKWebView 切换四套配色 × 深浅两档，得到八组对应的主色。关闭手帐后仍可唤出随手记。 |
| 离线重启与图片 | 初版 `7acd1034` 在唯一 v19 隔离栈完成真实网页批准和钥匙串兑换。停止 API 后，在随手记中提交两条合成记录（一条文字，一条带 PNG）。进程完全退出并重启，断网快搜找回两条。恢复后各有一份创建回执。部署侧核对 PNG 下载内容与原 64×48 样本逐字节相同，JPEG 缩略图为 200，桌面手帐实际解码出 64×48 图片。 |
| 同键重放与冷启动 | 在隔离 SQLite 副本中只恢复文字记录的待发状态，保留原 UUID、幂等键、冻结正文和首次发送时间。初版暴露快速回执过早通知窗口的退出竞态。修复候选 `e183e70c` 在框架启动事件后才运行同步，再次冷启动得到 `201` 和 `Idempotent-Replayed: true`，进程存活，手帐可交互并显示原两条。数据库仍为两条收藏、两份原始回执。 |
| 网页撤销 | Web 设置撤销返回 204。原生应用随后保存的第三条文字收到 401 并进入 `auth_paused`，本机保留原文，面板显示重新配对。部署侧最终核对两条收藏、两份回执、两次配对均已撤销，活跃桌面会话为零。 |
| 构建与自动化 | 桌面独立模块的 `go test -count=1 -race ./...`、`go vet ./...`、前端类型检查和生产构建均通过。覆盖真实隔离 Keychain、SQLite 重启/账号隔离、回执丢失及七天窗口。 |

联调使用同一候选源码及静态资源生成的 Wails 测试构建，在真实 AppKit/WKWebView 中驱动控件，并将配对页定向到隔离 Chrome。标准应用包使用生产构建标签。回执丢失场景由本机副本注入，API、PostgreSQL、Web 和受控对象服务执行实际请求。隔离栈、卷、合成记录、专用 Chrome 与测试钥匙串已清理。

**待验**：实际全屏、多显示器及多 Space 的焦点归还；系统输入法候选窗（已测组合事件）；屏幕录制权限授予/拒绝与实际框选；Finder 拖放、物理全局快捷键和菜单栏拖悬；Intel、macOS 13 实机兼容性以及 Developer ID、公证与分发。

## 5. 旧版单机 MyGo 桌面端（过渡保留说明）

仓库根目录仍保留旧版单机离线笔记程序（Go 1.27.3 + MyGo Native UI + SQLite，版本 `0.2.0`），供已有本机用户继续使用与回退，新版 `apps/desktop/` 与其完全隔离：

- 入口与模块：`main.go`、`mygo.json`、`internal/{app,entries,ai,db,model,urltitle,validation}/`。
- 数据隔离：旧版默认读写 `./data/spark.sqlite`（已加入 `.gitignore`）。新版桌面端必须使用独立目录（`SPARK_DESKTOP_DATA_DIR` 或 `os.UserConfigDir()/SparkDesktop`），**严禁读取、修改或清理旧版 `data/`**。
- 旧版只读验证命令（仅在涉及根目录旧代码时执行，测试须隔离 `SPARK_DATA_DIR` 与可写模块缓存）：

```bash
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
go tool mygo vet .
CGO_ENABLED=0 go test -v ./...
```
