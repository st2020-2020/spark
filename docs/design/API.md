# 接口契约与联调说明

接口版本 v1，机器契约见 [openapi.json](../../contracts/openapi.json)。其中 52 个操作覆盖首发账号、项目、收藏、附件、整理、搜索和管理后台。接口当前为待实现设计，未来桌面同步接口在 M6 扩展。

## 请求与响应

统一前缀 `/api/v1`，JSON 使用 UTF-8 和 snake_case。ID 为 UUID，时间为 UTC RFC3339，日期区间使用左闭右开。可空响应字段采用省略字段表达，空集合返回 `[]`。成功响应直接返回资源或分页对象。

客户端未知字段在写入时返回 422，防止旧客户端误提交隐藏状态；读取时忽略未知响应字段。写操作使用 JSON 请求体，内容类型不符返回 415。正文之外的 API JSON 请求体上限建议 1 MiB，图片走 OSS。密码长度 12 至 128 个 Unicode 字符，允许粘贴和密码管理器，登录不修剪密码。

| 状态 | 代表错误码 | 客户端动作 |
| --- | --- | --- |
| 400 | invalid_request、invalid_cursor | 修正请求；游标错误重新加载 |
| 401 | session_expired、authentication_failed | 登录或重新验证 |
| 403 | forbidden、csrf_failed、ai_disabled | 展示权限或设置说明 |
| 404 | not_found | 返回列表，保留正在编辑的草稿 |
| 409 | content_conflict、decision_conflict、resource_conflict、idempotency_mismatch、duplicate_resource、invite_unavailable | 展示当前版本或重新选择，保留用户输入 |
| 410 | upload_expired、import_expired | 重新建立上传或导入预览 |
| 413 | request_too_large | 压缩或减少输入 |
| 422 | validation_failed、unsupported_document、invalid_attachment、registration_failed | 展示字段错误 |
| 429 | rate_limited、quota_exceeded | 根据 Retry-After 重试或等待额度恢复 |
| 503 | service_unavailable | 保留草稿，退避重试 |

错误统一为 `{ "error": { "code": "content_conflict", "message": "内容已更新，请比较后保存。", "request_id": "...", "details": { "current_content_version": 3 } } }`。错误 details 只返回当前用户有权读取的信息。供应商错误映射为内部稳定错误码。

## 会话与注册

登录和注册成功返回 SessionResult，同时设置 `spark_session` Cookie，属性采用 Secure、HttpOnly、SameSite=Lax、Path=/，会话有效期建议 7 天。响应附 `Cache-Control: no-store`。会话 token 随机生成，数据库仅存摘要。CSRF token 通过 SessionResult 返回，修改类请求放在 `X-CSRF-Token`。

首次进入 Web 调用 `GET /auth/session` 恢复账号和 CSRF token。页面刷新后重新读取。匿名的验证码、登录、注册和找回密码请求同样验证 Origin，限制来源和发送频率。登出撤销服务端会话并使 Cookie 过期。

验证码接口对账号存在与否使用统一响应形状；密码恢复对无效或不存在账号使用统一失败信息。账号被禁用后撤销会话、拒绝后续签名授权并停止新 AI 任务。

注册输入邮箱、密码、challenge_id、verification_code 和 invite_code。前端预检用于反馈，后端最终事务同时验证账号、挑战和邀请码。注册响应丢失时可通过既有账号登录，邀请码消费以事务状态为准。

初始管理员由受控的部署初始化命令创建，使用与普通用户相同的认证机制并附加角色校验。管理员角色变更通过运维流程，普通注册固定为 user。

## 幂等与版本

OpenAPI 中必填的 Idempotency-Key 使用 16 至 128 字符的随机键。项目决定 PATCH 的键为可选，整理模式会提供。相同用户、操作和键只代表同一次意图。请求正文按规范 JSON 序列化计算摘要，相同请求重放返回原成功状态与结果，并加 `Idempotent-Replayed: true`。尚在执行返回 409 operation_in_progress 和 Retry-After。幂等结果与业务修改同事务完成。

存储的上传授权重放可能已过期，客户端应重新申请新上传会话和新的幂等键。旧临时对象通过清理任务回收。收藏创建携带客户端 UUID，响应丢失可先按 ID 查询。

内容修改的 base_content_version 只校验正文编辑版本，后台整理和已读变化不会导致正文编辑冲突。关联修改使用 base_decision_version，项目修改使用 base_version，删除与恢复使用 base_resource_version。版本信息来自最近一次读取，不接受直接覆盖服务端版本。

PATCH 字段省略表示保留，空字符串清除可清除的文字字段。original_url 置空后根据正文重新选择主要网址；manual_title 置空恢复自动标题。attachment_ids 出现时表示本次保留的已有附件，upload_ids 表示新增附件，两者总数最多 9。更新原文和用途后的合计字符数由服务端再次校验。

## 富文本协议

[document.schema.json](../../contracts/document.schema.json) 定义首发 Tiptap 结构子集，[样例](../../contracts/examples/document.json) 可直接作为联调输入。

允许段落、文本、换行、有序及无序列表、列表项，标记为 bold、highlight、link。列表嵌套深度最多 3 层、文档节点最多 10,000 个，后端除 Schema 校验外做深度和大小限制。链接仅接受 HTTP(S)，禁止凭据 URL，展示时进行属性和文本转义。编辑器序列化适配统一移除默认值空属性，如高亮颜色，保证输出符合受限协议；任意未知节点不能静默丢弃。

图片通过独立附件数组展示，正文使用文本和简单格式。纯文本派生统一遍历顺序，段落和列表项间插入换行，保留用户字词用于搜索与摘要。空文档使用一个空 paragraph。

暂不支持的格式版本返回 422 unsupported_document，前端保留本地文档。旧 MyGo 内容导入时按段落构建 v1 文档，原图经新附件流程上传。

## 收藏和人工归类

[创建样例](../../contracts/examples/collection-create.json) 使用虚构 UUID 和 example.com，开发联调时替换成当前账号真实项目和附件 ID。

POST /collections 返回 201 时，原始数据与初始任务已落库。organization 字段可能仍处于 queued 或 skipped。保存接口的成功不依赖模型成功。

项目和标签 PATCH 接受 operations 数组，同一 ID 在一次请求中只能出现一次。include 表示用户确认，exclude 表示显式排除并阻止自动重新添加，reset 清除人工覆盖并恢复自动判断资格。每个集合操作原子执行，验证全部目标属于当前用户后提交。成功返回完整 Collection。

整理模式通过项目 PATCH 的 `Idempotency-Key` 取得可选 `undo_receipt`。确认页面上显示的建议时携带相应运行及项目版本。撤销调用 `POST /collections/{id}/projects/undo`，提交回执中的操作键与决定版本。服务端核对账号、收藏、项目和当前状态，在一个事务中恢复此前关联及引文。有变更的 PATCH 和撤销保留原成功响应。无变更的 PATCH 重放时返回当前可访问的收藏，不再写入或生成回执。同键异体、过期回执或并发修改返回 409。

活动项目可自动关联，用户可主动把收藏加入暂停或已结束项目。有效归类为 manual、confirmed、auto；suggested 和 rejected 不计入项目收藏数。unclassified 表示没有任一有效项目关联，与阅读和整理状态独立。

PUT /read 显式设置已读或未读。GET 读取没有已读副作用，前端在详情成功可见时调用 PUT。清空或改写已读时间不会触发 AI。

收藏软删除后详情仍可由本人通过 ID 读取，并显示 deleted_at。只有恢复、永久删除、历史和本人附件读取适用于回收站内容。编辑、手动归类和重新整理返回 409 collection_in_trash。

POST /organization 以最新内容版本重新整理，已有同输入活动运行时复用该运行。AI 关闭时返回 403；额度不足时返回 429。自动任务可进入 blocked 状态，保存仍成功。

## 导出本人数据

`GET /me/export?format=markdown|json` 需要有效会话及对应的 `X-CSRF-Token` 请求头，返回 ZIP 下载。项目与未删除收藏来自当前账号的同一个数据库快照。导出按账号限流，每十分钟可发起一次。429 响应通过 `Retry-After` 返回实际剩余秒数；客户端可据此显示可再次导出的时间。具体参数和响应头见 [OpenAPI](../../contracts/openapi.json)。

## 附件时序

1. POST /uploads 取得临时对象 PUT URL、必须随请求发送的 headers 和 expires_at，建议授权 10 分钟。
2. 浏览器用原始文件字节 PUT 到 OSS，按授权头发送。CORS 允许正式及预发布 Web Origin 的必要 PUT 请求和头。
3. POST /uploads/{id}/complete 返回 202，服务端把对象复制到仅服务端可写的最终键并校验最终对象，GET /uploads/{id} 查询 verifying、ready 或 rejected。
4. 创建或编辑收藏时提交 ready 上传 ID，事务内校验所属用户、单图大小和总图数，再关联为 attached。
5. GET /attachments/{id}/download 校验所属用户和收藏状态，返回短期 GET URL，建议 5 分钟。过期重新请求。

同一上传最多绑定一次。图片确认任务重试复用最终键，清理和附件绑定竞争时锁定 uploads 行。授权在到期前可以重放，因此最终对象复制完成后再校验，客户端仍持有的临时写授权无法修改最终对象。文件解码还要限制像素与解压资源，阈值在真实图片测试中锁定。

软删除收藏的本人仍可在回收站预览附件。永久删除受限于已签发访问地址的剩余时效和客户端副本，服务器立即停止签发新授权。

## 搜索与分页

GET /collections 默认 scope=active，按 created_at DESC、id DESC 稳定排序。分页返回 items 和可选 next_cursor，默认 30 条，最多 100 条。游标包含最后排序键、查询范围和有效期，服务端签名并绑定用户及筛选参数，过期后从第一页重新加载。

搜索 q 去除首尾空白，以空白拆分最多 10 个词，按字面子串匹配，各词取交集，英文大小写不敏感。对 SQL 通配字符做字面转义。中文连续短语按原短语匹配，候选字段包括标题、原文、用途、网址、当前版本提取结果与标签。

首发搜索按收藏时间倒序；结果返回实际命中的纯文本片段，前端安全高亮。过滤 project_id、tag_id、type、read、日期范围与 scope 取交集。分页期间新增内容可能出现在重新加载后的首页，接口不承诺跨请求快照。

## 管理接口与配额

邀请码样例位于 [invites.csv](../../contracts/examples/invites.csv)，仅作格式说明。预览返回行级错误，提交必须在过期前且 errors 为空。重复确认返回同一批次，禁用批次或单码只影响后续兑换。

预算 units 定义为微元，1,000,000 units 等于 1 元人民币，用于内部费用预留与结算。供应商用量依据锁定价格配置换算并向上取整，价格版本随调用记录。预算按 Asia/Shanghai 日期计算，用户界面展示可理解的额度状态。

首批平台 AI 的预算配置以 PostgreSQL 单行 `ai_budget_config` 为唯一来源。管理员通过 `GET /admin/budgets` 读取，使用 `PUT /admin/budgets` 按版本更新。平台和每用户的日额度初始均为 0，管理员分配后才可发起计费调用。新预留按当前限额检查，调低限额保留已有预留及待对账金额，两者继续占用当日额度。`GET /me/usage` 合并当前配置和登录用户的当日账本。

`worker_concurrency` 随预算配置存储，Worker 启动时读取；调整并发需重启 Worker，调整日额度对后续预留即时生效。路由 JSON 管理模型、计价和单次任务的输入输出、超时及尝试上限，拒绝额外的日额度和并发配置字段。

模型配置使用服务端已配置的 credential_alias。配置写入要验证别名、供应商、地域与模型组合，并记录操作者。enabled=true 前必须完成真实连通性和结构化输出验证，失败保留原配置。管理员查看接口永远返回脱敏配置。

## 契约变更

OpenAPI 中的路径、operationId、枚举和必填字段变更需同步客户端生成与接口测试。增加响应字段遵循向后兼容，删除字段或改变含义需要新版本或迁移期。M0 选择并固定生成器及验证器版本，生成 Go 与 TypeScript 客户端后编译验收。
