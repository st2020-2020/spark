package cloud.stwqy.spark.core.designsystem

import android.app.Application
import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class SparkMotionTest {
    @Test fun motionDurationsMatchWebSystemTokens() {
        assertEquals(100, SparkMotion.Instant)
        assertEquals(160, SparkMotion.Fast)
        assertEquals(240, SparkMotion.Normal)
        assertEquals(320, SparkMotion.Sheet)
        // EaseOut curves must start at 0, finish at 1, and decelerate smoothly.
        assertEquals(0f, SparkMotion.EaseOut.transform(0f), 1e-4f)
        assertEquals(1f, SparkMotion.EaseOut.transform(1f), 1e-4f)
        assertTrue(SparkMotion.EaseOut.transform(0.5f) > 0.7f)
        assertEquals(0f, SparkMotion.EaseSheet.transform(0f), 1e-4f)
        assertEquals(1f, SparkMotion.EaseSheet.transform(1f), 1e-4f)
    }

    @Test fun reducedMotionReflectsAnimatorDurationScale() {
        val context = RuntimeEnvironment.getApplication()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        assertFalse(SparkMotion.isReducedMotion(context))

        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(SparkMotion.isReducedMotion(context))

        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0.5f)
        assertFalse(SparkMotion.isReducedMotion(context))
    }
}
