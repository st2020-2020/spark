package cloud.stwqy.spark.core.security

import cloud.stwqy.spark.core.security.WebNavigation.Destination.BLOCK
import cloud.stwqy.spark.core.security.WebNavigation.Destination.BROWSER
import cloud.stwqy.spark.core.security.WebNavigation.Destination.LOCAL_DRAFTS
import cloud.stwqy.spark.core.security.WebNavigation.Destination.WEB
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WebNavigationTest {
    private val origin = "https://spark.example"
    private val inbox = "$origin/inbox"
    private val nav = WebNavigation(origin, allowCleartextDevOrigin = false)

    @Test fun allowsOnlyExactOriginGetForMainDocuments() {
        assertTrue(nav.allowsMainDocument(inbox, "GET"))
        assertFalse(nav.allowsMainDocument("$origin/login", "POST"))
        assertFalse(nav.allowsMainDocument("https://elsewhere.example/form", "POST"))
        assertFalse(nav.allowsMainDocument("https://elsewhere.example", "GET"))
        assertEquals(BLOCK, nav.decide(inbox, "$origin/login", "POST", true, false, false))
        assertEquals(WEB, nav.decide(inbox, "$origin/api/v1/auth/login", "POST", false, false, false))
        assertTrue(nav.isInbox("https://SPARK.example/inbox"))
        assertFalse(nav.isInbox("$origin/inbox/"))
        assertFalse(nav.isSameOrigin("https://spark.example:443/inbox"))
        assertFalse(nav.isSameOrigin("https://spark.example.other.example/inbox"))
        assertFalse(nav.isSameOrigin("http://spark.example/inbox"))
        assertFalse(nav.isSameOrigin("https://person@spark.example/inbox"))
    }

    @Test fun draftsRoutesRequireSameOriginMainFrameUserGestureGetAndNoQueryOrFragment() {
        for (path in listOf("/mobile/local-drafts", "/android/local-drafts")) {
            val target = origin + path
            assertEquals(LOCAL_DRAFTS, nav.decide(inbox, target, "GET", true, true, false))
            assertEquals(BLOCK, nav.decide(inbox, "$target?", "GET", true, true, false))
            assertEquals(BLOCK, nav.decide(inbox, "$target#", "GET", true, true, false))
            assertEquals(BLOCK, nav.decide(inbox, target, "POST", true, true, false))
            assertEquals(BLOCK, nav.decide(inbox, target, "GET", true, false, false))
            assertEquals(BLOCK, nav.decide(inbox, target, "GET", true, true, true))
            assertEquals(BLOCK, nav.decide(inbox, target, "GET", false, true, false))
            assertEquals(BLOCK, nav.decide("https://elsewhere.example", target, "GET", true, true, false))
        }
    }

    @Test fun externalNavigationRequiresExplicitGestureAndSafeHttpUrl() {
        val external = "https://elsewhere.example/post"
        assertEquals(BROWSER, nav.decide(inbox, external, "GET", true, true, false))
        assertEquals(BROWSER, nav.decide(inbox, "http://elsewhere.example", "GET", true, true, false))
        assertEquals(BLOCK, nav.decide(inbox, external, "GET", true, false, false))
        assertEquals(BLOCK, nav.decide(inbox, external, "GET", true, true, true))
        assertEquals(BLOCK, nav.decide(inbox, external, "POST", true, true, false))
        assertEquals(BLOCK, nav.decide(inbox, external, "GET", false, true, false))
        assertEquals(BLOCK, nav.decide(null, external, "GET", true, true, false))
        for (url in listOf("https://person@elsewhere.example", "file:///data/a", "content://source/a",
            "javascript:0", "intent://other", "http://spark.example", "https://[%]", "https:elsewhere.example")) {
            assertEquals(url, BLOCK, nav.decide(inbox, url, "GET", true, true, false))
        }
    }

    @Test fun devCleartextIsLimitedToTheConfiguredLoopbackOrigin() {
        val dev = WebNavigation("http://10.0.2.2:5173", allowCleartextDevOrigin = true)
        assertTrue(dev.isSameOrigin("http://10.0.2.2:5173/inbox"))
        assertFalse(dev.isSameOrigin("http://10.0.2.2:5174/inbox"))
        assertThrows(IllegalArgumentException::class.java) { WebNavigation("http://10.0.2.2:5173", false) }
        assertThrows(IllegalArgumentException::class.java) { WebNavigation("http://elsewhere.example", true) }
    }
}
