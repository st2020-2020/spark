package cloud.stwqy.spark.core.designsystem

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun SparkCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val colors = LocalSparkColors.current
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = colors.surface),
        border = BorderStroke(1.dp, colors.border),
    ) { content() }
}

@Composable
internal fun PaperLabel(label: String, tone: PaperTone, modifier: Modifier = Modifier) {
    Surface(modifier, shape = RoundedCornerShape(5.dp), color = tone.background, contentColor = tone.foreground) {
        Text(label, Modifier.widthIn(max = 210.dp).padding(PaddingValues(horizontal = 8.dp, vertical = 4.dp)),
            style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun WashiTapeChip(projectId: String, label: String, dark: Boolean) {
    PaperLabel(label, SparkTokens.projectTone(projectId, dark))
}

@Composable
internal fun StatusBanner(message: String, error: Boolean, modifier: Modifier = Modifier) {
    val status = LocalSparkStatusColors.current
    val colors = LocalSparkColors.current
    Surface(
        modifier.heightIn(min = 36.dp), shape = MaterialTheme.shapes.small,
        color = if (error) status.dangerBg else colors.surfaceMuted,
        contentColor = if (error) status.danger else colors.fgSoft,
    ) {
        Text(message, Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
    }
}
