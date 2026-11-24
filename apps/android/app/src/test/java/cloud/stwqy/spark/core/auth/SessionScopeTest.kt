package cloud.stwqy.spark.core.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.security.MessageDigest
import java.util.Base64

class SessionScopeTest {
    @Test fun retainsV1FingerprintAndSendsOnlyTheSessionCookie() {
        val cookie = "spark_session=synthetic-v1-cookie"
        val snapshot = SessionScope.fromCookie("other=unused; $cookie; theme=dark") as SessionSnapshot.CookieBased
        val digest = MessageDigest.getInstance("SHA-256").digest(cookie.toByteArray())
        assertEquals("pending:" + Base64.getEncoder().encodeToString(digest), snapshot.provisionalScope)
        assertEquals(mapOf("Cookie" to cookie), snapshot.requestHeaders)
        assertFalse(snapshot.toString().contains(cookie))
    }

    @Test fun missingEmptyMalformedAndDuplicateSessionCookiesAreGuest() {
        for (header in listOf(null, "other=1", "spark_session=", "spark_session=alpha; spark_session=beta",
            "spark_session=alpha\nbeta")) {
            assertEquals(SessionSnapshot.Guest, SessionScope.fromCookie(header))
        }
    }
}
