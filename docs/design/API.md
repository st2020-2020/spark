# 接口契约与联调说明

接口版本 v1，机器契约见 [openapi.json](../../contracts/openapi.json)。当前契约覆盖账号、项目、收藏、附件、整理、搜索、回访和管理后台。未来桌面同步接口在 M6 扩展。

## 请求与响应

统一前缀 `/api/v1`，JSON 使用 UTF-8 和 snake_case。ID 为 UUID，时间为 UTC RFC3339，日期区间使用左闭右开。可空响应字段采用省略字段表达，空集合返回 `[]`。成功响应直接返回资源或分页对象。

客户端未知字段在写入时返回 422，防止旧客户端误提交隐藏状态；读取时忽略未知响应字段。写操作使用 JSON 请求体，内容类型不符返回 415。正文之外的 API JSON 请求体上限建议 1 MiB，图片走 OSS。密码长度 12 至 128 个 Unicode 字符，允许粘贴和密码管理器，登录不修剪密码。

| 状态 | 代表错误码 | 客户端动作 |
| --- | --- | --- |
| 400 | invalid_request、invalid_cursor | 修正请求；游标错误重新加载 |
| 401 | session_expired、authentication_failed | 登录或重新验证 |
| 403 | forbidden、csrf_failed、ai_disabled | 展示权限或设置说明 |
| 404 | not_found | 返回列表，保留正在编辑的草稿 |
| 409 | content_conflict、decision_conflict、resource_conflict、idempotency_mismatch、duplicate_resource、invite_unavailable、resurface_day_changed、tag_conflict | 展示当前版本或重新选择，保留用户输入 |
| 410 | upload_expired、import_expired | 重新建立上传或导入预览 |
| 413 | request_too_large | 压缩或减少输入 |
| 422 | validation_failed、unsupported_document、invalid_attachment、registration_failed | 展示字段错误 |
| 429 | rate_limited、quota_exceeded | 根据 Retry-After 重试或等待额度恢复 |
| 503 | service_unavailable | 保留草稿，退避重试 |

错误统一为 `{ "error": { "code": "content_conflict", "message": "内容已更新，请比较后保存。", "request_id": "...", "details": { "current_content_version": 3 } } }`。错误 details 只返回当前用户有权读取的信息。供应商错误映射为内部稳定错误码。

## 会话与注册

登录和注册成功返回 SessionResult，同时设置 `spark_session` Cookie，属性采用 Secure、HttpOnly、SameSite=Lax、Path=/，会话有效期建议 7 天。响应附 `Cache-Control: no-store`。会话 token 随机生成，数据库仅存摘要。CSRF token 通过 SessionResult 返回，修改类请求放在 `X-CSRF-Token`。

首次进入 Web 调用 `GET /auth/session` 恢复账号和 CSRF token。页面刷新后重新读取。匿名的验证码、登录、注册和找回密码请求同样验证 Origin，限制来源和发送频率。登出撤销服务端会话并使 Cookie 过期。

SessionResult 的可选 `purge_enabled` 字段表示是否开放登记新的永久删除。字段缺失时按关闭处理。

验证码申请返回 202 表示已持久受理，返回的 expires_in 和 resend_after 单位为秒。用户更改邮箱或用途后需要重新申请。未启用投递时返回 503，超限返回 429 并使用 Retry-After。验证码接口对账号存在与否使用统一响应形状；密码恢复对无效或不存在账号使用统一失败信息。账号被禁用后撤销会话、拒绝后续签名授权并停止新 AI 任务。

注册输入邮箱、密码、challenge_id、verification_code 和 invite_code。前端预检用于反馈，后端最终事务同时验证账号、挑战和邀请码。注册响应丢失时可通过既有账号登录，邀请码消费以事务状态为准。

初始管理员由受控的部署初始化命令创建，使用与普通用户相同的认证机制并附加角色校验。管理员角色变更通过运维流程，普通注册固定为 user。

## 幂等与版本

OpenAPI 中必填的 Idempotency-Key 使用 16 至 128 字符的随机键。项目决定 PATCH 的键为可选，整理模式会提供。相同用户、操作和键只代表同一次意图。请求正文按规范 JSON 序列化计算摘要，相同请求重放返回原成功状态与结果，并加 `Idempotent-Replayed: true`。尚在执行返回 409 operation_in_progress 和 Retry-After。幂等结果与业务修改同事务完成。

存储的上传授权重放可能已过期，客户端应重新申请新上传会话和新的幂等键。旧临时对象通过清理任务回收。收藏创建携带客户端 UUID，响应丢失可先按 ID 查询。 在幂等记录有效期内，已创建且未永久删除的含图收藏可用原键、原请求重放，即使此时图片存储已关闭。关闭图片存储时，新建含图收藏返回 503。

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

`POST /collections` 可选 `source_collection_id`。首次写入时来源必须是本账号尚未软删的收藏，缺失、他人或已删除来源均返回 404。续写是独立的收藏，项目按客户端提交的 `project_ids` 保存。来源不能通过编辑更改。新写入与来源校验同事务，已成功的请求可以用原键继续回放，同键变更来源返回 409。

项目和标签 PATCH 接受 operations 数组，同一 ID 在一次请求中只能出现一次。include 表示用户确认，exclude 表示显式排除并阻止自动重新添加，reset 清除人工覆盖并恢复自动判断资格。每个集合操作原子执行，验证全部目标属于当前用户后提交。成功返回完整 Collection。

整理模式通过项目 PATCH 的 `Idempotency-Key` 取得可选 `undo_receipt`。确认页面上显示的建议时携带相应运行及项目版本。撤销调用 `POST /collections/{id}/projects/undo`，提交回执中的操作键与决定版本。服务端核对账号、收藏、项目和当前状态，在一个事务中恢复此前关联及引文。有变更的 PATCH 和撤销保留原成功响应。无变更的 PATCH 重放时返回当前可访问的收藏，不再写入或生成回执。同键异体、过期回执或并发修改返回 409。

活动项目可自动关联，用户可主动把收藏加入暂停或已结束项目。有效归类为 manual、confirmed、auto；suggested 和 rejected 不计入项目收藏数。unclassified 表示没有任一有效项目关联，与阅读和整理状态独立。

PUT /read 显式设置已读或未读。GET 读取没有已读副作用，前端在详情成功可见时调用 PUT。清空或改写已读时间不会触发 AI。

收藏软删除后详情仍可由本人通过 ID 读取，并显示 deleted_at。只有恢复、永久删除、历史和本人附件读取适用于回收站内容。编辑、手动归类和重新整理返回 409 collection_in_trash。

POST /organization 以最新内容版本重新整理，已有同输入活动运行时复用该运行。AI 关闭时返回 403；额度不足时返回 429。自动任务可进入 blocked 状态，保存仍成功。

### 续写线索

收藏详情和列表提供可选的 `thread_id`、`source_collection_id` 和 `follow_up_count`。计数为同线索中除当前收藏外的活跃成员数量。普通收藏或直接来源已永久清理时，省略 `source_collection_id`。清理也从续写创建的缓存回放中移除该来源引用。

`GET /collections/{id}/thread` 从本账号任一活跃成员进入，返回 `thread_id`、`items` 和可选的 `next_cursor`。按创建时间及收藏 ID 升序，默认 30 条，最多 100 条。分页游标绑定账号、入口收藏和查询参数。活跃成员含 `display_title`。软删成员仅含 `id`、`created_at` 和 `status: deleted`，永久清理登记后从时间线省略。剩余成员仍可进入同一线索。

## 导出本人数据

`GET /me/export?format=markdown|json` 需要有效会话及对应的 `X-CSRF-Token` 请求头，返回 ZIP 下载。项目与未删除收藏来自当前账号的同一个数据库快照。导出按账号限流，每十分钟可发起一次。429 响应通过 `Retry-After` 返回实际剩余秒数；客户端可据此显示可再次导出的时间。具体参数和响应头见 [OpenAPI](../../contracts/openapi.json)。

## 标签与外观偏好

`GET /tags` 返回本账号标签，支持 `q`、`cursor` 和 `limit`。联想按规范名做字面包含匹配，`collection_count` 仅统计未删除且仍有效的关联。v0.6 标签为平级，`Tag.path` 与显示名一致。`GET /projects` 支持按项目名查询，可和 `state=active` 一起联想。

`POST /tags` 接受 `{name}`，需要 CSRF 与幂等键。先去首尾空白并做 Unicode NFC，长度 1 至 24 个字符。用户内规范名按 Unicode 大小写折叠去重，同名返回 `409 duplicate_resource`。`PATCH /tags/{id}` 接受 `{name,expected_name}`，`DELETE /tags/{id}?expected_name=` 成功返回 204，原名称不符返回 `409 tag_conflict`。删除清除该标签的所有关联并保留收藏正文。

文字自动整理在 `spark-ai-tags-v1` 和 `spark-ai-image-material-v1` 授权下发送匹配标签并应用结果。更早的授权继续使用原有的文字整理范围。用户可在设置页查看新版说明后主动更新。

新建收藏使用 `tag_ids` 指定已有标签。修改标签用 `PATCH /collections/{id}/tags`，与项目共用 `base_decision_version`，支持 include、exclude、reset。详情返回用于编辑的全部决定，卡片、标签计数和筛选只显示有效关联。`GET /collections` 和 `GET /search` 均可按 `tag_id` 筛选，关键词命中有效标签时来源标记为 `tag`。JSON 导出保留标签目录及收藏的标签决定，Markdown 在收藏内列出标签决定。

登录、注册和 `GET /auth/session` 的 `user` 返回 `palette` 与 `theme`。可使用 `PATCH /me/preferences` 单独更新任意一项，配色取 `mint`、`sea`、`matcha`、`sakura`，明暗取 `system`、`light`、`dark`，默认 `mint` 和 `system`。旧客户端原有的 AI 设置请求仍有效，两个偏好组互不覆盖。

## 附件时序

1. POST /uploads 取得临时对象 PUT URL、必须随请求发送的 headers 和 expires_at，建议授权 10 分钟。
2. 浏览器用原始文件字节 PUT 到 OSS，按授权头发送。CORS 允许正式及预发布 Web Origin 的必要 PUT 请求和头。
3. POST /uploads/{id}/complete 返回 202，服务端把对象复制到仅服务端可写的最终键并校验最终对象，GET /uploads/{id} 查询 verifying、ready 或 rejected。
4. 创建或编辑收藏时提交 ready 上传 ID，事务内校验所属用户、单图大小和总图数，再关联为 attached。
5. GET /attachments/{id}/download 校验所属用户和收藏状态，返回短期 GET URL，建议 5 分钟。过期重新请求。

同一上传最多绑定一次。重复创建请求在上传仍可直传时复用上传 ID，并签发有效期受限的新 PUT URL。确认任务重复提交返回当前状态，同一上传的验证任务只入队一次。图片确认重试复用最终键，清理和附件绑定竞争时锁定 uploads 行。授权在到期前可以重放，因此最终对象复制完成后再校验，客户端仍持有的临时写授权无法修改最终对象。确认读取和解码完整最终对象，图片长边最多 8,192 像素、总像素最多 16,777,216。GIF 额外限制帧数和累计解码像素。

软删除收藏的本人仍可在回收站预览附件。永久删除受限于已签发访问地址的剩余时效和客户端副本，服务器立即停止签发新授权。

每个账号每个 UTC 自然日最多新建 40 次上传，声明大小合计最多 100 MiB。每个 10 分钟 UTC 窗口最多尝试签名 60 次上传授权和 120 次下载授权，两类签名分别计数。校验通过且尚待直传的同键重试补签同一暂存键，只计入签名次数。签名失败保留本次签名计数和已建立的上传记录，客户端可用原键继续。新上传被拒绝时，上传记录和额度扣取一并回滚。超限返回 `429 rate_limited`，`Retry-After` 为当前限制窗口的剩余秒数。已签发下载授权仍按最长 5 分钟到期。

## 永久删除与状态

`POST /collections/{id}/purge` 接受回收站内本人收藏的 `base_resource_version`，需要 CSRF 和幂等键。返回 `202 Accepted` 及稳定的 `operation_id`。登记后收藏立即从回收站、详情和搜索排除，恢复和新附件授权也停止。重放返回原操作当前状态。

`GET /collections/{id}/purge` 仅向所属账号返回已登记操作，响应包括 `operation_id` 和 `status`。 `queued` 表示独立账本待持久化，`running` 表示仍有数据库或对象待清理，`completed` 表示两者清理完成。清理按后台任务重试。开关关闭时新的永久删除请求返回 `503 integration_not_configured`。

## 图片理解

`GET /me/image-analysis` 返回账户的 `enabled`、当前账号的 `available`（生产要求平台已启用、UUID 匹配且仍是管理员） 与当前 `required_consent_version`。`PUT /me/image-analysis` 开启时须携带该版本，没有资格的账号请求开启返回 403 `image_analysis_unavailable`。关闭时发送 `{"enabled":false}`，即使失去资格也可以撤回。授权文案须明确说明会将此后新保存的确认图片的视觉副本发送给第三方 DeepSeek，用于识别图中文字并生成 AI 画面描述。副本应用方向并去除 EXIF、GPS 与注释，用户仍可下载原件。图片使用独立授权，并复用收藏的 AI 排除设置。

`GET /collections/{id}/extractions` 中 `source_kind=image` 的 `source_id` 是附件 ID。`text` 为逐字识别的标题和代表性摘录，`image_description` 为简短的中文主题和 AI 画面描述。触及输出上限时，存在可验证的完整字段则返回 `partial / image_output_truncated`；两个字段均空则为 `failed / image_output_truncated_empty`，两种结果均带 `truncated: true`。服务正常完成的两个空字段表示未识别到可用内容。可信用量按实际结算，缺少可靠用量时保留待核对金额。额度不足为 `blocked / quota_exceeded`。

收藏详情的 `image_notes` 保存按附件顺序排列的图片说明正文段。每段有 `attachment_id`、`version`、`state` 与 `text`。服务端总返回数组，历史图片说明迁移后也可读。使用 `PATCH /attachments/{id}/image-note` 提交 `base_version` 与最多 2000 字的 `text`，空白删除段落，版本落后返回 `409 image_note_conflict` 和 `details.current_version`。人工段落内容独立于原富文本，正文渲染与分享以 `image_notes` 为准，JSON 和 Markdown 导出均包含当前段落。图片提取面板仍可展示原始识别。私有 `GET /attachments/{id}/thumbnail` 返回同账号可读附件的 JPEG，用于卡片。

当前解析只读取有界 JSON 对象中的顶层字符串 `text` 和 `description`，允许仅返回其中一个字段。额外字段的值按 JSON 验证后舍弃。重复键、超深结构、尾随内容和非法字段类型返回 `image_provider_content_invalid`。截断由供应商的 `finish_reason=length` 判定，只保留已经闭合并通过验证的已知字段。可信用量继续独立结算。

图片诊断码区分响应读取中断 `image_response_read_failed`、响应封装无效 `image_response_invalid`、候选结构或工具调用异常 `image_provider_choice_invalid`、终止原因异常 `image_provider_finish_invalid`、内容被过滤 `image_provider_content_filtered`、供应商中断 `image_provider_interrupted`、正常停止时的空白响应 `image_provider_empty_output`。旧记录可能保留 `invalid_model_output`。

结果随有效附件保留，编辑备注和重排复用结果。图片项的 `content_version` 为首次绑定版本。移除附件或收藏进入回收站后，提取接口和搜索均省略该结果。搜索片段分别标为 `image_text`、`image_description`。

`POST /attachments/{id}/image-analysis/retry` 接受 `base_extraction_id` 与 `consent_version: "deepseek-image-retry-v1"`，需要 CSRF 和幂等键。界面先确认本次将这张已保存图片的视觉副本再次发给 DeepSeek，服务端复核独立图片授权、账号资格、收藏排除和预算。当前附件仍有效时，目标提取 ID 在普通正文编辑后继续有效。旧版 `partial`、`truncated: true` 且两个字段均空的结果与新版空截断均可申请。符合条件的当前提取返回 `image_retry_available: true`。

首次受理返回 `202` 和新恢复作业，提取列表只显示同一个附件的当前作业。对初次目标的重复请求以及原请求键的重放返回同一作业当前结果。恢复作业若因额度不足且零派发、零账务而终止，提取项再次返回 `image_retry_available: true`。用户可明确确认，提交该恢复作业 ID 及新幂等键重排同一作业。已派发作业的后续请求只读取结果。前端沿用收藏的 `organization` SSE 更新提取列表。

旧版当前可见的首次识别或恢复记录，若为 `failed / invalid_model_output`、两个字段均空且本次账务已结算，也会返回 `image_retry_available: true`。用户可用该提取 ID 和新键明确确认一次当前版本的兼容恢复，本次费用单独核算。旧账务未知时不开放这条恢复路径。

拒绝状态包括 `403 image_analysis_unavailable`、`image_consent_required`、`ai_excluded`，跨账号或附件已移除为 404。回收站为 `409 collection_in_trash`，不匹配的提取 ID 为 `409 extraction_conflict`，材料不满足恢复条件为 `422 image_retry_not_available`。开关关闭为 `503 integration_not_configured`，配置超出图片 Token 上界为 `503 image_token_limit`，当前余额不足为 `429 quota_exceeded`。

文字整理经 `PATCH /me/preferences` 提交 `ai_enabled: true` 和 `consent_version: "spark-ai-image-material-v1"` 同意将合格附件的图中文字和 AI 画面描述一并发给第三方文字模型用于整理。独立图片授权、试用资格和单条排除同时有效时才使用。文字 Worker 仅收到派生文本。登录、会话恢复和偏好更新的用户字段 `ai_consent_version` 返回最近的文字授权版本，启用状态由 `ai_enabled` 表示。

收藏整理响应中的 `image_material_status` 为 `consent_required`、`waiting` 或 `included`，分别对应需补充文字授权、此轮正在等待图片提取、此轮成功或部分成功且用到了图片材料。上层等待状态为 `queued`。整理队列总期限为十分钟，超期未能使用图片的等待运行返回 `failed / image_material_timeout`，识别完成后可重新整理。图片终态没有可用文本时用原有文字材料，无可用材料则为 `skipped / insufficient_material`。旧文字授权下，主动整理合格含图收藏返回 `403 image_material_consent_required`。同一活动运行复用，既有图片提取结果可在主动整理时复用。

项目引文的 `source_id` 可以是 `original_text`、`intent`、`image_text:<附件 UUID>` 或 `image_description:<附件 UUID>`。引文必须逐字来自该次模型输入的对应段。既有 `organization` SSE 通知图片状态和整理变化，客户端按需重新读取收藏、提取和整理。

新版文字授权 `spark-ai-image-notes-v1` 增加图片笔记自动归档。在独立图片授权仍有效且收藏允许时，识别完成可触发或唤醒一次文字整理。符合依据的进行中项目会生成 `decision=auto`，可用主题可在同事务创建并关联项目。人工关联和排除优先。组织详情的 `image_archive_status` 为 `consent_required`、`linked` 或 `created`，分别表示需新版同意、已自动关联或已自动新建并关联。人工修改过或删除的图片说明会从新版归档证据中排除，仍可使用有效 OCR。事件沿用 `organization` SSE，并重新读取项目目录和项目资料列表。

## 网页信息提取

`GET /collections/{id}/extractions` 返回当前版本的提取材料。网页项用 `source_kind=url`、原始主要网址 `source_id` 和收藏 `content_version` 标识。状态为 `queued` 或 `running` 时可继续查询。成功项的 `source_title`、`site_name`、`summary` 用于预览，`text` 保留用于检索的正文片段。失败、已阻止、已跳过或暂无提取项时可继续显示原网址。

`POST /collections/{id}/extractions` 重新获取当前主要网址，使用 CSRF 和幂等键，返回 `202` 与当前网页提取项。同一操作重放读取当前结果。重新执行已结束的提取会生成新提取 ID，并保留同一收藏内容版本。功能关闭时返回 `503 integration_not_configured`，没有主要网址时返回 `422 missing_url`。

## 搜索与分页

GET /collections 默认 scope=active，按 created_at DESC、id DESC 稳定排序。分页返回 items 和可选 next_cursor，默认 30 条，最多 100 条。游标包含最后排序键、查询范围和有效期，服务端签名并绑定用户及筛选参数，过期后从第一页重新加载。

搜索 q 去除首尾空白，以空白拆分最多 10 个词，按字面子串匹配，各词取交集，英文大小写不敏感。对 SQL 通配字符做字面转义。中文连续短语按原短语匹配，候选字段包括标题、原文、用途、网址、当前版本提取结果与标签。

首发搜索按收藏时间倒序；结果返回实际命中的纯文本片段，前端安全高亮。过滤 project_id、tag_id、type、read、日期范围与 scope 取交集。分页期间新增内容可能出现在重新加载后的首页，接口不承诺跨请求快照。

## 灵光日历与今日重现

`GET /me/activity?from=&to=&tz=` 聚合当前账号未删除的收藏。日期为 `YYYY-MM-DD`，起日包含、止日不包含，一次 1 至 31 个自然日。时区由浏览器传入 IANA 名称。响应 `days` 包含零条日期，每天返回 `date`、`count`、`created_from` 和 `created_to`。两个时间为当地相邻日期的起点，可直接用于默认活动列表的日期筛选。夏令时或整天跳过的历史时区由服务端解析。

`GET /collections` 与 `GET /search` 的 `created_from` 和 `created_to` 为 RFC3339 时间，分别为包含下界和不包含上界，可以单独传入。相同边界返回空结果，逆序返回 `400 invalid_request`。范围与账号、回收站范围及其他筛选共同生效。

`POST /collections/{id}/opened` 仅在用户主动打开有效收藏详情时发出，需要 CSRF，成功返回 `204`。本人回收站收藏仍可通过普通详情读取，记录主动查看返回 `409 collection_in_trash`。其他账号或已登记永久删除的收藏返回 `404`。预取、刷新和 SSE 补读沿用只读详情。

`GET /me/resurface?tz=` 返回当地 `date` 和最多三条 `{collection, reason}`，其中 `collection` 为 `CollectionSummary`。依次选取满 7 天仍待归类的收藏、属于进行中项目且满 30 天未打开的收藏、往年同月同日的收藏。前两组优先较早的记录，往年同日优先最近一年的记录。同账号同当地日期固定选取结果，读取时省略已删除或隐藏的卡片，无候选时 `items` 为空。

`GET /me/resurface/preferences` 读取 `{enabled}`，默认启用，`PUT` 可更新。关闭后重现接口返回空数组，恢复开启时复用今日已有结果。`PUT /me/resurface/{id}/hidden?date=&tz=` 按结果的日期隐藏单卡，成功或同日重复隐藏返回 `204`，超出当天返回 `409 resurface_day_changed`，当前账号当日无该卡时返回 `404`。隐藏和偏好写入均需要 CSRF。

## 管理接口与配额

邀请码样例位于 [invites.csv](../../contracts/examples/invites.csv)，仅作格式说明。预览返回行级错误，提交必须在过期前且 errors 为空。重复确认返回同一批次，禁用批次或单码只影响后续兑换。

预算 units 定义为微元，1,000,000 units 等于 1 元人民币，用于内部费用预留与结算。供应商用量依据锁定价格配置换算并向上取整，价格版本随调用记录。预算按 Asia/Shanghai 日期计算，用户界面展示可理解的额度状态。

首批平台 AI 的预算配置以 PostgreSQL 单行 `ai_budget_config` 为唯一来源。管理员通过 `GET /admin/budgets` 读取，使用 `PUT /admin/budgets` 按版本更新。平台和每用户的日额度初始均为 0，管理员分配后才可发起计费调用。新预留按当前限额检查，调低限额保留已有预留及待对账金额，两者继续占用当日额度。`GET /me/usage` 合并当前配置和登录用户的当日账本。

`worker_concurrency` 随预算配置存储，Worker 启动时读取；调整并发需重启 Worker，调整日额度对后续预留即时生效。路由 JSON 管理模型、计价和单次任务的输入输出、超时及尝试上限，拒绝额外的日额度和并发配置字段。

模型配置使用服务端已配置的 credential_alias。配置写入要验证别名、供应商、地域与模型组合，并记录操作者。enabled=true 前必须完成真实连通性和结构化输出验证，失败保留原配置。管理员查看接口永远返回脱敏配置。

## 契约变更

OpenAPI 中的路径、operationId、枚举和必填字段变更需同步客户端生成与接口测试。增加响应字段遵循向后兼容，删除字段或改变含义需要新版本或迁移期。M0 选择并固定生成器及验证器版本，生成 Go 与 TypeScript 客户端后编译验收。
