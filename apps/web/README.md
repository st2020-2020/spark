# Spark Web (`apps/web`)

Spark 在线邀请内测版 Web 前端，基于 React、TypeScript、Vite、React Router、TanStack Query 与受限 Tiptap 编辑器构建，接口类型由 `contracts/openapi.json` 生成。

## 依赖安装与类型生成

```bash
cd apps/web
npm ci
npm run gen:types
```

`npm run gen:types` 读取 `../../contracts/openapi.json` 生成 `src/api/schema.d.ts`。

## 本地开发与容器联调

默认配置对接本地后端 `http://127.0.0.1:8080`：

- 开发服务器固定监听端口 `5173`（`strictPort: true`），主机地址由 `VITE_DEV_HOST` 控制（默认 `127.0.0.1`，容器内设为 `0.0.0.0`）
- `/api` 通过 Vite proxy 转发至 `VITE_API_PROXY_TARGET`（默认 `http://127.0.0.1:8080`，容器内可设为后端服务名如 `http://api:8080`）
- 健康检查调用契约定义的 `GET /api/v1/health/live` 与 `GET /api/v1/health/ready`
- 会话启动时通过 `GET /api/v1/auth/session` 恢复账号与 `csrf_token`，写请求携带 `X-CSRF-Token`

启动真实联调模式（默认）：

```bash
npm run dev
```

容器（OrbStack Compose）启动参考：

- `Dockerfile`: `apps/web/Dockerfile`（基于 `node:22-alpine`，`npm ci`，默认 `CMD ["npm", "run", "dev"]`）
- 环境变量：`VITE_DEV_HOST=0.0.0.0`、`VITE_API_PROXY_TARGET=http://<backend-service>:8080`
- 端口映射：`127.0.0.1:5173:5173`（宿主机浏览器继续访问 `http://127.0.0.1:5173`）

### 测试适配器模式（仅本地开发/测试隔离使用）

当后端尚未启动时，可显式启用本地内存测试适配器（仅在 `import.meta.env.DEV` 或 Vitest 测试中生效，生产构建 `npm run build` 中完全隔离且不可达；界面顶部会明确提示处于模拟模式，且不会假报真实邮件或模型处理成功）：

```bash
VITE_USE_TEST_ADAPTER=true npm run dev
```

或在开发模式访问 `http://127.0.0.1:5173/?adapter=test`（使用 `?adapter=real` 切回真实后端）。

测试适配器默认内置管理员账号（`admin@spark.local` / `SparkAdmin1234!`）与初始测试邀请码（`SPARK-TEST-0001`、`SPARK-TEST-0002`）。

## 检查与测试

```bash
npm run typecheck
npm run test
npm run build
```
