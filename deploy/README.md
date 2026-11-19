# 部署

| 文件 | 用途 |
| --- | --- |
| `compose.dev.yaml` | 本机开发：在 OrbStack 中运行 PostgreSQL、API、Worker、Web 开发服务器，以及运维工具（`tools`）与容器内测试（`test`）。操作步骤见 [server/README.md](../server/README.md) |
| `compose.prod.yaml` | 自托管生产：运行 PostgreSQL、API、可选 AI Worker（`ai` profile）与运维工具；Web 构建为静态文件，由 HTTPS 站点托管 |
| `compose.v0.3-oss.yaml`、`compose.v0.3-url-extract.yaml`、`compose.v0.3-image-analysis.yaml`、`compose.v0.3-purge.yaml`、`compose.v0.3-purge-oss.yaml` | v0.3 按能力拆分的生产叠加文件（对应 `asset-worker`、`url-worker`、`image-worker`、`purge-worker` 与挂载） |
| `release-prod.sh` | 生产安全发布与回退入口：基于已审核主干的不可变 commit SHA 构建、执行预检与目标锁、备份、显式迁移（如 `v3 -> v7`）、可选 Worker 启停、有界健康检查与失败回退 |

本机测试部署必须通过 OrbStack Compose 启动 Web、API 与数据库，不以宿主机上新建的服务替代。

## 安全模型与职责边界

- **操作员手动调用模式**：生产发布由具备 SSH 权限的操作员在本机手动执行 `deploy/release-prod.sh`；PR CI **不持有**生产 SSH 密钥、`.env` 或 AI 网关密钥。
- **不可变主干 commit 构建**：`deploy` 强制要求完整的 40 位小写十六进制 Git commit SHA（`--commit <sha40>`），校验其位于已审核主干（默认 `--trusted-ref origin/main`，且 `--mode ssh` 下禁止覆盖 `--trusted-ref`）祖先链上，并通过 `git archive` 导出构建，不把本地未提交修改或未合入分支带入生产。
- **目标端互斥与严苛 SSH**：目标目录通过 `${DEPLOY_DIR}/.release.lock` 互斥防并发；`ssh` 与 `rsync -e` 均启用 `StrictHostKeyChecking=yes` 且安全引用空参数。`preflight` 全程只读，不创建目录。
- **凭证与数据隔离**：`.env`（权限须为 `0600` 或 `0400`）、AI 路由/密钥文件及数据库备份保存在仓库和镜像之外；脚本不输出密钥内容。
- **默认关闭可选能力**：
  - 未传 `--with-worker` 时，预检要求 `SPARK_AI_ENABLED` 不得为 `true`；传入 `--with-worker` 时，强校验 `SPARK_AI_ENABLED=true`、非空 `SPARK_AI_TRIAL_USER_IDS`、路由文件存在且 `gateway-key` 权限为 `0400/0440/0600/0640`。
  - 未传对应标志时，`SPARK_OSS_ENABLED`、`SPARK_URL_EXTRACT_ENABLED`、`SPARK_IMAGE_ANALYSIS_ENABLED`、`SPARK_PURGE_ENABLED` 均不得为 `true`。启用对应能力时：
    - `--with-oss`：校验 `SPARK_OSS_ENABLED=true`、`config.json` 存在、平台凭证权限 `0400/0440/0600/0640`，叠加 `compose.v0.3-oss.yaml` 并启停 `asset-worker`。
    - `--with-url-extract`：校验 `SPARK_URL_EXTRACT_ENABLED=true`，叠加 `compose.v0.3-url-extract.yaml` 并启停 `url-worker`（仅在审批出站规则后开启）。
    - `--with-image-analysis`：必须同时传 `--with-oss`，校验 `SPARK_IMAGE_ANALYSIS_ENABLED=true` 与模型密钥权限 `0400/0440/0600/0640`，叠加 `compose.v0.3-image-analysis.yaml` 并启停 `image-worker`。
    - `--with-purge`：校验 `SPARK_PURGE_ENABLED=true` 与独立故障域的删除回执目录（`SPARK_DELETION_LEDGER_HOST_PATH`，默认 `/var/lib/spark-deletion-ledger`）存在且权限严格为 `0700`（UID `65532` 拥有），叠加 `compose.v0.3-purge.yaml`（若同时 `--with-oss` 则追加 `compose.v0.3-purge-oss.yaml`）并启停 `purge-worker`。

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
| `SPARK_OSS_ENABLED` / `SPARK_OSS_CONFIG_HOST_PATH` / `SPARK_OSS_CREDENTIALS_HOST_PATH` | 可选，默认 `false`；启用私有 OSS 时配置（凭证文件须为 `0400/0440/0600/0640`） |
| `SPARK_URL_EXTRACT_ENABLED` | 可选，默认 `false` |
| `SPARK_IMAGE_ANALYSIS_ENABLED` / `SPARK_IMAGE_ANALYSIS_KEY_HOST_PATH` | 可选，默认 `false`；需同时开启 OSS |
| `SPARK_PURGE_ENABLED` / `SPARK_DELETION_LEDGER_HOST_PATH` | 可选，默认 `false`；启用时须提前备好 `0700` 独立账本目录（UID `65532`） |

### 2. 只读预检（不改动目标环境）

```sh
./deploy/release-prod.sh preflight \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env
```

启用文字 AI 时，预检和发布命令均追加 `--with-worker`。回退按快照和当前环境文件决定是否启动 Worker。已运行的 Worker 会随 Docker 重启恢复。运维通过 Compose 执行 `stop worker` 后，Docker 重启时会保留停用状态；需要恢复时显式启动 Worker。

### 3. 执行不可变发布与显式迁移（兼容 `/opt/spark` 与可选 v0.3 Worker）

由 v0.2.x（schema v3）首次升级至 v0.3（schema v7，含迁移 `007_extraction_keys_upload_cleanup.sql`）须显式传入 `--migrate`。只升级 schema 时，保持外部能力开关为 `false` 或留空。外部密钥和目录准备就绪后，可另行启用相应能力并使用对应的 `--with-*` 标志。

```sh
./deploy/release-prod.sh deploy \
  --tag v0.3.0 \
  --commit <40位发布提交SHA> \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env \
  --web-dir /opt/spark/web \
  --goproxy https://mirrors.tencent.com/go,direct \
  --health-url https://spark.stwqy.cloud \
  --migrate \
  --verify-restore
```

`deploy` 按以下顺序执行（兼容既有 `/opt/spark` 布局；先上线新 API 与迁移，再切换静态 Web）：

1. **本地、远端预检与结构前置核对**：校验 40 位 SHA 及其对 `--trusted-ref`（默认 `origin/main`，`--mode ssh` 禁止覆盖）的可信祖先关系、Web 生产包无 `test-adapter`（可用 `--skip-web` 跳过 Web）、目标 `.env` 权限与各项启用能力对应的外部文件/账本目录、磁盘空间（≥ 1 GB）。若目标数据库版本低于构建版本（如 `v3 < v7`）但未传 `--migrate`，在修改目标前立即拒绝执行；同时拒绝隐式降级。
2. **初始备份与按次不可变回退快照**：获取 `${DEPLOY_DIR}/.release.lock` 后，独占创建 `${DEPLOY_DIR}/backups/<release-id>`（防复用），备份现有 `/opt/spark/web`、全部 `deploy/compose*.yaml`、`server/`、绑定运行中 `api` 容器镜像 ID 并打标 `spark-api:rollback-<release-id>`，同时记录 `schema.version`、原 `api.overlays` 及 `worker`/`asset-worker`/`url-worker`/`image-worker`/`purge-worker` 的 `*.was_running`；在已运行的 PostgreSQL 上执行 `pg_dump -Fc` 并校验归档目录（传 `--verify-restore` 时在唯一临时库 `spark_restore_verify_<release_id>` 实测 `pg_restore`）。
3. **构建与显式 `v3 -> v7` 迁移切换**：将 `server/` 与全部 `deploy/compose*.yaml` 同步至当次独立的 `*.staging-<release-id>` 空目录并构建 `spark-api:prod`（含 `/spark-api`、`/spark`、`/spark-worker`）。停止全部运行中的 Worker；当需要跨版本迁移（如 `v3 -> v7`）且已传 `--migrate` 时，短暂停止旧 `api` 执行静默期 `pg_dump -Fc`（确保 `spark.dump` 之后零新写入）并可选验证恢复，再运行 `tools migrate`。脚本从已审核提交的 `server/db/migrate.go` 读取目标版本，切换前后均以此比较 `schema_migrations` 中的最大版本。验收 v0.3 时预期为 `7`。
4. **有界健康检查、可选 Worker 启动与切换**：按生效的 Compose 叠加文件重建 `api` 并探测 `127.0.0.1:${API_PORT}/api/v1/health/{live,ready}`（默认上限 `--health-timeout 60` 秒）；随后按传入标志（`--with-worker` / `--with-oss` / `--with-url-extract` / `--with-image-analysis` / `--with-purge`）逐个启动对应 Worker 并检查 `healthy`；切换静态 Web 目录前保留上一版 `index.html` 引用的 `assets/*`，最后按 `--health-url` 复核公网就绪。
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

当前环境文件、密钥路径和试用账号范围继续生效。冲突的开关保持关闭，逐项输出原因。手动回退恢复运行时后，如有能力差异，返回状态码 `3`。只有运行时验证通过且能力无差异时输出 `Rollback complete`。

从 schema v7 回退到 v0.2.x 的 schema v3 快照时，旧版 API 要求数据库匹配 v3，须显式追加 `--restore-db`。脚本停下 API 和 Worker，将 v7 库保存到 `${BDIR}/pre-rollback-<release_id>.dump`，然后从 `${BDIR}/spark.dump` 还原 v3 并启动旧版服务。原快照之后的写入可从回退前转储中恢复。

跨版本手动还原会检查活库删除账本和独立回执目录，并在停写后复查。发现删除记录或无法检查回执时，须转入隔离恢复流程；若在停写后发现新回执，数据库仍保留原状，API 与 Worker 等待运维处置。

若在启用永久删除（T08）后发生数据库时间点回滚，务必在恢复数据库并执行迁移后、开放用户流量前，按 [永久删除与备份重放](../server/README.md#永久删除与备份重放v03-t08) 向 `tools` 只读挂载独立账本目录执行 `/spark replay-deletions`，并单独启动 `purge-worker` 核对墓碑、对象清理和撤销旧会话/授权。

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
| 永久删除 | [compose.v0.3-purge.yaml](compose.v0.3-purge.yaml)（有 OSS 时叠加 [compose.v0.3-purge-oss.yaml](compose.v0.3-purge-oss.yaml)） | `purge-worker`（`--with-purge`） | `/var/lib/spark-deletion-ledger`（与数据库备份分属不同故障域，UID `65532` 拥有且权限 `0700`） |

OSS 使用现有平台 AK/SK 由服务端直连，同一私有桶按前缀隔离测试与生产。平台密钥通过私有文件只读挂载，`.env` 仅配置开关和宿主路径。[`oss-v2` 配置](../server/README.md#私有-oss-的外部配置与联调)

所有新能力开关在 `.env` 与 `compose.prod.yaml` 中默认关闭，系统管理员通过原有日额度控制图片与文字整理总花费。详见 [server/README.md](../server/README.md)；生产开关、真实凭证及正式发布须待全部改动合入主干并打标签后按流程执行。
