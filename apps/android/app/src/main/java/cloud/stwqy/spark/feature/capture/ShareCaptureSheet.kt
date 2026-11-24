package cloud.stwqy.spark.feature.capture

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import cloud.stwqy.spark.core.designsystem.LocalSparkColors
import cloud.stwqy.spark.core.designsystem.LocalSparkStatusColors
import cloud.stwqy.spark.core.designsystem.StatusBanner
import cloud.stwqy.spark.feature.drafts.DraftAccountLine
import cloud.stwqy.spark.feature.drafts.DraftActions
import cloud.stwqy.spark.feature.drafts.DraftCatalogPicker
import cloud.stwqy.spark.feature.drafts.DraftEditor
import cloud.stwqy.spark.feature.drafts.DraftUiState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShareCaptureSheet(ui: DraftUiState, model: ShareCaptureViewModel, dark: Boolean) {
    val colors = LocalSparkColors.current
    val dismissAllowed by rememberUpdatedState(ui.initialized && !ui.busy && ui.picker == null)
    val sheet = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        // Flush before dismissing the window so a failed write leaves the editor usable.
        confirmValueChange = { target ->
            if (target == SheetValue.Hidden) {
                if (dismissAllowed) model.closeEditor()
                false
            } else true
        },
    )
    ModalBottomSheet(
        onDismissRequest = model::closeEditor,
        sheetState = sheet,
        containerColor = colors.surface,
        contentColor = colors.fg,
        scrimColor = LocalSparkStatusColors.current.scrim,
        properties = ModalBottomSheetProperties(shouldDismissOnBackPress = ui.picker == null),
    ) {
        if (ui.picker != null) {
            DraftCatalogPicker(ui, model, dark, Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp))
        } else {
            Column(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("收藏到 Spark", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                        DraftAccountLine(ui)
                    }
                    TextButton(onClick = model::closeEditor, enabled = ui.initialized && !ui.busy) { Text("关闭") }
                }
                val invalid = ui.shareError
                if (invalid != null) StatusBanner(invalid, error = true, Modifier.fillMaxWidth())
                if (ui.draft != null) {
                    key(ui.draft.id) {
                        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                            DraftEditor(ui, model, dark)
                        }
                    }
                } else if (!ui.initialized) {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                }
                if (ui.draft != null || ui.error != null || (ui.initialized && invalid == null)) {
                    HorizontalDivider(color = colors.border)
                    DraftActions(ui, model)
                }
            }
        }
    }
}
