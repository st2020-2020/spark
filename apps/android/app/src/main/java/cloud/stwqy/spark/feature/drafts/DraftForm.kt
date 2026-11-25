package cloud.stwqy.spark.feature.drafts

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.designsystem.AnimatedStatusBanner
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.PaperLabel
import cloud.stwqy.spark.core.designsystem.PaperTone
import cloud.stwqy.spark.core.designsystem.SparkAddChip
import cloud.stwqy.spark.core.designsystem.SparkChevronIcon
import cloud.stwqy.spark.core.designsystem.SparkHaptics
import cloud.stwqy.spark.core.designsystem.SparkMotion
import cloud.stwqy.spark.core.designsystem.SparkRemovableChip
import cloud.stwqy.spark.core.designsystem.SparkTokens
import cloud.stwqy.spark.core.designsystem.WashiTapeChip
import cloud.stwqy.spark.core.designsystem.sparkPressScale
import cloud.stwqy.spark.core.designsystem.sparkTween
import cloud.stwqy.spark.core.network.isSparkWhitespace
import cloud.stwqy.spark.core.storage.DraftContent
import cloud.stwqy.spark.core.storage.DraftStatus
import java.util.Locale

internal fun filledExtraOptionCount(content: DraftContent): Int {
    var filled = 0
    if (content.purpose.any { !it.isSparkWhitespace() }) filled++
    if (content.manualTitle.any { !it.isSparkWhitespace() }) filled++
    if (content.excluded) filled++
    return filled
}

internal fun isValidDraftTitle(manualTitle: String): Boolean {
    val trimmed = manualTitle.trim(Char::isSparkWhitespace)
    return trimmed.codePointCount(0, trimmed.length) <= AppConfig.MAX_TITLE_CODE_POINTS
}

internal fun disabledSaveReason(ui: DraftUiState, withinLimit: Boolean, validTitle: Boolean): String? = when {
    ui.images.any { ui.importStatus(it.asset) == DraftImageImport.READING } -> "等待图片读取…"
    ui.hasUnimportedImages -> "请先重试或移除失败的图片"
    !withinLimit -> "正文与用途超出 50,000 字"
    !validTitle -> "标题超出 200 字"
    else -> null
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun DraftEditor(ui: DraftUiState, model: DraftViewModel, dark: Boolean) {
    val draft = ui.draft ?: return
    val colors = LocalSparkColors.current
    val view = LocalView.current
    val initialFilled = remember(draft.id) { filledExtraOptionCount(ui.content) > 0 }
    var extra by rememberSaveable(draft.id) { mutableStateOf(initialFilled) }
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val count = remember(ui.content.body, ui.content.purpose) { draftCharacterCount(ui.content) }
    val titleCount = remember(ui.content.manualTitle) {
        val trimmed = ui.content.manualTitle.trim(Char::isSparkWhitespace)
        trimmed.codePointCount(0, trimmed.length)
    }
    val validTitle = titleCount <= AppConfig.MAX_TITLE_CODE_POINTS
    val limit = AppConfig.MAX_TEXT_CODE_POINTS
    val filledCount = remember(ui.content.purpose, ui.content.manualTitle, ui.content.excluded) {
        filledExtraOptionCount(ui.content)
    }

    LaunchedEffect(validTitle) {
        if (!validTitle) extra = true
    }

    val chevronRotation by animateFloatAsState(
        targetValue = if (extra) 180f else 0f,
        animationSpec = sparkTween(SparkMotion.Normal, SparkMotion.EaseOut),
        label = "extraChevron",
    )
    val counterColor by animateColorAsState(
        targetValue = if (count > limit) MaterialTheme.colorScheme.error else colors.fgSoft,
        animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
        label = "counterColor",
    )

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (ui.images.isNotEmpty()) DraftImageStrip(ui, model)
        DraftTextField(
            text = ui.content.body,
            label = if (ui.images.isEmpty()) "文字或网址" else "文字或网址（可选）",
            readOnly = !ui.canEdit,
            minLines = 4,
            maxLines = 8,
            error = count > limit,
        ) { value, composing -> model.edit(ui.content.copy(body = value), composing) }
        AnimatedVisibility(
            visible = count >= 45_000,
            modifier = Modifier.align(Alignment.End),
            enter = fadeIn(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)) +
                expandVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)),
            exit = fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit)) +
                shrinkVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
        ) {
            val counterText = if (count > limit) {
                String.format(Locale.US, "已超出 %,d 字", count - limit)
            } else {
                String.format(Locale.US, "%,d / 50,000 字", count)
            }
            Text(counterText, style = MaterialTheme.typography.labelSmall, color = counterColor)
        }

        FlowRow(
            modifier = Modifier.fillMaxWidth().animateContentSize(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (ui.canChoose) {
                for (kind in CatalogKind.entries) {
                    SparkAddChip(label = "+ ${kind.label}") {
                        focus.clearFocus()
                        keyboard?.hide()
                        model.openPicker(kind)
                    }
                }
            }
            for (kind in CatalogKind.entries) {
                val ids = if (kind == CatalogKind.PROJECT) ui.content.projectIds else ui.content.tagIds
                SelectedLabels(
                    ids = ids,
                    ui = ui,
                    kind = kind,
                    dark = dark,
                    remove = if (ui.canEdit) {
                        { id -> model.toggleChoice(kind, id) }
                    } else null,
                )
            }
        }

        TextButton(
            onClick = {
                SparkHaptics.tick(view)
                extra = !extra
            },
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val toggleLabel = when {
                    extra -> "收起更多选项"
                    filledCount > 0 -> "更多选项（已填 $filledCount 项）"
                    else -> "更多选项"
                }
                Text(toggleLabel)
                SparkChevronIcon(
                    color = MaterialTheme.colorScheme.primary,
                    size = 14.dp,
                    modifier = Modifier.graphicsLayer { rotationZ = chevronRotation },
                )
            }
        }
        AnimatedVisibility(
            visible = extra,
            enter = expandVertically(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) +
                fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)),
            exit = shrinkVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) +
                fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit)),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                DraftTextField(
                    text = ui.content.purpose,
                    label = "补一句用途",
                    readOnly = !ui.canEdit,
                    minLines = 2,
                    maxLines = 4,
                ) { value, composing -> model.edit(ui.content.copy(purpose = value), composing) }
                DraftTextField(
                    text = ui.content.manualTitle,
                    label = "可选标题",
                    readOnly = !ui.canEdit,
                    singleLine = true,
                    error = !validTitle,
                    supportingText = if (titleCount > 180) {
                        { Text("$titleCount / ${AppConfig.MAX_TITLE_CODE_POINTS} 字") }
                    } else null,
                ) { value, composing -> model.edit(ui.content.copy(manualTitle = value), composing) }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .toggleable(
                            value = ui.content.excluded,
                            enabled = ui.canEdit,
                            role = Role.Checkbox,
                            onValueChange = {
                                SparkHaptics.tick(view)
                                model.edit(ui.content.copy(excluded = it))
                            },
                        ),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(ui.content.excluded, onCheckedChange = null, enabled = ui.canEdit)
                    Text("本条不参与 AI 整理", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        val stateNotice = when {
            draft.frozen -> "上次保存结果未确认，内容已锁定。联网后可重试保存，不会重复创建。"
            draft.status == DraftStatus.QUEUED -> "已加入待发送队列，联网后自动发送。"
            else -> null
        }
        AnimatedStatusBanner(stateNotice, error = false, Modifier.fillMaxWidth())
    }
}

@Composable
internal fun DraftActions(
    ui: DraftUiState,
    model: DraftViewModel,
    modifier: Modifier = Modifier,
) {
    val draft = ui.draft
    val view = LocalView.current
    val offline = !ui.online || ui.access == DraftAccess.OFFLINE
    val login = ui.access == DraftAccess.SIGNED_OUT
    val withinLimit = remember(ui.content.body, ui.content.purpose) {
        draftCharacterCount(ui.content) <= AppConfig.MAX_TEXT_CODE_POINTS
    }
    val validTitle = remember(ui.content.manualTitle) { isValidDraftTitle(ui.content.manualTitle) }
    val blockReason = remember(ui.images, ui.activeImageImports, withinLimit, validTitle) {
        disabledSaveReason(ui, withinLimit, validTitle)
    }

    val localStatus = ui.notice ?: when {
        ui.sending -> "正在发送…"
        ui.busy -> "正在处理…"
        blockReason != null -> blockReason
        ui.persisting -> "正在保存到本机…"
        ui.dirty -> "待保存"
        draft?.frozen == true -> "内容已锁定"
        draft != null -> "已存本机"
        else -> null
    }

    val primaryInteraction = remember { MutableInteractionSource() }
    val statusEnter = fadeIn(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut))
    val statusExit = fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit))
    val inProgress = ui.sending || ui.busy

    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AnimatedStatusBanner(ui.error, error = true, Modifier.fillMaxWidth())
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Box(Modifier.weight(1f).heightIn(min = 32.dp), contentAlignment = Alignment.CenterStart) {
                AnimatedContent(
                    targetState = localStatus,
                    transitionSpec = { statusEnter togetherWith statusExit },
                    label = "draftLocalStatus",
                ) { status ->
                    if (status != null) {
                        Text(
                            status,
                            style = MaterialTheme.typography.labelMedium,
                            color = if (blockReason != null && status == blockReason) {
                                MaterialTheme.colorScheme.error
                            } else LocalSparkColors.current.fgSoft,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            when {
                login && (ui.online || draft == null) -> {
                    val enabled = ui.canLogin
                    Button(
                        onClick = {
                            SparkHaptics.tick(view)
                            model.login()
                        },
                        enabled = enabled,
                        modifier = Modifier.heightIn(min = 44.dp).sparkPressScale(primaryInteraction, enabled = enabled),
                        interactionSource = primaryInteraction,
                    ) { Text("登录 Spark") }
                }
                draft == null -> Unit
                offline && !draft.frozen -> {
                    val enabled = ui.canEdit && !ui.hasUnimportedImages && ui.hasContent && withinLimit && validTitle
                    Button(
                        onClick = {
                            SparkHaptics.confirm(view)
                            model.save()
                        },
                        enabled = enabled,
                        modifier = Modifier
                            .heightIn(min = 44.dp)
                            .animateContentSize(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut))
                            .sparkPressScale(primaryInteraction, enabled = enabled),
                        interactionSource = primaryInteraction,
                    ) {
                        PrimaryButtonContent(loading = inProgress, idleLabel = "存为待发送", loadingLabel = "正在保存…")
                    }
                }
                ui.access == DraftAccess.UNAVAILABLE || ui.access == DraftAccess.OFFLINE && draft.frozen && ui.online -> {
                    val enabled = !ui.busy && !ui.isClosing
                    Button(
                        onClick = {
                            SparkHaptics.tick(view)
                            model.retrySession()
                        },
                        enabled = enabled,
                        modifier = Modifier.heightIn(min = 44.dp).sparkPressScale(primaryInteraction, enabled = enabled),
                        interactionSource = primaryInteraction,
                    ) { Text("重新连接") }
                }
                else -> {
                    val enabled = ui.canSend && (draft.frozen || !ui.hasUnimportedImages && ui.hasContent && withinLimit && validTitle)
                    Button(
                        onClick = {
                            SparkHaptics.confirm(view)
                            model.save()
                        },
                        enabled = enabled,
                        modifier = Modifier
                            .heightIn(min = 44.dp)
                            .animateContentSize(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut))
                            .sparkPressScale(primaryInteraction, enabled = enabled),
                        interactionSource = primaryInteraction,
                    ) {
                        PrimaryButtonContent(
                            loading = inProgress,
                            idleLabel = if (draft.frozen) "重试保存" else "保存到收件箱",
                            loadingLabel = if (ui.sending) "正在保存…" else "正在处理…",
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PrimaryButtonContent(loading: Boolean, idleLabel: String, loadingLabel: String) {
    val enter = fadeIn(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut))
    val exit = fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit))
    AnimatedContent(
        targetState = loading,
        transitionSpec = { enter togetherWith exit },
        label = "primaryButtonLoading",
    ) { isBusy ->
        if (isBusy) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
                )
                Text(loadingLabel)
            }
        } else {
            Text(idleLabel)
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
    trailingIcon: (@Composable () -> Unit)? = null,
    supportingText: (@Composable () -> Unit)? = null,
    onChange: (value: String, composing: Boolean) -> Boolean,
) {
    val colors = LocalSparkColors.current
    // Only selection/composition lives in the field. Room and the ViewModel own the text.
    var start by rememberSaveable { mutableIntStateOf(text.length) }
    var end by rememberSaveable { mutableIntStateOf(text.length) }
    var field by remember { mutableStateOf(TextFieldValue(text, TextRange(start.coerceIn(0, text.length), end.coerceIn(0, text.length)))) }
    SideEffect {
        if (field.text != text) field = TextFieldValue(text, TextRange(field.selection.end.coerceIn(0, text.length)))
    }
    val fieldColors = if (readOnly) {
        OutlinedTextFieldDefaults.colors(
            focusedContainerColor = colors.surfaceMuted,
            unfocusedContainerColor = colors.surfaceMuted,
            focusedBorderColor = colors.border,
            unfocusedBorderColor = colors.border,
        )
    } else {
        OutlinedTextFieldDefaults.colors()
    }
    OutlinedTextField(
        value = field,
        onValueChange = { next ->
            if (onChange(next.text, next.composition != null)) {
                field = next
                start = next.selection.start
                end = next.selection.end
            }
        },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        readOnly = readOnly,
        minLines = minLines,
        maxLines = maxLines,
        singleLine = singleLine,
        isError = error,
        trailingIcon = trailingIcon,
        supportingText = supportingText,
        colors = fieldColors,
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
        val display = if (kind == CatalogKind.TAG && known != null) "#$label" else label
        if (remove != null) {
            val tone = if (kind == CatalogKind.PROJECT) {
                SparkTokens.projectTone(id, dark)
            } else PaperTone(colors.accent, colors.accentFg)
            SparkRemovableChip(
                label = display,
                removeDescription = "移除${kind.label}：$label",
                tone = tone,
                onRemove = { remove(id) },
            )
        } else if (kind == CatalogKind.PROJECT) {
            WashiTapeChip(id, label, dark)
        } else {
            PaperLabel(display, PaperTone(colors.accent, colors.accentFg))
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
        text = {
            Text(
                if (frozen) "若上次已保存成功，收件箱里的收藏不受影响，仅移除本机副本。"
                else "删除后无法恢复，仅移除这条本机草稿。",
            )
        },
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
        DraftAccess.SIGNED_OUT -> "未登录 · 将先存在本机"
        DraftAccess.VERIFIED -> "已登录"
        DraftAccess.OFFLINE -> "离线 · 将先存在本机"
        DraftAccess.UNAVAILABLE -> "暂时无法确认账号"
    }
    Text(
        account,
        style = MaterialTheme.typography.bodySmall,
        color = LocalSparkColors.current.fgSoft,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}
