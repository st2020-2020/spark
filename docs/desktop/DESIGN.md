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
rounded:
  card: 8
  control: 6
spacing:
  unit: 4
---

# Spark 原生界面设计

Spark 桌面版是中文个人卡片笔记应用：浅灰背景、绿色操作、紧凑录入区、左侧标签与热力图、单列原文笔记流。在线 Web 的视觉另见 [Web 视觉与交互规范](../design/WEB-VISUAL.md)。

## 颜色和主题

`internal/app/theme.go` 中的 `currentPalette` 定义浅色和深色配色，`applySparkTheme` 将配色应用到 MyGo 组件。上方记录浅色配色。绿色用于主操作与标签，红色用于删除和错误。卡片使用主题表面色与细边框。

## 字体和尺寸

使用 MyGo 默认字体。面板标题字号为 22，列表原文为 14，详情原文为 15，日期与标签为 12。列表原文最多预览八行，详情显示全文和整理摘要。卡片圆角为 8，常用控件圆角为 6。

## 窗口和布局

主窗口初始尺寸为 1080 × 740，最小尺寸为 720 × 500。左侧栏宽 232，右侧录入区、笔记流和详情内容的最大宽度为 760。标签列表、笔记流和详情各自滚动。

## 组件

`internal/app/app.go` 使用 MyGo Native UI 组件渲染侧栏、录入、列表和详情。近十二周热力图按笔记创建时间的本地日期计算。侧栏提供笔记与标签统计，列表卡片显示日期、原文、图片和标签。
