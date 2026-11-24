package cloud.stwqy.spark.feature.drafts

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkStatusColors
import cloud.stwqy.spark.core.designsystem.PaperLabel
import cloud.stwqy.spark.core.designsystem.PaperTone
import cloud.stwqy.spark.core.designsystem.SparkCard
import cloud.stwqy.spark.core.designsystem.StatusBanner
import cloud.stwqy.spark.core.storage.DraftStatus
import cloud.stwqy.spark.core.storage.DraftSummary

@Composable
internal fun LocalDraftsScreen(ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean, onClose: () -> Unit) {
    val colors = LocalSparkColors.current
    val editing = ui.draft != null
    Column(
        Modifier.fillMaxSize().background(colors.bg).safeDrawingPadding().imePadding().padding(horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().weight(1f)) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = if (editing) model::closeEditor else onClose,
                    enabled = !ui.busy,
                ) { Text(if (editing) "返回草稿箱" else "返回") }
                Column(Modifier.weight(1f)) {
                    Text(
                        if (editing) "编辑草稿" else "本机草稿", Modifier.semantics { heading() },
                        style = MaterialTheme.typography.titleLarge,
                    )
                    DraftAccountLine(ui)
                }
            }
            HorizontalDivider(color = colors.border)
            if (editing) {
                key(ui.draft?.id) {
                    Column(
                        Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        DraftEditor(ui, model, dark)
                        DeleteDraftAction(ui.draft?.frozen == true, !ui.busy) { model.delete() }
                    }
                }
                HorizontalDivider(color = colors.border)
                DraftActions(ui, model, Modifier.fillMaxWidth().padding(vertical = 8.dp))
            } else {
                DraftList(ui, model, dark)
            }
        }
    }
    if (ui.picker != null) DraftCatalogDialog(ui, model, dark)
}

@Composable
private fun DraftCatalogDialog(ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean) {
    Dialog(onDismissRequest = model::closePicker, properties = DialogProperties(
        usePlatformDefaultWidth = false, securePolicy = SecureFlagPolicy.SecureOn,
    )) {
        SparkCard(Modifier.padding(16.dp).widthIn(max = 520.dp).fillMaxWidth().imePadding()) {
            DraftCatalogPicker(ui, model, dark, Modifier.padding(16.dp))
        }
    }
}

@Composable
private fun DraftList(ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(
                Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(onClick = model::newDraft, enabled = ui.initialized && !ui.busy) { Text("记一条") }
                if (ui.access == DraftAccess.SIGNED_OUT) {
                    TextButton(onClick = model::login, enabled = ui.online && !ui.busy) { Text("登录 Spark") }
                } else if (ui.online && ui.access in listOf(DraftAccess.OFFLINE, DraftAccess.UNAVAILABLE)) {
                    TextButton(onClick = model::retrySession, enabled = !ui.busy) { Text("重新连接") }
                }
            }
        }
        if (!ui.initialized) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        val status = ui.error ?: ui.notice
        if (status != null) item {
            StatusBanner(status, error = ui.error != null,
                modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite })
        }
        if (ui.initialized && ui.rows.isEmpty() && ui.error == null) {
            item { Text("暂无本机草稿。", color = LocalSparkColors.current.fgSoft) }
        }
        items(ui.rows, key = { it.id }) { row -> DraftRow(row, ui, model, dark) }
        if (ui.page > 0 || ui.hasNextPage) item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = { model.pageBy(-1) }, enabled = ui.page > 0 && !ui.busy) { Text("上一页") }
                TextButton(onClick = { model.pageBy(1) }, enabled = ui.hasNextPage && !ui.busy) { Text("下一页") }
            }
        }
    }
}

@Composable
private fun DraftRow(row: DraftSummary, ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean) {
    val colors = LocalSparkColors.current
    val statusColors = LocalSparkStatusColors.current
    val frozen = row.status == DraftStatus.UNCERTAIN || row.status == DraftStatus.SUBMITTING
    val (status, tone) = when (row.status) {
        DraftStatus.EDITING -> "编辑中" to PaperTone(colors.surfaceMuted, colors.fgSoft)
        DraftStatus.QUEUED -> "待发送" to PaperTone(colors.accent, colors.accentFg)
        DraftStatus.UPLOADING_ASSETS -> "上传中" to PaperTone(colors.accent, colors.accentFg)
        DraftStatus.SUBMITTING, DraftStatus.UNCERTAIN ->
            "待确认" to PaperTone(statusColors.warningBg, statusColors.warning)
    }
    SparkCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PaperLabel(status, tone)
            TextButton(onClick = { model.editDraft(row.id) }, enabled = !ui.busy, contentPadding = PaddingValues(0.dp)) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        row.title.ifBlank { row.preview.trim().ifBlank {
                            if (row.imageCount > 0) "图片收藏" else "空白草稿"
                        } },
                        style = MaterialTheme.typography.titleMedium,
                        color = colors.fg, maxLines = if (row.title.isBlank()) 3 else 1, overflow = TextOverflow.Ellipsis,
                    )
                    if (row.title.isNotBlank() && row.preview.isNotBlank()) {
                        Text(row.preview, style = MaterialTheme.typography.bodySmall, color = colors.fgSoft,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            if (row.imageCount > 0) {
                Text("${row.imageCount} 张图片", color = colors.fgSoft, style = MaterialTheme.typography.labelMedium)
            }
            if (row.projectIds.isNotEmpty() || row.tagIds.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    SelectedLabels(row.projectIds, ui, CatalogKind.PROJECT, dark)
                    SelectedLabels(row.tagIds, ui, CatalogKind.TAG, dark)
                }
            }
            row.lastError?.let { Text(it, color = statusColors.danger, style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (frozen || row.status == DraftStatus.QUEUED) {
                    TextButton(onClick = { model.save(row) }, enabled = ui.canSend) {
                        Text(if (frozen) "重试保存" else "发送")
                    }
                }
                DeleteDraftAction(frozen, !ui.busy && row.status != DraftStatus.UPLOADING_ASSETS &&
                    row.status != DraftStatus.SUBMITTING) { model.delete(row) }
            }
        }
    }
}

@Composable
private fun DeleteDraftAction(frozen: Boolean, enabled: Boolean, onDelete: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    TextButton(onClick = { confirm = true }, enabled = enabled) {
        Text("删除", color = if (enabled) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (confirm) {
        DeleteDraftDialog(frozen, onCancel = { confirm = false }, onDelete = {
            confirm = false
            onDelete()
        })
    }
}
