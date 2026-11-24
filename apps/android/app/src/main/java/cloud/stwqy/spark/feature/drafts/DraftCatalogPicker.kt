package cloud.stwqy.spark.feature.drafts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.StatusBanner
import cloud.stwqy.spark.core.designsystem.WashiTapeChip

@Composable
internal fun DraftCatalogPicker(ui: DraftUiState, model: DraftViewModel, dark: Boolean, modifier: Modifier = Modifier) {
    val picker = ui.picker ?: return
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val ids = if (picker.kind == CatalogKind.PROJECT) ui.content.projectIds else ui.content.tagIds
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("选择" + picker.kind.label, Modifier.weight(1f).semantics { heading() },
                style = MaterialTheme.typography.titleLarge)
            TextButton(onClick = {
                focus.clearFocus()
                keyboard?.hide()
                model.closePicker()
            }) { Text("完成") }
        }
        DraftTextField(picker.query, "搜索" + picker.kind.label, singleLine = true, onChange = model::searchPicker)
        LazyColumn(Modifier.fillMaxWidth().heightIn(min = 64.dp, max = 300.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (picker.loading) {
                item { LinearProgressIndicator(Modifier.fillMaxWidth().height(3.dp)) }
            }
            if (picker.notice != null) {
                item {
                    StatusBanner(picker.notice, error = false, Modifier.fillMaxWidth())
                    if (ui.online && !picker.loading) {
                        TextButton(onClick = model::retryPicker) { Text("刷新目录") }
                    }
                }
            }
            if (!picker.loading && picker.options.isEmpty() && picker.notice == null) {
                item {
                    val empty = if (picker.query.isBlank()) "暂无可选" else "没有匹配的"
                    Text(empty + picker.kind.label, Modifier.padding(vertical = 12.dp),
                        style = MaterialTheme.typography.bodySmall, color = LocalSparkColors.current.fgSoft)
                }
            }
            items(picker.options, key = { it.id }) { option ->
                val checked = option.id in ids
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(
                        checked, role = Role.Checkbox, onValueChange = { model.toggleChoice(picker.kind, option.id) },
                    ),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(checked, onCheckedChange = null)
                    if (picker.kind == CatalogKind.PROJECT) WashiTapeChip(option.id, option.name, dark)
                    else Text("#" + option.name, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (picker.cursor != null) {
                item {
                    TextButton(onClick = model::nextPickerPage, enabled = !picker.loading) { Text("加载更多") }
                }
            }
        }
    }
}
