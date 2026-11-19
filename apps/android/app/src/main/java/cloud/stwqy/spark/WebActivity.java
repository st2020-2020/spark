package cloud.stwqy.spark;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
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
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Toast;

public final class WebActivity extends Activity {
    private WebView web;
    private Button retry;
    private boolean returningToDraft;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        returningToDraft = !Intent.ACTION_MAIN.equals(getIntent().getAction()) && !isTaskRoot();

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setPadding(dp(6), 0, dp(6), 0);
        page.addView(toolbar);
        if (returningToDraft) {
            action(toolbar, "返回草稿", view -> finish());
        } else {
            action(toolbar, "收件箱", view -> open("/inbox"));
            action(toolbar, "待确认", view -> open("/unclassified?tab=suggested"));
            action(toolbar, "本机草稿", view ->
                startActivity(new Intent(this, ShareActivity.class)));
        }

        retry = new Button(this);
        retry.setText("网页未能载入，点此重试");
        retry.setVisibility(View.GONE);
        retry.setOnClickListener(view -> {
            if (isSparkPage(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) {
                web.reload();
            } else {
                open("/inbox");
            }
        });
        page.addView(retry);
        web = new WebView(this);
        page.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(page);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isSparkPage(uri)) return false;
                if (request.isForMainFrame() && request.hasGesture()
                    && ("https".equalsIgnoreCase(uri.getScheme()) || "http".equalsIgnoreCase(uri.getScheme()))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
                    } catch (ActivityNotFoundException ex) {
                        Toast.makeText(WebActivity.this, "请先安装可打开链接的浏览器", Toast.LENGTH_SHORT).show();
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                retry.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) retry.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) retry.setVisibility(View.VISIBLE);
            }
        });
        String previous = state == null ? null : state.getString("page");
        if (previous != null && isSparkPage(Uri.parse(previous))) web.loadUrl(previous);
        else open("/inbox");
    }

    private static boolean isSparkPage(Uri uri) {
        return uri != null && SparkApi.ORIGIN.equals("https://" + uri.getEncodedAuthority())
            && "https".equalsIgnoreCase(uri.getScheme());
    }

    private void open(String path) {
        web.loadUrl(SparkApi.ORIGIN + path);
    }

    private void action(LinearLayout bar, String title, View.OnClickListener click) {
        Button button = new Button(this, null, android.R.attr.borderlessButtonStyle);
        button.setText(title);
        button.setMinHeight(dp(48));
        button.setOnClickListener(click);
        bar.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("page", web.getUrl());
    }

    @Override
    public void onBackPressed() {
        if (!returningToDraft && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        ((LinearLayout) web.getParent()).removeView(web);
        web.destroy();
        super.onDestroy();
    }
}
