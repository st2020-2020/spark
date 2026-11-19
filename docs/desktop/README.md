# Spark 桌面版（MyGo）

桌面版是本机单用户的卡片笔记应用，使用 MyGo Native UI、Go 与 SQLite。它是后续联网桌面客户端的基础（ROADMAP M6），当前与在线版数据互不相通。

| 文档 | 内容 |
| --- | --- |
| 本文 | 运行、打包、功能、AI 配置与验证命令 |
| [DESIGN.md](DESIGN.md) | 桌面界面的配色、字号、布局与组件 |
| [UX-CONTRACT.md](UX-CONTRACT.md) | 桌面录入、浏览、编辑与删除的交互约定 |

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `main.go`、`mygo.json` | 应用入口、菜单与窗口；MyGo 应用与打包配置 |
| `internal/app/` | MyGo Native UI 视图、主题、图标与 `ui.Tester` 测试 |
| `internal/entries/` | 条目增删改查、乐观锁与后台异步整理调度 |
| `internal/ai/` | AI Provider 接口、本地规则引擎与 OpenAI / Anthropic 适配器 |
| `internal/db/` | 纯 Go SQLite 连接与自动建表 |
| `internal/model/` | Entry、Organization 等领域模型 |
| `internal/urltitle/` | 带 SSRF 防护的网页标题抓取 |
| `internal/validation/` | 内容长度、网址提取与图片魔数校验 |

## 运行与打包

需要 macOS 与 Go 1.27.3 或更高版本。MyGo CLI 版本由 `go.mod` 指定，通过 `go tool mygo` 运行。以下命令在仓库根目录执行。

```bash
go run .                          # 开发运行
go tool mygo dev .                # 热重载开发模式
go tool mygo build -skip-dmg -o build .   # 生成 build/darwin-arm64/Spark.app
go tool mygo build -o build .             # 同时生成 .dmg
```

## 功能

- **原生界面**：左侧工作空间栏（笔记与标签统计、近 12 周活跃热力图、标签导航）与右侧单列笔记流、独立详情视图。
- **快速记录**：文字、HTTP(S) 链接与单张图片（文件选择或 `⌘V` 粘贴）；`⌘Enter` / `Ctrl+Enter` 保存，`⌘N` 聚焦录入，`⌘F` 聚焦搜索。
- **本地持久化**：`modernc.org/sqlite`，开启 WAL。数据目录优先使用 `SPARK_DATA_DIR`；从仓库启动默认 `./data`；从其他目录启动时优先已有的 `./data`，否则使用 `os.UserConfigDir()/Spark`。
- **图片校验**：仅接受 JPEG、PNG、GIF、WebP（文件头魔数与 5 MB 上限），二进制随条目存于 SQLite，删除时一并清理。
- **网页标题抓取**：读取 `<title>` 或 `og:title`；阻止内网、回环、链路本地、带凭据网址与 `198.18.0.0/15`，固定解析 IP 并校验每次重定向；8 秒超时、最多 3 跳、512 KiB 上限。
- **自动整理**：默认本地中英文规则引擎（识别 `#标签`、关键词分组并生成摘要）；可选远程模型，超时或缺少密钥时回退规则引擎并提示。
- **编辑保护**：乐观锁版本号防止并发覆盖；详情有未保存修改时，返回或切换会先确认。

> 仓库内的 `data/` 是真实使用数据，已被忽略。开发与测试不得读取、改写或清空它。

## AI Provider 配置

默认使用本地规则整理。接入远程模型时，将根目录 `.env.example` 复制为 `.env.local` 并填入密钥（`.env.local` 已被忽略，不得提交）。启用后会把用于整理的笔记文本和网页标题发送给所选服务。

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=填写你自己的密钥
OPENAI_MODEL=gpt-4.1-mini
```

```dotenv
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=填写你自己的密钥
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

## 验证

```bash
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
go tool mygo vet .
CGO_ENABLED=0 go test -v ./...
```

界面测试使用 MyGo `ui.Tester`（`internal/app/app_test.go`），存储测试使用临时 SQLite（`internal/entries/service_test.go`）。
