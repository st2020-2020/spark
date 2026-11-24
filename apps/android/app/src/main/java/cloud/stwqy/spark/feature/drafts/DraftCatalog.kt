package cloud.stwqy.spark.feature.drafts

import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.config.isUuid
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.CatalogPage
import cloud.stwqy.spark.core.network.SparkApiClient
import cloud.stwqy.spark.core.storage.DraftRepository
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal enum class CatalogKind(val label: String) { PROJECT("项目"), TAG("标签") }

internal data class CatalogChoice(val id: String, val name: String)

internal class DraftCatalog(
    private val drafts: DraftRepository,
    private val api: SparkApiClient,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private data class CatalogRefresh(
        val fingerprint: String, val fetchedAt: Long, val cursor: String?, val wasEmpty: Boolean,
    )
    private val refreshes = mutableMapOf<CatalogKind, CatalogRefresh>()
    private val refreshLock = Mutex()

    fun invalidate() = refreshes.clear()

    suspend fun cached(snapshot: SessionSnapshot, kind: CatalogKind): List<CatalogChoice> = when (kind) {
        CatalogKind.PROJECT -> drafts.cachedProjects(snapshot).map { CatalogChoice(it.id, it.name) }
        CatalogKind.TAG -> drafts.cachedTags(snapshot).map { CatalogChoice(it.id, it.name) }
    }

    suspend fun page(
        account: VerifiedAccount,
        kind: CatalogKind,
        query: String,
        cursor: String? = null,
        force: Boolean = false,
    ): CatalogPage<CatalogChoice> = refreshLock.withLock {
        val firstPage = query.isEmpty() && cursor == null
        val fingerprint = account.snapshot.provisionalScope
        val previous = refreshes[kind]?.takeIf { it.fingerprint == fingerprint }
        if (firstPage && !force && previous != null && now() - previous.fetchedAt in 0 until AppConfig.CATALOG_TTL_MILLIS) {
            val saved = cached(account.snapshot, kind)
            if (saved.isNotEmpty() || previous.wasEmpty) return@withLock CatalogPage(saved, previous.cursor)
        }
        val result = when (kind) {
            CatalogKind.PROJECT -> {
                val page = api.projects(account, query.takeIf(String::isNotEmpty), cursor)
                val active = page.items.filter { it.state == "active" }
                val choices = active.map { choice(it.id, it.name) }
                drafts.replaceProjects(account, active, append = !firstPage)
                CatalogPage(choices.distinctBy { it.id }, page.nextCursor)
            }
            CatalogKind.TAG -> {
                val page = api.tags(account, query.takeIf(String::isNotEmpty), cursor)
                val choices = page.items.map { choice(it.id, it.path) }
                drafts.replaceTags(account, page.items, append = !firstPage)
                CatalogPage(choices.distinctBy { it.id }, page.nextCursor)
            }
        }
        if (firstPage) {
            refreshes[kind] = CatalogRefresh(fingerprint, now(), result.nextCursor, result.items.isEmpty() && result.nextCursor == null)
        } else if (query.isEmpty() && previous != null) {
            refreshes[kind] = previous.copy(cursor = result.nextCursor, wasEmpty = false)
        }
        result
    }

    private fun choice(id: String, name: String): CatalogChoice {
        if (!isUuid(id) || name.isBlank()) throw ApiError.invalidResponse()
        return CatalogChoice(id, name)
    }
}
