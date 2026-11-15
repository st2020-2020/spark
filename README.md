# Spark · 随手记，慢慢想

一个真正可运行的「随手记录 + AI 自动整理」个人 MVP。使用 **Next.js App Router + TypeScript + Tailwind CSS + SQLite / better-sqlite3**，没有 Prisma，也没有 generate 步骤。

## 启动

建议使用 Node.js **22 LTS（22.19+）或 24 LTS**，以及 npm。

```bash
cd ~/ai-ws/spark
npm install
npm run dev
```

访问 **http://localhost:3000**。首次运行自动创建 SQLite 表，不需要手动迁移、初始化或配置 API key。默认仅监听本机 `127.0.0.1`。

生产模式：

```bash
npm run build
npm start
```

如果 npm 默认源不可用：`npm install --registry=https://registry.npmjs.org`。better-sqlite3 是原生模块，优先下载预编译文件；没有对应平台预编译时需要本机编译工具（macOS Xcode Command Line Tools / Linux make、g++、Python）。

## 已实现

- 文字、URL、单张图片记录；支持文字附图。提交立即插入顶部临时卡片，服务器保存后替换；失败保留输入并撤回卡片。
- 展示原始内容、来源与时间；全文在独立详情页查看，可编辑、永久删除。图片可在详情中完整查看。
- HTTP(S) URL 自动抓取 HTML title（其次 OG title）；失败仍保留原始 URL，页面说明未取到标题。
- 新建与编辑后自动生成标签和一句话摘要。默认本地关键词/规则，不依赖网络模型。
- 按标签过滤、关键词搜索原文/网页标题/摘要/标签；组合筛选状态保存在 URL。
- 首页总条目数、去重 tag 数；空态、失败反馈、上传预览、删除确认、未保存提醒、移动端单列布局。
- 数据跨进程重启保留；编辑使用版本号避免静默覆盖，旧整理结果不能覆盖新编辑。

## 数据与图片

默认所有内容（包括原始图片二进制）保存在 `data/spark.sqlite`，WAL 文件可能同目录出现；整个 `data/` 被 Git 忽略。图片通过 `/api/entries/:id/image` 读取，删除记录同时删除图片。

只接受 JPG、PNG、GIF、WebP，单张不超过 5 MB。服务端检查类型、大小及文件头；不接受 SVG。当前不做 OCR/图片理解，摘要与标签只依据文字说明，纯图片使用诚实的通用描述。

备份：先停止应用，再复制整个 `data/`。删除不可恢复，请先做好备份。更改数据目录可使用环境变量 `SPARK_DATA_DIR=/absolute/path/to/data`。

## AI provider

接口在 `src/lib/ai/provider.ts`：

```ts
interface AIProvider {
  readonly name: string;
  organize(input: OrganizeInput): Promise<{ tags: string[]; summary: string }>;
}
```

`src/lib/ai/index.ts` 选择 provider；`rules.ts` 是默认实现；`openai.ts` / `anthropic.ts` 是可切换的 HTTP 适配器。模型响应超时、key 缺失、响应不合法时均回退规则，并在详情中显示回退说明。key 只在服务端通过环境变量读取，不进入前端、不硬编码、不记录响应正文。

如需切换，复制 `.env.example` 为 `.env.local` 并设置以下任一组合，然后重启：

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=填写你自己的密钥
OPENAI_MODEL=gpt-4.1-mini
```

或：

```dotenv
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=填写你自己的密钥
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

模型名称可由环境变量替换为账号可用模型。启用远程 provider 后，会向所选服务发送记录文字与网页标题；默认 rules 不会发送给模型服务。两种远程适配器提供实现，但没有真实 key 的验收只验证规则与失败回退。

## 异步处理与边界

记录先写入 SQLite，再由 Next.js `after()` 抓取标题并整理，前端轮询更新。pending 状态持久化在数据库里，下次读取会恢复未完成任务；这是一套单进程 MVP 任务执行方式。生产扩展建议改成独立 worker/持久队列。

网页抓取限制为公网 HTTP(S)，阻止内网/回环/链路本地地址与凭据 URL；验证每次重定向并固定 DNS 结果。8 秒超时、最多 3 次跳转、最多 512 KiB HTML，不执行网页脚本。本机代理若返回 `198.18.0.0/15` Fake-IP，则通过固定的 Cloudflare HTTPS DNS 查询原始域名，只连接重新校验后的真实公网 IP，不放行合成地址或私网地址。Node 支持时也合并系统受信任 CA，以兼容本机 HTTPS 代理，仍验证 TLS 证书和主机名。需要登录、反爬、仅靠 JS 渲染、非 UTF-8 或超大页面可能拿不到标题。

当前是**单用户本机应用，无登录与访问控制**；不能直接暴露到公网。使用 Node 服务和持久可写磁盘，不能静态导出，也不适合没有持久磁盘的 serverless 实例。MVP 全量加载元数据后本地筛选，图片按需读取；大量数据时应加入服务端分页与 SQLite FTS5。

## 验证命令

```bash
npm run lint
npm run typecheck
npm test
npm run format:check
npm run build
npm run test:integration
```

集成测试启动独立生产服务（默认 `127.0.0.1:3101`，可用 `SPARK_TEST_PORT` 修改），使用临时数据库，覆盖文字/图片/URL 创建、标题抓取、摘要与标签、编辑冲突、重启持久化及删除清理，不写入你的数据。URL 标题验证需要网络可访问 `https://example.com`。

## 目录

```text
src/app/                 App Router 页面、API 与全局样式
src/components/          收件箱、详情与共享 UI
src/lib/db.ts            SQLite 自动建表与连接
src/lib/entries.ts       条目服务与异步整理
src/lib/ai/              provider 接口、规则、OpenAI/Anthropic 适配器
src/lib/url-title.ts     有超时/大小/公网限制的标题抓取
tests/                  核心行为测试
scripts/smoke.ts         生产服务集成验证
DESIGN.md                视觉 tokens 与设计约定
UX-CONTRACT.md           交互和状态约定
```

下一步：图片 OCR、独立整理队列、全文索引与分页、数据导入导出；需要跨设备访问时先加入登录与权限控制。
