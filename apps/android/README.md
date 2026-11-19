# Spark Android 分享客户端

在浏览器或其他应用选中文字、分享网页时，选择「Spark 灵光」。核对原文，可补充用途或勾选本条排除 AI，再保存到 Spark。AI 的授权、额度与项目建议由同一个 Spark 账号管理。打开桌面图标可查看收件箱、处理待确认建议，以及继续本机草稿。

## 在另一台机器构建

复制整个 `apps/android/`，或解压交付的源码包后进入 `android/`。此目录是独立 Gradle 工程，包含 Wrapper。可直接用 Android Studio 打开此目录，或按以下方式构建。

1. 准备 JDK 17、Android SDK Platform 35 和 SDK Build Tools 34.0.0。让 Android Studio 选择 SDK，或在命令行设置 `ANDROID_HOME`。首次构建需要能访问 Gradle 分发站点、Google Maven 与 Maven Central。[Android Gradle Plugin 兼容性](https://developer.android.com/build/releases/past-releases/agp-8-7-0-release-notes)
2. 在包含 `gradlew` 的目录运行以下命令。Windows PowerShell 使用 `.\gradlew.bat :app:assembleDebug`。

   ```sh
   ./gradlew :app:assembleDebug
   ```

3. 产物为 `app/build/outputs/apk/debug/app-debug.apk`。打开手机的 USB 调试并连接后可安装。

   ```sh
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

最低支持 Android 7.0（API 24），手机需有可运行现有 Spark 网页的 Android System WebView。应用通过 HTTPS 访问内置的 Spark 站点，首次请在应用内登录。调试包可用于内测。正式签名可在 Android Studio 选择 **Build → Generate Signed App Bundle or APK**，签名文件和密码由发布者保管。

## 首次真机验收

请使用专门的测试账号及合成材料。验证基础收藏时可勾选单条排除 AI。

安装后可用一条命令打开分享编辑页。看到预填网址后，仍由你决定是否保存。

```sh
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT https://example.com/spark-test -n cloud.stwqy.spark/.ShareActivity
```

- 从浏览器分享一个带标题的网址，再从其他应用分享两段文字。分别补充用途并保存。打开收件箱，核对正文、链接与用途，每次分享应各产生一条收藏。
- 在分享页编辑后断网，退出并重新打开本机草稿。恢复联网后用原账号继续保存。若发送后连接中断，重试同一草稿，检查收件箱只有一条对应记录。
- 在未登录或会话过期时分享，完成登录并返回草稿。用两个测试账号切换，核对各自已绑定的草稿、收藏和待确认项目建议。
- 用有既存建议的账号打开「待确认」，确认加入项目，再刷新查看决定是否保留。该页面沿用手机版网页的实时提示。

此版接收 `ACTION_SEND` 的 `text/plain`。系统分享和本机草稿采用原生界面，登录、浏览和人工确认使用同源 WebView。图片、文件及系统后台推送留待后续版本。当前仅交付源码，首轮 Android 编译和手机端验收由打包环境完成。
