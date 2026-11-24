package cloud.stwqy.spark.feature.drafts

import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.MediaStorage
import cloud.stwqy.spark.worker.DraftSubmissionCoordinator
import java.util.UUID

internal class LocalDraftsViewModel(
    drafts: DraftRepository,
    credentials: SessionCredentialProvider,
    catalog: DraftCatalog,
    submission: DraftSubmissionCoordinator,
    media: MediaStorage,
    restored: DraftRestore,
    initialIdentity: DraftIdentity,
) : DraftViewModel(
    drafts, credentials, catalog, submission, media,
    capture = false, restored, initialIdentity,
) {
    fun editDraft(id: String) = open(id)
    fun newDraft() = newDraft(UUID.randomUUID().toString())
    fun pageBy(delta: Int) = page(delta)
}
