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
| users | id, email_normalized text, password_hash text, status enum(active,disabled), role enum(user,admin), ai_enabled bool, ai_policy_version int, ai_consent_at?, ai_consent_version?, created_at, updated_at | 邮箱唯一；默认 user；密码采用成熟库的 Argon2id 编码，参数随部署评测固定 |
| email_challenges | id, email_normalized, purpose enum(register,password_reset), code_digest, expires_at, attempts int, consumed_at?, created_at | 过期索引；验证码摘要采用服务端秘密密钥计算；服务端生成高熵 challenge ID |
| sessions | id, user_id, token_digest, csrf_digest, expires_at, last_seen_at, revoked_at?, device_label, created_at | token_digest 唯一；user_id 与有效状态索引 |
| invite_batches | id, name, status enum(active,disabled), created_by, created_at | 管理员创建；禁用批次立即阻止后续兑换 |
| invite_codes | id, batch_id, code_digest, expires_at?, max_uses int, used_count int, disabled_at?, created_at | code_digest 唯一；0 ≤ used_count ≤ max_uses；默认 max_uses=1 |
| invite_redemptions | id, invite_id, user_id, created_at | 每用户唯一注册兑换；邀请码与用户外键 |
| invite_imports | id, admin_id, name, payload_digest, encrypted_rows, validation_result jsonb, state enum(preview,committed,expired), expires_at, batch_id?, created_at | 预览暂存加密，提交成功或过期后清除原码；payload_digest 用于核对 |

邮箱去除首尾空白并以产品约定的小写形式作为账号标识。验证码有效期建议 10 分钟、最多尝试 5 次、重发间隔 60 秒，旧验证码在同邮箱同用途新挑战生成时失效。邮件发送通过持久任务，原始验证码只存在于短期加密任务载荷中，完成或到期后清除。

邀请码允许管理员导入 CSV，首发接受 code、expires_at、max_uses 三列；code 为 12 至 64 位 ASCII 字母数字或连字符，区分大小写。导入时去除首尾空白，重复行与已有代码摘要冲突显示明确行号。一次最多 1,000 行，预览有效期 30 分钟；存在错误时整个批次不提交。并发提交仍由唯一约束兜底并回滚。

注册事务先验证并锁定邮箱挑战，再依次锁定批次和邀请码，检查有效状态及额度，创建用户、兑换记录和会话，消费验证码并增加 used_count。任一步失败整体回滚。响应丢失后客户端通过登录恢复，已注册账号重复注册返回统一的注册失败提示。禁用邀请码与兑换使用同一锁顺序。

## 项目、收藏与附件

| 表 | 字段 | 约束与索引 |
| --- | --- | --- |
| projects | id, user_id, name varchar(100), description varchar(2000), focus_points jsonb, state enum(active,paused,completed), version bigint, created_at, updated_at | 用户内名称可重复；关注点最多 20 项，每项 100 字；user_id/state/updated_at 索引 |
| collections | id, user_id, document jsonb, plain_text text, intent text, original_url?, manual_title?, content_version bigint, resource_version bigint, decision_version bigint, read_at?, ai_excluded bool, ai_policy_version bigint, deleted_at?, purge_after?, purge_requested_at?, created_at, updated_at | user_id/created_at/id 降序索引；用户活动收藏及回收站部分索引 |
| collection_revisions | id, user_id, collection_id, content_version, document, intent, original_url?, manual_title?, attachment_ids jsonb, created_at | UNIQUE(collection_id,content_version)；快照属于对应用户 |
| uploads | id, user_id, staging_key, final_key?, provider_version?, filename, declared_size bigint, actual_size?, mime_type, sha256?, status enum(pending,verifying,ready,attached,rejected,expired), expires_at, created_at, updated_at | staging_key 唯一；用户/状态/到期索引 |
| attachments | id, user_id, collection_id, upload_id, object_key, provider_version?, filename, mime_type, size_bytes bigint, sha256, position int, removed_at?, created_at | upload_id 唯一且同用户；有效附件在收藏内 position 唯一；object_key 唯一 |
| tags | id, user_id, name varchar(24), normalized_name, parent_id?, created_at, updated_at | 用户内 UNIQUE(user_id,parent_id,normalized_name) 使用 NULLS NOT DISTINCT 或等效根节点约束；父标签同用户；校验循环 |
| collection_tags | user_id, collection_id, tag_id, decision enum(manual,confirmed,auto,rejected), run_id?, created_at, updated_at | 复合主键(collection_id,tag_id)，两侧均同用户 |
| collection_projects | user_id, collection_id, project_id, decision enum(manual,confirmed,auto,rejected,suggested), reason?, evidence jsonb, project_version?, run_id?, created_at, updated_at | 复合主键(collection_id,project_id)，两侧均同用户；user_id/project_id/decision 索引 |

原文和用途合计按 Unicode 字符数计 50,000，标题最多 200 字。空白正文只有在带有效网址或至少一个已确认附件时可保存。首发自动提取一个主要网址，按显式 original_url 优先、正文第一个有效 HTTP(S) 链接次之；正文其他链接仍完整保存。

收藏类型由内容派生，可同时包含 text、url、image，筛选采用包含匹配。手动标题优先于生成标题，原文首段或域名作为最终回退。照片和原图只引用稳定对象键，带签名的地址在读取时生成。

项目首期通过暂停或完成状态管理生命周期。标签层级最多 3 层，路径按父级组合。去除空白、Unicode NFC 和英文大小写折叠用于用户内标签匹配，显示名称保留用户输入。标签重命名冲突返回 409。首期标签数量与层级由接口验证。

## 提取、整理与费用

| 表 | 字段 | 约束与索引 |
| --- | --- | --- |
| extractions | id, user_id, collection_id, content_version, source_kind enum(url,image), source_id text, status, text?, source_title?, evidence_meta jsonb, error_code?, extractor_version, created_at, updated_at | UNIQUE(collection_id,content_version,source_kind,source_id,extractor_version) |
| organization_runs | id, user_id, collection_id, content_version, user_policy_version, collection_policy_version, status, stages jsonb, model_id?, prompt_version, matching_policy_version, project_snapshot jsonb, result jsonb, error_code?, started_at?, completed_at?, created_at, updated_at | 同输入和策略仅一个活动运行，由部分唯一约束或任务唯一性配合事务保证 |
| organization_current | user_id, collection_id, run_id, generated_title?, summary?, content_version, updated_at | 收藏唯一；仅用于当前版本的显示；过期结果可从运行历史诊断 |
| usage_reservations | id, user_id, run_id, attempt_no, budget_day date, reserved_units bigint, actual_units?, state enum(reserved,settled,released,uncertain), created_at, updated_at | UNIQUE(run_id,attempt_no)；金额或额度采用整数最小单位 |
| daily_budgets | scope enum(platform,user), owner_key, budget_day, limit_units, reserved_units, settled_units | 复合主键(scope,owner_key,budget_day)；事务行锁校验限额 |
| model_configs | id, version, enabled bool, provider, model_id, region, deployment_scope, secret_ref, timeout_seconds, limits jsonb, created_at | secret_ref 指向服务端秘密配置；管理员读取仅返回是否已配置 |

AI 处理状态见 ORGANIZATION，River 自有表由其官方迁移单独管理。调用费用日采用 Asia/Shanghai；达到额度暂停相应任务，用户仍能保存收藏。超时且供应商无法确认结果的调用记 uncertain，预算暂按预留计算，后续对账。

## 幂等、变更和审计

| 表 | 字段 | 约束与用途 |
| --- | --- | --- |
| idempotency_keys | user_id, operation, key, request_digest, resource_id?, status enum(running,completed), response_status?, response_json?, expires_at, created_at | 主键(user_id,operation,key)，完成结果建议保留 7 天 |
| user_change_counters | user_id, last_seq bigint | 每用户唯一，所有用户资源变更事务首先锁定 |
| change_events | user_id, seq, resource_type, resource_id, resource_version, action enum(upsert,delete), created_at | 主键(user_id,seq)；首期保留 90 天用于未来同步和追踪 |
| deletion_ledger | id, user_id, collection_id, object_keys jsonb, requested_at, replicated_at?, completed_at? | 永久删除意图复制到独立受限存储，用于恢复后重放；清理完毕后按政策缩减字段 |
| admin_audit | id, actor_id, action, target_type, target_id?, safe_metadata jsonb, created_at | 记录导入、禁用、用户状态和配置修改，保留 180 天作为建议值 |

写入收藏事务同时写原始数据、幂等结果、变更事件和 River 任务。幂等键相同且请求摘要不同返回 409。任务重试遵循独立任务幂等逻辑。创建收藏使用客户端提供的 UUID，幂等记录过期后 UUID 冲突返回 409并指向已存在资源。永久删除后仍保留最小墓碑以防旧重试复活资源。

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

永久删除请求在同一事务设置 purge_requested_at、增加资源版本、写入删除变更、deletion_ledger 和清理任务，返回 202。此后详情、恢复、附件新授权和模型结果应用均拒绝该资源。清理按可重试步骤删除对象、提取结果、整理内容、版本快照和正文，保留最小墓碑。独立删除清单复制成功后才标记清理完成。临时上传 24 小时后回收。编辑移除附件只设置 removed_at，当前视图排除，历史版本和对应附件保留至收藏永久删除，存储用量包含这些对象。

备份恢复先在隔离环境执行，再重放独立删除清单、撤销会话和到期授权、检查附件引用，最后开放流量。备份保留建议 30 天，删除清单至少覆盖最老可恢复备份及其校验窗口。
