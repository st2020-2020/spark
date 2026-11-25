# 部署

| 文件 | 用途 |
| --- | --- |
| `compose.dev.yaml` | 本机开发：在 OrbStack 中运行 PostgreSQL、API、Worker、Web 开发服务器，以及运维工具（`tools`）与容器内测试（`test`）。操作步骤见 [server/README.md](../server/README.md) |
| `compose.prod.yaml` | 自托管生产：运行 PostgreSQL、API、可选 AI Worker（`ai` profile）与运维工具；Web 构建为静态文件，由 HTTPS 站点托管 |
| [compose.v0.4-mail.yaml](compose.v0.4-mail.yaml) | 生产邮件 Worker 共用叠加，按授权再加入 SMTP 或腾讯云 SES 叠加 |
| `compose.v0.3-oss.yaml`、`compose.v0.3-url-extract.yaml`、`compose.v0.3-image-analysis.yaml`、`compose.v0.3-purge.yaml`、`compose.v0.3-purge-oss.yaml` | v0.3 按能力拆分的生产叠加文件（对应 `asset-worker`、`url-worker`、`image-worker`、`purge-worker` 与挂载） |
| `release-prod.sh` | 生产安全发布与回退入口：基于已审核主干的不可变 commit SHA 构建、执行预检与目标锁、备份、显式迁移（如 `v3 -> v7`）、可选 Worker 启停、有界健康检查与失败回退 |
| [backup-db.sh](backup-db.sh)、[compose.recovery.yaml](compose.recovery.yaml) | 加密逻辑备份及干净隔离环境中的离线恢复 |

本机测试部署必须通过 OrbStack Compose 启动 Web、API 与数据库，不以宿主机上新建的服务替代。

## 安全模型与职责边界

- **操作员手动调用模式**：生产发布由具备 SSH 权限的操作员在本机手动执行 `deploy/release-prod.sh`；PR CI **不持有**生产 SSH 密钥、`.env` 或 AI 网关密钥。
- **不可变主干 commit 构建**：`deploy` 强制要求完整的 40 位小写十六进制 Git commit SHA（`--commit <sha40>`），校验其位于已审核主干（默认 `--trusted-ref origin/main`，且 `--mode ssh` 下禁止覆盖 `--trusted-ref`）祖先链上，并通过 `git archive` 导出构建，不把本地未提交修改或未合入分支带入生产。
- **目标端互斥与严苛 SSH**：目标目录通过 `${DEPLOY_DIR}/.release.lock` 互斥防并发；`ssh` 与 `rsync -e` 均启用 `StrictHostKeyChecking=yes` 且安全引用空参数。`preflight` 全程只读，不创建目录。
- **凭证与数据隔离**：`.env`（权限须为 `0600` 或 `0400`）、AI 路由/密钥文件及数据库备份保存在仓库和镜像之外；脚本不输出密钥内容。
- **默认关闭可选能力**：
  - 未传 `--with-worker` 时，预检要求 `SPARK_AI_ENABLED` 不得为 `true`；传入 `--with-worker` 时，强校验 `SPARK_AI_ENABLED=true`、非空 `SPARK_AI_TRIAL_USER_IDS`、路由文件存在且 `gateway-key` 权限为 `0400/0440/0600/0640`。
  - 生产邮件默认禁用。启用须在受控环境文件配置获准的提供方并传入 `--with-mail`。预检只核对设置与凭据文件元数据，不连接供应商。
  - 未传对应标志时，`SPARK_OSS_ENABLED`、`SPARK_URL_EXTRACT_ENABLED`、`SPARK_IMAGE_ANALYSIS_ENABLED`、`SPARK_PURGE_ENABLED` 均不得为 `true`。启用对应能力时：
    - `--with-oss`：校验 `SPARK_OSS_ENABLED=true`、`config.json` 存在、平台凭证权限 `0400/0440/0600/0640`，叠加 `compose.v0.3-oss.yaml` 并启停 `asset-worker`。
    - `--with-url-extract`：校验 `SPARK_URL_EXTRACT_ENABLED=true`，叠加 `compose.v0.3-url-extract.yaml` 并启停 `url-worker`（仅在审批出站规则后开启）。
    - `--with-image-analysis`：必须同时传 `--with-oss`，校验 `SPARK_IMAGE_ANALYSIS_ENABLED=true`、单个管理员 UUID `SPARK_IMAGE_ANALYSIS_ADMIN_ID` 与模型密钥权限 `0400/0440/0600/0640`，叠加 `compose.v0.3-image-analysis.yaml` 并启停 `image-worker`。
    - `--with-purge`：校验 `SPARK_PURGE_ENABLED=true`、独立的删除回执存储及首次启用的固定 UTC 到期切线。回执配置只传给 `purge-worker`，默认复用后台 OSS 配置与凭据。见 [删除回执存储](#删除回执存储)。

## 生产发布入口：`deploy/release-prod.sh`

### 1. 首次准备生产目录与环境文件

升级入口面向已有部署（例如由 v0.2.x `v3` 升级至 v0.3 `v7`）。整版完成开发、自测、联调和人工审查，功能与发布 PR 均合入主干后，由维护者推送指向发布提交的附注标签。生产入口会向 `origin` 查询标签所指提交，并在连接目标服务器前与指定 SHA 核对。操作员先在干净的已评审主干检出中执行 `git fetch origin main`，再运行本目录的脚本。

在目标服务器准备 `/opt/spark/.env`（权限 `0600`，保留在仓库之外），至少设置：

| 变量 | 说明 |
| --- | --- |
| `SPARK_ORIGIN` | 站点的 `https://` 地址 |
| `SPARK_DB_PASSWORD` | 数据库密码，可用 `openssl rand -hex 32` 生成 |
| `SPARK_SECRET` | 随机值，用 `openssl rand -base64 32` 生成 |
| `SPARK_ENCRYPTION_KEY` | 另一个独立随机值，用 `openssl rand -base64 32` 生成 |
| `SPARK_AI_ENABLED` / `SPARK_AI_TRIAL_USER_IDS` | 可选，默认 `false`；启用文字整理时设 `true` 与白名单 UUID |
| `SPARK_MAIL_MODE` | 默认 `disabled`；生产计划使用 `tencent-ses`，`smtp` 保留为独立选项。见 [邮件提供方](#邮件提供方) |
| `SPARK_OSS_ENABLED` / `SPARK_OSS_CONFIG_HOST_PATH` / `SPARK_OSS_CREDENTIALS_HOST_PATH` | 可选，默认 `false`；启用私有 OSS 时配置（凭证文件须为 `0400/0440/0600/0640`） |
| `SPARK_URL_EXTRACT_ENABLED` | 可选，默认 `false` |
| `SPARK_IMAGE_ANALYSIS_ENABLED` / `SPARK_IMAGE_ANALYSIS_KEY_HOST_PATH` | 可选，默认 `false`；需同时开启 OSS |
| `SPARK_PURGE_ENABLED` | 可选，默认 `false` |
| `SPARK_DELETION_LEDGER_BACKEND` | 缺省为 `file`，沿用原文件回执。首次使用阿里云 OSS 回执时设为 `oss`。 |
| `SPARK_DELETION_LEDGER_HOST_PATH` | 文件模式专用，默认 `/var/lib/spark-deletion-ledger`，要求独立故障域、UID `65532` 拥有、`0700` |
| `SPARK_DELETION_LEDGER_OSS_PREFIX` | 复用附件配置时必填。已获准的同桶专用前缀，以 `/` 结尾，须与附件前缀不重叠。 |
| `SPARK_DELETION_LEDGER_OSS_CONFIG_HOST_PATH` | 可选配置覆盖，默认沿用 `SPARK_OSS_CONFIG_HOST_PATH` |
| `SPARK_DELETION_LEDGER_OSS_CREDENTIALS_HOST_PATH` | 可选独立写入凭据，默认沿用 `SPARK_OSS_CREDENTIALS_HOST_PATH` |
| `SPARK_PURGE_EXPIRY_START_AT` | 首次生产启用永久删除时必填，只传给 `purge-worker`。填写已确认的 UTC 切换时刻，格式为 `YYYY-MM-DDTHH:MM:SSZ`，后续发布、重启均沿用这一值。 |

启用切线后，Worker 只自动登记已经到期且到期时间在切线及之后的笔记。切线以前已到期的笔记仍可从回收站手动恢复或显式永久删除。显式删除和已登记清理的重试继续正常处理。已经启用永久删除且没有设置切线的旧安装沿用原到期策略。

文件模式的回执存储与数据库及其备份分属独立故障域。首次使用时在隔离环境验证同目录硬链接、文件和目录 `fsync`、重连后读回。已有文件回执的部署先安排历史回执的离线恢复和重放演练，再切换回执存储。

### 2. 只读预检（不改动目标环境）

```sh
./deploy/release-prod.sh preflight \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env
```

启用文字 AI 时，预检和发布命令均追加 `--with-worker`。v0.4 沿用生产已批准的试用名单、网关只读挂载、平台及用户日额度与并发配置。验收核对 Worker 健康、试用名单仍启用及预算配置保留，避免为验收触发模型作业。回退按快照和当前环境文件决定是否启动 Worker。已运行的 Worker 会随 Docker 重启恢复。运维通过 Compose 执行 `stop worker` 后，Docker 重启时会保留停用状态；需要恢复时显式启动 Worker。

### 3. 执行不可变发布与显式迁移

从 v0.6.4 升级至 v0.6.5 需要显式迁移 schema v14 → v15。迁移前停写并验证备份可恢复。已有图片理解授权与文字整理授权分别保留，启用自动创建标签时由用户确认新版整理说明。以下示例沿用生产已开启的文字 AI、腾讯云 SES、私有 OSS 和单管理员图片理解。预检也须传入同一组能力标志。

```sh
./deploy/release-prod.sh deploy \
  --tag v0.6.5 \
  --commit <40位发布提交SHA> \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env \
  --web-dir /opt/spark/web \
  --goproxy https://mirrors.tencent.com/go,direct \
  --health-url https://spark.stwqy.cloud \
  --with-worker --with-mail --with-oss --with-image-analysis \
  --migrate \
  --verify-restore
```

`deploy` 按以下顺序执行（兼容既有 `/opt/spark` 布局；先上线新 API 与迁移，再切换静态 Web）：

1. **本地、远端预检与结构前置核对**：校验 40 位 SHA 及其对 `--trusted-ref`（默认 `origin/main`，`--mode ssh` 禁止覆盖）的可信祖先关系、Web 生产包无 `test-adapter`（可用 `--skip-web` 跳过 Web）、目标 `.env` 权限与各项启用能力对应的外部文件/账本目录、磁盘空间（≥ 1 GB）。若目标数据库版本低于构建版本（如 `v3 < v7`）但未传 `--migrate`，在修改目标前立即拒绝执行；同时拒绝隐式降级。
2. **初始备份与按次不可变回退快照**：获取 `${DEPLOY_DIR}/.release.lock` 后，独占创建 `${DEPLOY_DIR}/backups/<release-id>`（防复用），备份现有 `/opt/spark/web`、全部 `deploy/compose*.yaml`、`server/`、绑定运行中 `api` 容器镜像 ID 并打标 `spark-api:rollback-<release-id>`，同时记录 `schema.version`、原 `api.overlays` 及 `worker`/`asset-worker`/`url-worker`/`image-worker`/`purge-worker` 的 `*.was_running`；在已运行的 PostgreSQL 上执行 `pg_dump -Fc` 并校验归档目录（传 `--verify-restore` 时在唯一临时库 `spark_restore_verify_<release_id>` 实测 `pg_restore`）。
3. **构建与显式迁移切换**。将 `server/` 与全部 `deploy/compose*.yaml` 同步至当次独立的 `*.staging-<release-id>` 空目录并构建 `spark-api:prod`（含 `/spark-api`、`/spark`、`/spark-worker`）。停止全部运行中的 Worker。跨版本发布传入 `--migrate` 后，短暂停止旧 `api` 执行停写期 `pg_dump -Fc`，可选验证恢复，再运行 `tools migrate`。脚本从已审核提交的 `server/db/migrate.go` 读取目标版本，切换前后均核对 `schema_migrations` 的最大版本。v0.6.5 的目标版本为 15。
4. **有界健康检查、可选 Worker 启动与切换**：按生效的 Compose 叠加文件重建 `api` 并探测 `127.0.0.1:${API_PORT}/api/v1/health/{live,ready}`（默认上限 `--health-timeout 60` 秒）。按传入标志逐个启动对应 Worker 并检查 `healthy`，包括 `--with-mail` 选择的邮件 Worker。切换静态 Web 前保留上一版 `index.html` 引用的 `assets/*`，最后按 `--health-url` 复核公网就绪。
5. **失败后的恢复**。同步、构建或同版本切换失败时，脚本从本次快照恢复 Web、服务端文件、容器镜像和仍获授权的 Worker。自动回退出现能力差异时逐项报告，发布命令保留原失败退出码。跨版本迁移开始后，只有目标端确认迁移流程在启动服务前失败，且该 Compose 项目仅有 PostgreSQL 在运行，才允许自动还原静默期转储。若目标端的迁移结果未确认，或新 API、Worker 已可能写入，脚本以状态码 `2` 退出，保留活库、独立删除回执和 `spark.dump`。先核对服务和反向代理，优先修复后继续部署。需要还原数据时按下一节处置。

可先加 `--dry-run` 仅运行预检和本地 `git archive` 构建，不修改目标环境。

### 4. 手动回退与跨版本数据库/删除账本恢复

手动回退先读取活库和备份的结构版本。旧备份缺少 `schema.version` 时使用备份源码 `server/db/migrate.go` 中的版本。无法确定版本，或跨版本但未传 `--restore-db` 时，脚本在停服务和替换文件前退出。

```sh
./deploy/release-prod.sh rollback \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env \
  --web-dir /opt/spark/web \
  --backup-dir /opt/spark/backups/<release-id>
```

回退时指定发布日志打印的完整备份目录。脚本读取快照 `api.overlays` 和 Worker 运行标记，以及当前 `--env-file` 的能力开关。只有快照的 API 开关有效、对应 Worker 当时运行且当前开关明确为 `true`，才选择该能力的叠加文件、注入对应开关并启动 Worker。较旧的备份没有文字 AI 开关记录时，以文字 Worker 的运行标记作为快照依据。图片理解需要 OSS。回退缺少原有或当前获准的 OSS 时，也会暂停需要 OSS 的永久删除，以保留待清理任务。

已使用固定到期切线的部署回退时，只有快照保存了相同切线且快照的 Compose 支持该配置，脚本才会恢复永久删除。回退到使用全量到期扫描的快照时，API 与永久删除 Worker 的该能力保持关闭，数据库和独立删除回执继续保留。

启用 OSS 回执后的快照会保存 `deletion-ledger.oss`。同版本回退只有在快照与当前绑定一致、候选镜像可读取同一命名空间且支持 OSS 回执时才恢复永久删除。旧版快照或回执存储不可达时，回退保持永久删除关闭并返回能力差异。

当前环境文件、密钥路径和试用账号范围继续生效。冲突的开关保持关闭，逐项输出原因。手动回退恢复运行时后，如有能力差异，返回状态码 `3`。只有运行时验证通过且能力无差异时输出 `Rollback complete`。

邮件只有在快照的模式与当前授权一致、当时有邮件 Worker，且对应叠加文件和凭据就绪时才恢复。v3/v7 旧快照或模式不一致时，API 以 `disabled` 启动并按需报告能力差异。还原 v8 或更新版本的数据库快照时，先用快照镜像使旧邮件挑战及任务失效，再启动 API。手动还原同时撤销复原的登录会话。

从 schema v7 回退到 v0.2.x 的 schema v3 快照时，旧版 API 要求数据库匹配 v3，须显式追加 `--restore-db`。脚本停下 API 和 Worker，将 v7 库保存到 `${BDIR}/pre-rollback-<release_id>.dump`，然后从 `${BDIR}/spark.dump` 还原 v3 并启动旧版服务。原快照之后的写入可从回退前转储中恢复。

文件回执模式的跨版本手动还原会检查活库删除账本和独立回执目录，并在停写后复查。发现删除记录或无法检查回执时，须转入隔离恢复流程；若在停写后发现新回执，数据库仍保留原状，API 与 Worker 等待运维处置。已配置或留下 OSS 回执绑定的部署只允许离线还原数据库，包含发布失败的自动回退。普通同版本回退保留现库。

若在启用永久删除后发生数据库时间点回滚，先在隔离环境校验完整回执并重放，再单独启动 `purge-worker` 核对墓碑与对象清理。OSS 模式按 [删除回执存储](#删除回执存储) 操作。文件模式按 [永久删除与备份重放](../server/README.md#永久删除与备份重放v03-t08) 向 `tools` 只读挂载独立回执目录，执行 `/spark replay-deletions`。

### 5. 管理员与运维命令

```sh
docker compose --env-file /opt/spark/.env -f /opt/spark/deploy/compose.prod.yaml -p spark-prod \
  run --rm -T tools admin admin@example.test < /path/to/private-password-file
```

升级到 v7 后，可用下列命令重新登记已耗尽重试的到期上传清理任务。命令单次登记最多 50 条，只访问 PostgreSQL。对象操作由资产 Worker 执行。[上传清理恢复](../server/README.md#图片附件与独立资产-workerv03-t03)

```sh
docker compose --env-file /opt/spark/.env -f /opt/spark/deploy/compose.prod.yaml -p spark-prod \
  run --rm --no-deps -T tools retry-upload-cleanup
```

生产静态站点由前置 HTTPS 反向代理托管（页面路由回退到 `index.html`，同源 `/api/` 转发到 `127.0.0.1:8080` 并保留原路径）。生产启用 AI Worker 的密钥挂载及 Nginx SSE 代理配置见 [server/README.md](../server/README.md)。

## 邮件提供方

邮件上线需要获准的发件身份、生产凭据以及专用验收收件箱。迁移至 v8 后以 `--with-mail` 执行预检和发布，可与 `--with-worker` 独立组合。API 与邮件 Worker 共用数据库和 `SPARK_ENCRYPTION_KEY`；供应商设置和只读凭据只传给邮件 Worker。Worker 的容器内就绪探针为 `127.0.0.1:9091/ready`。就绪检查只确认服务可工作，真实送达以授权收件箱中各一次注册与重置邮件为准。

### 腾讯云 SES

启用时使用 `SPARK_MAIL_MODE=tencent-ses` 和 [腾讯云 SES 叠加](compose.v0.4-mail-tencent-ses.yaml)。

广州 SES 已开通，`notify.stwqy.cloud` 的 MX、SPF、DMARC 和 2048 位 DKIM 均已通过验证。发信地址已创建。以下是非秘密的生产准备参数。

| 变量 | 准备值或说明 |
| --- | --- |
| `SPARK_SES_REGION` | `ap-guangzhou` |
| `SPARK_SES_FROM` | `verify@notify.stwqy.cloud` |
| `SPARK_SES_REGISTER_TEMPLATE_ID` | `71083`。注册模板，审核中 |
| `SPARK_SES_RESET_TEMPLATE_ID` | `71084`。密码重置模板，审核中 |
| `SPARK_SES_CREDENTIALS_HOST_PATH` | 默认 `/etc/spark/mail/tencent-ses-credentials.json`，JSON 仅含 `secret_id` 和 `secret_key` |

两份模板各使用一个 `{{code}}` 变量。模板均审核通过后再按发布流程启用，真实收件验收由总控统一执行，注册和密码重置各一次。

生产发信身份只授予 `ses:SendEmail`，域名验证、模板送审及凭据分发由控制面另行授权。凭据文件置于私有目录，使用 `root:65532 0440` 或 UID 65532 的 `0400`，在 Worker 中只读挂载为 `/run/secrets/spark-ses-credentials.json`。

### SMTP

保留 SMTP 联调时使用 `SPARK_MAIL_MODE=smtp` 和 [SMTP 叠加](compose.v0.4-mail-smtp.yaml)。

| 变量 | 值 |
| --- | --- |
| `SPARK_SMTP_HOST` / `SPARK_SMTP_FROM` | SMTP 服务器证书对应的主机名和获准的纯 ASCII 发件邮箱，不含显示名称 |
| `SPARK_SMTP_TLS` / `SPARK_SMTP_PORT` | `implicit` 默认 465，或 `starttls` 默认 587。按服务商配置指定可选端口 |
| `SPARK_SMTP_CREDENTIALS_HOST_PATH` | 默认 `/etc/spark/mail/smtp-credentials.json`。使用私有目录及 `root:65532 0440` 或 UID 65532 的 `0400` 文件 |

凭据 JSON 只含 `username` 和 `password`，在邮件 Worker 中只读挂载为 `/run/secrets/spark-smtp-credentials.json`。

开发 Compose 默认保留本地开发邮件适配器。隔离联调使用合成凭据，指定私有凭据文件路径，并在 `compose.dev.yaml` 之后追加且只追加对应的提供方叠加，再显式启动 `api mail-worker`。SMTP 私有测试 CA 可另加 [compose.dev-mail-tls.yaml](compose.dev-mail-tls.yaml) 并给出 `SPARK_SMTP_CA_HOST_PATH`。生产叠加只使用系统信任根。

观察邮件 Worker 健康、队列最老待发年龄、失败及结果不明计数。用结构化日志判断错误类型和任务 ID，不记录收件人、验证码、密文、SMTP 原始响应或凭据。

## 每日加密备份与异机恢复

发布停写快照供版本回退，保留在生产主机。既有手动主机快照是独立的单次记录。日常数据库备份使用 [backup-db.sh](backup-db.sh) 的 GnuPG 公钥加密。备份进程只持有恢复公钥，解密私钥由独立恢复端保管。配置加密上传前，先确认专用备份存储、写入和恢复权限、保留期与告警责任。v0.4 边界为加密日备份、独立存储保留 30 天及每月恢复演练；附件桶的凭据不能代用。

在受控运行环境中，把专用公钥放入私有目录并提前创建 `0700` 的本地加密归档出站目录。源数据库只读，明文直接从 `pg_dump` 传给 GnuPG。默认输出本地 `0600` 密文；成功上传时另有确认。可通过 `SPARK_BACKUP_REMOTE` 指定预配置的 rclone 远端前缀，并通过 `SPARK_BACKUP_RCLONE_CONFIG` 指定受控的 `0600` 或 `0400` 配置。备份身份限于专属存储的上传及必要的对象元数据查询，保留期由存储独立控制。恢复端使用单独的只读身份。

```sh
./deploy/backup-db.sh backup spark-prod /etc/spark/backup/recovery-public.asc /var/lib/spark-encrypted-backups
```

正式调度在授权后的系统服务中每日执行同一命令，并设置上述上传参数。监控命令退出状态与最近一次成功异机保存的备份时间。本地密文在上传失败时保留，重传同一归档前核对远端对象。现有生产发布和主机快照记录不能证明每日调度、异机留存或失败告警已就绪。

生产可沿用现有 systemd。资产就绪后，以 `Type=oneshot` 的专用服务运行备份，服务的 `EnvironmentFile` 指向只读的受控上传配置。配套 timer 设置 `OnCalendar=daily` 与 `Persistent=true`。启用前须确认脚本报告异机上传成功，并从恢复身份独立取回一份归档。将上传失败和最近异机备份超过 24 小时纳入告警。

离线恢复在另一台受控主机上执行。用只读备份身份取回密文，备妥对应 PostgreSQL 主版本、受审版本的工具镜像和可恢复的应用配置。恢复环境文件权限为 `0600`，配置独立的 `SPARK_RECOVERY_DB_PASSWORD`（建议 URL 安全字符）及 `SPARK_RECOVERY_IMAGE`。使用 OSS 回执时还需配置有权读取回执的凭据和正式命名空间绑定。先启动内部网络中的空 PostgreSQL，保持 API、全部 Worker 和流量关闭。备份完整解密验证后才恢复到数据库，恢复脚本会撤销旧会话、作废验证码、清除待发密文、取消旧邮件任务。恢复端临时工作目录须在受控的加密卷上，必要时通过 `TMPDIR` 指定。

```sh
docker compose --env-file /secure/recovery.env -f deploy/compose.recovery.yaml \
  -p spark-restore-drill up -d --wait postgres
./deploy/backup-db.sh restore spark-restore-drill /secure/spark-snapshot.dump.gpg \
  /secure/recovery-keyring /secure/recovery.env
```

保持隔离并核对账号、收藏、项目及附件关联。若曾启用永久删除，从独立存储取回删除回执并按原流程重放，再核对已删对象和数据均未复活。随后按 [恢复验收](../docs/design/DELIVERY.md#测试用例矩阵) 核验应用配置和新登录，记录实际可恢复时间点以及服务重新可用耗时。数据库备份只覆盖数据库，附件与删除回执的恢复依赖各自的独立存储。

### 删除回执存储

OSS 回执默认复用附件 `oss-v2` 配置的桶、地域、官方 HTTPS 端点和附件前缀。用 `SPARK_DELETION_LEDGER_OSS_PREFIX` 明确指定同桶的私有并列前缀。例如附件使用 `spark/prod/` 时，`spark-deletion-ledger/` 可作为待核对的候选。配置实测通过后固定该前缀。附件与回执都由 Spark 后端使用受控凭据，账号之间的笔记和附件权限仍由 Spark 校验。

写入和恢复可复用现有后台 OSS 凭据文件，也可各自设置覆盖。凭据 JSON 至少含 `access_key_id` 和 `access_key_secret`，文件为 `root:65532 0440` 或 `65532 0400`，容器只读挂载。单独配置也可用，显式指定 `SPARK_DELETION_LEDGER_OSS_CONFIG_HOST_PATH` 并提供 `region`、`endpoint`、`bucket`、`prefix`、`object_prefix` 五个字段。只有完全无 OSS 附件时 `object_prefix` 才留空。

首次启用前由云管理员核对私有访问、Bucket Policy、有效 RAM 授权、版本和生命周期。桶须处于从未启用版本控制的状态。已启用和已暂停的桶都会忽略条件拒绝覆盖头。回执须在数据库备份可恢复期限内保留且可立即读取。云端有效规则须禁止回执被覆盖（含不带条件头的覆盖）或删除，并限制现有宽授权的外部主体访问该前缀。服务仍发送条件创建请求，发布探针验证并发与异体覆盖结果。[阿里云 OSS 条件写](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject) · [前缀防覆盖规则](https://www.alibabacloud.com/help/en/oss/user-guide/prevent-file-overwrite)

| 操作 | 所需范围 |
| --- | --- |
| 永久删除 Worker 归档回执 | 指定桶 `oss:GetBucketVersioning`，仅 `<prefix>receipts/*` 的 `oss:GetObject`、`oss:PutObject` |
| 离线恢复读取回执 | 指定桶 `oss:GetBucketVersioning`，`oss:ListObjects` 分别按精确的 `oss:Prefix` 限定 `<prefix>receipts/` 和 `<prefix>probes/`，以及对应前缀的 `oss:GetObject` |
| 合成探针身份 | 指定桶 `oss:GetBucketVersioning`，对 `<prefix>probes/*` 的 `oss:GetObject`、`oss:PutObject`，列表严格限定 `oss:Prefix=<prefix>probes/` |

共用身份时合并实际需要的授权。保留附件前缀的清理权限，对回执前缀逐项验证禁止覆盖、删除对象、删除版本和修改 ACL。采用独立回执凭据时，另核对附件身份在回执前缀没有写入权限。恢复工具只检查、列举和读取回执，共用的云端身份可以有其他获准权限。探针结果单独记录，正式 `receipts/*` 的有效策略由控制面核验。桶级列表权限用精确的 `oss:Prefix` 限定。[阿里云 OSS RAM 前缀授权](https://www.alibabacloud.com/help/en/oss/user-guide/access-control-base-on-ram-policy)

<details>
<summary>使用独立凭据时的 RAM 策略示例（含探针）</summary>

以下是供管理员核对或配置的两份 RAM 策略示例。将 `YOUR_BUCKET` 和示例前缀替换为实际值，分别绑定到对应身份。已有更宽的 Allow 仍可能生效，须结合桶策略和其他授权核验。两份示例包含发布前合成探针所需权限。

**回执写入身份**

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetBucketVersioning"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject", "oss:GetObject"],
      "Resource": [
        "acs:oss:*:*:YOUR_BUCKET/spark-deletion-ledger/receipts/*",
        "acs:oss:*:*:YOUR_BUCKET/spark-deletion-ledger/probes/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:ListObjects"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET"],
      "Condition": {"StringEquals": {"oss:Prefix": ["spark-deletion-ledger/probes/"]}}
    }
  ]
}
```

**恢复只读身份**

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:GetBucketVersioning"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:GetObject"],
      "Resource": [
        "acs:oss:*:*:YOUR_BUCKET/spark-deletion-ledger/receipts/*",
        "acs:oss:*:*:YOUR_BUCKET/spark-deletion-ledger/probes/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["oss:ListObjects"],
      "Resource": ["acs:oss:*:*:YOUR_BUCKET"],
      "Condition": {"StringEquals": {"oss:Prefix": [
        "spark-deletion-ledger/receipts/", "spark-deletion-ledger/probes/"
      ]}}
    }
  ]
}
```

</details>

用已审候选镜像与获准凭据运行一次 `/spark probe-deletion-ledger <新的随机UUID>`。命令只操作 `<prefix>probes/`，检查并发创建、防覆盖、内容未变和前缀限定列表。由受控恢复主机使用恢复时实际挂载的凭据运行 `verify-deletion-ledger`，回读同一探针并生成绑定。示例在 Bash 中执行，`LEDGER_CONFIG` 指向复用的附件配置或显式回执配置，`LEDGER_PREFIX` 为复用配置时的专用前缀：

```bash
umask 077
docker run --rm --read-only --pull never \
  -e SPARK_DELETION_LEDGER_BACKEND=oss \
  -e "SPARK_DELETION_LEDGER_OSS_PREFIX=${LEDGER_PREFIX:-}" \
  -v "$LEDGER_CONFIG:/run/spark-deletion-ledger/oss.json:ro" \
  -v "$PROBE_CREDENTIALS:/run/secrets/spark-deletion-ledger-oss:ro" \
  --entrypoint /spark "$REVIEWED_SPARK_IMAGE" probe-deletion-ledger "$PROBE_UUID" || exit 1
namespace="$(docker compose --env-file "$RECOVERY_ENV" \
  -f deploy/compose.recovery.yaml -f deploy/compose.recovery-ledger-oss.yaml \
  -p spark-restore-ledger-check run --rm --no-deps -T tools \
  verify-deletion-ledger "$PROBE_UUID")" || exit 1
(set -o noclobber; printf '%s\n%s\n' "$PROBE_UUID" "$namespace" > "$BINDING_FILE")
```

绑定文件两行依次保存探针 UUID 与已验证的单行命名空间 JSON。将同一文件以 `0600` 保存在部署根目录的 `deletion-ledger.oss`，并独立随恢复配置保留。保留该已验证探针供后续恢复，不重新生成探针来放行旧库。运行版本升级后发布脚本用 Worker 身份检查桶版本，并比较实际命名空间和绑定。

OSS 模式恢复环境设置 `SPARK_DELETION_LEDGER_BACKEND=oss` 及 `SPARK_DELETION_LEDGER_OSS_BINDING_HOST_PATH`（绑定文件绝对路径）。复用模式设置 `SPARK_OSS_CONFIG_HOST_PATH`、`SPARK_OSS_CREDENTIALS_HOST_PATH` 和 `SPARK_DELETION_LEDGER_OSS_PREFIX`。可通过 `SPARK_DELETION_LEDGER_OSS_CONFIG_HOST_PATH` 和 `SPARK_DELETION_LEDGER_OSS_READ_CREDENTIALS_HOST_PATH` 显式覆盖配置或凭据。只启动内部网络的 PostgreSQL。恢复脚本用短时 `tools` 容器读取并验证已知探针和绑定，再导入数据库，并使用校验时固定的配置重放回执。探针缺失、命名空间不符或 OSS 不可达时在导入前停止。若重放过程中失联，恢复库继续隔离。完成后验证删除队列、对象状态和已撤销会话，再开放流量。

每日备份即使每次成功，故障发生在下一次备份前也可能丢失近 24 小时写入；漏跑或上传失败会延长窗口。数据库 RPO 15 分钟与 RTO 2 小时仍是设计目标。RPO 需要基础备份、持续异机 WAL 归档、归档延迟监控和时间点恢复演练来证明。[数据库恢复目标](../docs/ARCHITECTURE.md#部署恢复与运行目标)

## 本地 OrbStack 隔离演练

本地演练同样从演练副本的 `origin` 核对提交和附注标签。未发布版本在临时目录创建演练专用的裸 Git 仓库，作为该副本的 `origin`，仅向这个临时仓库写入演练分支和标签。演练使用独立的 OrbStack Docker 上下文；上下文中的 `spark-api:prod` 是演练用镜像标签，须与其他发布环境分开。可使用 `--mode local --docker-context orbstack` 在独立临时目录、独立端口与独立 Compose 项目名下演练全流程（如从 `v0.2.0` `v3` 环境配合 `--migrate` 在默认关闭能力时升至 `v7`，验证 API 就绪后再显式使用 `--restore-db` 回退；不触碰 `spark-local` 与生产环境），演练结束后按 [AGENTS.md](../AGENTS.md) 清理临时项目容器、卷、镜像与临时目录：

```sh
./deploy/release-prod.sh deploy \
  --commit "<待演练40位SHA>" \
  --tag v0.3.0 \
  --trusted-ref docs/v0.3-schema-v7-release \
  --mode local \
  --docker-context orbstack \
  --project spark-v03-rel-rehearsal \
  --deploy-dir /tmp/spark-v03-rel-rehearsal \
  --api-port 18089 \
  --migrate \
  --verify-restore
```

## v0.3 外部配置与挂载

| 能力 | 叠加文件 | 对应 Worker 与启动标志 | 宿主机文件与权限要求 |
| --- | --- | --- | --- |
| 私有 OSS | [compose.v0.3-oss.yaml](compose.v0.3-oss.yaml) | `asset-worker`（`--with-oss`） | `/etc/spark/oss/config.json`（只读）、`/etc/spark/oss/credentials.json`（`root:65532` 加 `0440`，或 UID `65532` 加 `0400`，只读挂载至 `/run/secrets/spark-oss-credentials.json`） |
| 网页提取 | [compose.v0.3-url-extract.yaml](compose.v0.3-url-extract.yaml) | `url-worker`（`--with-url-extract`） | 无外部密钥（仅在审批出站策略后启用） |
| 图片理解 | [compose.v0.3-image-analysis.yaml](compose.v0.3-image-analysis.yaml) | `image-worker`（`--with-image-analysis`，须同时 `--with-oss`） | `/etc/spark/image-analysis/api-key`（`root:65532`、`0440`/`0400`、`create_host_path: false`） |
| 永久删除 | [compose.v0.3-purge.yaml](compose.v0.3-purge.yaml) → OSS 回执时 [compose.v0.10-purge-ledger-oss.yaml](compose.v0.10-purge-ledger-oss.yaml) → 有附件时 [compose.v0.3-purge-oss.yaml](compose.v0.3-purge-oss.yaml) | `purge-worker`（`--with-purge`） | 文件目录或私有 OSS 回执前缀。默认复用后台配置与凭据，可选独立覆盖。 |

OSS 使用现有平台 AK/SK 由服务端直连，同一私有桶按前缀隔离测试与生产。平台密钥通过私有文件只读挂载，`.env` 仅配置开关和宿主路径。[`oss-v2` 配置](../server/README.md#私有-oss-的外部配置与联调)

图片理解叠加文件为 API、图片 Worker 和文字 Worker 配置相同的 `SPARK_IMAGE_ANALYSIS_ENABLED` 与 `SPARK_IMAGE_ANALYSIS_ADMIN_ID`。文字 Worker 使用这两项核对图片派生材料的试用范围，继续沿用原有文字 AI 试用配置及挂载。

图片 Worker 读取与 API、文字 Worker 一致的 `SPARK_AI_ENABLED` 和 `SPARK_AI_TRIAL_USER_IDS`，识别完成时按文字整理的试用范围决定是否入队。文字整理的路由配置和模型密钥由文字 Worker 使用。

所有新能力开关在 `.env` 与 `compose.prod.yaml` 中默认关闭，系统管理员通过原有日额度控制图片与文字整理总花费。详见 [server/README.md](../server/README.md)；生产开关、真实凭证及正式发布须待全部改动合入主干并打标签后按流程执行。
