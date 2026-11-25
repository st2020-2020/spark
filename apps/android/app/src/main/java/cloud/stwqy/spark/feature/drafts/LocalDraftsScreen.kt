package cloud.stwqy.spark.feature.drafts

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalBottomSheetProperties
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import cloud.stwqy.spark.core.designsystem.AnimatedStatusBanner
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkReducedMotion
import cloud.stwqy.spark.core.designsystem.LocalSparkStatusColors
import cloud.stwqy.spark.core.designsystem.PaperLabel
import cloud.stwqy.spark.core.designsystem.PaperTone
import cloud.stwqy.spark.core.designsystem.SparkBackIcon
import cloud.stwqy.spark.core.designsystem.SparkBrandMark
import cloud.stwqy.spark.core.designsystem.SparkCard
import cloud.stwqy.spark.core.designsystem.SparkHaptics
import cloud.stwqy.spark.core.designsystem.SparkMotion
import cloud.stwqy.spark.core.designsystem.sparkPressScale
import cloud.stwqy.spark.core.designsystem.sparkSpring
import cloud.stwqy.spark.core.designsystem.sparkTween
import cloud.stwqy.spark.core.storage.DraftStatus
import cloud.stwqy.spark.core.storage.DraftSummary

@Composable
internal fun LocalDraftsScreen(ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean, onClose: () -> Unit) {
    val colors = LocalSparkColors.current
    val reducedMotion = LocalSparkReducedMotion.current
    val editing = ui.draft != null
    val isEmptyList = ui.initialized && ui.rows.isEmpty() && ui.error == null
    val view = LocalView.current

    val titleEnter = fadeIn(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)) +
        slideInVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)) { if (editing) 6 else -6 }
    val titleExit = fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit))
    val pageEnterRight = slideInHorizontally(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) { it / 4 } +
        fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut))
    val pageExitLeft = slideOutHorizontally(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) { -it / 8 } +
        fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit))
    val pageEnterLeft = slideInHorizontally(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) { -it / 4 } +
        fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut))
    val pageExitRight = slideOutHorizontally(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) { it / 8 } +
        fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit))
    val instantIn = fadeIn(sparkTween(SparkMotion.Instant))
    val instantOut = fadeOut(sparkTween(SparkMotion.Instant))

    Column(
        Modifier.fillMaxSize().background(colors.bg).safeDrawingPadding().imePadding().padding(horizontal = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().weight(1f)) {
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(
                    onClick = if (editing) model::closeEditor else onClose,
                    enabled = !ui.busy,
                    modifier = Modifier.size(48.dp).semantics {
                        contentDescription = if (editing) "返回草稿箱" else "返回"
                    },
                ) {
                    SparkBackIcon(color = if (ui.busy) colors.muted else colors.fg)
                }
                Column(Modifier.weight(1f)) {
                    AnimatedContent(
                        targetState = editing,
                        transitionSpec = {
                            if (reducedMotion) instantIn togetherWith instantOut
                            else titleEnter togetherWith titleExit
                        },
                        label = "draftsTopTitle",
                    ) { isEditing ->
                        Text(
                            if (isEditing) "编辑草稿" else "本机草稿",
                            Modifier.semantics { heading() },
                            style = MaterialTheme.typography.titleLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    DraftAccountLine(ui)
                }
                if (editing) {
                    DeleteDraftAction(
                        frozen = ui.draft?.frozen == true,
                        enabled = !ui.busy && !ui.sending,
                        quiet = true,
                    ) { model.delete() }
                } else if (!isEmptyList) {
                    val newInteraction = remember { MutableInteractionSource() }
                    FilledTonalButton(
                        onClick = {
                            SparkHaptics.tick(view)
                            model.newDraft()
                        },
                        enabled = ui.initialized && !ui.busy,
                        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 8.dp),
                        modifier = Modifier.heightIn(min = 40.dp).sparkPressScale(newInteraction, enabled = ui.initialized && !ui.busy),
                        interactionSource = newInteraction,
                    ) { Text("+ 记一条") }
                }
            }
            HorizontalDivider(color = colors.border)
            // Destroy previous account's list/editor subtree immediately on session switch (zero cross-account fade leak).
            key(ui.sessionGeneration) {
                AnimatedContent(
                    targetState = editing,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    transitionSpec = {
                        if (reducedMotion) {
                            instantIn togetherWith instantOut
                        } else if (targetState) {
                            pageEnterRight togetherWith pageExitLeft
                        } else {
                            pageEnterLeft togetherWith pageExitRight
                        }
                    },
                    label = "draftsBody",
                ) { isEditing ->
                    if (isEditing) {
                        key(ui.draft?.id) {
                            Column(
                                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = 12.dp),
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                DraftEditor(ui, model, dark)
                            }
                        }
                    } else {
                        DraftList(ui, model, dark)
                    }
                }
            }
            AnimatedVisibility(
                visible = editing,
                enter = slideInVertically(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) { it / 2 } +
                    fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)),
                exit = slideOutVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) { it / 2 } +
                    fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit)),
            ) {
                Column(Modifier.fillMaxWidth()) {
                    HorizontalDivider(color = colors.border)
                    DraftActions(ui, model, Modifier.fillMaxWidth().padding(vertical = 8.dp))
                }
            }
        }
    }
    if (ui.picker != null) DraftCatalogModal(ui, model, dark)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DraftCatalogModal(ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean) {
    val colors = LocalSparkColors.current
    val compact = LocalConfiguration.current.screenWidthDp < 600
    if (compact) {
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = model::closePicker,
            sheetState = sheet,
            shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
            containerColor = colors.surface,
            contentColor = colors.fg,
            scrimColor = LocalSparkStatusColors.current.scrim,
            properties = ModalBottomSheetProperties(securePolicy = SecureFlagPolicy.SecureOn),
        ) {
            DraftCatalogPicker(
                ui, model, dark,
                Modifier.fillMaxWidth().imePadding().padding(start = 20.dp, end = 20.dp, bottom = 20.dp),
            )
        }
    } else {
        Dialog(
            onDismissRequest = model::closePicker,
            properties = DialogProperties(usePlatformDefaultWidth = false, securePolicy = SecureFlagPolicy.SecureOn),
        ) {
            SparkCard(Modifier.padding(16.dp).widthIn(max = 520.dp).fillMaxWidth().imePadding()) {
                DraftCatalogPicker(ui, model, dark, Modifier.padding(16.dp))
            }
        }
    }
}

@Composable
private fun DraftList(ui: DraftUiState, model: LocalDraftsViewModel, dark: Boolean) {
    val colors = LocalSparkColors.current
    val view = LocalView.current
    val needsAccessAction = ui.access == DraftAccess.SIGNED_OUT ||
        (ui.online && ui.access in listOf(DraftAccess.OFFLINE, DraftAccess.UNAVAILABLE))
    val itemFadeIn = sparkTween<Float>(SparkMotion.Normal, SparkMotion.EaseOut)
    val itemFadeOut = sparkTween<Float>(SparkMotion.Fast, SparkMotion.EaseExit)
    val itemPlacement = sparkSpring(SparkMotion.SpringGentle)

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "access") {
            AnimatedVisibility(
                visible = needsAccessAction,
                enter = expandVertically(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)) +
                    fadeIn(sparkTween(SparkMotion.Normal, SparkMotion.EaseOut)),
                exit = shrinkVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) +
                    fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
            ) {
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
                        Text(
                            if (ui.access == DraftAccess.SIGNED_OUT) "登录后即可将本机草稿同步到收件箱。"
                            else "暂时无法确认账号状态。",
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                        )
                        if (ui.access == DraftAccess.SIGNED_OUT) {
                            TextButton(onClick = model::login, enabled = ui.online && !ui.busy) { Text("登录 Spark") }
                        } else {
                            TextButton(onClick = model::retrySession, enabled = !ui.busy) { Text("重新连接") }
                        }
                    }
                }
            }
        }
        item(key = "loading") {
            AnimatedVisibility(
                visible = !ui.initialized,
                enter = fadeIn(sparkTween(SparkMotion.Instant)),
                exit = fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
            ) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(3.dp),
                    trackColor = colors.surfaceMuted,
                    strokeCap = StrokeCap.Round,
                )
            }
        }
        item(key = "banner") {
            AnimatedStatusBanner(
                message = ui.error ?: ui.notice,
                error = ui.error != null,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (ui.initialized && ui.rows.isEmpty() && ui.error == null) {
            item(key = "empty") {
                val emptyInteraction = remember { MutableInteractionSource() }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .animateItem(fadeInSpec = itemFadeIn, placementSpec = itemPlacement, fadeOutSpec = itemFadeOut)
                        .padding(vertical = 44.dp, horizontal = 24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SparkBrandMark(size = 48.dp)
                    Text("草稿箱是空的", style = MaterialTheme.typography.titleMedium, color = colors.fg)
                    Text(
                        "离线分享或暂存的草稿会保存在这里；已加入待发送队列的会在联网后自动发送。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fgSoft,
                        textAlign = TextAlign.Center,
                    )
                    Button(
                        onClick = {
                            SparkHaptics.tick(view)
                            model.newDraft()
                        },
                        enabled = !ui.busy,
                        modifier = Modifier.padding(top = 6.dp).heightIn(min = 44.dp)
                            .sparkPressScale(emptyInteraction, enabled = !ui.busy),
                        interactionSource = emptyInteraction,
                    ) { Text("记一条") }
                }
            }
        }
        items(ui.rows, key = { it.id }) { row ->
            DraftRow(
                row = row,
                ui = ui,
                model = model,
                dark = dark,
                modifier = Modifier.animateItem(
                    fadeInSpec = itemFadeIn,
                    placementSpec = itemPlacement,
                    fadeOutSpec = itemFadeOut,
                ),
            )
        }
        if (ui.page > 0 || ui.hasNextPage) {
            item(key = "pager") {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = { model.pageBy(-1) }, enabled = ui.page > 0 && !ui.busy) { Text("上一页") }
                    Text(
                        "第 ${ui.page + 1} 页",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.muted,
                    )
                    TextButton(onClick = { model.pageBy(1) }, enabled = ui.hasNextPage && !ui.busy) { Text("下一页") }
                }
            }
        }
    }
}

@Composable
private fun DraftRow(
    row: DraftSummary,
    ui: DraftUiState,
    model: LocalDraftsViewModel,
    dark: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = LocalSparkColors.current
    val statusColors = LocalSparkStatusColors.current
    val view = LocalView.current
    val frozen = row.status == DraftStatus.UNCERTAIN || row.status == DraftStatus.SUBMITTING
    val activeTransfer = row.status == DraftStatus.UPLOADING_ASSETS || row.status == DraftStatus.SUBMITTING
    val (status, tone) = when (row.status) {
        DraftStatus.EDITING -> "编辑中" to PaperTone(colors.surfaceMuted, colors.fgSoft)
        DraftStatus.QUEUED -> "待发送" to PaperTone(colors.accent, colors.accentFg)
        DraftStatus.UPLOADING_ASSETS -> "上传中" to PaperTone(colors.accent, colors.accentFg)
        DraftStatus.SUBMITTING -> "正在发送" to PaperTone(colors.accent, colors.accentFg)
        DraftStatus.UNCERTAIN -> "待确认" to PaperTone(statusColors.warningBg, statusColors.warning)
    }
    SparkCard(
        modifier = modifier.fillMaxWidth(),
        onClick = { model.editDraft(row.id) },
        enabled = !ui.busy,
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PaperLabel(status, tone, leadingSpinner = activeTransfer)
                if (row.imageCount > 0) {
                    Text("${row.imageCount} 张图片", color = colors.fgSoft, style = MaterialTheme.typography.labelMedium)
                }
            }
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    row.title.ifBlank {
                        row.preview.trim().ifBlank {
                            if (row.imageCount > 0) "图片收藏" else "空白草稿"
                        }
                    },
                    style = MaterialTheme.typography.titleMedium,
                    color = colors.fg,
                    maxLines = if (row.title.isBlank()) 3 else 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (row.title.isNotBlank() && row.preview.isNotBlank()) {
                    Text(
                        row.preview,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fgSoft,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (row.projectIds.isNotEmpty() || row.tagIds.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SelectedLabels(row.projectIds, ui, CatalogKind.PROJECT, dark)
                    SelectedLabels(row.tagIds, ui, CatalogKind.TAG, dark)
                }
            }
            row.lastError?.let {
                Text(it, color = statusColors.danger, style = MaterialTheme.typography.bodySmall)
            }
            val canDelete = !ui.busy && !activeTransfer
            val showSend = row.status == DraftStatus.UNCERTAIN || row.status == DraftStatus.QUEUED
            if (canDelete || showSend) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box {
                        if (canDelete) {
                            DeleteDraftAction(frozen, enabled = true, quiet = true) { model.delete(row) }
                        }
                    }
                    if (showSend) {
                        val sendInteraction = remember { MutableInteractionSource() }
                        FilledTonalButton(
                            onClick = {
                                SparkHaptics.confirm(view)
                                model.save(row)
                            },
                            enabled = ui.canSend,
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                            modifier = Modifier.heightIn(min = 38.dp).sparkPressScale(sendInteraction, enabled = ui.canSend),
                            interactionSource = sendInteraction,
                        ) {
                            Text(if (row.status == DraftStatus.UNCERTAIN) "重试保存" else "发送")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DeleteDraftAction(
    frozen: Boolean,
    enabled: Boolean,
    quiet: Boolean = false,
    onDelete: () -> Unit,
) {
    val colors = LocalSparkColors.current
    val view = LocalView.current
    var confirm by remember { mutableStateOf(false) }
    TextButton(onClick = { confirm = true }, enabled = enabled) {
        Text(
            "删除",
            color = when {
                !enabled -> colors.muted
                quiet -> colors.fgSoft
                else -> MaterialTheme.colorScheme.error
            },
        )
    }
    if (confirm) {
        DeleteDraftDialog(
            frozen = frozen,
            onCancel = { confirm = false },
            onDelete = {
                SparkHaptics.reject(view)
                confirm = false
                onDelete()
            },
        )
    }
}
