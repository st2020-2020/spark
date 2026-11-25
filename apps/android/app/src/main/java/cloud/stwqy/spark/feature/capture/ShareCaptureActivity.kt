package cloud.stwqy.spark.feature.capture

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import cloud.stwqy.spark.core.designsystem.SparkTheme
import cloud.stwqy.spark.core.security.InvalidShare
import cloud.stwqy.spark.core.security.SharedInputParser
import cloud.stwqy.spark.feature.drafts.CaptureClosing
import cloud.stwqy.spark.feature.drafts.DraftActivity
import cloud.stwqy.spark.feature.drafts.DraftRestore
import cloud.stwqy.spark.feature.drafts.draftModel
import cloud.stwqy.spark.feature.drafts.draftRestore

class ShareCaptureActivity : DraftActivity() {
    internal override val model: ShareCaptureViewModel by lazy {
        draftModel {
            val restored = restoreState.draftRestore()
            val snapshot = spark.credentials.currentSnapshot()
            val (incoming, error) = if (restored.draftId != null && !restored.incoming) null to null
            else parse(intent, restored, snapshot.provisionalScope)
            ShareCaptureViewModel(
                spark.drafts, spark.credentials, spark.draftCatalog, spark.draftSubmission, spark.media,
                restored, incoming, spark.cachedWorkspaceIdentity(snapshot), error,
            )
        }
    }
    private var restoreState: Bundle? = null

    override fun onCreate(state: Bundle?) {
        restoreState = state
        super.onCreate(state)
        model
        restoreState = null
        onBackPressedDispatcher.addCallback(this) {
            if (model.state.value.isClosing) return@addCallback
            if (model.state.value.picker != null) model.closePicker() else model.closeEditor()
        }
        setContent {
            val ui by model.state.collectAsState()
            val dark = ui.identity.isDark(isSystemInDarkTheme())
            SparkTheme(ui.identity.palette, dark) {
                ShareCaptureSheet(
                    ui = ui,
                    model = model,
                    dark = dark,
                    onFinishComplete = ::completeFinish,
                )
            }
        }
    }

    // ShareCaptureSheet drives smooth dismissal from rotation-safe ViewModel closing state.
    override fun onFinishEffect(message: String?) = Unit

    private fun completeFinish(closing: CaptureClosing) {
        if (isFinishing) return
        val (shouldFinish, message) = model.consumeClosing(closing.generation)
        if (!shouldFinish) return
        message?.let { Toast.makeText(this, it, Toast.LENGTH_SHORT).show() }
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val (shared, error) = parse(intent, DraftRestore(), spark.credentials.currentSnapshot().provisionalScope)
        model.receive(shared, error, hasNetwork())
    }

    private fun parse(intent: Intent, restored: DraftRestore, scope: String): Pair<SharedDraft?, String?> = try {
        ShareCaptureViewModel.sharedDraft(restored, scope, SharedInputParser.read(intent)) to null
    } catch (invalid: InvalidShare) {
        null to invalid.message
    }
}
