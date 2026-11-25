package cloud.stwqy.spark.core.designsystem

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.R

@Composable
internal fun SparkBrandMark(size: Dp = 48.dp, modifier: Modifier = Modifier) {
    val colors = LocalSparkColors.current
    Surface(
        modifier = modifier.size(size),
        shape = RoundedCornerShape((size.value * 0.28f).dp),
        color = colors.primary,
    ) {
        Image(
            painter = painterResource(R.drawable.ic_jar),
            contentDescription = null,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@Composable
internal fun SparkCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colors = LocalSparkColors.current
    val cardColors = CardDefaults.cardColors(containerColor = colors.surface)
    val border = BorderStroke(1.dp, colors.border)
    if (onClick != null) {
        val interaction = remember { MutableInteractionSource() }
        Card(
            onClick = onClick,
            modifier = modifier.sparkPressScale(interaction, pressedScale = 0.985f, enabled = enabled),
            enabled = enabled,
            colors = cardColors,
            border = border,
            interactionSource = interaction,
        ) { content() }
    } else {
        Card(modifier = modifier, colors = cardColors, border = border) { content() }
    }
}

@Composable
internal fun PaperLabel(
    label: String,
    tone: PaperTone,
    modifier: Modifier = Modifier,
    leadingSpinner: Boolean = false,
) {
    val bg by animateColorAsState(
        targetValue = tone.background,
        animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
        label = "paperLabelBg",
    )
    val fg by animateColorAsState(
        targetValue = tone.foreground,
        animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
        label = "paperLabelFg",
    )
    val enter = fadeIn(sparkTween(SparkMotion.Instant, SparkMotion.EaseOut))
    val exit = fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit))
    Surface(
        modifier = modifier.animateContentSize(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)),
        shape = RoundedCornerShape(6.dp),
        color = bg,
        contentColor = fg,
    ) {
        Row(
            Modifier.widthIn(max = 210.dp).padding(PaddingValues(horizontal = 8.dp, vertical = 4.dp)),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (leadingSpinner) {
                CircularProgressIndicator(
                    modifier = Modifier.size(10.dp),
                    strokeWidth = 1.5.dp,
                    color = fg,
                )
            }
            AnimatedContent(
                targetState = label,
                transitionSpec = { enter togetherWith exit },
                label = "paperLabelText",
            ) { text ->
                Text(text, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
internal fun WashiTapeChip(projectId: String, label: String, dark: Boolean, modifier: Modifier = Modifier) {
    PaperLabel(label, SparkTokens.projectTone(projectId, dark), modifier = modifier)
}

@Composable
internal fun SparkAddChip(
    label: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalSparkColors.current
    val view = LocalView.current
    val interaction = remember { MutableInteractionSource() }
    Surface(
        onClick = {
            SparkHaptics.tick(view)
            onClick()
        },
        modifier = Modifier
            .heightIn(min = 36.dp)
            .sparkPressScale(interaction, pressedScale = 0.96f, enabled = enabled),
        enabled = enabled,
        shape = RoundedCornerShape(999.dp),
        color = colors.surfaceMuted,
        contentColor = colors.fg,
        border = BorderStroke(1.dp, colors.borderStrong),
        interactionSource = interaction,
    ) {
        Box(
            Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
    }
}

@Composable
internal fun SparkRemovableChip(
    label: String,
    removeDescription: String,
    tone: PaperTone,
    enabled: Boolean = true,
    onRemove: () -> Unit,
) {
    val reducedMotion = LocalSparkReducedMotion.current
    val view = LocalView.current
    val interaction = remember { MutableInteractionSource() }
    val enter = remember { Animatable(if (reducedMotion) 1f else 0.88f) }
    LaunchedEffect(reducedMotion) {
        if (reducedMotion) {
            enter.snapTo(1f)
        } else {
            enter.animateTo(1f, androidx.compose.animation.core.tween(SparkMotion.Fast, easing = SparkMotion.EaseSpring))
        }
    }
    Surface(
        onClick = {
            SparkHaptics.tick(view)
            onRemove()
        },
        modifier = Modifier
            .heightIn(min = 36.dp)
            .graphicsLayer {
                scaleX = enter.value
                scaleY = enter.value
                alpha = ((enter.value - 0.88f) / 0.12f).coerceIn(0f, 1f)
            }
            .sparkPressScale(interaction, pressedScale = 0.96f, enabled = enabled)
            .semantics { contentDescription = removeDescription },
        enabled = enabled,
        shape = RoundedCornerShape(999.dp),
        color = tone.background,
        contentColor = tone.foreground,
        interactionSource = interaction,
    ) {
        Row(
            Modifier.widthIn(max = 216.dp).padding(start = 10.dp, end = 8.dp, top = 7.dp, bottom = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                modifier = Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            SparkCloseIcon(size = 12.dp, color = tone.foreground.copy(alpha = 0.78f))
        }
    }
}

@Composable
internal fun StatusBanner(message: String, error: Boolean, modifier: Modifier = Modifier) {
    val status = LocalSparkStatusColors.current
    val colors = LocalSparkColors.current
    val bg by animateColorAsState(
        targetValue = if (error) status.dangerBg else colors.surfaceMuted,
        animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
        label = "bannerBg",
    )
    val fg by animateColorAsState(
        targetValue = if (error) status.danger else colors.fgSoft,
        animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
        label = "bannerFg",
    )
    Surface(
        modifier.heightIn(min = 36.dp),
        shape = MaterialTheme.shapes.small,
        color = bg,
        contentColor = fg,
    ) {
        Text(message, Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
internal fun AnimatedStatusBanner(
    message: String?,
    error: Boolean,
    modifier: Modifier = Modifier,
) {
    var cached by remember { mutableStateOf(message) }
    var cachedError by remember { mutableStateOf(error) }
    if (message != null) {
        cached = message
        cachedError = error
    }
    AnimatedVisibility(
        visible = message != null,
        modifier = modifier,
        enter = expandVertically(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) +
            fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)),
        exit = shrinkVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) +
            fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
    ) {
        cached?.let { text ->
            val semanticMod = if (cachedError) {
                Modifier.semantics { liveRegion = LiveRegionMode.Polite }
            } else Modifier
            StatusBanner(text, cachedError, semanticMod)
        }
    }
}

@Composable
internal fun SparkBackIcon(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val stroke = Stroke(width = size.toPx() * 0.1f, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val midY = this.size.height / 2f
        val left = this.size.width * 0.22f
        val right = this.size.width * 0.78f
        val tipOffset = this.size.width * 0.24f
        drawLine(color, Offset(right, midY), Offset(left, midY), strokeWidth = stroke.width, cap = StrokeCap.Round)
        drawLine(color, Offset(left + tipOffset, midY - tipOffset), Offset(left, midY), strokeWidth = stroke.width, cap = StrokeCap.Round)
        drawLine(color, Offset(left + tipOffset, midY + tipOffset), Offset(left, midY), strokeWidth = stroke.width, cap = StrokeCap.Round)
    }
}

@Composable
internal fun SparkCloseIcon(color: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val stroke = size.toPx() * 0.13f
        val pad = this.size.width * 0.22f
        val end = this.size.width - pad
        drawLine(color, Offset(pad, pad), Offset(end, end), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(color, Offset(end, pad), Offset(pad, end), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}

@Composable
internal fun SparkChevronIcon(color: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val stroke = size.toPx() * 0.12f
        val midX = this.size.width / 2f
        val topY = this.size.height * 0.36f
        val bottomY = this.size.height * 0.66f
        val span = this.size.width * 0.28f
        drawLine(color, Offset(midX - span, topY), Offset(midX, bottomY), strokeWidth = stroke, cap = StrokeCap.Round)
        drawLine(color, Offset(midX, bottomY), Offset(midX + span, topY), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}
