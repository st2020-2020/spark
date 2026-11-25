package cloud.stwqy.spark

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.database.sqlite.SQLiteException
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import cloud.stwqy.spark.core.auth.SessionScope
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkReducedMotion
import cloud.stwqy.spark.core.designsystem.SparkBrandMark
import cloud.stwqy.spark.core.designsystem.SparkHaptics
import cloud.stwqy.spark.core.designsystem.SparkMotion
import cloud.stwqy.spark.core.designsystem.SparkPalette
import cloud.stwqy.spark.core.designsystem.SparkTheme
import cloud.stwqy.spark.core.designsystem.SparkTokens
import cloud.stwqy.spark.core.designsystem.SparkTransitions
import cloud.stwqy.spark.core.designsystem.sparkPressScale
import cloud.stwqy.spark.core.designsystem.sparkTween
import cloud.stwqy.spark.core.network.ActiveNetworkMonitor
import cloud.stwqy.spark.core.security.WebNavigation
import cloud.stwqy.spark.feature.capture.ShareCaptureActivity
import cloud.stwqy.spark.feature.drafts.LocalDraftsActivity
import cloud.stwqy.spark.feature.workspace.MobileHostBridge
import cloud.stwqy.spark.feature.workspace.SystemMediaSaver
import cloud.stwqy.spark.feature.workspace.WebFileChooser
import cloud.stwqy.spark.feature.workspace.WorkspaceAppearance
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream

class WebActivity : ComponentActivity() {
    private val navigation = WebNavigation()
    private val spark get() = application as SparkApp
    private val appearanceCache get() = spark.workspaceAppearance
    private val networkMonitor by lazy { ActiveNetworkMonitor(this) }
    private lateinit var root: FrameLayout
    private lateinit var errorPanel: ComposeView
    private lateinit var webBack: OnBackPressedCallback
    private lateinit var chooser: WebFileChooser
    private lateinit var bridge: MobileHostBridge
    private var web: WebView? = null
    private var bridgeAttached = false
    private var loginStartedIn: String? = null
    private var lastPage: String? = null
    private var observedScope: String? = null
    private var sessionUpdate: Job? = null
    private var firstRenderReady = false
    private var failed by mutableStateOf(false)
    private var loadProgress by mutableIntStateOf(0)
    private var appearance by mutableStateOf(WorkspaceAppearance(SparkPalette.MINT, false, 0))

    override fun onCreate(state: Bundle?) {
        val splash = installSplashScreen()
        val launchedAt = SystemClock.uptimeMillis()
        splash.setKeepOnScreenCondition {
            !firstRenderReady && SystemClock.uptimeMillis() - launchedAt < SPLASH_MAX_HOLD_MS
        }
        if (Build.VERSION.SDK_INT >= 31) {
            splash.setOnExitAnimationListener { provider ->
                if (SparkMotion.isReducedMotion(this)) {
                    provider.remove()
                } else {
                    val splashView = provider.view
                    splashView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
                    runCatching { provider.iconView }.getOrNull()?.animate()
                        ?.scaleX(1.05f)
                        ?.scaleY(1.05f)
                        ?.setDuration(SparkMotion.Normal.toLong())
                        ?.setInterpolator(SparkMotion.EaseOutInterpolator)
                        ?.start()
                    splashView.animate()
                        .alpha(0f)
                        .setDuration(SparkMotion.Normal.toLong())
                        .setInterpolator(SparkMotion.EaseOutInterpolator)
                        .withEndAction {
                            splashView.setLayerType(View.LAYER_TYPE_NONE, null)
                            provider.remove()
                        }
                        .start()
                }
            }
        }
        super.onCreate(state)
        enableEdgeToEdge(navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        if (isDraftLoginCaller()) {
            loginStartedIn = state?.getString(LOGIN_FINGERPRINT) ?: spark.credentials.currentSnapshot().provisionalScope
            SparkTransitions.registerTargetModalTransitions(this)
        }
        chooser = WebFileChooser(this)
        bridge = MobileHostBridge(
            this, spark.credentials, spark.api,
            SystemMediaSaver(this, spark.workspaceStaging, spark.workspaceDocuments), spark.workspaceFileOperation,
            appearanceChanged = { applyAppearance(it, fromPage = true) },
            openDrafts = ::openDrafts,
            authChanged = { sessionChanged(web?.url, flush = true) },
        )
        root = FrameLayout(this)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            view.updatePadding(left = safe.left, top = safe.top, right = safe.right, bottom = safe.bottom)
            WindowInsetsCompat.CONSUMED
        }
        applyAppearance(readAppearance())
        attachWorkspaceFeedback()
        webBack = onBackPressedDispatcher.addCallback(this, enabled = false) {
            val view = web ?: return@addCallback
            if (returnAfterLogin(view.url)) return@addCallback
            if (view.canGoBack()) {
                clearError()
                view.goBack()
            } else {
                webBack.isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onResume(owner: LifecycleOwner) {
                if (loginStartedIn != null) SparkTransitions.refreshTargetModalClose(this@WebActivity)
                networkMonitor.start { online -> web?.setNetworkAvailable(online) }
                web?.onResume()
                sessionChanged(web?.url)
                spark.draftWork.requestSend()
            }
        })
        createWebView()
        load(state?.getString(PAGE))
    }

    private fun createWebView() {
        val view = WebView(this)
        web = view
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString += " " + AppConfig.USER_AGENT_MARKER
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
        view.setBackgroundColor(appearance.background)
        root.addView(view, 0, FrameLayout.LayoutParams(-1, -1))
        bridgeAttached = bridge.attach(view)
        view.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (view === web) loadProgress = newProgress
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                if (webView !== web || failed || !navigation.isSameOrigin(webView.url) || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                    filePathCallback.onReceiveValue(null)
                    return true
                }
                val snapshot = spark.credentials.currentSnapshot()
                return chooser.show({ uris ->
                    filePathCallback.onReceiveValue(uris?.takeIf {
                        webView === web && navigation.isSameOrigin(webView.url) && spark.credentials.currentSnapshot() == snapshot
                    })
                }, fileChooserParams)
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                when (navigation.decide(
                    view.url, request.url.toString(), request.method, request.isForMainFrame,
                    request.hasGesture(), request.isRedirect,
                )) {
                    WebNavigation.Destination.WEB -> false
                    WebNavigation.Destination.LOCAL_DRAFTS -> {
                        openDrafts()
                        true
                    }
                    WebNavigation.Destination.BROWSER -> {
                        openBrowser(request.url)
                        true
                    }
                    WebNavigation.Destination.BLOCK -> true
                }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (!request.isForMainFrame || navigation.allowsMainDocument(request.url.toString(), request.method)) return null
                return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(byteArrayOf()))
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (view !== web) return
                bridge.navigationStarted(view)
                chooser.cancel()
                if (navigation.allowsMainDocument(url, "GET")) {
                    lastPage = url
                    clearError()
                    loadProgress = 0
                } else {
                    view.stopLoading()
                    showError()
                }
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                firstRenderReady = true
                if (view === web && !failed && navigation.allowsMainDocument(url, "GET")) {
                    bridge.documentCommitted(view)
                    view.setNetworkAvailable(networkMonitor.hasNetwork())
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showError()
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame) showError()
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                if (navigation.isSameOrigin(url)) lastPage = url
                webBack.isEnabled = view.canGoBack()
                sessionChanged(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                firstRenderReady = true
                webBack.isEnabled = view.canGoBack()
                sessionChanged(url)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view !== web) return true
                destroyWebView()
                showError()
                return true
            }
        }
        view.setNetworkAvailable(networkMonitor.hasNetwork())
    }

    private fun attachWorkspaceFeedback() {
        root.addView(ComposeView(this).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                SparkTheme(appearance.palette, appearance.dark) {
                    val reducedMotion = LocalSparkReducedMotion.current
                    var showBar by remember { mutableStateOf(false) }
                    LaunchedEffect(loadProgress, failed, reducedMotion) {
                        when {
                            failed -> showBar = false
                            loadProgress in 1..99 -> showBar = true
                            loadProgress >= 100 && showBar -> {
                                if (!reducedMotion) delay(120)
                                showBar = false
                            }
                            else -> showBar = false
                        }
                    }
                    val smoothProgress by animateFloatAsState(
                        targetValue = (loadProgress / 100f).coerceIn(0f, 1f),
                        animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
                        label = "webProgress",
                    )
                    AnimatedVisibility(
                        visible = showBar,
                        enter = fadeIn(sparkTween(SparkMotion.Instant, SparkMotion.EaseOut)),
                        exit = fadeOut(sparkTween(SparkMotion.Normal, SparkMotion.EaseExit)),
                    ) {
                        LinearProgressIndicator(
                            progress = { smoothProgress },
                            modifier = Modifier.fillMaxWidth().height(2.dp),
                            trackColor = LocalSparkColors.current.surfaceMuted,
                            strokeCap = StrokeCap.Round,
                        )
                    }
                }
            }
        }, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        errorPanel = ComposeView(this).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                SparkTheme(appearance.palette, appearance.dark) {
                    val colors = LocalSparkColors.current
                    val hostView = LocalView.current
                    AnimatedVisibility(
                        visible = failed,
                        enter = fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) +
                            scaleIn(initialScale = 0.96f, animationSpec = sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)),
                        exit = fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
                    ) {
                        val backdropInteraction = remember { MutableInteractionSource() }
                        val retryInteraction = remember { MutableInteractionSource() }
                        val draftsInteraction = remember { MutableInteractionSource() }
                        val interactiveBackdrop = if (failed) {
                            Modifier.clickable(interactionSource = backdropInteraction, indication = null) {}
                        } else {
                            Modifier.clearAndSetSemantics {}
                        }
                        Box(
                            Modifier
                                .fillMaxSize()
                                .background(colors.bg)
                                .then(interactiveBackdrop)
                                .padding(24.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Card(
                                modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                                colors = CardDefaults.cardColors(containerColor = colors.surface),
                            ) {
                                Column(
                                    modifier = Modifier.verticalScroll(rememberScrollState()).padding(24.dp),
                                    verticalArrangement = Arrangement.spacedBy(12.dp),
                                    horizontalAlignment = Alignment.Start,
                                ) {
                                    SparkBrandMark(size = 52.dp)
                                    Text(
                                        "暂时连不上 Spark",
                                        style = MaterialTheme.typography.headlineSmall,
                                        modifier = Modifier.semantics { heading() },
                                    )
                                    Text(
                                        "检查网络后再试试，也可以先写本机草稿。",
                                        color = colors.fgSoft,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                    Row(
                                        Modifier.fillMaxWidth().padding(top = 4.dp),
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Button(
                                            onClick = {
                                                SparkHaptics.confirm(hostView)
                                                retry()
                                            },
                                            enabled = failed,
                                            modifier = Modifier
                                                .heightIn(min = 48.dp)
                                                .sparkPressScale(retryInteraction, enabled = failed),
                                            interactionSource = retryInteraction,
                                        ) { Text("重新载入") }
                                        OutlinedButton(
                                            onClick = {
                                                SparkHaptics.tick(hostView)
                                                openDrafts()
                                            },
                                            enabled = failed,
                                            modifier = Modifier
                                                .heightIn(min = 48.dp)
                                                .sparkPressScale(draftsInteraction, enabled = failed),
                                            interactionSource = draftsInteraction,
                                        ) { Text("本机草稿") }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        val errorHost = ConditionalTouchHost(this) { failed }
        errorHost.addView(errorPanel, FrameLayout.LayoutParams(-1, -1))
        root.addView(errorHost, FrameLayout.LayoutParams(-1, -1))
    }

    private class ConditionalTouchHost(
        context: Context,
        private val acceptTouch: () -> Boolean,
    ) : FrameLayout(context) {
        override fun dispatchTouchEvent(ev: MotionEvent): Boolean = acceptTouch() && super.dispatchTouchEvent(ev)
    }

    private fun showError() {
        firstRenderReady = true
        failed = true
        chooser.cancel()
        web?.let(bridge::navigationStarted)
        web?.visibility = View.INVISIBLE
    }

    private fun clearError() {
        failed = false
        web?.visibility = View.VISIBLE
    }

    private fun retry() {
        clearError()
        loadProgress = 0
        if (web == null) createWebView()
        load(lastPage)
    }

    private fun load(url: String?) {
        val start = AppConfig.ORIGIN + if (loginStartedIn == null) WebNavigation.INBOX else WebNavigation.LOGIN
        web?.let { view ->
            bridge.navigationStarted(view)
            view.loadUrl(url?.takeIf { navigation.allowsMainDocument(it, "GET") } ?: start)
        }
    }

    private fun readAppearance(): WorkspaceAppearance {
        val snapshot = spark.credentials.currentSnapshot()
        val identity = spark.cachedWorkspaceIdentity(snapshot)
        val palette = identity.palette
        val systemDark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val dark = identity.isDark(systemDark)
        val fallback = SparkTokens.colors(palette, dark).bg.toArgb()
        val background = if (appearanceCache.getString("scope", null) == snapshot.provisionalScope) {
            appearanceCache.getInt("background", fallback)
        } else fallback
        return WorkspaceAppearance(palette, dark, background)
    }

    private fun applyAppearance(changed: WorkspaceAppearance, fromPage: Boolean = false) {
        appearance = changed
        if (fromPage) {
            appearanceCache.edit().putString("palette", changed.palette.wireValue).putBoolean("dark", changed.dark)
                .putString("scope", spark.credentials.currentSnapshot().provisionalScope)
                .putInt("background", changed.background).apply()
        }
        root.setBackgroundColor(changed.background)
        web?.setBackgroundColor(changed.background)
        theme.applyStyle(
            if (changed.dark) R.style.ThemeOverlay_Spark_Dialog_Dark else R.style.ThemeOverlay_Spark_Dialog_Light,
            true,
        )
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !changed.dark
            if (Build.VERSION.SDK_INT >= 26) isAppearanceLightNavigationBars = !changed.dark
        }
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        // Android 7 cannot draw dark navigation buttons. Keep contrast on those devices.
        if (Build.VERSION.SDK_INT < 26) {
            @Suppress("DEPRECATION")
            window.navigationBarColor = SparkTokens.colors(changed.palette, dark = true).bg.toArgb()
        }
    }

    private fun isDraftLoginCaller(): Boolean = intent.action == ACTION_LOGIN_FOR_DRAFT &&
        callingActivity in setOf(
            ComponentName(this, LocalDraftsActivity::class.java),
            ComponentName(this, ShareCaptureActivity::class.java),
            ComponentName(packageName, "cloud.stwqy.spark.ShareActivity"),
        )

    private fun sessionChanged(url: String?, flush: Boolean = false) {
        if (!navigation.isSameOrigin(url)) return
        val snapshot = spark.credentials.currentSnapshot()
        if (flush || observedScope != snapshot.provisionalScope) {
            observedScope = snapshot.provisionalScope
            sessionUpdate?.cancel()
            sessionUpdate = lifecycleScope.launch {
                try {
                    if (flush) launch(Dispatchers.IO) { spark.credentials.flush() }
                    spark.drafts.observeSession(snapshot)
                    if (snapshot != SessionSnapshot.Guest) spark.draftWork.requestSend()
                } catch (_: SQLiteException) {
                    observedScope = null
                    Log.w("Spark", "Unable to update local session scope")
                }
            }
        }
        returnAfterLogin(url)
    }

    private fun returnAfterLogin(url: String?): Boolean {
        val start = loginStartedIn ?: return false
        if (failed || isFinishing || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || !navigation.isInbox(url)) return false
        val current = spark.credentials.currentSnapshot().provisionalScope
        if (current == SessionScope.GUEST || current == start) return false
        // LocalDraftsActivity verifies the new session before claiming the selected draft.
        setResult(RESULT_OK, Intent().putExtra(LOGIN_FINGERPRINT, current))
        finish()
        return true
    }

    private fun openBrowser(url: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "没有找到可打开此链接的浏览器", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openDrafts() {
        startActivity(Intent(this, LocalDraftsActivity::class.java))
        SparkTransitions.applyCallerPushEnter(this)
    }

    override fun finish() {
        super.finish()
        if (loginStartedIn != null) SparkTransitions.applyLegacyModalExit(this)
    }

    override fun onSaveInstanceState(state: Bundle) {
        super.onSaveInstanceState(state)
        state.putString(PAGE, lastPage)
        state.putString(LOGIN_FINGERPRINT, loginStartedIn)
    }

    override fun onPause() {
        networkMonitor.stop()
        web?.onPause()
        lifecycleScope.launch(Dispatchers.IO) { spark.credentials.flush() }
        super.onPause()
    }

    private fun destroyWebView() {
        val view = web ?: return
        web = null
        webBack.isEnabled = false
        if (bridgeAttached) bridge.detach(view)
        bridgeAttached = false
        chooser.cancel()
        view.webChromeClient = null
        view.webViewClient = WebViewClient()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    override fun onDestroy() {
        networkMonitor.stop()
        destroyWebView()
        super.onDestroy()
    }

    companion object {
        private const val ACTION_LOGIN_FOR_DRAFT = "cloud.stwqy.spark.LOGIN_FOR_DRAFT"
        private const val SPLASH_MAX_HOLD_MS = 450L
        internal const val LOGIN_FINGERPRINT = "loginFingerprint"
        private const val PAGE = "page"

        internal fun loginIntent(context: Context) =
            Intent(context, WebActivity::class.java).setAction(ACTION_LOGIN_FOR_DRAFT)
    }
}
