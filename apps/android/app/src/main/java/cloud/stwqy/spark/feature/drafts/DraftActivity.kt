package cloud.stwqy.spark.feature.drafts

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
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
import cloud.stwqy.spark.core.storage.DraftLoginHandoff
import kotlinx.coroutines.launch

abstract class DraftActivity : ComponentActivity() {
    private val connectivity by lazy { getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager }
    private var watchingNetwork = false
    private var online = false
    internal val spark get() = application as SparkApp
    internal abstract val model: DraftViewModel
    private val signIn = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.loginResult(result.data?.getStringExtra(WebActivity.LOGIN_FINGERPRINT).takeIf { result.resultCode == RESULT_OK })
    }
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkChanged()
        override fun onLost(network: Network) = networkChanged()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = networkChanged()
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                model.effects.collect { effect ->
                    when (effect) {
                        DraftEffect.Login -> signIn.launch(WebActivity.loginIntent(this@DraftActivity))
                        is DraftEffect.Finish -> {
                            effect.message?.let { Toast.makeText(this@DraftActivity, it, Toast.LENGTH_SHORT).show() }
                            finish()
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        online = hasNetwork()
        model.resume(online)
        spark.draftWork.requestSend()
        connectivity.registerDefaultNetworkCallback(network)
        watchingNetwork = true
    }

    override fun onPause() {
        if (watchingNetwork) connectivity.unregisterNetworkCallback(network)
        watchingNetwork = false
        model.pause()
        super.onPause()
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

    internal fun hasNetwork(): Boolean = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true

    private fun networkChanged() = runOnUiThread {
        if (watchingNetwork) {
            val available = hasNetwork()
            if (available != online) {
                online = available
                model.resume(available)
                if (available) spark.draftWork.requestSend()
            }
        }
    }
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
