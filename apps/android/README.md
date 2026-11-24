# Spark Android

在浏览器、相册或其他应用分享文字、网页或图片时，选择「Spark 灵光」。可核对内容、补充用途或勾选本条排除 AI，再保存到 Spark。AI 的授权、额度与项目建议由同一个 Spark 账号管理。打开桌面图标可查看收件箱、处理待确认建议，以及继续本机草稿。

## 在另一台机器构建

复制整个 `apps/android/`，或解压交付的源码包后进入 `android/`。此目录是独立 Gradle 工程，包含 Wrapper。可直接用 Android Studio 打开此目录，或按以下方式构建。

1. 准备 JDK 17、Android SDK Platform 35 和 SDK Build Tools 34.0.0。让 Android Studio 选择 SDK，或在命令行设置 `ANDROID_HOME`。首次构建需要能访问 Gradle 分发站点、Google Maven 与 Maven Central。[Android Gradle Plugin 兼容性](https://developer.android.com/build/releases/past-releases/agp-8-7-0-release-notes)
2. 在包含 `gradlew` 的目录运行 JVM 测试，构建两个调试包及未签名的生产包。

   ```sh
   ./gradlew :app:testProdDebugUnitTest :app:assembleProdDebug :app:assembleDevDebug :app:assembleProdRelease
   ```

   Windows PowerShell 使用 `.\gradlew.bat`，任务名相同。若 PATH 优先找到其他 JDK，先将 `JAVA_HOME` 设为 JDK 17 的安装目录。

3. 打开测试设备的 USB 调试后，安装所需的 APK。

   ```sh
   adb install -r app/build/outputs/apk/dev/debug/app-dev-debug.apk
   ```

最低支持 Android 7.0（API 24），设备需安装可运行 Spark 网页的 Android System WebView。两个变体的包名不同，可以同机安装。

| 变体 | 包名 | 站点 | 调试 APK |
| --- | --- | --- | --- |
| `prod` | `cloud.stwqy.spark` | `https://spark.stwqy.cloud` | `app/build/outputs/apk/prod/debug/app-prod-debug.apk` |
| `dev` | `cloud.stwqy.spark.dev` | 默认 `http://10.0.2.2:5173` | `app/build/outputs/apk/dev/debug/app-dev-debug.apk` |

在本机 `local.properties` 设置 `spark.dev.origin` 可切换开发站点。允许 HTTPS 源，以及 `10.0.2.2`、`127.0.0.1`、`localhost` 三个主机的 HTTP 源。平台和站点联调按 [部署说明](../../deploy/README.md) 使用隔离环境。

生产包输出到 `app/build/outputs/apk/prod/release/app-prod-release-unsigned.apk`。覆盖安装要求包名及签名一致。正式包在 Android Studio 通过 **Build → Generate Signed App Bundle or APK** 签名，签名文件和密码由发布者保管。

## 原生分享和本机草稿

文字与网址通过 `ACTION_SEND` 的 `text/plain` 入口接收。图片通过 `ACTION_SEND` 或 `ACTION_SEND_MULTIPLE` 的 `image/*` 入口接收，可单独保存或附上文字。每条最多 9 张，每张最多 5 MiB，支持 JPEG、PNG、GIF 和 WebP。悬浮卡片和草稿编辑器可查看缩略图、单张上传状态、重试或移除图片。

收到图文时，Spark 先保存正文和图片条目，再读取图片，单张最多等待 15 秒。导入失败可移除，系统授权仍有效时可在分享卡片重试。若分享窗口退出或进程恢复后无法继续读取，草稿中保留正文和未导入条目，可移除或回到来源应用重新分享。

断网时可存为待发送草稿。恢复联网后，WorkManager 对当前已验证账号的草稿尝试续传。若设备限制后台读取登录状态，重新打开 Spark 会检查队列，也可在草稿箱单条重试。待确认草稿会核对原收藏 UUID，必要时重放原提交。图片副本保存在应用私有目录，收藏确认或删除草稿后清理。Android 7.1 及更新版本可长按应用图标打开本机草稿。v1 草稿库随首次打开迁移到 Room v2，保留草稿归属和冻结的收藏 UUID。

## 首次真机验收

请使用专门的测试账号及合成材料。验证基础收藏时可勾选单条排除 AI。

安装后可用一条命令打开分享编辑页。看到预填网址后，仍由你决定是否保存。

```sh
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT https://example.com/spark-test -n cloud.stwqy.spark/.ShareActivity
```

- 从浏览器分享一个带标题的网址，再从其他应用分享两段文字。检查悬浮卡片预填正文和网址，选择项目、标签并展开更多选项补充用途或标题。保存后应回到来源应用。打开收件箱核对文字、链接和归类。
- 在分享页编辑后断网，从缓存选择项目并点「存为待发送草稿」。重新打开本机草稿，核对预览和待发送状态。恢复联网后使用原账号发送。若发送后连接中断，可在草稿箱重试，检查收件箱只有一条对应记录。
- 从相册或截屏分享单张图片和多张图片，分别保存纯图和图文。检查缩略图、单图进度和移除操作，再在收件箱核对图片数量、顺序和正文。用超过 5 MiB 或损坏的合成图片验证拒绝提示。
- 分享多图并在断网后存为草稿。重新打开应用、回到桌面并恢复联网，核对待发送状态和最终收藏。测试上传或提交时断网后的恢复，并核对收件箱只生成一条收藏。
- 在未登录或会话过期时分享，完成登录并返回草稿。用两个测试账号切换，核对各自已绑定的草稿、收藏和待确认项目建议。
- 在草稿箱用「记一条」新建草稿。打开后验证继续编辑，以及删除确认的取消和删除路径。
- 用有既存建议的账号打开「待确认」，确认加入项目，再刷新查看决定是否保留。该页面沿用手机版网页的实时提示。
- 在工作区选择一张和多张相册图片，确认取消后可以再次选择。在有 CSV 导入入口的页面核对系统文件选择。
- 切换四套配色的深浅模式，查看状态栏与导航栏。断网打开页面后恢复网络，点击「重试」。
- 在收藏详情下载 PNG 分享卡并打开系统分享。在设置导出 ZIP，检查下载目录中的文件。Android 7–9 使用系统文件选择器指定保存位置。

## 本地验证记录

2026-11-22，67 项 JVM 测试及 `prodDebug`、`devDebug`、`prodRelease` 构建通过。API 35 模拟器使用合成图片和本地协议夹具验证了单图和多图分享、断网入队、强制停止并重开后的后台发送、逐张移除和本机媒体清理。使用相同的本地调试签名从 v0.1.0 覆盖安装至 v0.2.0，再升级到 v0.3.0，原有两条离线草稿均可打开。

真实后端与 OSS 联调、真机分享与后台续传，以及正式签名覆盖安装仍待验收。详见 [Android v0.3 交付批次](../../docs/releases/android-v0.3.md#8-分批次交付计划与完成定义dod)。
