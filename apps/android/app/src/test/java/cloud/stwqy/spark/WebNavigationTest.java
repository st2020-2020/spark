package cloud.stwqy.spark;

import static cloud.stwqy.spark.WebNavigation.Destination.BLOCK;
import static cloud.stwqy.spark.WebNavigation.Destination.BROWSER;
import static cloud.stwqy.spark.WebNavigation.Destination.LOCAL_DRAFTS;
import static cloud.stwqy.spark.WebNavigation.Destination.WEB;

/** Standalone checks for the navigation policy, runnable with a JDK and no Android SDK. */
public final class WebNavigationTest {
    private static final String CURRENT = WebNavigation.ORIGIN + "/inbox";
    private static final String DRAFTS = WebNavigation.ORIGIN + "/android/local-drafts";

    public static void main(String[] args) {
        expect("local drafts link", LOCAL_DRAFTS, CURRENT, DRAFTS, "GET", true, true, false);
        expect("same-origin page", WEB, CURRENT, WebNavigation.ORIGIN + "/projects", "GET", true, true, false);
        expect("external link", BROWSER, CURRENT, "https://example.test/page", "GET", true, true, false);
        expect("external HTTP link", BROWSER, CURRENT, "http://example.test/page", "GET", true, true, false);
        expect("external drafts path", BROWSER, CURRENT, "https://example.test/android/local-drafts",
                "GET", true, true, false);
        expect("external page as source", WEB, "https://example.test", DRAFTS, "GET", true, true, false);
        expect("no current page", WEB, null, DRAFTS, "GET", true, true, false);
        expect("non-user navigation", WEB, CURRENT, DRAFTS, "GET", true, false, false);
        expect("subframe navigation", WEB, CURRENT, DRAFTS, "GET", false, true, false);
        expect("redirect with gesture", WEB, CURRENT, DRAFTS, "GET", true, true, true);
        expect("form submission", WEB, CURRENT, DRAFTS, "POST", true, true, false);
        expect("external redirect", BLOCK, CURRENT, "https://example.test/page", "GET", true, true, true);
        expect("external script navigation", BLOCK, CURRENT, "https://example.test/page",
                "GET", true, false, false);
        expect("custom scheme", BLOCK, CURRENT, "intent://android/local-drafts", "GET", true, true, false);

        for (String suffix : new String[]{"/", "?from=more", "#top", "?", "#"}) {
            expect("draft path suffix " + suffix, WEB, CURRENT, DRAFTS + suffix, "GET", true, true, false);
        }
        expect("encoded path", WEB, CURRENT, WebNavigation.ORIGIN + "/android/%6cocal-drafts",
                "GET", true, true, false);
        expect("different port", BROWSER, CURRENT, "https://spark.stwqy.cloud:8443/android/local-drafts",
                "GET", true, true, false);
        expect("HTTP at Spark host", BROWSER, CURRENT, "http://spark.stwqy.cloud/android/local-drafts",
                "GET", true, true, false);
        expect("lookalike host", BROWSER, CURRENT, "https://spark.stwqy.cloud.example.test/android/local-drafts",
                "GET", true, true, false);
        expect("userinfo", BLOCK, CURRENT, "https://spark.stwqy.cloud@example.test/android/local-drafts",
                "GET", true, true, false);

        System.out.println("WebNavigation checks passed");
    }

    private static void expect(String scenario, WebNavigation.Destination expected, String source,
                               String target, String method, boolean mainFrame, boolean gesture, boolean redirect) {
        WebNavigation.Destination actual = WebNavigation.decide(source, target, method, mainFrame, gesture, redirect);
        if (actual != expected) {
            throw new AssertionError(scenario + ": expected " + expected + ", got " + actual);
        }
    }
}
