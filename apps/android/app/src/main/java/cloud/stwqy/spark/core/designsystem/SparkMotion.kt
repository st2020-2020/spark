package cloud.stwqy.spark.core.designsystem

import android.app.Activity
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.animation.PathInterpolator
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import cloud.stwqy.spark.R

/**
 * Unified motion language mirroring apps/web/src/styles/tokens.css so Android native surfaces
 * share the exact cadence, curves, and restraint of the Web workspace.
 */
object SparkMotion {
    val EaseOut: Easing = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
    /** Small settle for things that appear in place (chips, checks); overshoot stays under 2%. */
    val EaseSpring: Easing = CubicBezierEasing(0.3f, 1.18f, 0.5f, 1f)
    /** Things that change position: a list item gliding to its new slot, an indicator sliding. */
    val EaseMove: Easing = CubicBezierEasing(0.32f, 0.72f, 0.24f, 1f)
    val EaseSheet: Easing = CubicBezierEasing(0.32f, 0.72f, 0f, 1f)
    val EaseExit: Easing = CubicBezierEasing(0.4f, 0f, 1f, 1f)

    const val Instant: Int = 100
    const val Fast: Int = 160
    const val Normal: Int = 240
    const val Sheet: Int = 320

    val SpringSnappy: SpringSpec<Float> = spring(dampingRatio = 0.78f, stiffness = 520f)
    val SpringGentle: SpringSpec<IntOffset> = spring(dampingRatio = 0.86f, stiffness = 360f)

    val EaseOutInterpolator: PathInterpolator by lazy { PathInterpolator(0.22f, 1f, 0.36f, 1f) }
    val EaseSheetInterpolator: PathInterpolator by lazy { PathInterpolator(0.32f, 0.72f, 0f, 1f) }

    fun isReducedMotion(context: Context): Boolean = try {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    } catch (_: RuntimeException) {
        false
    }
}

val LocalSparkReducedMotion = staticCompositionLocalOf { false }

@Composable
internal fun <T> sparkTween(
    durationMillis: Int = SparkMotion.Normal,
    easing: Easing = SparkMotion.EaseOut,
    delayMillis: Int = 0,
): FiniteAnimationSpec<T> = if (LocalSparkReducedMotion.current) {
    snap()
} else {
    tween(durationMillis = durationMillis, delayMillis = delayMillis, easing = easing)
}

@Composable
internal fun <T> sparkSpring(spec: SpringSpec<T>): FiniteAnimationSpec<T> =
    if (LocalSparkReducedMotion.current) snap() else spec

/** Draw-phase only press scale: zero relayout and zero per-frame recomposition. */
internal fun Modifier.sparkPressScale(
    interactionSource: InteractionSource,
    pressedScale: Float = 0.97f,
    enabled: Boolean = true,
): Modifier = composed {
    if (!enabled || LocalSparkReducedMotion.current) return@composed this
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = if (pressed) {
            tween(durationMillis = SparkMotion.Instant, easing = SparkMotion.EaseOut)
        } else {
            SparkMotion.SpringSnappy
        },
        label = "sparkPressScale",
    )
    graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

internal object SparkHaptics {
    fun tick(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    fun confirm(view: View) {
        val code = if (Build.VERSION.SDK_INT >= 30) {
            HapticFeedbackConstants.CONFIRM
        } else {
            HapticFeedbackConstants.VIRTUAL_KEY
        }
        view.performHapticFeedback(code)
    }

    fun reject(view: View) {
        val code = if (Build.VERSION.SDK_INT >= 30) {
            HapticFeedbackConstants.REJECT
        } else {
            HapticFeedbackConstants.LONG_PRESS
        }
        view.performHapticFeedback(code)
    }
}

internal object SparkTransitions {
    fun applyCallerPushEnter(caller: Activity) {
        if (Build.VERSION.SDK_INT < 34) {
            applyLegacy(caller, R.anim.spark_push_enter, R.anim.spark_push_exit)
        }
    }

    fun registerTargetPushTransitions(target: Activity) {
        if (Build.VERSION.SDK_INT >= 34) {
            applyApi34(target, Activity.OVERRIDE_TRANSITION_OPEN, R.anim.spark_push_enter, R.anim.spark_push_exit)
            applyApi34(target, Activity.OVERRIDE_TRANSITION_CLOSE, R.anim.spark_pop_enter, R.anim.spark_pop_exit)
        }
    }

    fun refreshTargetPushClose(target: Activity) {
        if (Build.VERSION.SDK_INT >= 34) {
            applyApi34(target, Activity.OVERRIDE_TRANSITION_CLOSE, R.anim.spark_pop_enter, R.anim.spark_pop_exit)
        }
    }

    fun applyLegacyPushExit(target: Activity) {
        if (Build.VERSION.SDK_INT < 34) {
            applyLegacy(target, R.anim.spark_pop_enter, R.anim.spark_pop_exit)
        }
    }

    fun applyCallerModalEnter(caller: Activity) {
        if (Build.VERSION.SDK_INT < 34) {
            applyLegacy(caller, R.anim.spark_modal_enter, R.anim.spark_modal_exit)
        }
    }

    fun registerTargetModalTransitions(target: Activity) {
        if (Build.VERSION.SDK_INT >= 34) {
            applyApi34(target, Activity.OVERRIDE_TRANSITION_OPEN, R.anim.spark_modal_enter, R.anim.spark_modal_exit)
            applyApi34(target, Activity.OVERRIDE_TRANSITION_CLOSE, R.anim.spark_modal_close_enter, R.anim.spark_modal_close_exit)
        }
    }

    fun refreshTargetModalClose(target: Activity) {
        if (Build.VERSION.SDK_INT >= 34) {
            applyApi34(target, Activity.OVERRIDE_TRANSITION_CLOSE, R.anim.spark_modal_close_enter, R.anim.spark_modal_close_exit)
        }
    }

    fun applyLegacyModalExit(target: Activity) {
        if (Build.VERSION.SDK_INT < 34) {
            applyLegacy(target, R.anim.spark_modal_close_enter, R.anim.spark_modal_close_exit)
        }
    }

    private fun applyApi34(activity: Activity, overrideType: Int, enterAnim: Int, exitAnim: Int) {
        if (Build.VERSION.SDK_INT >= 34) {
            val (enter, exit) = if (SparkMotion.isReducedMotion(activity)) 0 to 0 else enterAnim to exitAnim
            activity.overrideActivityTransition(overrideType, enter, exit)
        }
    }

    private fun applyLegacy(activity: Activity, enterAnim: Int, exitAnim: Int) {
        val (enter, exit) = if (SparkMotion.isReducedMotion(activity)) 0 to 0 else enterAnim to exitAnim
        @Suppress("DEPRECATION")
        activity.overridePendingTransition(enter, exit)
    }
}
