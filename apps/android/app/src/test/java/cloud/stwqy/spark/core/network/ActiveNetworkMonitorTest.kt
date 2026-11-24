package cloud.stwqy.spark.core.network

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowConnectivityManager
import org.robolectric.shadows.ShadowNetworkCapabilities

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26], application = Application::class)
class ActiveNetworkMonitorTest {
    private val app get() = RuntimeEnvironment.getApplication()
    private val connectivity get() = requireNotNull(app.getSystemService(ConnectivityManager::class.java))

    @Test fun internetCapabilityIsSufficientWithoutValidation() {
        val monitor = ActiveNetworkMonitor(app)
        val network = requireNotNull(connectivity.activeNetwork)
        val capabilities = setInternet(network, true)

        assertFalse(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
        assertTrue(monitor.hasNetwork())

        setInternet(network, false)
        assertFalse(monitor.hasNetwork())
        shadowOf(connectivity).setActiveNetworkInfo(null)
        assertFalse(monitor.hasNetwork())
    }

    @Test fun refreshesForDefaultNetworkEventsAndStopsDeliveringAfterPause() {
        val monitor = ActiveNetworkMonitor(app)
        val network = requireNotNull(connectivity.activeNetwork)
        val system = shadowOf(connectivity)
        val main = shadowOf(Looper.getMainLooper())
        val states = mutableListOf<Boolean>()
        setInternet(network, true)
        monitor.start { states += it }
        val callback = system.networkCallbacks.single()

        callback.onCapabilitiesChanged(network, setInternet(network, false))
        assertEquals(listOf(true), states)
        main.idle()
        setInternet(network, true)
        callback.onAvailable(network)
        main.idle()
        system.setActiveNetworkInfo(null)
        callback.onLost(network)
        main.idle()
        assertEquals(listOf(true, false, true, false), states)

        callback.onLost(network)
        monitor.stop()
        monitor.stop()
        main.idle()
        assertTrue(system.networkCallbacks.isEmpty())
        assertEquals(listOf(true, false, true, false), states)

        monitor.start { states += it }
        assertEquals(listOf(true, false, true, false, false), states)
        assertEquals(1, system.networkCallbacks.size)
        monitor.stop()
    }

    @Test
    @Config(shadows = [RejectRegistration::class])
    fun registrationFailureStillDeliversCurrentConnectivity() {
        setInternet(requireNotNull(connectivity.activeNetwork), true)
        val monitor = ActiveNetworkMonitor(app)
        val states = mutableListOf<Boolean>()

        monitor.start { states += it }
        monitor.stop()

        assertEquals(listOf(true), states)
    }

    private fun setInternet(network: Network, available: Boolean): NetworkCapabilities {
        val capabilities = ShadowNetworkCapabilities.newInstance()
        if (available) shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        shadowOf(connectivity).setNetworkCapabilities(network, capabilities)
        return capabilities
    }

    @Implements(ConnectivityManager::class)
    class RejectRegistration : ShadowConnectivityManager() {
        @Implementation
        override fun registerDefaultNetworkCallback(callback: ConnectivityManager.NetworkCallback) {
            throw SecurityException("Test network callback denial")
        }
    }
}
