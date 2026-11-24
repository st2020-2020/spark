package cloud.stwqy.spark.feature.drafts

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.PaperLabel
import cloud.stwqy.spark.core.designsystem.PaperTone
import cloud.stwqy.spark.core.designsystem.StatusBanner
import cloud.stwqy.spark.core.designsystem.SparkTokens
import cloud.stwqy.spark.core.designsystem.WashiTapeChip
import cloud.stwqy.spark.core.network.isSparkWhitespace
import cloud.stwqy.spark.core.storage.DraftStatus

@Composable
internal fun DraftEditor(ui: DraftUiState, model: DraftViewModel, dark: Boolean) {
    val draft = ui.draft ?: return
    val colors = LocalSparkColors.current
    var extra by rememberSaveable(draft.id) { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val count = remember(ui.content.body, ui.content.purpose) { draftCharacterCount(ui.content) }
    val limit = AppConfig.MAX_TEXT_CODE_POINTS
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (ui.images.isNotEmpty()) DraftImageStrip(ui, model)
        DraftTextField(
            ui.content.body, if (ui.images.isEmpty()) "文字或网址" else "文字或网址（可选）", !ui.canEdit, minLines = 4, maxLines = 8,
            error = count > limit,
        ) { value, composing -> model.edit(ui.content.copy(body = value), composing) }
        if (count >= 45_000) {
            Text(
                "$count / 50,000 字（正文和用途）",
                Modifier.align(Alignment.End),
                style = MaterialTheme.typography.labelSmall,
                color = if (count > limit) MaterialTheme.colorScheme.error else colors.fgSoft,
            )
        }

        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            for (kind in CatalogKind.entries) {
                val ids = if (kind == CatalogKind.PROJECT) ui.content.projectIds else ui.content.tagIds
                if (ui.canChoose) {
                    TextButton(onClick = {
                        focus.clearFocus()
                        keyboard?.hide()
                        model.openPicker(kind)
                    }) { Text("+ " + kind.label) }
                }
                SelectedLabels(ids, ui, kind, dark, remove = if (ui.canEdit) {
                    { id -> model.toggleChoice(kind, id) }
                } else null)
            }
        }

        TextButton(onClick = { extra = !extra }) {
            Text(if (extra) "收起更多选项" else "更多选项")
        }
        if (extra) {
            DraftTextField(ui.content.purpose, "补一句用途", !ui.canEdit, minLines = 2, maxLines = 4) {
                value, composing -> model.edit(ui.content.copy(purpose = value), composing)
            }
            DraftTextField(ui.content.manualTitle, "可选标题", !ui.canEdit, singleLine = true,
                error = ui.content.manualTitle.codePointCount(0, ui.content.manualTitle.length) > AppConfig.MAX_TITLE_CODE_POINTS,
            ) { value, composing -> model.edit(ui.content.copy(manualTitle = value), composing) }
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(
                    value = ui.content.excluded, enabled = ui.canEdit, role = Role.Checkbox,
                    onValueChange = { model.edit(ui.content.copy(excluded = it)) },
                ),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(ui.content.excluded, onCheckedChange = null, enabled = ui.canEdit)
                Text("本条不参与 AI 整理", style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (draft.frozen) {
            StatusBanner("保存结果待确认。可以使用原内容重试，或删除本机草稿。", error = false)
        } else if (draft.status == DraftStatus.QUEUED) {
            StatusBanner("已存为待发送草稿。联网后会尝试发送。", error = false)
        }
    }
}

@Composable
internal fun DraftActions(
    ui: DraftUiState,
    model: DraftViewModel,
    modifier: Modifier = Modifier,
) {
    val draft = ui.draft
    val offline = !ui.online || ui.access == DraftAccess.OFFLINE
    val login = ui.access == DraftAccess.SIGNED_OUT
    val localStatus = ui.notice ?: when {
        ui.busy -> "正在处理…"
        ui.sending -> "正在发送…"
        ui.dirty -> "正在保存本机草稿…"
        draft?.frozen == true -> "待确认"
        draft != null -> "已存本机"
        else -> null
    }
    val withinLimit = remember(ui.content.body, ui.content.purpose) {
        draftCharacterCount(ui.content) <= AppConfig.MAX_TEXT_CODE_POINTS
    }
    val validTitle = remember(ui.content.manualTitle) {
        val trimmed = ui.content.manualTitle.trim(Char::isSparkWhitespace)
        trimmed.codePointCount(0, trimmed.length) <= AppConfig.MAX_TITLE_CODE_POINTS
    }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ui.error?.let { StatusBanner(it, error = true, Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }) }
        Row(
            Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.weight(1f).heightIn(min = 32.dp), contentAlignment = Alignment.CenterStart) {
                localStatus?.let {
                    Text(it, style = MaterialTheme.typography.labelMedium, color = LocalSparkColors.current.fgSoft)
                }
            }
            when {
                login && (ui.online || draft == null) -> Button(
                    onClick = model::login,
                    enabled = ui.canLogin,
                ) {
                    Text("登录 Spark")
                }
                draft == null -> Unit
                offline && !draft.frozen -> Button(
                    onClick = { model.save() },
                    enabled = ui.canEdit && !ui.hasUnimportedImages && ui.hasContent && withinLimit && validTitle,
                ) {
                    Text("存为待发送草稿")
                }
                ui.access == DraftAccess.UNAVAILABLE || ui.access == DraftAccess.OFFLINE && draft.frozen && ui.online ->
                    Button(onClick = model::retrySession, enabled = !ui.busy) { Text("重新连接") }
                else -> Button(
                    onClick = { model.save() },
                    enabled = ui.canSend && (draft.frozen || !ui.hasUnimportedImages && ui.hasContent && withinLimit && validTitle),
                ) { Text(if (draft.frozen) "重试保存" else "保存到收件箱") }
            }
        }
    }
}

@Composable
internal fun DraftTextField(
    text: String,
    label: String,
    readOnly: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = 1,
    singleLine: Boolean = false,
    error: Boolean = false,
    onChange: (value: String, composing: Boolean) -> Boolean,
) {
    // Only selection/composition lives in the field. Room and the ViewModel own the text.
    var start by rememberSaveable { mutableIntStateOf(text.length) }
    var end by rememberSaveable { mutableIntStateOf(text.length) }
    var field by remember { mutableStateOf(TextFieldValue(text, TextRange(start.coerceIn(0, text.length), end.coerceIn(0, text.length)))) }
    SideEffect {
        if (field.text != text) field = TextFieldValue(text, TextRange(field.selection.end.coerceIn(0, text.length)))
    }
    OutlinedTextField(
        field, onValueChange = { next ->
            if (onChange(next.text, next.composition != null)) {
                field = next
                start = next.selection.start
                end = next.selection.end
            }
        },
        modifier = Modifier.fillMaxWidth(), label = { Text(label) }, readOnly = readOnly,
        minLines = minLines, maxLines = maxLines, singleLine = singleLine, isError = error,
    )
}

@Composable
internal fun SelectedLabels(
    ids: List<String>,
    ui: DraftUiState,
    kind: CatalogKind,
    dark: Boolean,
    remove: ((String) -> Unit)? = null,
) {
    val colors = LocalSparkColors.current
    val names = if (kind == CatalogKind.PROJECT) ui.projects else ui.tags
    for (id in ids) {
        val known = names.firstOrNull { it.id == id }?.name
        val label = known ?: "已选" + kind.label
        if (remove != null) {
            TextButton(onClick = { remove(id) }, modifier = Modifier.widthIn(max = 205.dp)) {
                val tone = if (kind == CatalogKind.PROJECT) {
                    SparkTokens.projectTone(id, dark)
                } else PaperTone(colors.accent, colors.accentFg)
                PaperLabel((if (kind == CatalogKind.TAG && known != null) "#" else "") + label + " ×", tone)
            }
        } else if (kind == CatalogKind.PROJECT) {
            WashiTapeChip(id, label, dark)
        } else {
            PaperLabel(if (known == null) label else "#$label", PaperTone(colors.accent, colors.accentFg))
        }
    }
}

@Composable
internal fun DeleteDraftDialog(
    frozen: Boolean,
    onCancel: () -> Unit,
    onDelete: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("删除本机草稿？") },
        text = { Text(if (frozen) "如果上次已保存到收件箱，那条收藏会保留。"
            else "这条草稿将从本机移除。") },
        dismissButton = { TextButton(onCancel) { Text("取消") } },
        confirmButton = {
            TextButton(onDelete) { Text("删除草稿", color = MaterialTheme.colorScheme.error) }
        },
    )
}

@Composable
internal fun DraftAccountLine(ui: DraftUiState) {
    val account = ui.email ?: when (ui.access) {
        DraftAccess.CHECKING -> "正在确认账号…"
        DraftAccess.SIGNED_OUT -> "未登录 · 草稿保存在本机"
        DraftAccess.VERIFIED -> "已登录 Spark"
        DraftAccess.OFFLINE -> "离线 · 草稿保存在本机"
        DraftAccess.UNAVAILABLE -> "暂时无法确认账号"
    }
    Text(account, style = MaterialTheme.typography.bodySmall, color = LocalSparkColors.current.fgSoft,
        maxLines = 1, overflow = TextOverflow.Ellipsis)
}
