package cloud.stwqy.spark;

import java.net.URI;
import java.net.URISyntaxException;

final class WebNavigation {
    static final String ORIGIN = "https://spark.stwqy.cloud";
    static final String USER_AGENT_MARKER = "SparkAndroid/2";
    static final String INBOX = "/inbox";
    static final String LOGIN = "/login";
    private static final String HOST = URI.create(ORIGIN).getHost();
    private static final String LOCAL_DRAFTS = "/android/local-drafts";

    enum Destination { WEB, LOCAL_DRAFTS, BROWSER, BLOCK }

    private WebNavigation() {}

    static Destination decide(String currentUrl, String url, String method,
                              boolean mainFrame, boolean gesture, boolean redirect) {
        URI target = parse(url);
        boolean clicked = mainFrame && gesture && !redirect && "GET".equals(method)
                && isSparkUrl(currentUrl);
        if (isSpark(target)) {
            if (clicked && LOCAL_DRAFTS.equals(target.getRawPath())
                    && target.getRawQuery() == null && target.getRawFragment() == null) {
                return Destination.LOCAL_DRAFTS;
            }
            return Destination.WEB;
        }
        if (clicked && target != null && target.getHost() != null && target.getRawUserInfo() == null
                && ("https".equalsIgnoreCase(target.getScheme()) || "http".equalsIgnoreCase(target.getScheme()))) {
            return Destination.BROWSER;
        }
        return Destination.BLOCK;
    }

    static boolean isSparkUrl(String url) {
        return isSpark(parse(url));
    }

    static boolean isInbox(String url) {
        URI target = parse(url);
        return isSpark(target) && INBOX.equals(target.getRawPath());
    }

    private static boolean isSpark(URI url) {
        return url != null && "https".equalsIgnoreCase(url.getScheme())
                && HOST.equalsIgnoreCase(url.getRawAuthority());
    }

    private static URI parse(String url) {
        if (url == null) return null;
        try {
            return new URI(url);
        } catch (URISyntaxException invalid) {
            return null;
        }
    }
}
