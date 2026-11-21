# Spark 在线后端

API 提供邀请注册、邮箱验证、登录与密码找回、资料收集、项目归类、搜索和个人数据导出。邮件、AI 整理、附件、网页提取和永久删除由独立 Worker 按部署配置启用。

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

迁移只在显式 `tools migrate` 中执行，API 与 Worker 启动会检查应用版本和 River 迁移并拒绝未迁移的库，不会重置数据。当前版本为 `009_revisit.sql`（版本 9）及 River 官方表迁移，重复迁移不重复执行。全新环境先迁移；已有数据的环境先备份（`dc exec -T postgres pg_dump -U spark -Fc spark_dev > .local/spark_dev.before_v9.dump`）再执行 `dc run --rm tools migrate`，从逻辑备份恢复的环境先恢复，再执行迁移。

## 图片附件与独立资产 Worker（v0.3-T03）

`SPARK_OSS_ENABLED` 默认关闭，API 在关闭时可直接启动，文字和网址收藏照常可用。开启时，API 签发上传和下载 URL。独立的 `/spark-worker assets` 只消费 River 的 `attachments` 队列，执行图片确认和上传到期清理。它使用 `DATABASE_URL`，独立在容器内提供 `127.0.0.1:9091/ready`。`/spark-worker healthcheck` 可用于两个 Worker 服务。文字 AI 的进程、开关、账号范围和同意规则沿用原配置。图片理解使用独立 Worker 与授权。

按 T01 的 OSS 叠加配置给 API 和资产 Worker 只读挂载 `oss-v2` 配置与现有平台 AK/SK。服务端连接私有桶并为已认证用户签发短时 URL。运行时通过 `SPARK_OSS_CONFIG_FILE` 读取配置，路径默认为 `/run/spark-oss/config.json`。平台凭据默认从 `/run/secrets/spark-oss-credentials.json` 读取，包含 `access_key_id` 和 `access_key_secret`。预置文件的其他元数据可保留。Tools 和仅启用文字 AI 的 Worker 无需挂载。

- 直传授权仅覆盖暂存键 `<prefix>users/{user_id}/uploads/{upload_id}`，签名包含 MIME 和浏览器随 Blob 发送的 Content-Length。幂等记录只存上传 ID。签名最长 PUT 600 秒、GET 300 秒。GET 授权仅覆盖该账号的已确认对象。
- 确认接口事务化登记验证任务并返回 202。资产 Worker 将暂存对象复制到仅服务端可写的 `<prefix>users/{user_id}/attachments/{upload_id}`，对最终对象完整读回、校验 5 MiB 上限和声明 MIME 并计算 SHA-256。单图长边最多 8,192 像素、总像素最多 16 Mi，GIF 另限 512 帧及累计 32 Mi 像素。客户端可在授权到期前重放暂存键的 PUT。最终对象由服务端写入。
- 上传记录从创建起保留 24 小时，清理任务与上传记录同时持久化。临时授权最晚在清理前 15 分钟失效。清理未绑定的最终对象以及所有到期的暂存对象，删除成功后移除未绑定记录。共用桶的接入前缀须能实删对象，首批由未开启版本控制的桶验证和上线。版本控制桶的旧版本清理另行验收。
- 中国内地新开通 OSS 的 Bucket 需要使用绑定 HTTPS 的自定义访问域名执行公网数据操作。内联图片的预览也使用该域名。CORS 放行实际 Web Origin、PUT 和授权返回的头。 [阿里云自定义域名说明](https://www.alibabacloud.com/help/zh/oss/user-guide/access-buckets-via-custom-domain-names)

对象存储故障导致清理任务耗尽重试后，恢复存储连接并在同一数据库运行 `dc run --rm tools retry-upload-cleanup`。每次最多登记 50 条已到期且无活动作业的上传，输出实际登记数。该命令只使用数据库。资产 Worker 对已绑定记录仅清理暂存对象，对未绑定记录也清理最终对象。已成功清理的暂存步骤跨重试保留。

## 网页信息提取（v0.3-T06）

`SPARK_URL_EXTRACT_ENABLED` 默认关闭。启用后，保存或编辑收藏只在 PostgreSQL 事务内记录主要网址和提取任务。独立的 `/spark-worker urls` 消费 `url_extraction` 队列并负责 HTTP 请求。该进程只需要数据库连接和抓取开关。同一镜像可分别运行文字整理、资产和网页提取，URL Worker 无需模型、OCR 或 OSS 文件。开启开关不会全量回填历史收藏，单条可通过提取接口重新获取。

仅在运维批准抓取出口并确认出站规则后叠加 [网页提取 Compose](../deploy/compose.v0.3-url-extract.yaml)。出口规则应覆盖内部域名、服务网络、云实例元数据和部署自身不应从抓取进程访问的地址。应用只使用系统 DNS，逐跳校验所有解析结果并用校验过的 IP 直连。代理环境变量、应用会话和用户提交的凭据不参与请求。请求限 HTTP(S) 80/443 端口、最多 3 次重定向、每次任务尝试 8 秒、解压及字符解码后各最多 2 MiB。网络暂时失败最多尝试 3 次。日志保留任务标识和错误类别。特殊用途地址筛选参考 [IPv4 登记表](https://www.iana.org/assignments/iana-ipv4-special-registry/) 与 [IPv6 登记表](https://www.iana.org/assignments/iana-ipv6-special-registry/)。

本地已获授权的 Compose 环境可在同一项目中启用 API 与 URL Worker。使用开发镜像时设置 `SPARK_API_IMAGE=spark-api:dev`，并让 `SPARK_DB_NAME=spark_dev` 或显式提供同库的 `SPARK_URL_WORKER_DATABASE_URL`。叠加后以 `SPARK_URL_EXTRACT_ENABLED=true` 启动 `api url-worker`。回退时将 API 开关恢复为 false，并停止 `url-worker`，已经保存的收藏和成功结果保留。隔离集成测试使用合成 HTTP 响应和测试专用 DNS、拨号入口。

## 图片理解（v0.3-T05）

图片理解默认关闭。在已有 OSS 配置的独立环境，可叠加 [compose.v0.3-image-analysis.yaml](../deploy/compose.v0.3-image-analysis.yaml)，使用 `--profile image-analysis` 启动 `image-worker`，同时给 API 和 Worker 设置 `SPARK_IMAGE_ANALYSIS_ENABLED=true`。Worker 运行 `/spark-worker images`，读取已确认版本的最终对象并重新校验大小和 SHA-256。供应商密钥只由该进程通过 `SPARK_IMAGE_ANALYSIS_KEY_FILE` 读入。生产端点固定为 DeepSeek Chat Completions。开发可用 `SPARK_IMAGE_ANALYSIS_ENDPOINT` 指向同容器的回环 HTTP 端点。

模型收到重新编码的视觉副本。JPEG、PNG 和 WebP 应用 EXIF 方向后剥离元数据，GIF 在副本符合大小限制时保留帧与时间。副本超出 5 MiB 时使用有界的静态副本。原始 OSS 对象及收藏下载保持原样。

图片理解按平台开关、账号的独立图片授权、单条排除与共享额度决定是否派发。`SPARK_AI_TRIAL_USER_IDS` 只限定文字整理。需要限定为测试账号的首次真实图片试用，应在隔离环境使用合成图片和小额预算。

只有用户通过独立图片授权后新绑定的附件才派发。每图向 `deepseek-flash` 发送一次内联图片和固定提示，显式关闭思考，上限为输入 1536 token 和输出 512 token，按高峰未命中价预留 7168 微元。发送后无法确认用量的记录维持 `uncertain` 并占用预留。供应商报告超出批准上限时保留待核对额度并阻止该配置继续派发。合成端点用于验证协议和预算行为。厂商账单、识别质量及试用额度在真实试用前核定。[DeepSeek 图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/) [DeepSeek 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

## 永久删除与备份重放（v0.3-T08）

`SPARK_PURGE_ENABLED` 默认关闭。启用时，API 在同一事务登记删除、记录变更并写入 River，收藏立即离开回收站。独立的 `/spark-worker purge` 每日扫描已到 30 天的回收站记录，并重入队未完成的清理。手动及到期删除使用同一流程。已经接受的请求可通过 [清理状态接口](../docs/design/API.md#永久删除与状态) 查到。

启用前为 `purge-worker` 挂载和 PostgreSQL 备份分属不同故障域的独立持久存储。创建专用目录，归运行 UID 65532 所有，权限 `0700`。使用 [删除 Compose 叠加](../deploy/compose.v0.3-purge.yaml)，设置 `SPARK_DELETION_LEDGER_HOST_PATH` 和同库的 `SPARK_PURGE_WORKER_DATABASE_URL`，并以 `SPARK_PURGE_ENABLED=true` 启动 `api purge-worker`。开发镜像用 `SPARK_API_IMAGE=spark-api:dev` 和 `SPARK_ENV=development`。保存过图片时追加 [清理 OSS 叠加](../deploy/compose.v0.3-purge-oss.yaml)，沿用图片存储的专属前缀与最小删除权限。文字收藏清理可独立运行。

Worker 先把只含操作 ID、归属、时间和对象清理计划的回执写入独立目录。回执采用 `0600` 权限，文件和目录条目持久化后才删数据。清理顺序与重试见 [数据设计](../docs/design/DATA.md#删除与恢复)。独立回执留存覆盖最早可恢复备份及其校验期。

恢复时先在隔离环境还原 PostgreSQL 备份与对应对象数据并执行迁移。在 API 和处理任务停止时，向 `tools` 只读挂载完整独立账本目录，设置 `SPARK_DELETION_LEDGER_DIR`，在恢复库上执行 `/spark replay-deletions`。该命令还原墓碑、删除恢复库中的旧数据并持久排队对象清理。然后只对恢复环境启动清理 Worker，核对所有已重放操作完成、撤销旧会话与授权并检查附件引用后再开放流量。重复重放可继续恢复流程。 如果回执含对象而恢复库缺少对应账号，命令会以非零退出并输出操作 ID。保持环境离线，核对 PostgreSQL 与对象备份是否配对，解决该回执涉及的对象后再开放流量。

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

## 验证邮件（v0.4-T02）

启用外部渠道前先迁移到 `008_mail_delivery.sql`。API 和独立 `/spark-worker mail` 共用数据库、`SPARK_ENCRYPTION_KEY` 及同一个 `SPARK_MAIL_MODE`。API 只需渠道模式，在同一事务保存挑战、加密载荷和仅含挑战 ID 的 River 任务。渠道配置和只读凭证文件只注入邮件 Worker。邮件 Worker 与 AI 和 OSS 独立，健康检查沿用 `/spark-worker healthcheck` 和 `127.0.0.1:9091/ready`。

### 腾讯云 SES

`SPARK_MAIL_MODE=tencent-ses` 使用官方 Go SDK 调用固定的 `https://ses.tencentcloudapi.com/`。两个模板均须在所选地域审核通过，唯一变量为 `code`。单次只发送给一个收件人，`TriggerType=1`。发件账号只需调用 `ses:SendEmail` 的权限。

| Worker 设置 | 值 |
| --- | --- |
| `SPARK_SES_REGION` | SES 资源所在地域，`ap-guangzhou` 或 `ap-hongkong` |
| `SPARK_SES_FROM` | 已验证发件地址，填写不带别名的 ASCII 邮箱 |
| `SPARK_SES_REGISTER_TEMPLATE_ID` | 审核通过的注册验证码模板 ID |
| `SPARK_SES_RESET_TEMPLATE_ID` | 审核通过的密码重置验证码模板 ID |
| `SPARK_SES_CREDENTIALS_FILE` | Worker 内读取的 JSON 文件，字段为 `secret_id` 和 `secret_key` |

SES 验证 HTTPS 证书，关闭 SDK 重试、区域回退、重定向和调试日志。腾讯云明确返回限频拒绝时由 River 安排重试。断线、异常 HTTP 状态、无法解析的响应或缺少受理标识时，保留 `uncertain` 并停止自动投递。腾讯云返回有效受理标识仅表示供应商接受了请求。

### SMTP

`SPARK_MAIL_MODE=smtp` 使用 SMTP，凭证文件为 JSON，包含 `username` 和 `password`。

| Worker 设置 | 值 |
| --- | --- |
| `SPARK_SMTP_HOST` | SMTP 服务器证书对应域名 |
| `SPARK_SMTP_TLS` | `implicit` 默认走 TLS 465，`starttls` 默认走 587 并强制升级 |
| `SPARK_SMTP_PORT` | 可选，覆盖上述端口 |
| `SPARK_SMTP_FROM` | 验证邮件的发件地址 |
| `SPARK_SMTP_CREDENTIALS_FILE` | 邮件 Worker 内只读凭证文件的路径 |
| `SPARK_SMTP_CA_FILE` | 可选的 PEM 信任根，供受控环境验证 |

身份和证书链始终验证，最低 TLS 1.2。AUTH PLAIN 只在 TLS 建立后进行。SMTP 发送中文纯文本和 HTML。最终接收回复丢失时保留 `uncertain`。

### 重发、切换与恢复

两种外部渠道的 `202` 均表示请求已持久受理，供应商接收时间记为 `delivered_at`。验证码 60 秒后可重发，有效期 10 分钟，最多试 5 次。现有 `development` 模式保留本地一次性读取，`disabled` 返回 `503`。

邮件 Worker 单并发，两种外部渠道共用平台限额，每 10 分钟最多接收 20 个新挑战，每 UTC 日最多 120 个，并受现有邮箱和来源限流。River 最多运行三次尝试，退避约 20 秒和 60 秒。Worker 临发复核挑战是否仍有效，明确拒收且挑战仍有效时才恢复密文安排重试。崩溃或结果不明后的任务不会自动重发，用户可按正常间隔申请新验证码。运维日志记录挑战 ID 和固定故障类别。

切换渠道时先停止旧邮件 Worker，再对齐 API 和新 Worker 的模式。加密载荷保留申请时的渠道，Worker 取消渠道不匹配的待发任务。同一个任务不会因切换渠道而改投。

恢复备份时保持 API 和邮件 Worker 停止，在离线恢复库运行 `/spark invalidate-restored-mail`。该命令取消恢复出的邮件队列并作废旧验证码，输出影响数量。完成恢复检查后再启用流量和邮件 Worker，由用户申请新验证码。停用外部投递时将 API 模式改为 `disabled`，并停止邮件 Worker。

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

Go module 与构建镜像固定 Go 1.27.4，Gin 1.11.0、pgx 5.9.2；完整依赖版本见 `go.mod/go.sum`。生成器固定 oapi-codegen 2.4.1、sqlc 1.29.0。类型生成以共享 contracts 为唯一来源；`oapi-overlay.yaml` 仅将 Go `UserStatus` 类型命名为 `AccountStatusRequest`，解决与 `User.status` 枚举的名称碰撞，不改变 JSON 字段、枚举或必填性。

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

SMTP 邮件 Worker 已在受控 TLS 邮件服务上验证注册与密码找回。生产启用须配置发件身份并验证实际收件。标签、自动采纳项目、完整管理后台及后续同步仍在规划中。文字整理使用 River 和独立 Worker，平台关闭时返回 `skipped` / `integration_not_configured`。图片附件、图片理解、网页提取和永久删除按各自能力开关配置。

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

## 私有 OSS 的外部配置与联调

测试与生产使用同一个私有桶，通过不同的 Spark 专属前缀隔离。前缀须非空、以 `/` 结尾，每段仅含字母、数字、下划线或连字符。测试使用 `spark/test-v03/<随机ID>/`，生产使用独立前缀。浏览器的 PUT 使用 `<prefix>users/{user_id}/uploads/{upload_id}`，资产 Worker 写入 `<prefix>users/{user_id}/attachments/{upload_id}`。

### 连接配置

宿主机默认配置文件为 `/etc/spark/oss/config.json`。配置需要以下字段：

```json
{
  "version": "oss-v2",
  "oss_region": "cn-shanghai",
  "oss_endpoint": "https://oss-cn-shanghai.aliyuncs.com",
  "bucket": "example-private-bucket",
  "prefix": "spark/test-v03/example-run/",
  "put_ttl_seconds": 600,
  "get_ttl_seconds": 300
}
```

`oss_region` 和 `oss_endpoint` 分别传给 OSS SDK。使用桶绑定的 HTTPS 自定义域名时，将该域名设为 `oss_endpoint`，并设置可选字段 `oss_use_cname: true`，默认值为 `false`。针对中国内地新开通 OSS 的公网访问要求，按[自定义域名说明](https://www.alibabacloud.com/help/zh/oss/user-guide/access-buckets-via-custom-domain-names)核对实际端点。可选字段 `credentials_file` 是容器内的文件路径。使用现有 Compose 叠加时省略该字段即可采用默认路径，也可显式填入 `/run/secrets/spark-oss-credentials.json`。宿主路径通过 `SPARK_OSS_CREDENTIALS_HOST_PATH` 覆盖。

### 凭据和访问范围

使用同一已有平台 AK/SK，宿主机默认凭据文件为 `/etc/spark/oss/credentials.json`。以私有权限保存，供容器 UID `65532` 读取，例如 `root:65532` 和 `0440`。原预置 JSON 文件需包含 `access_key_id` 和 `access_key_secret`，其他预置元数据可保留。服务端使用这两项直连 OSS。把凭据留在受控主机，环境文件仅记录宿主路径。

核对该平台身份在获准桶与前缀上的 `oss:PutObject`、`oss:GetObject` 和 `oss:DeleteObject` 权限。应用按配置前缀生成对象键。浏览器只收到按对象、方法和时效签发的 URL。平台身份的权限范围由云端策略决定。核对桶的私有 ACL、阻止公共访问和版本控制状态。CORS 的 `AllowedOrigins` 填实际 Web 的精确 Origin，并放行 `PUT` 和签名所需的请求头。浏览器需要跨域读取下载响应时也放行 `GET`。

### 服务挂载范围

API 和资产 Worker 只读挂载 OSS 配置及平台凭据。图片 Worker 启用时使用同一 OSS 挂载读取已确认的对象，同时独占图片分析密钥。永久删除启用且使用 OSS 时，清理 Worker 同样只读挂载 OSS 文件。文字整理 Worker 继续使用自己的模型配置。[发布说明](../deploy/README.md)

### 真实供应商联调

按已获准的桶、测试前缀、OSS 地域、HTTPS 端点、私有访问和精确 Origin 配置隔离环境。凭据文件沿用受控主机的现有平台密钥。用合成图验证直传、校验、下载和已登记键的删除。图片理解单独使用获准的合成样本、试用预算及仅挂载到图片 Worker 的试用密钥。

### 本地合成配置隔离校验

在本地 OrbStack 仅使用合成占位配置（禁止真实凭证）叠加验证挂载、只读权限与服务健康：

```sh
docker --context orbstack compose \
  --env-file server/.env \
  -f deploy/compose.dev.yaml \
  -f deploy/compose.v0.3-oss.yaml \
  config --quiet
```
