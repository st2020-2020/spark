package cloud.stwqy.spark.core.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.MainThread

internal class ActiveNetworkMonitor(context: Context) {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var registered = false
    private var listener: ((Boolean) -> Unit)? = null
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refresh()
        override fun onLost(network: Network) = refresh()
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = refresh()

        private fun refresh() {
            // A lost network may already have been replaced by another default network.
            main.post { listener?.invoke(hasNetwork()) }
        }
    }

    fun hasNetwork(): Boolean {
        val manager = connectivity ?: return false
        return try {
            val network = manager.activeNetwork ?: return false
            // Internet capability is sufficient even when Android's validation probe fails.
            manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        } catch (error: SecurityException) {
            Log.w("Spark", "Cannot read default network (${error.javaClass.simpleName})")
            false
        }
    }

    @MainThread
    fun start(onChanged: (Boolean) -> Unit) {
        listener = onChanged
        if (!registered && connectivity != null) {
            try {
                connectivity.registerDefaultNetworkCallback(callback)
                registered = true
            } catch (error: RuntimeException) {
                Log.w("Spark", "Cannot register default network callback (${error.javaClass.simpleName})")
            }
        }
        onChanged(hasNetwork())
    }

    @MainThread
    fun stop() {
        listener = null
        if (!registered) return
        try {
            connectivity?.unregisterNetworkCallback(callback)
            registered = false
        } catch (_: IllegalArgumentException) {
            registered = false // The callback has already been removed.
        } catch (error: RuntimeException) {
            // Keep the registration for another cleanup attempt, with the Activity listener already detached.
            Log.w("Spark", "Cannot unregister default network callback (${error.javaClass.simpleName})")
        }
    }
}
