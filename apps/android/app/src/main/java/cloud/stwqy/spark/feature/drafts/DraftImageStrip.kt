package cloud.stwqy.spark.feature.drafts

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkReducedMotion
import cloud.stwqy.spark.core.designsystem.LocalSparkStatusColors
import cloud.stwqy.spark.core.designsystem.SparkCard
import cloud.stwqy.spark.core.designsystem.SparkCloseIcon
import cloud.stwqy.spark.core.designsystem.SparkHaptics
import cloud.stwqy.spark.core.designsystem.SparkMotion
import cloud.stwqy.spark.core.designsystem.sparkPressScale
import cloud.stwqy.spark.core.designsystem.sparkSpring
import cloud.stwqy.spark.core.designsystem.sparkTween
import cloud.stwqy.spark.core.storage.AssetUploadState

@Composable
internal fun DraftImageStrip(ui: DraftUiState, model: DraftViewModel) {
    val colors = LocalSparkColors.current
    val statusColors = LocalSparkStatusColors.current
    val reducedMotion = LocalSparkReducedMotion.current
    val view = LocalView.current
    val itemFadeIn = sparkTween<Float>(SparkMotion.Normal, SparkMotion.EaseOut)
    val itemFadeOut = sparkTween<Float>(SparkMotion.Fast, SparkMotion.EaseExit)
    val itemPlacement = sparkSpring(SparkMotion.SpringGentle)

    LazyRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        itemsIndexed(ui.images, key = { _, image -> image.asset.id }) { index, image ->
            val asset = image.asset
            val uploading = ui.imageProgress[asset.id]
            val state = uploading?.state ?: asset.uploadState
            val importStatus = ui.importStatus(asset)
            val importing = importStatus == DraftImageImport.READING
            val canRetryImport = asset.uploadState.importIncomplete && !importing && model.canRetryImport(asset)
            val interrupted = !ui.sending && !ui.busy &&
                (state == AssetUploadState.UPLOADING || state == AssetUploadState.VERIFYING)
            val error = when {
                importing -> null
                state.importIncomplete -> asset.errorMessage ?: if (canRetryImport) "读取中断，可重试"
                    else "读取失败，请移除后重新分享"
                image.file == null -> "图片不可读，请移除"
                state == AssetUploadState.FAILED -> asset.errorMessage ?: "上传失败，可重试"
                else -> null
            }
            val label = "图片 ${index + 1}"
            val context = LocalContext.current
            val request = remember(context, image.file, reducedMotion) {
                image.file?.let { file ->
                    ImageRequest.Builder(context)
                        .data(file)
                        .crossfade(if (reducedMotion) 0 else SparkMotion.Fast)
                        .memoryCachePolicy(CachePolicy.DISABLED)
                        .diskCachePolicy(CachePolicy.DISABLED)
                        .build()
                }
            }
            val statusText = when (state) {
                AssetUploadState.LOCAL -> null
                AssetUploadState.UPLOADING -> if (interrupted) "待续传" else "上传中"
                AssetUploadState.VERIFYING -> if (interrupted) "待确认" else "核验中…"
                AssetUploadState.READY -> "已上传"
                AssetUploadState.FAILED -> "上传失败"
                AssetUploadState.IMPORTING, AssetUploadState.IMPORT_FAILED -> when (importStatus) {
                    DraftImageImport.READING -> "读取中…"
                    DraftImageImport.INTERRUPTED -> "读取中断"
                    DraftImageImport.FAILED -> "导入失败"
                    null -> null
                }
            }
            val statusColor by animateColorAsState(
                targetValue = when (state) {
                    AssetUploadState.READY -> statusColors.success
                    AssetUploadState.FAILED, AssetUploadState.IMPORT_FAILED -> statusColors.danger
                    else -> colors.fgSoft
                },
                animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
                label = "imageStatusColor",
            )
            val showProgress = uploading?.fraction != null || importing ||
                (!interrupted && (state == AssetUploadState.UPLOADING || state == AssetUploadState.VERIFYING))
            val smoothFraction by animateFloatAsState(
                targetValue = (uploading?.fraction ?: 0f).coerceIn(0f, 1f),
                animationSpec = sparkTween(SparkMotion.Fast, SparkMotion.EaseOut),
                label = "imageUploadProgress",
            )
            val showRetryUpload = ui.draft?.frozen == false && (interrupted || state == AssetUploadState.FAILED) && image.file != null
            val showRetryImport = ui.draft?.frozen == false && canRetryImport

            SparkCard(
                Modifier
                    .width(116.dp)
                    .animateItem(fadeInSpec = itemFadeIn, placementSpec = itemPlacement, fadeOutSpec = itemFadeOut),
            ) {
                Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(Modifier.size(width = 100.dp, height = 76.dp)) {
                        val pulseState = if (importing && !reducedMotion) {
                            val transition = rememberInfiniteTransition(label = "importPulse")
                            transition.animateFloat(
                                initialValue = 0.5f,
                                targetValue = 0.9f,
                                animationSpec = infiniteRepeatable(
                                    animation = tween(1200, easing = SparkMotion.EaseOut),
                                    repeatMode = RepeatMode.Reverse,
                                ),
                                label = "importPulseAlpha",
                            )
                        } else null
                        val staticAlpha = if (importing) 0.7f else 1f

                        Box(
                            Modifier
                                .matchParentSize()
                                .clip(MaterialTheme.shapes.small)
                                .graphicsLayer { alpha = pulseState?.value ?: staticAlpha }
                                .background(colors.surfaceMuted),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (request != null) {
                                AsyncImage(request, label, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
                            }
                        }
                        if (ui.draft?.frozen == false) {
                            val removeInteraction = remember { MutableInteractionSource() }
                            Box(
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .size(36.dp)
                                    .clickable(
                                        interactionSource = removeInteraction,
                                        indication = null,
                                        enabled = ui.canEdit,
                                        role = Role.Button,
                                        onClick = {
                                            SparkHaptics.tick(view)
                                            model.removeImage(asset.id)
                                        },
                                    )
                                    .semantics { contentDescription = "移除$label" },
                                contentAlignment = Alignment.TopEnd,
                            ) {
                                Surface(
                                    modifier = Modifier
                                        .padding(4.dp)
                                        .size(22.dp)
                                        .sparkPressScale(removeInteraction, pressedScale = 0.9f, enabled = ui.canEdit),
                                    shape = CircleShape,
                                    color = colors.fg.copy(alpha = 0.72f),
                                    contentColor = colors.surface,
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        SparkCloseIcon(color = colors.surface, size = 11.dp)
                                    }
                                }
                            }
                        }
                    }
                    AnimatedVisibility(
                        visible = showProgress,
                        enter = fadeIn(sparkTween(SparkMotion.Instant)),
                        exit = fadeOut(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)),
                    ) {
                        val fraction = uploading?.fraction
                        if (fraction != null) {
                            LinearProgressIndicator(
                                progress = { smoothFraction },
                                modifier = Modifier.fillMaxWidth().height(3.dp),
                                trackColor = colors.surfaceMuted,
                                strokeCap = StrokeCap.Round,
                            )
                        } else {
                            LinearProgressIndicator(
                                modifier = Modifier.fillMaxWidth().height(3.dp),
                                trackColor = colors.surfaceMuted,
                                strokeCap = StrokeCap.Round,
                            )
                        }
                    }
                    if (statusText != null) {
                        Text(statusText, color = statusColor, style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    }
                    if (error != null) {
                        Text(
                            error,
                            color = statusColors.danger,
                            style = MaterialTheme.typography.bodySmall,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    AnimatedVisibility(
                        visible = showRetryUpload || showRetryImport,
                        enter = expandVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)) +
                            fadeIn(sparkTween(SparkMotion.Fast, SparkMotion.EaseOut)),
                        exit = shrinkVertically(sparkTween(SparkMotion.Fast, SparkMotion.EaseExit)) +
                            fadeOut(sparkTween(SparkMotion.Instant, SparkMotion.EaseExit)),
                    ) {
                        TextButton(
                            onClick = {
                                SparkHaptics.tick(view)
                                model.retryImage(asset.id)
                            },
                            enabled = if (showRetryUpload) ui.canSend && ui.canEdit else ui.canEdit,
                            contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                            modifier = Modifier.semantics { contentDescription = "重试$label" },
                        ) { Text("重试") }
                    }
                }
            }
        }
    }
}
