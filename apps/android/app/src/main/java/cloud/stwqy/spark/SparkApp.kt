package cloud.stwqy.spark

import android.app.Application
import cloud.stwqy.spark.core.auth.WebViewCookieCredentialProvider
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.designsystem.SparkPalette
import cloud.stwqy.spark.core.network.SparkApiClient
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.SparkDatabase
import cloud.stwqy.spark.core.storage.MediaStorage
import cloud.stwqy.spark.feature.drafts.DraftCatalog
import cloud.stwqy.spark.feature.drafts.DraftIdentity
import cloud.stwqy.spark.feature.workspace.SafDocumentWriter
import cloud.stwqy.spark.feature.workspace.WorkspaceFileStaging
import cloud.stwqy.spark.worker.AssetUploadCoordinator
import cloud.stwqy.spark.worker.DraftSubmissionCoordinator
import cloud.stwqy.spark.worker.DraftWorkScheduler
import java.util.concurrent.atomic.AtomicBoolean

class SparkApp : Application() {
    internal val workspaceFileOperation = AtomicBoolean(false)
    internal val workspaceStaging by lazy { WorkspaceFileStaging(cacheDir) }
    internal val workspaceDocuments by lazy { SafDocumentWriter(applicationContext, workspaceStaging) }
    internal val api by lazy { SparkApiClient() }
    internal val credentials by lazy { WebViewCookieCredentialProvider(api) }
    internal val drafts by lazy { DraftRepository(SparkDatabase.open(this), currentSnapshot = credentials::currentSnapshot) }
    internal val draftCatalog by lazy { DraftCatalog(drafts, api) }
    internal val media by lazy { MediaStorage(this) }
    internal val draftWork by lazy { DraftWorkScheduler(this, drafts) }
    internal val draftSubmission by lazy {
        val uploader = AssetUploadCoordinator(drafts, media, credentials, api,
            getSharedPreferences("asset_retry_after", MODE_PRIVATE))
        DraftSubmissionCoordinator(drafts, credentials, api, media, uploader, draftWork::requestSend)
    }

    override fun onCreate() {
        super.onCreate()
        draftWork.start()
    }

    internal val workspaceAppearance by lazy { getSharedPreferences("workspace_appearance", MODE_PRIVATE) }

    internal fun cachedWorkspaceIdentity(snapshot: SessionSnapshot): DraftIdentity {
        if (workspaceAppearance.getString("scope", null) != snapshot.provisionalScope) return DraftIdentity()
        val palette = SparkPalette.fromWire(workspaceAppearance.getString("palette", null))
        val theme = if (!workspaceAppearance.contains("dark")) "system"
        else if (workspaceAppearance.getBoolean("dark", false)) "dark" else "light"
        return DraftIdentity(palette, theme)
    }
}
