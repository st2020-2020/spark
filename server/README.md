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

迁移只在显式 `tools migrate` 中执行，API 启动会检查版本并拒绝未迁移的库，不会重置数据。当前版本为 `001_initial.sql`（版本 1），重复迁移不重复执行。全新环境先迁移；从已有逻辑备份恢复的环境先恢复，再执行迁移。

宿主机浏览器使用 `http://127.0.0.1:5173`，Vite `/api` 代理到容器内 `http://api:8080`。`GET http://127.0.0.1:8080/api/v1/health/live` 检查进程；`/api/v1/health/ready` 检查真实 PostgreSQL 和迁移版本。没有 `/api/v1/health` 别名。PostgreSQL 仅映射 `127.0.0.1:54329`，容器使用服务名 `postgres:5432`；宿主服务端口不参与部署。

API 的 `SPARK_CONTAINER=true` 显式允许开发容器内部监听 `0.0.0.0:8080`，Compose 只映射回环地址。开发 Origin 固定为 `http://127.0.0.1:5173`，匿名写请求同样校验 Origin；不信任代理提供的客户端 IP。开发会话 Cookie 为 HttpOnly、SameSite=Lax、Path=/；仅显式 development 模式允许非 Secure Cookie。生产要求 HTTPS Origin、Secure Cookie，禁止开发邮件模式。该 Compose 是本机开发配置，不用于公网生产部署。

停止本项目服务使用 `dc stop`，保留卷；后续 `dc up -d` 继续使用数据。不要执行全局 prune，不用 `down -v` 清除已有数据，也不要把 macOS PostgreSQL 物理数据目录挂到 Linux 容器。

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
- 管理员邀请导入预览/提交、批次/代码列表与启用/禁用。

正文遵循共享 OpenAPI 中与 `contracts/document.schema.json` 一致的允许结构，保留原始 JSON 和派生纯文本，校验 HTTP(S) 链接、无凭据 URL、最多三层列表、10,000 个节点和原文+用途合计 50,000 Unicode 字符。未知字段/节点不会静默丢弃。网址只保存，不在请求中抓取。

项目/收藏/邀请导入创建使用幂等键；请求按规范 JSON 序列化计算摘要，幂等结果与业务写入同事务持久化；相同键不同请求返回 409，进行中的同键请求返回 409 和 Retry-After。收藏保留客户端 UUID，即使幂等记录过期也不会重复创建同一 UUID。用户业务变更先锁自己的变更计数器，再变更资源；跨用户 ID 按不存在处理，关联外键同时限制用户归属。

内容编辑只检查 `base_content_version`，人工项目操作只检查 `base_decision_version`，删除/恢复检查 `base_resource_version`，项目检查 `base_version`。冲突 409 含当前对应版本；无变化操作不增加版本。人工排除持久化为 `rejected`，不会因编辑原文或阅读状态改变而丢失。变更事件、内容历史快照与业务写入同事务保存。

列表默认每页 30、最大 100，收藏与项目按创建时间/ID 倒序稳定分页。搜索按空白拆分最多十个词，字面子串交集、英文不区分大小写，覆盖本批次已有的标题、原文、用途、网址；每条返回实际命中片段。搜索、筛选和分页都限定当前用户。回收站内容从正常列表/搜索排除并禁止编辑，保留期显示 30 天。

## 生成与验证

Go module 与构建镜像固定 Go 1.27.3，Gin 1.11.0、pgx 5.7.6；完整依赖版本见 `go.mod/go.sum`。生成器固定 oapi-codegen 2.4.1、sqlc 1.29.0。共享 contracts 只读；`oapi-overlay.yaml` 仅将 Go `UserStatus` 类型命名为 `AccountStatusRequest`，解决与 `User.status` 枚举的名称碰撞，不改变 JSON 字段、枚举或必填性。

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

尚未实现真实邮件投递、OSS/附件、网页提取、OCR、模型、River Worker/自动整理、标签、AI 偏好与预算、永久删除/到期清理、完整管理后台及后续同步。相应未实现路由返回结构化 404；带附件/标签的收藏请求明确拒绝。当前收藏原文可靠落库，整理状态始终明确为 `skipped` / `integration_not_configured`，没有虚构队列任务或模型成功。保留 30 天的字段不表示已有自动清理任务。

正式邮件缺凭证只阻止相应集成；`disabled` 模式验证码接口返回 503，不假报已发送。首批没有以仿真实现代替真实 PostgreSQL。容器中的 pgx/sqlc 与真实数据库验证和前端浏览器闭环分别报告；容量压测、真实云服务和备份恢复 RPO/RTO 属于后续验收。

## 本轮实测（2026-11-16）

OrbStack Docker 29.8.2 内以 `postgres:17.6-alpine`、`golang:1.27.3-alpine`、前端 `node:22-alpine` 完成镜像构建与启动；API 运行用户为 `65532:65532`。已有测试开发库通过逻辑备份/恢复迁入容器，随后显式迁移检查成功。宿主机旧 API 与两个 PostgreSQL 实例已停止，原目录及 `0600` 逻辑备份保留。

`dc run --rm test`（`CGO_ENABLED=0 go test ./... -count=1`，连接容器 PostgreSQL）、`go build ./...`、`go vet ./...` 均在容器通过。集成测试退出后 `spark_test` 中没有残留的本轮测试 schema。API 直连 live/ready 及经 Web 代理的 ready 均真实返回 200 / `{"status":"ok"}`；匿名会话经代理返回 401。没有将未配置的云服务或后续里程碑报告为通过；完整浏览器验收由前端会话报告。
