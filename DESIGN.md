---
version: alpha
colors:
  primary: "#287b59"
  background: "#f6f7f6"
  surface: "#ffffff"
  foreground: "#343b36"
  muted: "#747d77"
  border: "#e5e9e6"
  accent: "#e6f2eb"
  danger: "#b83545"
typography:
  display:
    fontFamily: "'Instrument Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  sans:
    fontFamily: "'Instrument Sans', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  mono:
    fontFamily: "'DM Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
rounded:
  card: "8px"
  control: "6px"
spacing:
  unit: "4px"
components:
  Button:
    height: "44px"
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
  Card:
    rounded: "8px"
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
  HelperText:
    textColor: "{colors.muted}"
  BrandMark:
    backgroundColor: "{colors.accent}"
  NoticeError:
    textColor: "{colors.danger}"
---

## Overview

Spark 是中文个人卡片笔记应用。本轮按用户指定的 flomo 公开界面调整：浅灰背景、绿色操作、小型输入框、左侧标签与热力图、单列原文笔记流。保持 Spark 名称与现有记录、编辑、搜索和草稿保护流程。

## Colors

src/app/globals.css 的 :root 是运行时 token 的来源，本文件镜像其值。--p-* 映射到 --primary、--background、--foreground、--muted；其他语义变量由共享组件直接使用。绿色表示主操作与标签，红色只用于删除和错误。中性色承托内容。

## Typography

Instrument Sans 用于英文与标识，中文沿用 PingFang SC / Microsoft YaHei，DM Mono 用于数字与键位；字体本地加载。主标题 20px、笔记原文 15px / 1.85，日期与标签 12–13px。原文列表最多预览八行，全文在详情读取。

## Layout

桌面整页居中，最大 1120px；228px 侧栏与最宽 780px 主区组成双栏。主区内笔记始终单列，输入框初始约 150px 高。880px 以下收起侧栏，改为顶部标识和可换行标签；手机 16px 左右边距。文档自然滚动。

## Elevation & Depth

卡片保持白色与细边框，取消静态阴影与大色块。焦点、hover 和确认对话框沿用共享组件。摘要不在首页重复展示，保留在详情的整理区域。

## Shapes

--radius-card 为 8px，--radius-control 为 6px。没有倾斜图形或装饰背景。

## Components

WorkspaceShell 维护共享导航、标签、本机标识和按实际记录生成的近十二周热力图；热力图按浏览器本地日期分组，不填充虚构活动。Button / Notice / AutoTextarea / ConfirmDialog 沿用 src/components/ui.tsx，AutoTextarea 的 minimumHeight 允许紧凑录入与详情编辑共用。

EntryCard 以日期、原文、图片与标签为主要内容，整理中的状态简短显示，摘要在详情查看。颜色、字号、形状、滚动条由 globals.css 统一提供。按钮忙碌时保持尺寸和可访问名称；缩小动画遵守 reduced-motion。

## Do's and Don'ts

不加入仿制的账号、回顾或设置入口；只有已实现的操作才显示。保持原始数据、现有 API 和同源保护。用户本轮要求尽快预览，只做编译检查与效果截图，不执行多轮门禁或完整回归测试。
