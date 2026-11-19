# 部署

| 文件 | 用途 |
| --- | --- |
| `compose.dev.yaml` | 本机开发：在 OrbStack 中运行 PostgreSQL、API、Worker、Web 开发服务器，以及运维工具（`tools`）与容器内测试（`test`）。操作步骤见 [server/README.md](../server/README.md) |
| `compose.prod.yaml` | 自托管生产：运行 PostgreSQL、API、可选 AI Worker（`ai` profile）与运维工具；Web 构建为静态文件，由 HTTPS 站点托管 |
| `release-prod.sh` | 生产安全发布与回退入口：基于已审核主干的不可变 commit SHA 构建、执行预检与目标锁、备份、免迁/显式迁移、有界健康检查与失败回退 |

本机测试部署必须通过 OrbStack Compose 启动 Web、API 与数据库，不以宿主机上新建的服务替代。

## 安全模型与职责边界

- **操作员手动调用模式**：生产发布由具备 SSH 权限的操作员在本机手动执行 `deploy/release-prod.sh`；PR CI **不持有**生产 SSH 密钥、`.env` 或 AI 网关密钥。
- **不可变主干 commit 构建**：`deploy` 强制要求完整的 40 位小写十六进制 Git commit SHA（`--commit <sha40>`），校验其位于已审核主干（默认 `--trusted-ref origin/main`，且 `--mode ssh` 下禁止覆盖 `--trusted-ref`）祖先链上，并通过 `git archive` 导出构建，不把本地未提交修改或未合入分支带入生产。
- **目标端互斥与严苛 SSH**：目标目录通过 `${DEPLOY_DIR}/.release.lock` 互斥防并发；`ssh` 与 `rsync -e` 均启用 `StrictHostKeyChecking=yes` 且安全引用空参数。`preflight` 全程只读，不创建目录。
- **凭证与数据隔离**：`.env`（权限须为 `0600` 或 `0400`）、AI 路由/密钥文件及数据库备份保存在仓库和镜像之外；脚本不输出密钥内容。
- **默认关闭 AI**：未传 `--with-worker` 时，预检要求 `SPARK_AI_ENABLED` 不得为 `true`；传入 `--with-worker` 时，预检强制校验 `SPARK_AI_ENABLED=true`、非空 `SPARK_AI_TRIAL_USER_IDS`、路由文件存在，且 `gateway-key` 权限不得对其他用户可读（如 `0440`、`0400`）。

## 生产发布入口：`deploy/release-prod.sh`

### 1. 首次准备生产目录与环境文件

升级入口面向已有 v3 数据库、API 和静态站点的部署。操作员先在干净的已评审主干检出中执行 `git fetch origin main`，再运行本目录的脚本。

在目标服务器准备 `/opt/spark/.env`（权限 `0600`，保留在仓库之外），至少设置：

| 变量 | 说明 |
| --- | --- |
| `SPARK_ORIGIN` | 站点的 `https://` 地址 |
| `SPARK_DB_PASSWORD` | 数据库密码，可用 `openssl rand -hex 32` 生成 |
| `SPARK_SECRET` | 随机值，用 `openssl rand -base64 32` 生成 |
| `SPARK_ENCRYPTION_KEY` | 另一个独立随机值，用 `openssl rand -base64 32` 生成 |
| `SPARK_AI_ENABLED` | 可选，默认 `false`；启用试用时设为 `true` |
| `SPARK_AI_TRIAL_USER_IDS` | 启用 AI 时必填，逗号分隔的授权账号 UUID |

### 2. 只读预检（不改动目标环境）

```sh
./deploy/release-prod.sh preflight \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env
```

目标已启用 AI 时，预检、发布和回退命令均追加 `--with-worker`。

### 3. 执行不可变发布（兼容 `/opt/spark` 与 Worker）

```sh
./deploy/release-prod.sh deploy \
  --commit <40位已审核commit-SHA> \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env \
  --web-dir /opt/spark/web \
  --goproxy https://mirrors.tencent.com/go,direct \
  --health-url https://spark.stwqy.cloud \
  --verify-restore
```

`deploy` 按以下顺序执行（兼容既有 `/opt/spark` 布局；先上线兼容旧 Web 的 API，再切换静态 Web）：

1. **本地与远端预检**：校验 40 位 SHA 及其对 `--trusted-ref`（默认 `origin/main`，`--mode ssh` 禁止覆盖）的可信祖先关系、Web 生产包无 `test-adapter`（可用 `--skip-web` 跳过 Web）、目标 `.env` 权限与必填项、磁盘空间（≥ 1 GB，不创建目录）。
2. **备份与按次不可变回退快照**：获取 `${DEPLOY_DIR}/.release.lock` 后，独占创建 `${DEPLOY_DIR}/backups/<release-id>`（防复用），备份现有 `/opt/spark/web`、`deploy/compose.prod.yaml`、`server/`，绑定运行中 `api` 容器镜像 ID 并打标 `spark-api:rollback-<release-id>`，同时记录 `worker` 先前是否运行；在已运行的 PostgreSQL 上执行 `pg_dump -Fc` 并校验归档目录（传 `--verify-restore` 时仅在 `createdb` 成功后注册清理并在唯一临时库 `spark_restore_verify_<release_id>` 实测 `pg_restore`）。
3. **构建与已有 v3 库校验**：将构建物上传到当次独立的 `*.staging-<release-id>` 空目录；在目标构建 `spark-api:prod`（含 `/spark-api`、`/spark`、`/spark-worker`），若存在运行中的 Worker 先优雅停止；T11 假定目标库已处于既有 `v3` 结构，只校验 `schema_migrations` 版本匹配（不自动建库或升级）。
4. **有界健康检查、旧静态资源保留与切换**：通过 `compose up --wait --wait-timeout` 与 `docker inspect` 状态校验重建 `api` 并带超时探测 `127.0.0.1:${API_PORT}/api/v1/health/{live,ready}`（默认上限 `--health-timeout 60` 秒）；传 `--with-worker` 时再重建并等待 `worker` 健康；切换静态 Web 目录前保留上一版 `index.html` 引用的 `assets/*` 以兼容在途浏览器页签，最后按 `--health-url` 带超时复核公网就绪。
5. **全链路失败自动回退**：上传阶段、构建/校验、健康检查或 `--health-url` 公网校验任意一步失败时，自动还原静态 Web、仅按 `worker.was_running` 决定是否恢复 `worker`、恢复旧版 `compose.prod.yaml` / `server/` 与运行中 `api` 镜像快照并重建 `api`；数据库备份保留在 `${DEPLOY_DIR}/backups/<release-id>/spark.dump`。

可先加 `--dry-run` 仅运行预检和本地 `git archive` 构建，不修改目标环境。

### 4. 手动回退

回退时先还原静态 Web，再停 Worker 并恢复上一版镜像与配置：

```sh
./deploy/release-prod.sh rollback \
  --host ubuntu@<server-ip> \
  --ssh-key ~/.ssh/id_ed25519 \
  --deploy-dir /opt/spark \
  --env-file /opt/spark/.env \
  --web-dir /opt/spark/web \
  --backup-dir /opt/spark/backups/<release-id>
```

回退时指定该次发布打印的完整备份目录。若同时需要回退数据库结构，请先确认影响范围，再使用备份目录中的 `spark.dump` 手动执行 `pg_restore`。

### 5. 首次创建管理员与可选 AI Worker

```sh
docker compose --env-file /opt/spark/.env -f /opt/spark/deploy/compose.prod.yaml -p spark-prod \
  run --rm -T tools admin admin@example.test < /path/to/private-password-file
```

生产静态站点由前置 HTTPS 反向代理托管（页面路由回退到 `index.html`，同源 `/api/` 转发到 `127.0.0.1:8080` 并保留原路径）。生产启用 AI Worker 的密钥挂载及 Nginx SSE 代理配置见 [server/README.md](../server/README.md)。

## 本地 OrbStack 隔离演练

演练使用独立的 OrbStack Docker 上下文；上下文中的 `spark-api:prod` 是演练用镜像标签，须与其他发布环境分开。可使用 `--mode local --docker-context orbstack` 在独立临时目录、独立端口与独立 Compose 项目名下演练全流程（不触碰 `spark-local` 与生产环境），演练结束后按 [AGENTS.md](../AGENTS.md) 清理临时项目容器、卷、镜像与临时目录：

```sh
./deploy/release-prod.sh deploy \
  --commit "$(git rev-parse origin/main)" \
  --mode local \
  --docker-context orbstack \
  --project spark-prod-rehearsal \
  --deploy-dir /tmp/spark-prod-rehearsal \
  --api-port 8080 \
  --verify-restore
```
