# 开发流程规范

本文规定 Spark 仓库的分支、提交、同步、评审、合并与发布流程，适用于所有开发者与 AI Agent。工程与文档规范见 [AGENTS.md](AGENTS.md)；版本规划见 [docs/releases/](docs/releases/README.md)。

## 1. 分支模型

采用主干开发（trunk-based）：

- `main` 是唯一的长期分支，始终保持可发布状态。所有改动通过短期分支与 Pull Request 合入，**不直接推送 `main`**。
- 短期分支从最新的 `main` 创建，完成一个主题后合并并删除，建议存活不超过一周。
- 发布以 `main` 上的 Git 标签标识，不维护长期的 `develop` 或 `release` 分支。

### 1.1 分支命名

格式：`<类型>/<版本或需求编号>-<简短描述>`，全部小写，单词用 `-` 连接，总长不超过 50 个字符。没有对应版本时省略编号。

同一个交付主题默认共用一条短期分支和一个 PR。使用目标发布的完整版本号和能辨认用户行为的描述，例如 `fix/v0.7.2-extension-save-feedback`。前后端并行开发可在同一分支按路径提交。只有需要单独合并或确实需要隔离工作时才拆分。独立打包机正在跟踪的分支名是外部接口，改名前须先迁移打包配置。

| 类型 | 用途 | 示例 |
| --- | --- | --- |
| `feat` | 新功能 | `feat/v0.2-triage-mode` |
| `fix` | 缺陷修复 | `fix/composer-border-radius` |
| `perf` | 性能优化 | `perf/v0.4-capacity` |
| `refactor` | 不改变行为的重构 | `refactor/web-modal` |
| `test` | 只涉及测试 | `test/v0.2-flow-timeout` |
| `docs` | 只涉及文档 | `docs/repo-governance` |
| `chore` | 构建、依赖、配置、运维脚本 | `chore/v0.4-backup` |
| `release` | 版本收尾：版本号、CHANGELOG、文档 | `release/v0.2.0` |
| `hotfix` | 已发布版本的紧急修复 | `hotfix/v0.2.1-export-timeout` |

## 2. 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 格式：

```text
<类型>(<范围>): <摘要>

<正文：做了什么、为什么、如何验证、有哪些限制>

<尾注：关联需求、破坏性变更、共同作者>
```

- **类型**：与分支类型相同（`feat`、`fix`、`perf`、`refactor`、`test`、`docs`、`chore`），发布收尾用 `chore(release)`。
- **范围**：`web`、`server`、`contracts`、`android`、`desktop`、`deploy`、`docs`；跨模块时选主要模块或省略。
- **摘要**：英文祈使句，首字母小写，不加句号，不超过 72 个字符，例如 `feat(web): add triage mode for unclassified notes`。
- **正文**：每行不超过 72 个字符；说明动机与验证结果，未执行的验证不写成通过。
- **尾注**：`Refs: F-01, v0.2-T05`；接口或数据不兼容时写 `BREAKING CHANGE: …`。
- 一个提交只做一件事；功能代码与独立的文档整理分开提交。提交前确认没有调试代码、密钥或本机文件。

在 Windows PowerShell 中，多行提交说明请写入文件后用 `git commit -F <文件>` 提交，避免引号被拆散。

## 3. 日常流程

```bash
# 1. 从最新的 main 创建分支
git switch main
git pull --ff-only
git switch -c feat/v0.2-triage-mode

# 2. 开发、按主题提交
git add <文件>
git commit -F <说明文件>

# 3. 推送前同步 main，保持线性历史
git fetch origin
git rebase origin/main

# 4. 推送并创建 Pull Request
git push -u origin feat/v0.2-triage-mode
gh pr create --base main --fill
```

- 同步一律用 `rebase`，不在功能分支上合并 `main`。rebase 后推送自己的分支使用 `git push --force-with-lease`，禁止 `--force`。
- 禁止改写他人分支的历史；多人协作同一分支时只追加提交。
- 推送前在本地完成相关模块检查（见第 4 节）。

## 4. Pull Request

### 4.1 要求

- **一个 PR 一个主题**。代码改动建议控制在 400 行以内（不含生成文件、锁文件与文档）；更大的改动按任务拆分。
- **标题**：与提交摘要格式相同，例如 `feat(web): add triage mode for unclassified notes`。
- **描述**：按 [PR 模板](.github/pull_request_template.md) 填写：改了什么、为什么、如何验证、风险与回滚、同步了哪些文档。
- **检查**：在描述中贴出实际运行的检查结果。[Verify Spark](.github/workflows/verify.yml) 在面向 main 的 PR 和 main 推送上运行密钥扫描、Web 类型生成/测试/构建及真实 PostgreSQL 后端测试。CI 使用 GitHub 托管的临时 runner、只读仓库权限和一次性测试库。桌面、Android 真机及交互联调仍按改动范围执行。

| 涉及模块 | 必须通过 |
| --- | --- |
| `apps/web/` | `npm run typecheck`、`npm run test`、`npm run build` |
| `apps/extension/` | 在扩展目录运行 `npm ci`、`npm test` 和 `npm run build`（含类型检查）；由现有 Web CI 一并执行。浏览器加载、绑定及撤销使用隔离服务验收。 |
| `server/` | `CGO_ENABLED=0 go test ./...`、`CGO_ENABLED=0 go build ./...`、`go vet ./...`（集成测试在容器中） |
| 根目录桌面代码 | `CGO_ENABLED=0 go test ./...`、`CGO_ENABLED=0 go build ./...` |
| `contracts/` | 重新生成前后端类型，两端检查通过 |
| 文档 | 相对链接有效 |

- **文档**：行为、接口或配置变化时，同一 PR 内更新对应的事实来源（见 [docs/README.md](docs/README.md)）。

密钥扫描覆盖 PR 引入的提交并隐藏匹配值。推送公开分支前先在本地扫描同一提交范围。发现真实凭证时应先撤销或轮换，再处理 Git 历史。只报告文件、规则、处理状态。工作流使用完整提交固定第三方 Action，凭证不持久化到检出目录。禁止向 PR runner 提供部署 SSH 身份、云密钥或生产配置文件。

### 4.2 评审

- 至少一名维护者批准后才能合并；作者不能批准自己的 PR。AI Agent 创建的 PR 必须由人批准。
- 评审关注：行为正确性、权限与数据隔离、失败路径、测试是否覆盖真实风险、文档是否同步。
- 评审意见全部回复或解决后再合并；需要后续处理的事项写入 ITERATION 或对应版本文档，不留在评论里。

## 5. 合并

- **默认使用 Squash and merge**：PR 标题成为 `main` 上的提交摘要，PR 描述精简为正文。
- PR 内的提交已按主题整理、需要保留时（例如代码与文档分开的两个提交），使用 **Rebase and merge**。
- **不使用 merge commit**，`main` 保持线性历史。
- PR 合并后由负责人核对远端分支顶端仍为已合并的 PR head，再删除已交付的短期分支。先检查工作树的未提交或未跟踪文件及后续提交，确认临时工作树已交接再回收。本地未发布的提交须先查明归属。版本历史通过 PR 和正式标签回查。以下示例清理本地分支：

```bash
git switch main
git pull --ff-only
git branch -d feat/v0.2-triage-mode
```

## 6. 版本发布

版本号与准出标准见 [docs/releases/README.md](docs/releases/README.md)。

1. 确认版本文档中的任务全部合并、验收标准通过。
2. 在交付分支完成版本收尾。只有从主干单独提交版本元数据时才创建 `release/vX.Y.Z`。收尾包括：更新 `apps/web/package.json` 版本号、[CHANGELOG](docs/CHANGELOG.md) 新增版本条目、ROADMAP 记录验证证据、版本文档状态改为「已发布」。
3. 发起 PR，合并到 `main`。
4. 在 `main` 的合并提交上打附注标签并推送：

```bash
git switch main
git pull --ff-only
git tag -a v0.2.0 -m "Spark v0.2.0"
git push origin v0.2.0
```

5. 人工确认发布 SHA 属于已评审的主干、对应检查通过。PR CI 没有生产发布身份；生产操作员用独立 SSH 身份发布，先预检并验证备份，切换后核对 API、Worker 和 Web。失败按部署说明回退。
6. 在 GitHub 创建 Release，说明取自 CHANGELOG 对应条目；按 [deploy/README.md](deploy/README.md) 部署。

## 7. 紧急修复

- `main` 上没有未发布的改动时：照常从 `main` 建 `hotfix/` 分支，合并后打补丁标签（`v0.2.1`）。
- `main` 已有未准备发布的改动时：从上一个标签创建分支 `git switch -c hotfix/v0.2.1-<描述> v0.2.0`，修复后打标签 `v0.2.1` 并部署，再把同一修复通过 PR 合入 `main`（`git cherry-pick`）。
- 紧急修复同样需要评审，可以缩短等待，但不跳过检查。

## 8. 仓库保护（维护者在 GitHub 设置）

GitHub 对 `main` 强制执行以下规则，管理员同样适用。

- 所有变更通过 PR 合入，合并前分支须与最新 `main` 同步。
- GitHub Actions 的 `Secret scan`、`Web`、`API and PostgreSQL` 三项检查均须通过。
- 禁止强制推送与删除分支。

维护者按第 4 节完成人工审查，至少一人批准当前改动。新提交需要重新确认。GitHub 的最低批准数设为 0，批准由维护者在合并前核对。合并时按仓库约定保持线性历史。

## 9. AI Agent 附加规则

- 推送、创建 PR、合并、打标签与发布只在用户明确要求时执行；每次授权只覆盖当次请求。
- 永远不直接推送 `main`；当前在 `main` 时先按第 1.1 节建分支。
- 开始前与提交前运行 `git status`，只提交本任务的文件；保留他人未提交的修改。
- 不提交本机配置与产物：`.env*`（`.env.example` 除外）、`data/`、`build/`、`dist/`、`node_modules/`、个人编辑器或 Agent 的本地设置。
- 推送后在汇报中写明分支名、提交列表、推送结果与未完成的验证。
