# 部署

| 文件 | 用途 |
| --- | --- |
| `compose.dev.yaml` | 本机开发：在 OrbStack 中运行 PostgreSQL、API、Worker、Web 开发服务器，以及运维工具（`tools`）与容器内测试（`test`）。操作步骤见 [server/README.md](../server/README.md) |
| `compose.prod.yaml` | 自托管生产：运行 PostgreSQL、API、Worker 与运维工具；Web 构建为静态文件，由 HTTPS 站点托管 |

本机测试部署必须通过 OrbStack Compose 启动 Web、API 与数据库，不以宿主机上新建的服务替代。

## 自托管生产部署

### 1. 准备环境文件

在仓库之外准备独立的生产环境文件（权限 `0600`），至少设置：

| 变量 | 说明 |
| --- | --- |
| `SPARK_ORIGIN` | 站点的 HTTPS 地址 |
| `SPARK_DB_PASSWORD` | 数据库密码，可用 `openssl rand -hex 32` 生成 |
| `SPARK_SECRET` | 随机值，用 `openssl rand -base64 32` 生成 |
| `SPARK_ENCRYPTION_KEY` | 另一个独立随机值，用 `openssl rand -base64 32` 生成 |

环境文件、凭证与数据备份都保存在仓库之外。

### 2. 启动服务

在仓库根目录执行，将环境文件路径替换为实际位置：

```sh
prod() { docker compose --env-file /path/to/production.env -f deploy/compose.prod.yaml "$@"; }
prod up -d --wait postgres
prod build api
prod run --rm tools migrate
prod up -d --wait api
```

### 3. 发布 Web

在 `apps/web/` 运行 `npm ci` 与 `npm run build`，由 HTTPS 站点托管 `dist/`：页面路由回退到 `index.html`，同源 `/api/` 转发到 `127.0.0.1:8080` 并保留原请求路径。通过 `/api/v1/health/ready` 检查 API 与数据库是否就绪。

### 4. 创建首个管理员

```sh
prod run --rm -T tools admin admin@example.test < /path/to/private-password-file
```

随后从 `/login` 登录，在 `/admin` 管理邀请码。生产配置默认禁用邮件，邮箱验证、自助注册与密码重置在接入邮件服务前不可用。

平台 AI 整理默认关闭，启用方式与运维命令见 [server/README.md](../server/README.md)。
