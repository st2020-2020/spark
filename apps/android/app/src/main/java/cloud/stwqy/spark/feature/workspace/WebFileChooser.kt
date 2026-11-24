package cloud.stwqy.spark.feature.workspace

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import cloud.stwqy.spark.core.config.AppConfig
import java.util.Locale

internal class WebFileChooser(private val activity: ComponentActivity) {
    private var pending: ValueCallback<Array<Uri>>? = null
    private var inFlight = false
    private val singleImage = activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        complete(listOfNotNull(uri))
    }
    private val multipleImages = activity.registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(AppConfig.MAX_IMAGES),
    ) { uris -> complete(uris.takeIf { it.size <= AppConfig.MAX_IMAGES }.orEmpty()) }
    private val documents = activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        complete(uris)
    }
    private val document = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        complete(listOfNotNull(uri))
    }

    fun show(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        if (inFlight || (params.mode != FileChooserParams.MODE_OPEN && params.mode != FileChooserParams.MODE_OPEN_MULTIPLE)) {
            callback.onReceiveValue(null)
            return true
        }
        pending = callback
        inFlight = true
        try {
            val accepted = params.acceptTypes.flatMap { it.split(',') }
                .map { it.trim().lowercase(Locale.ROOT) }.filter(String::isNotEmpty)
            val onlyImages = accepted.isNotEmpty() && accepted.all { it.startsWith("image/") || it in imageExtensions }
            val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
            if (onlyImages) {
                val visual = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                if (multiple) multipleImages.launch(visual) else singleImage.launch(visual)
            } else {
                val mime = documentMimeTypes(accepted).toTypedArray()
                if (multiple) documents.launch(mime) else document.launch(mime)
            }
        } catch (_: ActivityNotFoundException) {
            complete(emptyList())
        } catch (_: SecurityException) {
            complete(emptyList())
        } catch (_: IllegalStateException) {
            complete(emptyList())
        } catch (_: IllegalArgumentException) {
            complete(emptyList())
        }
        return true
    }

    fun cancel() {
        // The picker may still return a result. Hold its slot until that result arrives.
        val callback = pending
        pending = null
        callback?.onReceiveValue(null)
    }

    private fun complete(uris: List<Uri>) {
        inFlight = false
        val callback = pending
        pending = null
        if (callback == null) return
        val selected = try {
            uris.takeIf { items -> items.isNotEmpty() && items.all(::canReadSelection) }
        } catch (_: SecurityException) {
            null
        }
        callback.onReceiveValue(selected?.toTypedArray())
    }

    private fun canReadSelection(uri: Uri): Boolean = uri.scheme == "content" &&
        uri.authority != "${activity.packageName}.fileprovider" &&
        activity.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
        PackageManager.PERMISSION_GRANTED

    private companion object {
        val imageExtensions = setOf(".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp")
    }
}

internal fun documentMimeTypes(accepted: List<String>): List<String> = accepted.flatMap { type ->
    when {
        type in listOf(".csv", "text/csv", "text/comma-separated-values") -> {
            // Android's file scanner may assign either MIME type to the same CSV file.
            listOf("text/csv", "text/comma-separated-values")
        }
        type.startsWith('.') -> listOfNotNull(android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(type.drop(1)))
        '/' in type -> listOf(type)
        else -> emptyList()
    }
}.distinct().ifEmpty { listOf("*/*") }
