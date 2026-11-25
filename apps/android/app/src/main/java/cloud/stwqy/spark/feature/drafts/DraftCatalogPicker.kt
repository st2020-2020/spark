package cloud.stwqy.spark.feature.drafts

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.SparkCloseIcon
import cloud.stwqy.spark.core.designsystem.SparkHaptics
import cloud.stwqy.spark.core.designsystem.SparkMotion
import cloud.stwqy.spark.core.designsystem.WashiTapeChip
import cloud.stwqy.spark.core.designsystem.sparkPressScale
import cloud.stwqy.spark.core.designsystem.sparkSpring
import cloud.stwqy.spark.core.designsystem.sparkTween

@Composable
internal fun DraftCatalogPicker(ui: DraftUiState, model: DraftViewModel, dark: Boolean, modifier: Modifier = Modifier) {
    val picker = ui.picker ?: return
    val colors = LocalSparkColors.current
    val view = LocalView.current
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val ids = if (picker.kind == CatalogKind.PROJECT) ui.content.projectIds else ui.content.tagIds
    val itemFadeIn = sparkTween<Float>(SparkMotion.Fast, SparkMotion.EaseOut)
    val itemFadeOut = sparkTween<Float>(SparkMotion.Instant, SparkMotion.EaseExit)
    val itemPlacement = sparkSpring(SparkMotion.SpringGentle)

    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            val header = if (ids.isEmpty()) {
                "选择${picker.kind.label}"
            } else {
                "选择${picker.kind.label}（已选 ${ids.size}）"
            }
            Text(
                header,
                Modifier.weight(1f).semantics { heading() },
                style = MaterialTheme.typography.titleLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            TextButton(onClick = {
                focus.clearFocus()
                keyboard?.hide()
                model.closePicker()
            }) { Text("完成") }
        }
        DraftTextField(
            text = picker.query,
            label = "搜索${picker.kind.label}",
            singleLine = true,
            trailingIcon = if (picker.query.isNotEmpty()) {
                {
                    IconButton(
                        onClick = { model.searchPicker("", false) },
                        modifier = Modifier.semantics { contentDescription = "清空搜索" },
                    ) {
                        SparkCloseIcon(color = colors.fgSoft, size = 16.dp)
                    }
                }
            } else null,
            onChange = model::searchPicker,
        )
        // Reserved 3dp track keeps the list from jumping as search requests start and settle.
        Box(Modifier.fillMaxWidth().height(3.dp)) {
            androidx.compose.animation.AnimatedVisibility(
                visible = picker.loading,
                enter = fadeIn(sparkTween(SparkMotion.Instant, SparkMotion.EaseOut)),
                exit = fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
            ) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(3.dp),
                    trackColor = colors.surfaceMuted,
                    strokeCap = StrokeCap.Round,
                )
            }
        }
        LazyColumn(
            Modifier.fillMaxWidth().heightIn(min = 64.dp, max = 300.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (picker.notice != null) {
                item(key = "notice") {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = MaterialTheme.shapes.small,
                        color = colors.surfaceMuted,
                        contentColor = colors.fgSoft,
                    ) {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(picker.notice, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            if (ui.online && !picker.loading) {
                                TextButton(onClick = model::retryPicker) { Text("刷新") }
                            }
                        }
                    }
                }
            }
            if (!picker.loading && picker.options.isEmpty() && picker.notice == null) {
                item(key = "empty") {
                    val empty = if (picker.query.isBlank()) {
                        "还没有${picker.kind.label}，可以先保存后再归类"
                    } else {
                        "没有找到匹配的${picker.kind.label}"
                    }
                    Text(
                        empty,
                        Modifier.padding(vertical = 14.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fgSoft,
                    )
                }
            }
            items(picker.options, key = { it.id }) { option ->
                val checked = option.id in ids
                val rowInteraction = remember { MutableInteractionSource() }
                val rowBg by animateColorAsState(
                    targetValue = if (checked) colors.accent.copy(alpha = 0.45f) else Color.Transparent,
                    animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
                    label = "pickerRowBg",
                )
                Surface(
                    modifier = Modifier
                        .fillMaxWidth()
                        .animateItem(fadeInSpec = itemFadeIn, placementSpec = itemPlacement, fadeOutSpec = itemFadeOut)
                        .sparkPressScale(rowInteraction, pressedScale = 0.985f)
                        .clip(RoundedCornerShape(10.dp)),
                    shape = RoundedCornerShape(10.dp),
                    color = rowBg,
                ) {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .toggleable(
                                value = checked,
                                interactionSource = rowInteraction,
                                indication = null,
                                role = Role.Checkbox,
                                onValueChange = {
                                    SparkHaptics.tick(view)
                                    model.toggleChoice(picker.kind, option.id)
                                },
                            )
                            .padding(horizontal = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked, onCheckedChange = null)
                        if (picker.kind == CatalogKind.PROJECT) WashiTapeChip(option.id, option.name, dark)
                        else Text("#" + option.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (picker.cursor != null) {
                item(key = "more") {
                    TextButton(onClick = model::nextPickerPage, enabled = !picker.loading) { Text("加载更多") }
                }
            }
        }
    }
}
