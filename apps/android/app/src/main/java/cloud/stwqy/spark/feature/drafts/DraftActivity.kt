package cloud.stwqy.spark.feature.drafts

import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import cloud.stwqy.spark.SparkApp
import cloud.stwqy.spark.WebActivity
import cloud.stwqy.spark.core.designsystem.SparkTransitions
import cloud.stwqy.spark.core.network.ActiveNetworkMonitor
import cloud.stwqy.spark.core.storage.DraftLoginHandoff
import kotlinx.coroutines.launch

abstract class DraftActivity : ComponentActivity() {
    private val networkMonitor by lazy { ActiveNetworkMonitor(this) }
    private var online = false
    internal val spark get() = application as SparkApp
    internal abstract val model: DraftViewModel
    private val signIn = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.loginResult(result.data?.getStringExtra(WebActivity.LOGIN_FINGERPRINT).takeIf { result.resultCode == RESULT_OK })
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                model.effects.collect { effect ->
                    when (effect) {
                        DraftEffect.Login -> {
                            signIn.launch(WebActivity.loginIntent(this@DraftActivity))
                            SparkTransitions.applyCallerModalEnter(this@DraftActivity)
                        }
                        is DraftEffect.Finish -> onFinishEffect(effect.message)
                    }
                }
            }
        }
    }

    protected open fun onFinishEffect(message: String?) {
        message?.let { Toast.makeText(this, it, Toast.LENGTH_SHORT).show() }
        finish()
    }

    override fun onResume() {
        super.onResume()
        online = networkMonitor.hasNetwork()
        model.resume(online)
        spark.draftWork.requestSend()
        networkMonitor.start { available ->
            if (available != online) {
                online = available
                model.resume(available)
                if (available) spark.draftWork.requestSend()
            }
        }
    }

    override fun onPause() {
        networkMonitor.stop()
        model.pause()
        super.onPause()
    }

    override fun onDestroy() {
        networkMonitor.stop()
        super.onDestroy()
    }

    override fun onSaveInstanceState(state: Bundle) {
        super.onSaveInstanceState(state)
        val restore = model.restore()
        state.putString("draftId", restore.draftId)
        state.putInt("page", restore.page)
        state.putString("loginScope", restore.handoff?.fromScope)
        restore.handoff?.let { state.putLong("loginRevision", it.revision) }
        state.putString("completedLogin", restore.completedLogin)
        state.putString("captureScope", restore.captureScope)
        state.putBoolean("incoming", restore.incoming)
    }

    internal fun hasNetwork(): Boolean = networkMonitor.hasNetwork()
}

internal fun Bundle?.draftRestore(): DraftRestore {
    if (this == null) return DraftRestore()
    val id = getString("draftId")
    val scope = getString("loginScope")
    return DraftRestore(
        draftId = id,
        page = getInt("page"),
        handoff = if (id != null && scope != null) DraftLoginHandoff(id, scope, getLong("loginRevision")) else null,
        completedLogin = getString("completedLogin"),
        captureScope = getString("captureScope"),
        incoming = getBoolean("incoming"),
    )
}

internal inline fun <reified T : ViewModel> ComponentActivity.draftModel(crossinline create: () -> T): T =
    ViewModelProvider(this, viewModelFactory { initializer<T> { create() } })[T::class.java]
