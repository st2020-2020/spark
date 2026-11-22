# 数据与事务详细设计

设计基线 v1。下表是目标 PostgreSQL 结构，实施者据此编写版本化迁移和 sqlc 查询。

## 通用约定

- 业务主键使用 UUID，时间使用 `timestamptz`，HTTP 输出 UTC RFC3339。整数版本从 1 开始。
- 下表字段标有 `?` 表示可空，其余必填。业务表带 `created_at`，可变资源带 `updated_at`，数据库设置默认时间。
- 所有用户资源带 `user_id`，并建立 `UNIQUE(user_id,id)`。关联外键同时包含所属用户和资源 ID。
- 客户端传入 UUID 只表示请求目标。身份来自验证后的会话，每条查询显式约束 `user_id`。跨用户资源按不存在返回。
- JSONB 适合结构化正文、模型结果和审计元数据。用户、项目、关联和附件使用关系字段及约束。

## 账号、邀请码与会话

| 表 | 字段 | 约束与索引 |
| --- | --- | --- |
| users | id, email_normalized text, password_hash text, status enum(active,disabled), role enum(user,admin), ai_enabled bool, ai_policy_version int, ai_consent_at?, ai_consent_version?, resurface_enabled bool, palette, theme, created_at, updated_at | 邮箱唯一；默认 user；密码采用成熟库的 Argon2id 编码，参数随部署评测固定 |
| email_challenges | id, email_normalized, purpose enum(register,password_reset), code_digest, expires_at, attempts int, consumed_at?, created_at | 过期索引；验证码摘要采用服务端秘密密钥计算；服务端生成高熵 challenge ID |
| mail_outbox | challenge_id, encrypted_payload?, expires_at, delivered_at?, delivery_state | 与挑战共用主键。开发取码与真实投递分开；真实投递的终态清除密文 |
| sessions | id, user_id, token_digest, csrf_digest, expires_at, last_seen_at, revoked_at?, device_label, created_at | token_digest 唯一；user_id 与有效状态索引 |
| invite_batches | id, name, status enum(active,disabled), created_by, created_at | 管理员创建；禁用批次立即阻止后续兑换 |
| invite_codes | id, batch_id, code_digest, expires_at?, max_uses int, used_count int, disabled_at?, created_at | code_digest 唯一；0 ≤ used_count ≤ max_uses；默认 max_uses=1 |
| invite_redemptions | id, invite_id, user_id, created_at | 每用户唯一注册兑换；邀请码与用户外键 |
| invite_imports | id, admin_id, name, payload_digest, encrypted_rows, validation_result jsonb, state enum(preview,committed,expired), expires_at, batch_id?, created_at | 预览暂存加密，提交成功或过期后清除原码；payload_digest 用于核对 |

邮箱去除首尾空白并以产品约定的小写形式作为账号标识。验证码有效期建议 10 分钟、最多尝试 5 次、重发间隔 60 秒，旧验证码在同邮箱同用途新挑战生成时失效。邮件作业只存挑战 ID。API 在同一事务内登记挑战、加密邮件载荷与投递作业。Worker 派发前先持久标记结果不明并取走密文；供应商确认接收后登记 accepted。仅在可确认尚未接收、挑战仍有效且尝试数有余时重新排队。恢复库重新接入服务前作废旧挑战与队列。

邀请码允许管理员导入 CSV，首发接受 code、expires_at、max_uses 三列；code 为 12 至 64 位 ASCII 字母数字或连字符，区分大小写。导入时去除首尾空白，重复行与已有代码摘要冲突显示明确行号。一次最多 1,000 行，预览有效期 30 分钟；存在错误时整个批次不提交。并发提交仍由唯一约束兜底并回滚。

注册事务先验证并锁定邮箱挑战，再依次锁定批次和邀请码，检查有效状态及额度，创建用户、兑换记录和会话，消费验证码并增加 used_count。任一步失败整体回滚。响应丢失后客户端通过登录恢复，已注册账号重复注册返回统一的注册失败提示。禁用邀请码与兑换使用同一锁顺序。

### 浏览器扩展授权

迁移 017 将已有 `sessions` 标为 `web`，新增 `extension` 类型。两类令牌均只存摘要。只有 Web 会话有 CSRF 摘要。扩展会话通过同一个设备管理入口按账号撤销，密码重置与备份恢复的会话撤销也覆盖扩展。

`extension_grants` 按 32 字节 `challenge` 唯一，记录账号、批准的 Web 会话、浏览器、有效期和消费时间。授权确认与兑换先锁账号、再复核并锁批准会话。兑换在事务内检查批准仍有效，原子标记已消费并新增扩展会话。密码重置锁账号后撤销会话，单设备撤销和兑换由会话行锁串行化。过期记录继续短时保留，用于区分迟到请求，再由新的批准请求分批清理。

扩展收藏新写和成功回放在账号写锁下再次验证扩展会话仍有效。新写复用收藏事务，并验证项目仍属于账号且进行中。幂等缓存只保留收藏 ID。永久清理时与普通收藏创建回执一并删除，墓碑继续阻止重放。

## 项目、收藏与附件

| 表 | 字段 | 约束与索引 |
| --- | --- | --- |
| projects | id, user_id, name varchar(100), description varchar(2000), focus_points jsonb, state enum(active,paused,completed), version bigint, created_at, updated_at | 用户内名称可重复；关注点最多 20 项，每项 100 字；user_id/state/updated_at 索引 |
| collections | id, user_id, thread_id, source_collection_id?, document jsonb, plain_text text, intent text, original_url?, manual_title?, content_version bigint, resource_version bigint, decision_version bigint, read_at?, last_opened_at?, ai_excluded bool, ai_policy_version bigint, deleted_at?, purge_after?, purge_requested_at?, created_at, updated_at | user_id/created_at/id 降序索引；用户活动收藏及回收站部分索引 |
| collection_thread_counts | user_id, thread_id, member_count, active_count | 账号和线索为主键，收藏插入、软删、恢复和物理删除同事务维护，最后一个成员清理后移除 |
| collection_revisions | id, user_id, collection_id, content_version, document, intent, original_url?, manual_title?, attachment_ids jsonb, created_at | UNIQUE(collection_id,content_version)；快照属于对应用户 |
| uploads | id, user_id, staging_key, final_key?, provider_version?, filename, declared_size bigint, actual_size?, mime_type, sha256 bytea?, status enum(pending,verifying,ready,attached,rejected,expired), error_code?, expires_at, staging_cleaned_at?, created_at, updated_at | staging_key、final_key 分别唯一；ready、attached 须有最终键、与声明一致的大小及 32 字节 SHA-256；用户/状态/到期索引 |
| attachments | id, user_id, collection_id, upload_id, object_key, provider_version?, filename, mime_type, size_bytes bigint, sha256, position int, removed_at?, created_at | upload_id 唯一且同用户；有效附件在收藏内 position 取 0 至 8 且唯一，同一语句可交换位置；object_key 唯一 |
| tags | id, user_id, name varchar(24), normalized_name, created_at, updated_at | 用户内规范名唯一；账号、创建时间和 ID 的索引用于分页 |
| collection_tags | user_id, collection_id, tag_id, decision enum(manual,confirmed,auto,rejected), run_id?, created_at, updated_at | 复合主键(collection_id,tag_id)，收藏、标签及 AI 运行均属于同账号；标签或收藏物理删除时删除关联 |
| collection_projects | user_id, collection_id, project_id, decision enum(manual,confirmed,auto,rejected,suggested), reason?, evidence jsonb, project_version?, run_id?, created_at, updated_at | 复合主键(collection_id,project_id)，两侧均同用户；user_id/project_id/decision 索引 |

原文和用途合计按 Unicode 字符数计 50,000，标题最多 200 字。空白正文只有在带有效网址或至少一个已确认附件时可保存。首发自动提取一个主要网址，按显式 original_url 优先、正文第一个有效 HTTP(S) 链接次之；正文其他链接仍完整保存。

收藏类型由内容派生，可同时包含 text、url、image，筛选采用包含匹配。手动标题优先于生成标题，原文首段或域名作为最终回退。照片和原图只引用稳定对象键，带签名的地址在读取时生成。

项目通过暂停或完成状态管理生命周期。v0.6 标签为账号内平级条目，名称去首尾空白并做 NFC，显示名保留大小写。唯一性和标签关键词匹配使用 Unicode 大小写折叠后的规范名。标签关联独立于收藏正文。重命名按原显示名检查冲突，删除一并移除关联并递增受影响收藏的决定版本和资源版本。

收藏创建时指定的标签为人工决定。标签和项目写入共用账号写锁及收藏决定版本，整组变更在同一事务提交。仅在用户确认文字与标签处理说明（`spark-ai-tags-v1`）后，整理任务才从提交材料中匹配本账号已有的标签名，使用同一次整理调用和原有计费预留。应用时再次核验名称与归属，已有人工决定优先。重整只替换自动标签，收藏内容版本变化时清除旧版本的自动标签，人工决定保留。

迁移 010 新增标签和外观偏好。既有账号默认 `mint` 配色和 `system` 明暗，同时保留 AI、回访与已有收藏数据。

迁移 016 为已有收藏分配独立的线索 UUID。续写与来源在同一账号写锁下登记，继承来源的 `thread_id`，并通过 `(user_id, source_collection_id)` 外键记录直接来源。新建后客户端不可变更关系。时间线走 `(user_id, thread_id, created_at, id)` 部分索引，排除已登记永久删除的成员，以创建时间和 ID 分页。每条收藏的计数按账号和线索主键读取，成本不随线索长度增加。

软删除保留线索成员占位并减少活跃计数，恢复补回计数。物理清理通过外键解除子条目的直接来源，并清理对应来源的创建缓存字段。线索标识独立于来源或首条收藏，源条目、任一中间条目清理后，其余成员仍保留原标识。

迁移 018 为浏览器扩展写入增加 `collections.capture_source`。旧收藏仅在同账号存在扩展创建入口的 201 回执且记录 ID 精确一致时补齐来源。升级不创建整理任务，通用 Web 收藏不会被推断为扩展来源。

网页归类在 `organization_runs.web_archive` 固定该次输入范围，结果单独保留 `web_archive_status`。复用原文字整理的内容版本、账号策略、收藏策略和决策版本校验。主动恢复按当前一条收藏登记，原始来源字段保持不变。项目链接和主题去重使用账号写锁及既有规范化索引。失败且没有账本记录时，新键显式重试才可另排，原键回执及已有账本的运行均保持原结果。

## 回访与时间

| 表 | 字段 | 约束与索引 |
| --- | --- | --- |
| resurface_days | user_id, local_date date | 账号和当地日期为主键。即使当天结果为空，也保留日期标记 |
| resurface_items | user_id, local_date, collection_id, position, reason, hidden | 按账号引用收藏和日期，位置 1 至 3 且当天唯一。永久删除级联清除候选，日期标记保留 |

迁移 009 保留已有收藏和已读状态，`last_opened_at` 初始为空。用户主动打开有效详情时，按账号写入当前查看时间，且时间不倒退。该写入不改变已读、收藏版本、更新时间或变更流水。D-05 使用独立查看时间，历史记录缺失时用收藏创建时间判断。普通读取和后台刷新不记行为。

重现开关默认开启。第一次请求在同一事务内登记本账号当地日期并保存最多三条候选，只记录收藏 ID、顺序、原因和单卡隐藏状态。并发请求以日期唯一约束复用已提交结果。读取时重新核对归属和可见性，失效或隐藏的卡片不补位。新日期生成时清除该账号已不可能为当前日期的旧记录。

## 提取、整理与费用

| 表 | 字段 | 约束与索引 |
| --- | --- | --- |
| extractions | id, user_id, collection_id, content_version, source_kind enum(url,image), source_id text, attachment_id?, status, text?, source_title?, evidence_meta jsonb, error_code?, extractor_version, image_user_policy_version?, image_collection_policy_version?, created_at, updated_at | 在账号、收藏、内容版本和来源类型内使用来源 ID 与提取版本的固定大小摘要去重。保留并核对原始来源 ID。图片作业按账号、附件和提取版本唯一，引用同账号同收藏的附件。网址来源使用主要网址和内容版本 |
| organization_runs | id, user_id, collection_id, content_version, user_policy_version, collection_policy_version, image_waiting, image_user_policy_version?, status, stages jsonb, model_id?, prompt_version, matching_policy_version, project_snapshot jsonb, result jsonb, error_code?, started_at?, completed_at?, created_at, updated_at | 同输入和策略仅一个活动运行，由部分唯一约束或任务唯一性配合事务保证 |
| organization_current | user_id, collection_id, run_id, generated_title?, summary?, content_version, updated_at | 收藏唯一；仅用于当前版本的显示；过期结果可从运行历史诊断 |
| usage_reservations | id, user_id, run_id?, image_extraction_id?, attempt_no, budget_day date, reserved_units bigint, actual_units?, state enum(reserved,settled,released,uncertain), created_at, updated_at | UNIQUE(run_id,attempt_no)；图片作业由同账号提取 ID 关联，每作业一条。删除来源后清除外键并保留账务 |
| daily_budgets | scope enum(platform,user), owner_key, budget_day, limit_units, reserved_units, settled_units | 复合主键(scope,owner_key,budget_day)；事务行锁校验限额 |
| model_configs | id, version, enabled bool, provider, model_id, region, deployment_scope, secret_ref, timeout_seconds, limits jsonb, created_at | secret_ref 指向服务端秘密配置；管理员读取仅返回是否已配置 |

网页提取写入锁定收藏并核对当前内容版本及删除状态；重复入队保留原结果，写回需匹配本次读取的 `updated_at`。网页结果使用 `source_title` 保存来源标题，`text` 保存有界正文，`evidence_meta` 保存 `site_name` 和 `summary`。同版本手动刷新后以新的提取 ID 标识当前结果。

用户图片授权独立记录 `image_consent_version`、`image_consented_at` 和递增的 `image_policy_version`。图片作业捕获账户和收藏策略版本，派发前及写回时再核对权限、删除状态及附件有效性。附件的已确认身份保持不变时复用结果。图片的已识别文字写入 `text`，画面描述及输出截断标记写入 `evidence_meta`。

v11 文字整理通过账号、收藏、附件和来源 ID 关联提取记录，校验首次绑定的内容版本、当前附件及图片策略。派发前和结果应用时复核此次提交文本的来源和范围。等待时保留同一运行且不预留文字额度。使用图片材料完成时记录所用图片策略版本，待确认建议仅在整理和图片授权仍有效时展示。人工决定保留。迁移保留既有提取和运行，无需补队历史收藏。

图片与文字整理均使用 `daily_budgets` 的平台和用户两行锁，先写账务再外呼。图片作业派发事务同时持久化派发状态及待核对金额，获取可信用量后结算。发送失败、漏计量或进程中断时仍占用原预留，重复投递不会再次发送该图片作业。

v12 手动恢复用独立提取版本为同一附件创建一行恢复作业。每个账号、附件和提取版本已有唯一约束，恢复范围由原提取 ID 和附件归属共同确定。恢复行继续沿用附件的首次绑定版本，在当前提取列表、搜索和整理视图中接替原行。原作业和费用账本保留。创建恢复作业和 River 入队与幂等记录同事务提交。

登记和实际外呼前分别核对平台及账号预算，调用上限仍为每张图 7168 微元。额度在派发前被占用时，作业保留为 `blocked / quota_exceeded`。用户明确要求重排且事务确认没有任何预留或账务行后，同一作业返回队列并捕获当前策略版本。一次实际派发使用同一个作业的唯一预留，发送后结果未知时保留该预留。既有原提取与费用的归属保持独立。

v13 以新的恢复提取版本记录当前解析器的恢复作业。旧版首次或恢复作业只有在当前可见、`invalid_model_output`、输出为空且同账号的使用量账本已经结算时，才可按当前授权与预算显式登记一次。新恢复优先作为当前提取，用于展示、搜索与整理。迁移保留旧提取与费用，兼容恢复与旧账独立。

v14 的 `collection_image_notes` 以账号及附件为主键，保存所附收藏、来源提取、正文说明、版本和生成、编辑或删除状态。历史迁移复制已可见的描述，同一迁移不提交 River 作业。用户编辑更新段落版本及收藏资源版本，原富文本和内容版本保持。识别完成事务只更新由系统生成的段落。编辑稿保留来源，删除状态阻止重识别重新添段。新版归档模型使用通过授权的 OCR 与未修改的生成描述，写回前重新检查当前证据。

新版图片归档任务按实际请求的图片来源和对应提取 ID 对比，复用同一活动作业并避免同组材料重复派发。主题查询用账号和规范化名称索引覆盖项目目录，串行复核后复用有效项目或创建项目。新增项目只写规范化名称，理由与逐字证据保存在图片笔记和项目的关联记录。

AI 处理状态见 ORGANIZATION，River 自有表由其官方迁移单独管理。调用费用日采用 Asia/Shanghai；达到额度暂停相应任务，用户仍能保存收藏。超时且供应商无法确认结果的调用记 uncertain，预算暂按预留计算，后续对账。

## 幂等、变更和审计

| 表 | 字段 | 约束与用途 |
| --- | --- | --- |
| idempotency_keys | user_id, operation, key, request_digest, resource_id?, status enum(running,completed), response_status?, response_json?, expires_at, created_at | 主键(user_id,operation,key)，完成结果建议保留 7 天 |
| user_change_counters | user_id, last_seq bigint | 每用户唯一，所有用户资源变更事务首先锁定 |
| change_events | user_id, seq, resource_type, resource_id, resource_version, action enum(upsert,delete), created_at | 主键(user_id,seq)；首期保留 90 天用于未来同步和追踪 |
| deletion_ledger | id, user_id, collection_id, object_keys jsonb, object_cursor int, requested_at, replicated_at?, completed_at? | UNIQUE(user_id,collection_id)；记录包含已移除附件的暂存键与最终键；作为墓碑独立于收藏生命周期，复制到独立受限存储供恢复后重放 |
| admin_audit | id, actor_id, action, target_type, target_id?, safe_metadata jsonb, created_at | 记录导入、禁用、用户状态和配置修改，保留 180 天作为建议值 |

写入收藏事务同时写原始数据、幂等结果、变更事件和 River 任务。幂等键相同且请求摘要不同返回 409。任务重试遵循独立任务幂等逻辑。创建收藏使用客户端提供的 UUID，幂等记录过期后 UUID 冲突返回 409并指向已存在资源。永久删除后仍保留最小墓碑以防旧重试复活资源。

整理操作在同一事务内保存决定前后的关联、建议来源、引文及相关版本。撤销回执复用 `idempotency_keys`，按账号、收藏和操作键定位；执行一次后记录响应供重放。项目编辑、来源变化或新的人工决定会阻止旧回执覆盖当前数据。新的无变更项目决定只保存请求摘要、状态和固定大小的标记；重放按账号及收藏读取当前版本，以免每个新键都复制一份正文。既有幂等响应继续按原格式读取。

导出使用账号独立的限流键，并在 PostgreSQL 的只读可重复读事务内读取项目、未删除收藏及其决定。并发请求共享同一账号限流窗口，拒绝请求不会延长窗口。

## 版本语义与锁顺序

| 操作 | content_version | decision_version | resource_version |
| --- | --- | --- | --- |
| 修改原文、用途、网址、手动标题或附件 | +1 | 保持 | +1 |
| 改项目或标签人工决定 | 保持 | +1 | +1 |
| 更新已读状态或 AI 排除 | 保持 | 保持 | +1 |
| 应用 AI 结果 | 保持 | 保持 | +1 |
| 删除、恢复 | 保持 | 保持 | +1 |

内容编辑携带 base_content_version，人工决定携带 base_decision_version，删除与恢复携带 base_resource_version。版本过期返回 409及当前对应版本。无变化的幂等操作不增加版本。

同一用户业务变更先锁 user_change_counters，再锁收藏或项目，再按 ID 顺序锁关联和附件。收藏删除、修改、AI 结果写回共用这条顺序。AI 网络请求在数据库事务之外执行，写回事务再次检查输入版本、策略版本和人工决定。

开启或关闭 AI 增加用户的 ai_policy_version，使运行中的旧策略结果失效。收藏 ai_excluded 变化增加收藏的 ai_policy_version。写回同时比较两个版本及当前偏好，即使用户快速关闭再打开，也无法应用关闭前的任务结果。

## 删除与恢复

软删除更新 deleted_at 和 purge_after，收藏及所有派生检索数据立即从普通查询排除。Worker 读取和写回都检查删除状态。恢复清除软删除字段，必要时补充最新版本整理任务。

永久删除请求在同一事务设置 purge_requested_at、增加资源版本、写入删除变更、deletion_ledger 和清理任务，返回 202。此后详情、恢复、附件新授权和模型结果应用均拒绝该资源。清理先同步独立回执，再以单个事务清除正文、提取结果、修订、关联及缓存响应。仍在结算的模型请求保留原结算机会，遗留未确认的预留继续计作 uncertain。随后按回执逐个清理对象并持久化进度，暂存对象等上传授权窗口结束后删除。账本中的账号和收藏 ID 作为墓碑保留。重复请求按账号及收藏 ID 读取原删除操作，旧创建请求也以同一墓碑为准。数据库清理、对象删除和独立删除清单复制成功后才标记账本完成。临时上传 24 小时后回收；先将未绑定上传标记为 expired 并保留对象键，删除对象成功后才移除记录。已绑定上传继续清理暂存对象，成功后记录 staging_cleaned_at。运维可有界重入没有活动作业的到期记录。编辑移除附件只设置 removed_at，当前视图排除，历史版本和对应附件保留至收藏永久删除，存储用量包含这些对象。

备份恢复先在隔离环境执行，重放独立回执并完成恢复库及对象清理。撤销会话和旧授权、检查附件引用后开放流量。已登记但尚未复制的操作仍依赖原库中的账本和排队任务。 回执含对象且恢复库缺少对应账号时重放报错，恢复环境保持离线，直至解决备份配对和该回执所列对象。备份保留建议 30 天，删除清单至少覆盖最老可恢复备份及其校验窗口。
