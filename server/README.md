# Spark 在线后端：首个开发批次

本模块实现邀请导入、邮箱验证、邀请注册、登录与会话、密码重置、项目、文字/网址收藏、用途、人工项目关联和关键词找回。它是 ROADMAP 首批纵向流程的后端，不代表 M1–M4 全部完成。根目录 MyGo 入口与真实 `data/` 不参与本模块。

## OrbStack 开发运行

本机测试部署全部运行在 OrbStack。API、PostgreSQL、Web、迁移、管理员与开发邮件 CLI、数据库集成测试均通过同一个 Compose 运行；不使用宿主机服务替代。需要 OrbStack Docker context、已安装的 Docker Compose，以及 `server/.env` 中的独立开发凭证。`.env`、`.local/`、`bin/` 已忽略，禁止提交。

首次配置：从 `.env.example` 复制 `.env`，设置独立随机的数据库密码及两个不同的 32 字节 base64 秘密（可用 `openssl rand -base64 32` 生成），文件权限设为 `0600`。`SPARK_SECRET` 用于验证码/邀请码摘要、CSRF 和分页签名，`SPARK_ENCRYPTION_KEY` 用于短期邮件/邀请预览加密。已有数据环境必须保留对应秘密，不要在重启时重新生成。

以下命令均在 `server/` 执行，可定义一个当前 shell 函数缩短命令；它不创建脚本或新工具：

```sh
dc() { docker --context orbstack compose --env-file .env -f ../deploy/compose.dev.yaml -p spark-local "$@"; }
dc up -d postgres
dc build api test
dc run --rm tools migrate
dc up -d --build api web
dc ps
```

迁移只在显式 `tools migrate` 中执行，API 与 Worker 启动会检查应用版本和 River 迁移并拒绝未迁移的库，不会重置数据。当前版本为 `003_organization_events.sql`（版本 3）及 River 官方表迁移，重复迁移不重复执行。全新环境先迁移；已有数据的环境先备份（`dc exec -T postgres pg_dump -U spark -Fc spark_dev > .local/spark_dev.before_v3.dump`）再执行 `dc run --rm tools migrate`，从逻辑备份恢复的环境先恢复，再执行迁移。

## 文本自动整理 Worker 与 AI 路由（默认关闭）

AI 整理默认关闭：`SPARK_AI_ENABLED` 默认为 `false`，且 `worker` 位于 Compose `ai` profile 下，普通 `dc up -d` 不会启动 `worker`、API 也不会读模型密钥；保存收藏保持原有 `skipped / integration_not_configured`，手动重整返回 `503`。

如需在本机 OrbStack 联调本机 Magpie 网关（`127.0.0.1:3425`，容器内经 `http://host.docker.internal:3425/v1/chat/completions` 访问）：

1. 在已忽略目录准备只读路由配置 `server/.local/ai-routes.json`（权限 `0444`，容器以 UID `65532` 只读挂载至 `/run/spark-ai/routes.json`；配置缺失、格式错误或含预算/并发/未知字段时 `worker` 拒绝启动并退出非 0）：

```json
{
  "version": "local-deepseek-estimate-v1",
  "max_attempts": 1,
  "timeout_seconds": 30,
  "max_input_chars": 8000,
  "routes": [
    {
      "name": "primary",
      "endpoint": "http://host.docker.internal:3425/v1/chat/completions",
      "model": "codebuddy/deepseek-v4.1-flash",
      "allow_unauthenticated_development": true,
      "output_mode": "json_object",
      "max_output_tokens": 1000,
      "input_price_units_per_million_tokens": 1000000,
      "output_price_units_per_million_tokens": 2000000
    }
  ]
}
```

- 上述 `input_price_units_per_million_tokens` / `output_price_units_per_million_tokens`（单位：微元，`1e6` 微元 = 1 元）仅为按估算汇率标定的本地记账单价，不等同于供应商实收结算；`allow_unauthenticated_development` 仅允许在 `SPARK_ENV=development` 且指向 `host.docker.internal` 或回环地址时使用。生产环境严禁开启该标志，必须改用 `api_key_file`（只读挂载且 UID `65532` 可读）。
- 预算限额与并发（`worker_concurrency`）的唯一数据源为 PostgreSQL `ai_budget_config`（由管理员通过 `GET/PUT /api/v1/admin/budgets` 管理）；初始日额度为 `0`，在管理员分配额度前不会发起外部模型调用。修改 `worker_concurrency` 后需重启 `worker` 容器生效（`dc --profile ai restart worker`）。
- 仅配置已批准的主路由；若未批准或未验证第二独立厂商备用路由，不添加 `backup` 路由（双厂商切换当前未测）。

2. 显式开启并启动（仅联调时）：

```sh
SPARK_AI_ENABLED=true dc up -d api
SPARK_AI_ENABLED=true dc --profile ai up -d worker
```

`worker` 仅在容器内部 `127.0.0.1:9091/ready` 提供健康检查（不映射宿主机端口），`read_only: true`、`stop_grace_period: 30s`。

3. **完整回退（停止全部新 AI 调用）**：必须**同时**关闭 API 入队开关并停止 `worker`：

```sh
SPARK_AI_ENABLED=false dc up -d api
dc --profile ai stop worker
```

仅停止 `worker` 而不关闭 `SPARK_AI_ENABLED` 会导致新收藏继续入队并停留在 `queued`（而非 `skipped`）；仅把 `SPARK_AI_ENABLED` 改回 `false` 仅阻止新入队，已入队任务仍会被运行中的 `worker` 按当前用户授权执行。

宿主机浏览器使用 `http://127.0.0.1:5173`，Vite `/api` 代理到容器内 `http://api:8080`。`GET http://127.0.0.1:8080/api/v1/health/live` 检查进程；`/api/v1/health/ready` 检查真实 PostgreSQL 和迁移版本。没有 `/api/v1/health` 别名。PostgreSQL 仅映射 `127.0.0.1:54329`，容器使用服务名 `postgres:5432`；宿主服务端口不参与部署。

API 的 `SPARK_CONTAINER=true` 显式允许开发容器内部监听 `0.0.0.0:8080`，Compose 只映射回环地址。开发 Origin 固定为 `http://127.0.0.1:5173`，匿名写请求同样校验 Origin；不信任代理提供的客户端 IP。开发会话 Cookie 为 HttpOnly、SameSite=Lax、Path=/；仅显式 development 模式允许非 Secure Cookie。生产要求 HTTPS Origin、Secure Cookie，禁止开发邮件模式。该 Compose 是本机开发配置，不用于公网生产部署。

停止本项目服务使用 `dc stop`，保留卷；后续 `dc up -d` 继续使用数据。不要执行全局 prune，不用 `down -v` 清除已有数据，也不要把 macOS PostgreSQL 物理数据目录挂到 Linux 容器。

## 生产文字整理的小额试用

[生产 Compose](../deploy/compose.prod.yaml) 默认关闭 `SPARK_AI_ENABLED`，Worker 仅通过 `ai` profile 启动。API 和 Worker 从同一受控生产环境文件读取 `SPARK_AI_TRIAL_USER_IDS`，值为逗号分隔的账号 UUID。可从获准账号的 `GET /api/v1/auth/session` 响应中取得 `user.id`。空名单拒绝全部生产账号，非 UUID 值会导致配置校验失败。名单外账号可继续保存、编辑和人工归类。新的自动整理会跳过，主动重整返回 `403 ai_trial_not_available`，Worker 领取旧任务时也会重新检查范围。名单内账号仍须明确同意，且收藏未排除并满足材料和额度要求。

在仓库外准备生产路由 JSON 和网关调用密钥文件，分别由 `SPARK_AI_CONFIG_HOST_PATH` 和 `SPARK_AI_GATEWAY_KEY_HOST_PATH` 指定。默认路径是 `/etc/spark/ai/routes.json` 与 `/etc/spark/ai/gateway-key`。两者仅只读挂载给 Worker，须允许容器 UID/GID `65532` 读取，可使用受控目录和 `root:65532`、`0440` 文件权限。路由使用已批准的鉴权端点，`api_key_file` 指向 `/run/secrets/spark-ai-gateway-key`。Worker 不发布端口，内置健康检查读取本地就绪状态和数据库迁移状态。

首次开启前，先完成现有数据库迁移并通过管理员预算接口设置获准的小额平台和单账号日限额。在同一生产环境文件填入批准的 UUID，并将 `SPARK_AI_ENABLED` 设为 `true`。使用根 README 的 `prod` 函数部署同一镜像的 API 和 Worker。

```sh
prod build api
prod up -d --wait --no-deps api
prod --profile ai up -d --wait --no-deps worker
```

名单和开关在进程启动时读取。修改名单或停用试用时，先执行 `prod --profile ai stop worker` 并等待停止，再更新环境文件、重建 API 容器。继续试用时用新配置重建 Worker，`restart` 不会载入更新后的环境变量。

```sh
prod up -d --wait --no-deps --force-recreate api
prod --profile ai up -d --wait --no-deps --force-recreate worker
```

完全停用时将 `SPARK_AI_ENABLED` 设为 `false`，仅重建 API，Worker 保持停止。停止时已在途的请求按现有超时和结算规则收尾。排队任务和既有结果会保留，Worker 日后领取任务时按新的名单、用户同意和单条排除状态决定是否处理。

### 生产 Nginx SSE 代理说明

API 的 `GET /api/v1/organization/events` 会返回 `X-Accel-Buffering: no`、`Cache-Control: no-store, no-transform` 并每 15 秒发送心跳注释帧。若前置 Nginx 默认 `proxy_http_version 1.0` 与 `proxy_read_timeout 60s`，建议在生产启用 SSE 前为精确路由增加专用 `location` 块以避免缓冲或长连接被过早断开：

```nginx
location = /api/v1/organization/events {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 300s;
}
```

登录后的同源客户端可打开 `GET /api/v1/organization/events`。每次建连先收到 `ready`，客户端重新读取相关收藏和待确认列表，补偿断线期间的变化。`organization` 事件仅包含 `collection_id`、`status` 和 `has_suggestion`，用于提示重新查询。会话到期、撤销、账号停用、API 停机或 PostgreSQL 连接中断都会关闭相关流。流最长五分钟，空闲时每十五秒发心跳，每帧写入与 flush 期限五秒。每个 API 进程持有一个独立的 PostgreSQL LISTEN 连接，最多 256 条流、每账号最多 6 条，积压客户端会断开并通过重连补偿。

`GET /api/v1/collections?has_suggestion=true` 可按账号分页找回待确认建议。`total` 统计当前筛选命中的全部收藏，与同次分页查询共享数据库快照。建议须来自收藏的当前内容版本，收藏未删除，项目仍活动且版本匹配。该判定同时用于事件、收藏列表和详情。`SessionResult` 的 `ai_trial_eligible`、`ai_platform_enabled` 分别表示名单资格与平台开关，用户同意状态仍取自 `user.ai_enabled`。

## 管理员、邀请码和开发邮件

初始管理员通过容器 CLI 创建，密码从标准输入读取，不通过命令参数、聊天或普通日志传递。可以从权限为 `0600` 的临时密码文件输入；命令不会打印密码，已存在邮箱会拒绝创建，不会覆盖账号或提权：

```sh
dc run --rm -T tools admin admin@example.test < /path/to/private-password-file
```

随后在 Web 登录管理员，按 OpenAPI 调用 `POST /admin/invite-imports` 预览 CSV，再调用 `/admin/invite-imports/{id}/commit` 原子提交。两者均需要当前 CSRF token 和新的 Idempotency-Key。CSV 表头为 `code,expires_at,max_uses`，接受 12–64 位 ASCII 字母、数字和连字符，区分大小写；到期时间可空或为未来 RFC3339 时间，首批只支持 `max_uses=1`。最多 1,000 行，重复行、已存在代码或其他错误均阻止整批提交。预览 30 分钟后失效；原始行加密存储，成功提交后清除密文，只保留摘要和不含邀请码的审计元数据。

`SPARK_MAIL_MODE=development` **不会发送真实邮件**。验证码申请成功仅表示挑战和短期加密开发消息已保存，返回 `202` 和 `X-Spark-Mail-Adapter: development`，响应不含验证码。操作者通过容器 CLI 读取一次：

```sh
dc run --rm -T tools dev-mail CHALLENGE_ID
```

这条受控命令向操作者终端输出明确标记 `development-only` 的测试消息；不要粘贴到聊天、截图或保存到普通日志。再次读取、过期或关闭开发模式后读取均失败。没有通过 HTTP 获取验证码的接口。验证码有效 10 分钟、最多 5 次错误尝试、同邮箱/用途重发间隔 60 秒；新挑战使旧挑战失效。账号、来源限流在 PostgreSQL 维护。注册在事务中消费验证、锁定批次/代码、创建用户、兑换记录和会话，任何后续失败均回滚；重置密码撤销既有会话。

登录或注册返回 `user`、`csrf_token`、`expires_at` 并设置 `spark_session`。刷新通过 `GET /api/v1/auth/session` 恢复 CSRF；登录后的写请求都带 `X-CSRF-Token`。普通注册只能创建 `user` 角色。

本机联调的私有测试资料如已准备，位于 `.local/dev-access.json` 与 `.local/dev-invites.csv`（`0600`）；文件不是正式账号，也不会进入镜像。新环境可以自行使用上述 CLI 创建管理员并导入测试邀请码，无需这些本机文件。

通过 `dc run --rm tools maintenance` 显式清理过期邮件密文、邀请预览密文、限流和幂等记录；开发环境长期运行时按需执行。

## 当前 API 与数据语义

已实现的契约操作：

- 健康 live/ready；邮箱验证、注册、登录、当前会话、登出、会话列表/撤销、密码重置。
- 项目创建、分页、详情、版本化修改（名称、描述、关注点、活动/暂停/完成状态）。
- 收藏创建、分页筛选、详情、内容编辑、人工项目决定、已读、移入回收站/恢复、当前整理状态。
- 中文/英文关键词搜索、字面 SQL 通配字符、匹配片段、按用户与筛选绑定并签名的游标。
- 管理员邀请导入预览/提交、批次/代码列表与启用/禁用；版本化预算管理。
- AI 同意偏好、单条排除、手动重整、整理进度/结果、每日额度，以及带来源引文的单项目建议。

正文遵循共享 OpenAPI 中与 `contracts/document.schema.json` 一致的允许结构，保留原始 JSON 和派生纯文本，校验 HTTP(S) 链接、无凭据 URL、最多三层列表、10,000 个节点和原文+用途合计 50,000 Unicode 字符。未知字段/节点不会静默丢弃。网址只保存，不在请求中抓取。

项目/收藏/邀请导入创建使用幂等键；请求按规范 JSON 序列化计算摘要，幂等结果与业务写入同事务持久化；相同键不同请求返回 409，进行中的同键请求返回 409 和 Retry-After。收藏保留客户端 UUID，即使幂等记录过期也不会重复创建同一 UUID。用户业务变更先锁自己的变更计数器，再变更资源；跨用户 ID 按不存在处理，关联外键同时限制用户归属。

内容编辑只检查 `base_content_version`，人工项目操作只检查 `base_decision_version`，删除/恢复检查 `base_resource_version`，项目检查 `base_version`。冲突 409 含当前对应版本；无变化操作不增加版本。人工排除持久化为 `rejected`，不会因编辑原文或阅读状态改变而丢失。变更事件、内容历史快照与业务写入同事务保存。

列表默认每页 30、最大 100，收藏与项目按创建时间/ID 倒序稳定分页。搜索按空白拆分最多十个词，字面子串交集、英文不区分大小写，覆盖本批次已有的标题、原文、用途、网址；每条返回实际命中片段。搜索、筛选和分页都限定当前用户。回收站内容从正常列表/搜索排除并禁止编辑，保留期显示 30 天。

## 生成与验证

Go module 与构建镜像固定 Go 1.27.3，Gin 1.11.0、pgx 5.7.6；完整依赖版本见 `go.mod/go.sum`。生成器固定 oapi-codegen 2.4.1、sqlc 1.29.0。类型生成以共享 contracts 为唯一来源；`oapi-overlay.yaml` 仅将 Go `UserStatus` 类型命名为 `AccountStatusRequest`，解决与 `User.status` 枚举的名称碰撞，不改变 JSON 字段、枚举或必填性。

在容器内重新生成（绑定本模块目录接收生成文件，契约只读挂载）：

```sh
dc run --rm --no-deps -v "$PWD:/src" -v "$PWD/../contracts:/contracts:ro" test \
  go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.4.1 \
  -config oapi-codegen.yaml ../contracts/openapi.json
dc run --rm --no-deps -v "$PWD:/src" test \
  go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.29.0 generate
```

首次为集成测试创建独立数据库（已存在则无需重复）：

```sh
dc exec -T postgres createdb -U spark spark_test
dc run --rm test
dc run --rm --no-deps test go build ./...
```

test 镜像设置 `CGO_ENABLED=0`；默认运行 `go test ./... -count=1`，实际连接容器 PostgreSQL。每轮只在明确指定的 `*_test` 数据库新建独立随机 schema，空库迁移/重复迁移后测试并删除自己的 schema，不清空数据库，不使用 `spark_dev`。未设置测试 URL 时集成测试明确 skip，不能将其报告为数据库验证通过。

测试覆盖首批真实流程、响应契约校验、Origin/CSRF、双用户隔离、中文/英文/通配字符搜索、游标绑定/防篡改、并发幂等、内容冲突、决定版本、一次性邀请码并发、注册中途数据库错误的完整回滚、验证码次数、批次禁用、密码重置撤销会话。

## 范围与限制

尚未实现真实邮件投递、OSS/附件、网页提取、OCR、标签、自动采纳项目、永久删除/到期清理、完整管理后台及后续同步。相应未实现路由返回结构化 404；带附件/标签的收藏请求明确拒绝。文字整理已经使用真实 River 队列和独立 Worker，模型调用由只读平台配置选择，首批仅生成建议；平台关闭时仍明确返回 `skipped` / `integration_not_configured`。保留 30 天的字段不表示已有自动清理任务。

正式邮件缺凭证只阻止相应集成；`disabled` 模式验证码接口返回 503，不假报已发送。首批没有以仿真实现代替真实 PostgreSQL。容器中的 pgx/sqlc 与真实数据库验证和前端浏览器闭环分别报告；容量压测、真实云服务和备份恢复 RPO/RTO 属于后续验收。

## 本轮实测（2026-11-16）

OrbStack Docker 29.8.2 内以 `postgres:17.6-alpine`、`golang:1.27.3-alpine`、前端 `node:22-alpine` 完成镜像构建与启动；API 运行用户为 `65532:65532`。已有测试开发库通过逻辑备份/恢复迁入容器，随后显式迁移检查成功。宿主机旧 API 与两个 PostgreSQL 实例已停止，原目录及 `0600` 逻辑备份保留。

`dc run --rm test`（`CGO_ENABLED=0 go test ./... -count=1`，连接容器 PostgreSQL）、`go build ./...`、`go vet ./...` 均在容器通过。集成测试退出后 `spark_test` 中没有残留的本轮测试 schema。API 直连 live/ready 及经 Web 代理的 ready 均真实返回 200 / `{"status":"ok"}`；匿名会话经代理返回 401。没有将未配置的云服务或后续里程碑报告为通过；完整浏览器验收由前端会话报告。

## 文字整理的应用行为与验证

`PATCH /api/v1/me/preferences` 开启时必须带非空 `consent_version`，记录同意时间与版本；切换偏好会增加用户策略版本，不重跑历史收藏。`PUT /collections/{id}/ai-exclusion` 修改单条策略，取消排除后也不自动重跑历史；可显式 `POST /collections/{id}/organization`（需幂等键）。内容编辑或恢复时按当前授权安排新任务。新内容与运行、River 任务同事务保存，模型等待不占数据库事务。平台开关只管新入队，停止 Worker 后已经保存的运行保持真实队列状态。

手动重整复用同一输入/策略的活动运行。平台未配置返回 503 `integration_not_configured`，未同意或已排除为 403 `ai_disabled` / `ai_excluded`，无有效文字或用途为 422 `insufficient_material`，额度不足为 429 `quota_exceeded`。自动保存不因模型、额度或网关失败而丢失原文；任务可以在排队后进入 `blocked`。

Worker 只发送截断后的 `original_text` / `intent` 以及当前账号的活动项目候选，不访问材料中的 URL、不提供工具。候选集先按项目名称、描述、关注点筛选并受上下文预算裁剪。共享结果 Schema、最多一个候选、空标签、具体来源中的逐字引文与候选 ID 白名单共同校验输出；未知来源、虚假引文或跨用户项目导致 `invalid_model_output`，不会写入关联。项目建议为 `suggested`，确认/忽略继续使用既有项目人工决定接口，`evidence`、`reason`、`project_version` 供展示依据。

结果应用再次检查用户状态、内容与两种策略版本、回收站状态和最新人工决定。编辑、快速关闭再开启、排除、删除/恢复都会使旧结果失效；`manual` / `confirmed` / `rejected` 不被机器写回覆盖。手动标题优先；生成标题可参与搜索。项目版本过期时跳过该建议并安排按新项目版本的补充运行；用量不明时不自动补跑。

预算与并发只有数据库管理配置生效，配置变更保留已有预留与待核对金额；同日的新预留使用最新限额，预留统一先锁平台再锁用户。每次供应商尝试独立记录路由、配置/估价版本、实际返回的模型标识和 token 用量；费用为按声明人民币微元单价向上取整的估算，不是供应商账单。发送前确认失败、401/403、429 可释放预留并在总尝试上限内重试/切备用；发送后超时、未知 5xx 或缺用量保留 `uncertain`，不会按零成本自动切备用。缺用量但结果有效时展示 `partial / usage_uncertain`，保留可用文字；供应商返回超过声明 token 上限的计量也视为待核对。

鉴权失败会按路由配置版本持久停用路由并记录脱敏告警；修复凭证后应更换 `version` 再启动。单条运行的数据库锁、状态与应用标记防止重复执行造成重复应用；进程中断遗留的预留恢复为 `uncertain`，不自动再次收费调用。请求有超时和总尝试限制，Worker 优雅退出停止领取并完成或取消在途调用、有限时地完成结算。

`internal/backend/model_schema.gen.go` 是共享 `contracts/organization-result.schema.json` 的生成嵌入，供独立镜像强校验；修改源 Schema 后在上述容器工具环境执行以下真实代码生成（无额外验收门禁）：

```sh
dc run --rm --no-deps -v "$PWD:/src" -v "$PWD/../contracts:/contracts:ro" test \
  go run ./cmd/genmodel ../contracts/organization-result.schema.json internal/backend/model_schema.gen.go
```

新增隔离 PostgreSQL 测试覆盖 v1→v2 保留原文升级、事务入队/活动运行复用、真实 River+受控 HTTP 响应、虚假引文/未知来源/跨用户项目、并发人工排除、内容与授权竞争、平台预算竞争、零额度、同日额度调整、未知用量、主备安全切换及遗留预留恢复。这些测试中的模型响应明确为合成控制响应；真实 Magpie 调用与浏览器验收由部署、前端会话分别报告，不等同于双厂商计量/隐私或完整 M3 评测已完成。
