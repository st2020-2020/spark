# Spark 文档索引与维护规范

本目录保存 Spark 的产品、设计、工程与交付文档。第一次接手请从 [HANDOFF.md](HANDOFF.md) 开始；本文说明每份文档管什么、何时更新、如何归档。

## 1. 文档地图

每类信息只有一个事实来源。其他文档需要时链接过去，不复制规则。

| 类别 | 文档 | 事实来源范围 | 状态 |
| --- | --- | --- | --- |
| 入口 | [HANDOFF.md](HANDOFF.md) | 阅读顺序、当前代码事实、决策状态、实施入口 | 现行 |
| 产品 | [PRODUCT.md](PRODUCT.md) | 产品定位、首发范围、默认值、页面与验收场景 | 现行 |
| 产品 | [ITERATION.md](ITERATION.md) | 首批之后的候选需求池、优先级与验收标准 | 待评审 |
| 词汇 | [CONTEXT.md](../CONTEXT.md) | 领域术语与界面用语 | 现行 |
| 架构 | [ARCHITECTURE.md](ARCHITECTURE.md) | 模块、进程、技术栈、数据流、部署方案 | 现行 |
| 计划 | [ROADMAP.md](ROADMAP.md) | 里程碑、依赖、完成标准、当前进度与验证证据 | 现行 |
| 计划 | [releases/](releases/README.md) | 版本拆分、准入准出标准、各版本技术设计与任务拆分 | 现行 |
| 流程 | [CONTRIBUTING.md](../CONTRIBUTING.md) | 分支、提交、评审、合并、发布与紧急修复 | 现行 |
| 协作 | [AGENTS.md](../AGENTS.md) | 开发者与 Agent 的工程规范 | 现行 |
| 记录 | [CHANGELOG.md](CHANGELOG.md) | 已交付的迭代变更（按日期） | 持续追加 |
| 记录 | [DECISIONS.md](DECISIONS.md) | 关键产品与工程决策及理由（按日期） | 持续追加 |
| 设计 | [design/DATA.md](design/DATA.md) | 数据字段、索引、归属约束、事务与版本语义 | 现行 |
| 设计 | [design/API.md](design/API.md) | 接口约定：会话、幂等、错误、分页 | 现行 |
| 设计 | [design/ORGANIZATION.md](design/ORGANIZATION.md) | 自动整理：提取、模型输出、项目匹配、重试 | 现行 |
| 设计 | [design/WEB.md](design/WEB.md) | Web 页面、状态与交互行为 | 现行 |
| 设计 | [design/WEB-VISUAL.md](design/WEB-VISUAL.md) | Web 视觉与交互规范（令牌、布局、组件） | 现行 |
| 设计 | [design/DELIVERY.md](design/DELIVERY.md) | 交付、验收用例与部署恢复 | 现行 |
| 契约 | [contracts/](../contracts/) | `openapi.json` 接口字段；`document.schema.json` 正文结构；`organization-result.schema.json` 模型输出 | 现行 |
| 桌面版 | [desktop/](desktop/README.md) | MyGo 桌面版的运行、设计与交互 | 现行 |
| 归档 | [archive/](archive/README.md) | 已被取代、仅供追溯的资料 | 只读 |

各模块的运行说明放在模块目录：[server/README.md](../server/README.md)（后端与本机容器栈）、[apps/web/README.md](../apps/web/README.md)（Web 前端）、[apps/android/README.md](../apps/android/README.md)（Android 分享客户端）、[deploy/README.md](../deploy/README.md)（部署）。

## 2. 何时更新哪份文档

| 发生的事 | 需要更新 |
| --- | --- |
| 产品范围、定位或默认值变化 | PRODUCT.md；影响页面行为时同步 WEB.md |
| 新想法、候选功能 | ITERATION.md（候选）；确认排期后放入 `releases/` 对应版本，在 ITERATION 标注去向 |
| 版本开发中范围或设计调整 | 对应版本文档的正文与变更记录；同步 `releases/README.md` 总览 |
| 接口或字段变化 | 先改 `contracts/`，再改 API.md / DATA.md 与生成的类型 |
| 页面行为变化 | WEB.md；视觉或组件变化同步 WEB-VISUAL.md |
| 完成一个可交付的批次 | ROADMAP 进度与验证证据；CHANGELOG 追加一条 |
| 做出有取舍的决定 | DECISIONS 追加一条（背景、决定、理由、影响） |
| 新术语出现在界面或代码中 | CONTEXT.md |
| 文档被整体取代 | 按下文归档规则移入 archive/ |

## 3. 文档生命周期

1. **候选**：想法与需求进入 ITERATION.md，状态为「候选 / 待评估」。
2. **排期**：确认后放入 `releases/vX.Y.md`，补齐技术设计与任务拆分。
3. **现行**：实现时写入对应的事实来源（PRODUCT、WEB、DATA、契约等），发布后在 ROADMAP、CHANGELOG 记录，版本文档转为只读。
4. **归档**：整份文件被新文档取代时，移入 `docs/archive/`，文件名加日期前缀 `YYYY-MM-DD-原名`，在 [archive/README.md](archive/README.md) 登记原路径、归档原因与替代文档，并更新所有引用。归档文件不再修改。

现行文档只描述当前事实与已确定的目标，不保留大段历史过程；需要追溯时依靠 Git 历史、CHANGELOG 与 DECISIONS。

## 4. 写作规范

- **语言**：中文撰写；代码标识、命令、路径与接口字段保持原文并用反引号标出。
- **文件头**：长期维护的文档在开头写明更新日期，必要时写明状态、版本与关联文档。
- **命名**：`docs/` 顶层核心文档用大写英文名（`PRODUCT.md`）；详细设计放 `docs/design/`；模块说明统一为模块目录下的 `README.md`。
- **日期**：一律写绝对日期 `YYYY-MM-DD`，不用「昨天」「本周」。
- **事实与目标分开**：目标值、计划与实测结果分别记录；未执行的验证不写成通过。
- **链接**：仓库内使用相对路径；移动文件后检查全部引用。
- **独立表述**：产品与设计文档用 Spark 自己的语言描述定位与方案，不以其他产品作为依据或对标。
- **克制**：不为单个任务新增证明文件、检查清单或审计流水；能在现有文档里写清的不新建文档。
