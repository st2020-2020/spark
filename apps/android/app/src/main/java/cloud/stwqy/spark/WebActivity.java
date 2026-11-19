package cloud.stwqy.spark;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

public final class WebActivity extends Activity {
    private static final String WEB_STATE = "webState";
    private FrameLayout root;
    private WebView web;
    private View errorPage;
    private String failedUrl;
    private boolean returningToDraft;
    private String loginStartedIn;
    private String pausedSession;
    private boolean resumed;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // This activity is also a launcher. Only a result caller from our own draft screen
        // can start the login round trip, regardless of the incoming intent's contents.
        returningToDraft = new ComponentName(this, ShareActivity.class).equals(getCallingActivity());
        if (returningToDraft) {
            loginStartedIn = state == null ? sessionScope() : state.getString("loginStartedIn");
        }

        root = new FrameLayout(this);
        setContentView(root);
        createWebView();

        Bundle history = state == null ? null : state.getBundle(WEB_STATE);
        if (history == null || !sessionScope().equals(state.getString("pageSession"))
                || web.restoreState(history) == null) {
            web.loadUrl(startUrl());
        } else {
            String previousFailure = state.getString("failedUrl");
            if (WebNavigation.isSparkUrl(previousFailure)) showError(previousFailure);
        }
    }

    private void createWebView() {
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        WebSettings settings = web.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " " + WebNavigation.USER_AGENT_MARKER);
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new SparkWebClient());
    }

    private final class SparkWebClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            switch (WebNavigation.decide(view.getUrl(), url.toString(), request.getMethod(),
                    request.isForMainFrame(), request.hasGesture(), request.isRedirect())) {
                case WEB:
                    return false;
                case LOCAL_DRAFTS:
                    startActivity(new Intent(WebActivity.this, ShareActivity.class));
                    return true;
                case BROWSER:
                    openBrowser(url);
                    return true;
                default:
                    return true;
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // Form POSTs bypass shouldOverrideUrlLoading.
            if (request.isForMainFrame() && !WebNavigation.isSparkUrl(request.getUrl().toString())) {
                return new WebResourceResponse("text/plain", "UTF-8", null);
            }
            return null;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap icon) {
            if (WebNavigation.isSparkUrl(url)) {
                clearError();
            } else {
                view.stopLoading();
                showError(startUrl());
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showError(request.getUrl().toString());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame()) showError(request.getUrl().toString());
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            // Web login changes routes through the History API.
            returnAfterLogin(url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            returnAfterLogin(url);
        }
    }

    private void openBrowser(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ex) {
            Toast.makeText(this, "请先安装可打开链接的浏览器", Toast.LENGTH_SHORT).show();
        }
    }

    private String startUrl() {
        return WebNavigation.ORIGIN + (returningToDraft ? WebNavigation.LOGIN : WebNavigation.INBOX);
    }

    private void showError(String url) {
        failedUrl = WebNavigation.isSparkUrl(url) ? url : startUrl();
        if (errorPage != null) return;
        SharePage page = new SharePage(this, "暂时无法打开 Spark");
        page.status.setText("请检查网络连接，或继续处理本机草稿。");
        page.primaryButton("重新载入", () -> {
            String retryUrl = failedUrl;
            if (retryUrl == null) return;
            clearError();
            if (retryUrl.equals(web.getUrl())) web.reload();
            else web.loadUrl(retryUrl);
        });
        page.button(returningToDraft ? "返回草稿" : "本机草稿", () -> {
            if (returningToDraft) finish();
            else startActivity(new Intent(this, ShareActivity.class));
        });
        errorPage = page.root;
        web.setVisibility(View.GONE);
        root.addView(errorPage, new FrameLayout.LayoutParams(-1, -1));
    }

    private void clearError() {
        failedUrl = null;
        if (errorPage == null) return;
        root.removeView(errorPage);
        errorPage = null;
        web.setVisibility(View.VISIBLE);
    }

    private static String sessionScope() {
        return ShareDrafts.provisionalScope(CookieManager.getInstance().getCookie(WebNavigation.ORIGIN));
    }

    private boolean returnAfterLogin(String url) {
        if (!returningToDraft || !resumed || isFinishing() || errorPage != null
                || !WebNavigation.isInbox(url)) return false;
        String scope = sessionScope();
        if (ShareDrafts.GUEST.equals(scope) || scope.equals(loginStartedIn)) return false;
        // The draft screen verifies the new session and the draft owner before exposing or saving data.
        setResult(RESULT_OK);
        finish();
        return true;
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        Bundle history = new Bundle();
        if (web.saveState(history) != null) state.putBundle(WEB_STATE, history);
        state.putString("pageSession", pausedSession != null ? pausedSession : sessionScope());
        state.putString("failedUrl", failedUrl);
        if (returningToDraft) state.putString("loginStartedIn", loginStartedIn);
    }

    @Override
    public void onBackPressed() {
        if (returnAfterLogin(web.getUrl())) return;
        // Back within a login round trip supports registration and password recovery.
        if (web.canGoBack()) {
            clearError();
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        resumed = false;
        pausedSession = sessionScope();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
        if (pausedSession != null && !pausedSession.equals(sessionScope())) {
            clearError();
            destroyWebView();
            createWebView();
            web.loadUrl(startUrl());
        }
        pausedSession = null;
        web.onResume();
        returnAfterLogin(web.getUrl());
    }

    private void destroyWebView() {
        web.setWebViewClient(new WebViewClient());
        web.stopLoading();
        root.removeView(web);
        web.destroy();
    }

    @Override
    protected void onDestroy() {
        destroyWebView();
        super.onDestroy();
    }
}
