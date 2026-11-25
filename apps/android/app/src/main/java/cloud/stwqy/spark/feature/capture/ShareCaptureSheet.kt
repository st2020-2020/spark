package cloud.stwqy.spark.feature.capture

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.designsystem.AnimatedStatusBanner
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkReducedMotion
import cloud.stwqy.spark.core.designsystem.LocalSparkStatusColors
import cloud.stwqy.spark.core.designsystem.SparkMotion
import cloud.stwqy.spark.core.designsystem.sparkTween
import cloud.stwqy.spark.feature.drafts.CaptureClosing
import cloud.stwqy.spark.feature.drafts.DraftAccountLine
import cloud.stwqy.spark.feature.drafts.DraftActions
import cloud.stwqy.spark.feature.drafts.DraftCatalogPicker
import cloud.stwqy.spark.feature.drafts.DraftEditor
import cloud.stwqy.spark.feature.drafts.DraftUiState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.isActive

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShareCaptureSheet(
    ui: DraftUiState,
    model: ShareCaptureViewModel,
    dark: Boolean,
    onFinishComplete: (CaptureClosing) -> Unit = {},
) {
    val colors = LocalSparkColors.current
    val reducedMotion = LocalSparkReducedMotion.current
    val dismissAllowed by rememberUpdatedState(ui.initialized && !ui.busy && ui.picker == null && !ui.locked)
    val closing by rememberUpdatedState(ui.isClosing)
    val sheet = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        // Flush before dismissing the window so a failed write leaves the editor usable.
        confirmValueChange = { target ->
            if (target == SheetValue.Hidden) {
                if (closing) {
                    true
                } else {
                    if (dismissAllowed) model.closeEditor()
                    false
                }
            } else true
        },
    )
    var needsReexpand by remember { mutableStateOf(false) }
    LaunchedEffect(ui.captureGeneration, ui.closing, reducedMotion) {
        val finish = ui.closing
        if (finish == null) {
            if (needsReexpand || ui.captureGeneration > 0L) {
                needsReexpand = false
                try {
                    sheet.show()
                } catch (cancelled: CancellationException) {
                    if (!coroutineContext.isActive) throw cancelled
                } catch (_: RuntimeException) {
                    // Sheet host may already be detaching.
                }
            }
            return@LaunchedEffect
        }
        needsReexpand = true
        if (!reducedMotion) {
            try {
                sheet.hide()
            } catch (cancelled: CancellationException) {
                if (!coroutineContext.isActive) throw cancelled
                // User touch/drag interrupted sheet.hide() while this closing generation is still active;
                // proceed to complete exit instead of wedging the sheet.
            } catch (_: RuntimeException) {
                // Sheet host may already be detaching; still complete exit cleanly.
            }
        }
        if (coroutineContext.isActive) onFinishComplete(finish)
    }

    val slideInLeft = slideInHorizontally(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) { it / 6 } +
        fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut))
    val slideOutLeft = slideOutHorizontally(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) { -it / 8 } +
        fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit))
    val slideInRight = slideInHorizontally(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) { -it / 6 } +
        fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut))
    val slideOutRight = slideOutHorizontally(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) { it / 8 } +
        fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit))
    val instantIn = fadeIn(sparkTween(SparkMotion.Instant))
    val instantOut = fadeOut(sparkTween(SparkMotion.Instant))

    ModalBottomSheet(
        onDismissRequest = { if (!ui.locked) model.closeEditor() },
        sheetState = sheet,
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        containerColor = colors.surface,
        contentColor = colors.fg,
        scrimColor = LocalSparkStatusColors.current.scrim,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = ui.picker == null && !ui.locked),
    ) {
        AnimatedContent(
            targetState = ui.picker != null,
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .animateContentSize(sparkTween(SparkMotion.Sheet, SparkMotion.EaseSheet)),
            transitionSpec = {
                if (reducedMotion) {
                    instantIn togetherWith instantOut
                } else if (targetState) {
                    slideInLeft togetherWith slideOutLeft
                } else {
                    slideInRight togetherWith slideOutRight
                }
            },
            label = "shareCaptureMode",
        ) { showingPicker ->
            if (showingPicker) {
                DraftCatalogPicker(ui, model, dark, Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp))
            } else {
                Column(
                    Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    val willSaveDraft = ui.draft != null && ui.hasContent && !ui.draft.frozen
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("收藏到 Spark", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                            DraftAccountLine(ui)
                        }
                        TextButton(
                            onClick = model::closeEditor,
                            enabled = ui.initialized && !ui.busy && !ui.locked,
                        ) { Text(if (willSaveDraft) "暂存" else "关闭") }
                    }
                    AnimatedStatusBanner(ui.shareError, error = true, Modifier.fillMaxWidth())
                    if (ui.draft != null) {
                        key(ui.draft.id) {
                            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                                DraftEditor(ui, model, dark)
                            }
                        }
                    } else if (!ui.initialized) {
                        Column(
                            Modifier.fillMaxWidth().padding(vertical = 20.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            LinearProgressIndicator(
                                modifier = Modifier.fillMaxWidth().height(3.dp),
                                trackColor = colors.surfaceMuted,
                                strokeCap = StrokeCap.Round,
                            )
                            Text("正在准备内容…", style = MaterialTheme.typography.bodySmall, color = colors.fgSoft)
                        }
                    }
                    if (ui.draft != null || ui.error != null || (ui.initialized && ui.shareError == null)) {
                        HorizontalDivider(color = colors.border)
                        DraftActions(ui, model)
                    }
                }
            }
        }
    }
}
