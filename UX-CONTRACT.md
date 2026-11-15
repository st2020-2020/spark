# Spark 交互约定

个人、本机、单用户 MVP，无账号与共享权限。依据本次用户需求：收集文字/URL/单张图片、编辑和永久删除、规则默认 AI、搜索及标签过滤。

| Capability | Canonical owner                               | Source of truth | Allowed variants                   | Verification          |
| ---------- | --------------------------------------------- | --------------- | ---------------------------------- | --------------------- |
| Form       | src/components/ui.tsx + src/lib/validation.ts | 本文件          | 新建、编辑                         | tests + smoke         |
| Scrollbar  | src/app/globals.css                           | DESIGN.md       | 全局                               | 浏览器 computed style |
| Toast      | Notice in src/components/ui.tsx               | 本文件          | success / error / info             | 浏览器反馈            |
| CRUD       | src/lib/entries.ts + src/components           | 本文件          | 创建留列表，保存留详情，删除回列表 | scripts/smoke.ts      |

- 首次提交用临时卡片立即出现在顶部；成功后替换为 SQLite 条目。失败撤回临时卡片、保留输入并显示重试指引。
- SQLite 保存后，Next after 执行 title/AI 整理。轮询 pending 条目；未完成任务在下次列表/详情读取时恢复。每次更新递增版本，旧整理结果不能覆盖新编辑。
- 搜索在本地已加载列表即时执行，不发送逐键请求（MVP 全量列表）；查询与 tag 写入 URL，刷新/浏览器前进后退可恢复。大数据分页留作下一步。
- 标签过滤与关键词搜索取交集，关键词匹配全文、网页标题、摘要、tag。
- 不清空正在编辑的输入；刷新/关闭页面有未保存提醒，详情返回通过共享确认对话框保护草稿。草稿只保存在内存。
- 删除采用原生 dialog 元素承载应用自有内容，showModal 提供焦点陷阱、inert 背景、Escape；初始聚焦取消，结束恢复焦点。
- 图片最多一张，JPEG/PNG/GIF/WebP，5 MB 上限，服务端检查文件头和文件大小；原始文件只存放数据目录，不进入 public 或 Git。
- 无 Select/Listbox、日期输入和批量表格选择；这些能力不适用。
- 中文标签与错误提示、日期按浏览器本地时区展示；所有输入有 label，错误用 live region 并关联字段。
