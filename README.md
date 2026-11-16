# Spark · 随手记，慢慢想

Spark 是 macOS 原生卡片笔记应用。窗口、菜单和界面使用 **MyGo Native UI**，业务逻辑和 SQLite 驱动使用纯 Go。界面开发沿用 `github.com/egoist/mygo/ui`。

## 启动与打包

开发需要 Go 1.27.3 或更高版本。MyGo CLI 版本由 `go.mod` 指定，通过 `go tool mygo` 运行。

### 开发运行

```bash
cd ~/ai-ws/spark
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

## 已实现功能

- **原生 GPU 界面（MyGo Native UI / Metal）**：左侧工作空间栏（笔记/标签统计、近 12 周本地活跃热力图、标签导航）+ 右侧单列笔记流与独立详情视图。
- **快速记录**：支持文字、HTTP(S) 链接与单张图片（文件选择或剪贴板直接 `⌘V` 粘贴），支持 `⌘ + Enter`（或 `Ctrl + Enter`）快捷保存，`⌘N` 聚焦录入，`⌘F` 聚焦搜索。
- **本地 SQLite 持久化**使用 `modernc.org/sqlite`，开启 WAL 模式。数据目录优先使用 `SPARK_DATA_DIR`。从仓库启动时默认使用 `./data`，从其他目录启动时优先使用已有的 `./data`，否则使用 `os.UserConfigDir()/Spark`。
- **图片校验与保存**：仅接受 JPG、PNG、GIF、WebP（检查文件头魔数与 5 MB 上限），二进制保存于 SQLite，删除记录同步清理。
- **SSRF 防护网页标题抓取**：自动抓取 HTTP(S) URL 的 `<title>` 或 `og:title`（阻止内网/回环/链路本地/凭据 URL 与 `198.18.0.0/15` 合成地址，固定解析 IP 并校验每次重定向，8 秒超时、最多 3 跳、512 KiB 上限）。
- **自动整理与可选 AI Provider**：默认使用本地中文/英文规则引擎（识别 `#标签` 与关键词分组并生成摘要）；也支持在 `.env.local` 中配置 `AI_PROVIDER=openai` 或 `anthropic`，超时或密钥缺失时自动回退规则引擎并标记提示。
- **编辑冲突与草稿保护**：编辑使用乐观锁版本号防止并发覆盖；详情页未保存修改时返回或切换标签会弹出确认对话框。

## AI Provider 配置

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

## 验证命令

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
internal/model/              Entry / Organization 等领域模型
internal/validation/         内容长度、URL 提取与图片魔数校验
internal/db/                 纯 Go SQLite 连接与自动建表
internal/urltitle/           SSRF 防护的 HTML 标题抓取
internal/ai/                 AI Provider 接口、规则引擎与 OpenAI/Anthropic 适配器
internal/entries/            条目 CRUD、乐观锁与后台异步整理调度
internal/app/                MyGo Native UI 视图、主题、图标与 ui.Tester 测试
```
