---
version: alpha
colors:
  primary: "#3259d5"
  background: "#f4f7fc"
  surface: "#ffffff"
  foreground: "#202d49"
  muted: "#63718c"
  border: "#dce3ef"
  accent: "#fae9a5"
  danger: "#b83545"
typography:
  display:
    fontFamily: "Georgia, 'Songti SC', serif"
  sans:
    fontFamily: "'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
  mono:
    fontFamily: "'SFMono-Regular', Consolas, monospace"
rounded:
  card: "20px"
  control: "12px"
spacing:
  unit: "4px"
components:
  Button:
    height: "44px"
  Card:
    rounded: "20px"
---

## Overview

Spark 是个人随手记录工具，第一任务是快速留下想法。产品界面使用浅蓝工作台、白色便签和明亮的钴蓝操作。标志是带四角火花的黄色纸片，强调尚未整理的灵感。避免营销大屏、装饰性图表和沉重的管理表格。中文为唯一界面语言。

## Colors

以上 tokens 对应 src/app/globals.css 的同名 CSS 变量；CSS 是运行时映射，修改时同步本文。颜色表达主操作、标签和危险操作，状态同时提供文字。

## Typography

系统中文字体无需网络字体请求；英文 Spark 标识使用 Georgia，正文 15–16px，标题 28–36px。数据使用等宽数字。长中文正文 1.8 行高，URL 任意换行。

## Layout

手机单列，桌面 224px 侧边导航 + 最宽 960px 主区。手机筛选折入横向可换行标签区。首页与详情共享页头、按钮、卡片、反馈组件。间距以 4px 为单位。

## Elevation & Depth

卡片细边框与轻微阴影；输入卡片用蓝色边框聚焦主任务。只有对话框使用遮罩。

## Shapes

卡片 20px、控件 12px，标签为胶囊形。火花图形仅用于品牌与整理提示。

## Components

Button / Notice / AutoTextarea / ConfirmDialog 为共享组件。按钮最小高度 44px，忙碌时尺寸不变。正文不做富文本 HTML 执行。全局滚动条可见且 token 化。

## Do's and Don'ts

优先保存，再整理。空状态直接邀请记录第一条，不塞入伪造数据。图片固定比例预览、详情完整展示。减少动画并支持 reduced-motion；所有交互有键盘焦点。
