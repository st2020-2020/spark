package cloud.stwqy.spark.core.storage

import android.os.CancellationSignal
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.EmptyCoroutineContext

/** Cancel both a provider open and any stream it has already handed back. */
internal class ProviderIo {
    val signal = CancellationSignal()
    private val cancelled = AtomicBoolean()
    private val stream = AtomicReference<ProviderStream?>()

    fun requireActive() {
        if (cancelled.get()) throw CancellationException("Content provider operation cancelled")
    }

    fun <T : Closeable, R> useStream(opened: T, read: (T) -> R): R {
        val registered = ProviderStream(opened)
        stream.set(registered)
        // use preserves the original failure if close also fails.
        return Closeable {
            try {
                registered.close()
            } finally {
                stream.compareAndSet(registered, null)
            }
        }.use {
            requireActive()
            read(opened)
        }
    }

    fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        // Closing a pipe wakes a blocked read/write. Do not wait for a remote
        // provider or a stream close on the caller's cancellation thread.
        stream.get()?.let { opened ->
            Dispatchers.IO.dispatch(EmptyCoroutineContext) {
                try {
                    opened.close()
                } catch (_: IOException) {
                    Log.w("Spark", "Could not close cancelled provider stream")
                }
            }
        }
        Dispatchers.IO.dispatch(EmptyCoroutineContext) { signal.cancel() }
    }

    private class ProviderStream(private val opened: Closeable) {
        private var closed = false

        // The I/O worker must wait for a concurrent close before compensating a write.
        @Synchronized fun close() {
            if (closed) return
            closed = true
            opened.close()
        }
    }
}

internal suspend fun <T> withProviderIo(run: suspend (ProviderIo) -> T): T = coroutineScope {
    val io = ProviderIo()
    val cancelIo = launch(start = CoroutineStart.UNDISPATCHED) {
        try {
            awaitCancellation()
        } finally {
            io.cancel()
        }
    }
    try {
        run(io)
    } finally {
        cancelIo.cancel()
    }
}
