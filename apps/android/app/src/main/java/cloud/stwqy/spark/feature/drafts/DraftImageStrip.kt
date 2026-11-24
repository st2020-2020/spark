package cloud.stwqy.spark.feature.drafts

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkStatusColors
import cloud.stwqy.spark.core.designsystem.SparkCard
import cloud.stwqy.spark.core.storage.AssetUploadState

@Composable
internal fun DraftImageStrip(ui: DraftUiState, model: DraftViewModel) {
    val colors = LocalSparkColors.current
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ui.images.forEachIndexed { index, image ->
            key(image.asset.id) {
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
                    state.importIncomplete -> asset.errorMessage ?: if (canRetryImport) "图片导入已中断。请重试或移除这张图片。"
                        else "图片导入已中断。请移除后从原应用重新分享。"
                    image.file == null -> "本机图片无法读取。"
                    state == AssetUploadState.FAILED -> asset.errorMessage ?: "图片上传失败。"
                    else -> null
                }
                val label = "图片 ${index + 1}"
                val context = LocalContext.current
                val request = remember(context, image.file) {
                    image.file?.let { file ->
                        ImageRequest.Builder(context).data(file)
                            .memoryCachePolicy(CachePolicy.DISABLED).diskCachePolicy(CachePolicy.DISABLED)
                            .build()
                    }
                }
                SparkCard(Modifier.width(136.dp)) {
                    Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                            if (ui.draft?.frozen == false) {
                                IconButton(
                                    onClick = { model.removeImage(asset.id) }, enabled = ui.canEdit,
                                    modifier = Modifier.semantics { contentDescription = "移除$label" },
                                ) { Text("×", style = MaterialTheme.typography.titleLarge) }
                            }
                        }
                        Box(
                            Modifier.size(width = 120.dp, height = 76.dp).clip(MaterialTheme.shapes.small)
                                .background(colors.surfaceMuted),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (request != null) {
                                AsyncImage(request, label, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
                            }
                        }
                        val status = when (state) {
                            AssetUploadState.LOCAL -> "待上传"
                            AssetUploadState.UPLOADING -> if (interrupted) "待续传" else "上传中"
                            AssetUploadState.VERIFYING -> if (interrupted) "待确认" else "正在确认"
                            AssetUploadState.READY -> "已就绪"
                            AssetUploadState.FAILED -> "上传失败"
                            AssetUploadState.IMPORTING, AssetUploadState.IMPORT_FAILED -> checkNotNull(importStatus).label
                        }
                        Text(status, color = colors.fgSoft, style = MaterialTheme.typography.labelSmall)
                        val fraction = uploading?.fraction
                        if (fraction != null) {
                            LinearProgressIndicator(progress = { fraction.coerceIn(0f, 1f) }, Modifier.fillMaxWidth())
                        } else if (importing || !interrupted &&
                            (state == AssetUploadState.UPLOADING || state == AssetUploadState.VERIFYING)) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                        }
                        error?.let {
                            Text(it, color = LocalSparkStatusColors.current.danger, style = MaterialTheme.typography.bodySmall)
                        }
                        if (ui.draft?.frozen == false && (interrupted || state == AssetUploadState.FAILED) && image.file != null) {
                            TextButton(onClick = { model.retryImage(asset.id) }, enabled = ui.canSend && ui.canEdit) {
                                Text("重试$label")
                            }
                        }
                        if (ui.draft?.frozen == false && canRetryImport) {
                            TextButton(onClick = { model.retryImage(asset.id) }, enabled = ui.canEdit) {
                                Text("重试$label")
                            }
                        }
                    }
                }
            }
        }
    }
}
