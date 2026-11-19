# Spark · 灵光

Spark 是个人的灵感与资料收集本：把一闪而过的文字、网址和图片先收下，再归到正在做的项目里，需要时快速找回。

产品主线是 **收集 → 归类到项目 → 找回**。定位、范围与路线见 [产品需求](docs/PRODUCT.md) 与 [开发计划](docs/ROADMAP.md)。

## 当前状态

| 端 | 技术 | 状态 |
| --- | --- | --- |
| 在线 Web | React + TypeScript + Vite | 邀请内测首个纵向批次已实现：账号与邀请注册、项目、文字与网址收藏、手动归类、关键词搜索、回收站、平台 AI 文字整理（默认关闭）；「灵光手帐」视觉与四套主题配色 |
| 后端 | Go + PostgreSQL + River Worker | 与 Web 同批实现，本机通过 OrbStack Compose 运行 |
| Android | Java（WebView + 原生分享） | 分享收藏客户端源码已交付，编译与真机验收待执行 |
| 桌面 | Go + MyGo Native UI + SQLite | 单机笔记应用，后续作为联网桌面客户端基础 |

v0.3 在集成分支接入了私有图片上传、网页提取、单独授权的图片理解及永久删除。图片理解已完成受控端点的浏览器联调和一次真实 DeepSeek 合成图片试用；真实 OSS 联调仍待验收。发布进度见 [v0.3 计划](docs/releases/v0.3.md)。真实邮件与标签属于后续版本。

## 仓库结构

```text
apps/web/        在线 Web 前端
apps/android/    Android 分享客户端（独立 Gradle 工程）
server/          Go API、Worker、数据库迁移与运维 CLI（独立 Go module）
contracts/       OpenAPI 接口契约与 JSON Schema（前后端共同依据）
deploy/          本机开发与生产 Compose 配置
docs/            产品、架构、设计、计划、变更与决策文档
main.go, internal/, mygo.json   MyGo 桌面版
CONTEXT.md       领域词汇
AGENTS.md        开发协作规范（人与 Agent 共用）
```

## 快速开始

| 我要… | 去看 |
| --- | --- |
| 在本机运行在线版（OrbStack） | [server/README.md](server/README.md)，启动后打开 `http://127.0.0.1:5173` |
| 开发与检查 Web 前端 | [apps/web/README.md](apps/web/README.md) |
| 自托管部署 | [deploy/README.md](deploy/README.md) |
| 运行或打包桌面版 | [docs/desktop/README.md](docs/desktop/README.md) |
| 构建 Android 客户端 | [apps/android/README.md](apps/android/README.md) |
| 了解产品与设计、接手开发 | [docs/HANDOFF.md](docs/HANDOFF.md)，文档总览见 [docs/README.md](docs/README.md) |

参与开发前请先阅读 [AGENTS.md](AGENTS.md)（工程规范）与 [CONTRIBUTING.md](CONTRIBUTING.md)（分支、提交与发布流程）；版本计划见 [docs/releases/](docs/releases/README.md)。
