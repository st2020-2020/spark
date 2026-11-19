# Spark · 随手记，慢慢想

Spark 帮助个人随手收藏文字和网址，关联正在进行的项目，在需要时通过搜索找回。桌面版还支持保存单张图片和自动整理。

Android 分享客户端源码位于 [apps/android](apps/android/README.md)。首版支持从系统分享菜单收藏文字和网址，安装包需在有 Android SDK 的机器上构建。

## 在线版

在线版由 React 前端、Go API 和 PostgreSQL 组成。当前支持登录和会话、项目、文字和网址收藏、手动关联项目、关键词搜索、回收站恢复，以及管理员导入邀请码。开发环境可用开发邮件适配器联调邀请注册和密码重置。平台可提供文字 AI 整理：用户同意后，后台可生成标题、摘要和带原文引文的项目建议，用户无需配置模型密钥。该功能默认关闭，已在隔离环境完成单路由真实模型联调。启用方式见[后端运行说明](server/README.md)。真实邮件、附件存储、网页正文提取和 OCR 仍待接入。

### 本机开发

需要 OrbStack 和 Docker Compose。从仓库根目录进入 `server/`，按[后端运行说明](server/README.md)建立本地 `.env`、启动容器并执行首次数据库迁移。启动后打开 `http://127.0.0.1:5173`。后端说明也包含初始管理员、开发邮件和数据库集成测试的操作；前端依赖和检查命令见 [Web README](apps/web/README.md)。

### 自托管部署

[生产 Compose](deploy/compose.prod.yaml)运行 API 和 PostgreSQL。准备独立的生产环境文件（权限 `0600`），设置 HTTPS 地址 `SPARK_ORIGIN`、数据库密码 `SPARK_DB_PASSWORD` 和两个独立的随机值 `SPARK_SECRET`、`SPARK_ENCRYPTION_KEY`。数据库密码可用 `openssl rand -hex 32` 生成，两个随机值分别用 `openssl rand -base64 32` 生成。环境文件、凭证和数据备份应保存在仓库外。

从仓库根目录执行以下命令，将环境文件路径替换为实际位置：

```sh
prod() { docker compose --env-file /path/to/production.env -f deploy/compose.prod.yaml "$@"; }
prod up -d --wait postgres
prod build api
prod run --rm tools migrate
prod up -d --wait api
```

在 `apps/web/` 运行 `npm ci` 和 `npm run build`，由 HTTPS 站点托管 `dist/`。前端页面路由回退到 `index.html`，同源 `/api/` 则转发到 `127.0.0.1:8080` 并保留原请求路径。通过 `/api/v1/health/ready` 检查 API 和数据库是否就绪。

首个管理员可通过 `prod run --rm -T tools admin admin@example.test < /path/to/private-password-file` 创建，随后从 `/login` 登录并在 `/admin` 管理邀请码。生产配置默认禁用邮件，邮箱验证、自助注册和密码重置暂不可用。

## 产品与开发文档

- [开发交接入口](docs/HANDOFF.md) 提供阅读顺序、决策状态、详细设计和接口契约。
- [领域词汇](CONTEXT.md) 定义收藏、项目、标签与关联。
- [在线版产品需求](docs/PRODUCT.md) 记录已确定方向、建议默认值和首发场景。
- [系统架构](docs/ARCHITECTURE.md) 定义数据、接口、异步处理、同步与部署方案。
- [开发计划](docs/ROADMAP.md) 列出里程碑、任务依赖和验收条件。

## 桌面版

桌面版使用 MyGo Native UI、Go 和 SQLite。开发需要 macOS 和 Go 1.27.3 或更高版本。MyGo CLI 版本由 `go.mod` 指定，通过 `go tool mygo` 运行。以下命令从仓库根目录执行。

### 开发运行

```bash
go run .
```

MyGo 也提供热重载开发模式。

```bash
go tool mygo dev .
```

### 打包 macOS 原生应用

```bash
# 生成 Spark.app（build/darwin-arm64/Spark.app）
go tool mygo build -skip-dmg -o build .

# 包含 .dmg 磁盘映像
go tool mygo build -o build .
```

### 已实现功能

- **原生 GPU 界面（MyGo Native UI / Metal）**：左侧工作空间栏（笔记/标签统计、近 12 周本地活跃热力图、标签导航）+ 右侧单列笔记流与独立详情视图。
- **快速记录**：支持文字、HTTP(S) 链接与单张图片（文件选择或剪贴板直接 `⌘V` 粘贴），支持 `⌘ + Enter`（或 `Ctrl + Enter`）快捷保存，`⌘N` 聚焦录入，`⌘F` 聚焦搜索。
- **本地 SQLite 持久化**使用 `modernc.org/sqlite`，开启 WAL 模式。数据目录优先使用 `SPARK_DATA_DIR`。从仓库启动时默认使用 `./data`，从其他目录启动时优先使用已有的 `./data`，否则使用 `os.UserConfigDir()/Spark`。
- **图片校验与保存**：仅接受 JPG、PNG、GIF、WebP（检查文件头魔数与 5 MB 上限），二进制保存于 SQLite，删除记录同步清理。
- **SSRF 防护网页标题抓取**：自动抓取 HTTP(S) URL 的 `<title>` 或 `og:title`（阻止内网/回环/链路本地/凭据 URL 与 `198.18.0.0/15` 合成地址，固定解析 IP 并校验每次重定向，8 秒超时、最多 3 跳、512 KiB 上限）。
- **自动整理与可选 AI Provider**：默认使用本地中文/英文规则引擎（识别 `#标签` 与关键词分组并生成摘要）；也支持在 `.env.local` 中配置 `AI_PROVIDER=openai` 或 `anthropic`，超时或密钥缺失时自动回退规则引擎并标记提示。
- **编辑冲突与草稿保护**：编辑使用乐观锁版本号防止并发覆盖；详情页未保存修改时返回或切换标签会弹出确认对话框。

### AI Provider 配置

默认使用本地规则整理。接入远程模型时，将 `.env.example` 复制为 `.env.local`，选择一组配置并填入密钥。启用后会向所选服务发送用于整理的笔记文本和网页标题。

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=填写你自己的密钥
OPENAI_MODEL=gpt-4.1-mini
```

也可以选择 Anthropic。

```dotenv
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=填写你自己的密钥
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### 验证命令

```bash
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
go tool mygo vet .
CGO_ENABLED=0 go test -v ./...
```

## 目录结构

```text
main.go                      桌面应用入口、菜单与窗口初始化
mygo.json                    MyGo 应用与打包配置
apps/web/                    React Web 前端
server/                      Go API、PostgreSQL 迁移与管理 CLI
contracts/                   OpenAPI 和共享 JSON Schema
deploy/                      本机开发与生产 Compose 配置
docs/                        产品、架构与交付文档
internal/model/              Entry / Organization 等领域模型
internal/validation/         内容长度、URL 提取与图片魔数校验
internal/db/                 纯 Go SQLite 连接与自动建表
internal/urltitle/           SSRF 防护的 HTML 标题抓取
internal/ai/                 AI Provider 接口、规则引擎与 OpenAI/Anthropic 适配器
internal/entries/            条目 CRUD、乐观锁与后台异步整理调度
internal/app/                MyGo Native UI 视图、主题、图标与 ui.Tester 测试
```
