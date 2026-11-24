package cloud.stwqy.spark.feature.drafts

import android.app.Application
import android.content.ComponentName
import android.content.pm.ActivityInfo
import android.content.res.Resources
import android.util.TypedValue
import cloud.stwqy.spark.R
import cloud.stwqy.spark.feature.capture.ShareCaptureActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26], application = Application::class)
class DraftHostsTest {
    @Test fun legacyShareAliasTargetsATransparentHostWithoutOrientationLock() {
        val app = RuntimeEnvironment.getApplication()
        val manager = app.packageManager
        val alias = manager.getActivityInfo(ComponentName(app.packageName, "cloud.stwqy.spark.ShareActivity"), 0)
        val capture = manager.getActivityInfo(ComponentName(app, ShareCaptureActivity::class.java), 0)
        val box = manager.getActivityInfo(ComponentName(app, LocalDraftsActivity::class.java), 0)
        assertEquals(ShareCaptureActivity::class.java.name, alias.targetActivity)
        assertTrue(alias.exported)
        assertFalse(capture.exported)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, capture.screenOrientation)
        assertNotEquals(0, capture.flags and ActivityInfo.FLAG_EXCLUDE_FROM_RECENTS)
        assertEquals(R.style.Theme_Spark_TranslucentSheet, capture.themeResource)
        assertTrue(app.resources.newTheme().apply { applyStyle(capture.themeResource, true) }.isTranslucent())
        assertFalse(box.exported)
        assertFalse(app.resources.newTheme().apply { applyStyle(box.themeResource, true) }.isTranslucent())
    }

    private fun Resources.Theme.isTranslucent(): Boolean =
        TypedValue().let { resolveAttribute(android.R.attr.windowIsTranslucent, it, true) && it.data != 0 }
}
