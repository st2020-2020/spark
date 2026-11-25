package cloud.stwqy.spark.feature.drafts

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.view.WindowCompat
import cloud.stwqy.spark.core.designsystem.SparkTheme
import cloud.stwqy.spark.core.designsystem.SparkTransitions

class LocalDraftsActivity : DraftActivity() {
    internal override val model: LocalDraftsViewModel by lazy {
        draftModel {
            LocalDraftsViewModel(
                spark.drafts, spark.credentials, spark.draftCatalog, spark.draftSubmission, spark.media,
                restoreState.draftRestore(), spark.cachedWorkspaceIdentity(spark.credentials.currentSnapshot()),
            )
        }
    }
    private var restoreState: Bundle? = null

    override fun onCreate(state: Bundle?) {
        restoreState = state
        super.onCreate(state)
        SparkTransitions.registerTargetPushTransitions(this)
        model
        restoreState = null
        enableEdgeToEdge(navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        val back = object : OnBackPressedCallback(false) {
            override fun handleOnBackPressed() = model.closeEditor()
        }
        onBackPressedDispatcher.addCallback(this, back)
        setContent {
            val ui by model.state.collectAsState()
            val dark = ui.identity.isDark(isSystemInDarkTheme())
            SideEffect {
                back.isEnabled = ui.draft != null
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
            SparkTheme(ui.identity.palette, dark) { LocalDraftsScreen(ui, model, dark, onClose = ::finish) }
        }
    }

    override fun onResume() {
        super.onResume()
        SparkTransitions.refreshTargetPushClose(this)
    }

    override fun finish() {
        super.finish()
        SparkTransitions.applyLegacyPushExit(this)
    }
}
