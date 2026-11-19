# Spark Android 分享客户端

从其他应用分享文字或网址时选择「Spark 灵光」。可以核对原文、补充用途，或勾选「本条不参与 AI 整理」。原文和编辑稿先保存在本机。在线登录、收件箱和 AI 待确认入口沿用 Spark 网页的手机导航。

## 本机草稿入口

- 新版 Web 在「更多 → 本机草稿」提供入口。WebView 的默认 User-Agent 末尾追加 `SparkAndroid/2`。Web 使用普通的 `<a href="/android/local-drafts">`。只有当前来自 Spark 同源页面、由用户发起且非重定向的主框架 GET 导航，且目标为精确的 `https://spark.stwqy.cloud/android/local-drafts`（无查询参数或片段），才打开原生草稿。该入口使用 WebView 导航回调。
- 旧版 Web 也可长按桌面「Spark 灵光」，选择「本机草稿」（Android 7.1+，需桌面启动器支持）。Android 7.0 使用单独的「灵光草稿」图标。
- 网页载入失败时，可在原生错误页重试或打开「本机草稿」。从草稿发起登录后，登录成功会回到同一条草稿。系统返回可以退出登录流程。

原生页面跟随系统深浅色，Web 仍采用网页自己的外观设置。入口接收 `ACTION_SEND` 的 `text/plain`。生产版本继续关闭图片和文件分享。

原生界面共用 `SharePage` 的滚动布局、表单控件和操作状态。配色、Activity 基础主题和系统栏由 `res/values` 与 `res/values-night` 管理。

## 在另一台机器构建和覆盖安装

复制整个 `apps/android/`。这是独立 Gradle 工程，包含 Gradle Wrapper，可直接用 Android Studio 打开。

1. 准备 JDK 17、Android SDK Platform 35 和 SDK Build Tools 34.0.0。让 Android Studio 选择 SDK，或设置 `ANDROID_HOME`。首次构建需要访问 Gradle 分发站点、Google Maven 与 Maven Central。[Android Gradle Plugin 兼容性](https://developer.android.com/build/releases/past-releases/agp-8-7-0-release-notes)
2. 在包含 `gradlew` 的目录运行 `./gradlew :app:assembleDebug`。Windows PowerShell 用 `.\gradlew.bat :app:assembleDebug`。产物位于 `app/build/outputs/apk/debug/app-debug.apk`。
3. 本版为 `0.2.0`（`versionCode 2`），包名仍是 `cloud.stwqy.spark`，最低支持 Android 7.0（API 24）。升级测试请用旧包的同一签名，用 `adb install -r app/build/outputs/apk/debug/app-debug.apk` 覆盖安装。跨机器生成的默认调试签名可能不同，签名不匹配时使用原签名重新打包，避免卸载丢掉草稿。正式签名从 Android Studio 选择 **Build → Generate Signed App Bundle or APK**，由发布者保管密钥。

## 真机升级验收

使用专用测试账号及合成内容。先在旧包留下已绑定账号的草稿，有条件时再留下结果待确认的草稿。覆盖安装新版后做以下检查。

- **在线导航**。新版 Web 只显示网页导航。点「更多 → 本机草稿」，系统返回应回到原网页。验证普通外链打开外部浏览器，带查询参数、子框架或自动跳转的草稿地址不会打开原生页。查看网页的 AI 待确认入口是否仍可使用。
- **旧 Web 与断网**。旧 Web 通过桌面入口打开原生草稿。断网后让网页重新载入，确认错误页的「本机草稿」可用。核对升级前的草稿，并在原账号下继续编辑。联网后使用「重新检查网络和账号」继续提交。
- **分享与恢复编辑**。从浏览器分别分享标题加网址和单独网址，从其他应用分享多段文字。核对文字、网址和用途，确认每次分享独立。可用 `adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT https://example.com/spark-test -n cloud.stwqy.spark/.ShareActivity` 打开预填页。编辑后切后台、旋转或从草稿列表返回，核对已写入的正文、用途和 AI 选项都能恢复。
- **重试与账号**。在提交后、收到响应前断网，恢复后重试同一条草稿，收件箱应只有一条对应收藏。退出登录或模拟会话过期，检查登录成功后返回原草稿、取消登录返回原界面，再用两个账号验证已绑定草稿的隔离。照片或文件分享菜单中不应提供此入口。
- **小屏与系统外观**。使用大字体、竖屏与横屏，打开中文输入法，检查聚焦字段、滚动区域和按钮可达性。系统返回先收起键盘，再沿当前界面返回。分别切换系统浅色和深色，检查分享页、草稿页与断网页的背景、主按钮、次要文字、状态栏及导航栏图标，网页配色由 Web 设置独立控制。

## 无 SDK 导航验证

以下命令在 `apps/android/` 下通过普通 JDK 运行源码测试，Android 编译、安装和真机交互由打包环境验证。

```sh
set -eu
classes_dir=$(mktemp -d)
trap 'rm -r "$classes_dir"' EXIT
package_path=cloud/stwqy/spark
javac --release 17 -d "$classes_dir" "app/src/main/java/$package_path/WebNavigation.java" \
  "app/src/test/java/$package_path/WebNavigationTest.java"
java -cp "$classes_dir" cloud.stwqy.spark.WebNavigationTest
```
