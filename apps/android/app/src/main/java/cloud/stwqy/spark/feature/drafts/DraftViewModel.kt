package cloud.stwqy.spark.feature.drafts

import android.database.sqlite.SQLiteException
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cloud.stwqy.spark.core.auth.SessionCredentialProvider
import cloud.stwqy.spark.core.auth.SessionSnapshot
import cloud.stwqy.spark.core.auth.VerifiedAccount
import cloud.stwqy.spark.core.config.AppConfig
import cloud.stwqy.spark.core.designsystem.SparkPalette
import cloud.stwqy.spark.core.network.ApiError
import cloud.stwqy.spark.core.network.collectionCharacterCount
import cloud.stwqy.spark.core.network.isSparkWhitespace
import cloud.stwqy.spark.core.network.hasValidUnicode
import cloud.stwqy.spark.core.storage.AssetUploadState
import cloud.stwqy.spark.core.storage.DraftAccountChanged
import cloud.stwqy.spark.core.storage.DraftAssetEntity
import cloud.stwqy.spark.core.storage.DraftChanged
import cloud.stwqy.spark.core.storage.DraftContent
import cloud.stwqy.spark.core.storage.DraftEntity
import cloud.stwqy.spark.core.storage.DraftLoginHandoff
import cloud.stwqy.spark.core.storage.DraftRepository
import cloud.stwqy.spark.core.storage.DraftStatus
import cloud.stwqy.spark.core.storage.DraftSummary
import cloud.stwqy.spark.core.storage.MediaStorage
import cloud.stwqy.spark.worker.AssetProgress
import cloud.stwqy.spark.worker.DraftSubmissionCoordinator
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import kotlin.coroutines.coroutineContext

internal enum class DraftAccess { CHECKING, SIGNED_OUT, VERIFIED, OFFLINE, UNAVAILABLE }

internal data class DraftIdentity(val palette: SparkPalette = SparkPalette.MINT, val theme: String = "system") {
    fun isDark(systemDark: Boolean) = when (theme) {
        "dark" -> true
        "light" -> false
        else -> systemDark
    }
}

internal data class DraftPicker(
    val kind: CatalogKind,
    val query: String = "",
    val options: List<CatalogChoice> = emptyList(),
    val cursor: String? = null,
    val loading: Boolean = false,
    val notice: String? = null,
)

internal data class DraftImage(val asset: DraftAssetEntity, val file: File?)

internal enum class DraftImageImport(val label: String) {
    READING("正在读取图片"), INTERRUPTED("导入中断"), FAILED("导入失败"),
}

internal data class DraftUiState(
    val draft: DraftEntity? = null,
    val content: DraftContent = DraftContent(""),
    val images: List<DraftImage> = emptyList(),
    val imageProgress: Map<String, AssetProgress> = emptyMap(),
    val activeImageImports: Set<String> = emptySet(),
    val rows: List<DraftSummary> = emptyList(),
    val page: Int = 0,
    val hasNextPage: Boolean = false,
    val projects: List<CatalogChoice> = emptyList(),
    val tags: List<CatalogChoice> = emptyList(),
    val picker: DraftPicker? = null,
    val identity: DraftIdentity = DraftIdentity(),
    val access: DraftAccess = DraftAccess.CHECKING,
    val online: Boolean = true,
    val email: String? = null,
    val shareError: String? = null,
    val initialized: Boolean = false,
    val busy: Boolean = false,
    val dirty: Boolean = false,
    val notice: String? = null,
    val error: String? = null,
) {
    val sending get() = draft?.status == DraftStatus.UPLOADING_ASSETS || draft?.status == DraftStatus.SUBMITTING
    val canEdit get() = draft?.frozen == false && !sending && !busy
    val canSend get() = online && !sending && !busy && access == DraftAccess.VERIFIED
    val canLogin get() = online && !busy && access == DraftAccess.SIGNED_OUT &&
        images.none { importStatus(it.asset) == DraftImageImport.READING }
    val hasContent get() = images.any { !it.asset.uploadState.importIncomplete } || content.body.any { !it.isSparkWhitespace() }
    val hasUnimportedImages get() = images.any { it.asset.uploadState.importIncomplete }
    val canChoose get() = canEdit && (access == DraftAccess.VERIFIED || access == DraftAccess.OFFLINE ||
        projects.isNotEmpty() || tags.isNotEmpty())

    fun importStatus(asset: DraftAssetEntity): DraftImageImport? = when {
        !asset.uploadState.importIncomplete -> null
        asset.id in activeImageImports -> DraftImageImport.READING
        asset.uploadState == AssetUploadState.IMPORTING -> DraftImageImport.INTERRUPTED
        else -> DraftImageImport.FAILED
    }
}

internal sealed interface DraftEffect {
    data object Login : DraftEffect
    data class Finish(val message: String? = null) : DraftEffect
}

internal abstract class DraftViewModel(
    private val drafts: DraftRepository,
    protected val credentials: SessionCredentialProvider,
    private val catalog: DraftCatalog,
    private val submission: DraftSubmissionCoordinator,
    private val media: MediaStorage,
    private val capture: Boolean,
    restored: DraftRestore,
    initialIdentity: DraftIdentity = DraftIdentity(),
    initialShareError: String? = null,
) : ViewModel() {
    private val mutableState = MutableStateFlow(DraftUiState(
        identity = initialIdentity, page = restored.page.coerceIn(0, MAX_PAGE), shareError = initialShareError,
    ))
    val state = mutableState.asStateFlow()
    private val eventChannel = Channel<DraftEffect>(Channel.BUFFERED)
    val effects = eventChannel.receiveAsFlow()

    private val writeLock = Mutex()
    private var snapshot: SessionSnapshot? = null
    private var account: VerifiedAccount? = null
    private var selected = restored.draftId
    private var handoff = restored.handoff
    private var completedLogin = restored.completedLogin
    private var action: Job? = null
    private var verification: Job? = null
    private var autosave: Job? = null
    private var pickerRequest: Job? = null
    private var replacement: Job? = null
    private var refreshPending: Boolean? = null
    private var foreground = false

    init {
        viewModelScope.launch {
            drafts.observeFingerprint().distinctUntilChanged().collect {
                reportFailures {
                    if (foreground && snapshot != null && credentials.currentSnapshot() != snapshot) sessionMoved()
                }
            }
        }
        viewModelScope.launch {
            drafts.observeDraftChanges().collect {
                if (foreground) reportFailures { reloadDraftChanges() }
            }
        }
    }

    fun resume(online: Boolean) {
        foreground = true
        mutableState.update { it.copy(online = online) }
        if (!online && state.value.picker != null) {
            pickerRequest?.cancel()
            mutableState.update { it.copy(picker = it.picker?.copy(
                loading = false, cursor = null, notice = "离线 · 可使用已缓存的目录。",
            )) }
        }
        refresh(online)
    }

    fun pause() {
        foreground = false
        pickerRequest?.cancel()
        cancelAutosave()
        if (state.value.dirty && action?.isActive != true) {
            viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
                withContext(NonCancellable) { reportFailures { persist() } }
            }
        }
    }

    open fun restore() = DraftRestore(selected, state.value.page, handoff, completedLogin)

    fun loginResult(fingerprint: String?) {
        completedLogin = fingerprint
        if (fingerprint == null) handoff = null
    }

    fun edit(content: DraftContent, composing: Boolean = false): Boolean {
        if (!state.value.canEdit) return false
        if (content == state.value.content) {
            if (composing) cancelAutosave()
            else if (state.value.dirty && autosave == null) scheduleAutosave()
            return true
        }
        if (requireCurrentOrRefresh() == null) return false
        if (content.body.length > AppConfig.MAX_SHARED_TEXT_UNITS ||
            content.purpose.length > AppConfig.MAX_SHARED_TEXT_UNITS ||
            content.manualTitle.length > 2 * AppConfig.MAX_TITLE_CODE_POINTS ||
            !content.body.hasValidUnicode() || !content.purpose.hasValidUnicode() || !content.manualTitle.hasValidUnicode()
        ) {
            mutableState.update { it.copy(error = "输入过长或含有无法保存的字符。") }
            return false
        }
        mutableState.update { it.copy(content = content, dirty = true, notice = null, error = null) }
        cancelAutosave()
        if (!composing) scheduleAutosave()
        return true
    }

    fun closeEditor() {
        if (!state.value.initialized || state.value.busy) return
        if (state.value.draft == null && capture) {
            eventChannel.trySend(DraftEffect.Finish())
            return
        }
        if (state.value.dirty && !isCurrent()) {
            sessionMoved()
            return
        }
        runAction {
            if (state.value.dirty) persist()
            if (capture) {
                eventChannel.send(DraftEffect.Finish())
            } else {
                selected = null
                mutableState.update { it.copy(draft = null, content = DraftContent(""), images = emptyList(), notice = null) }
                current()?.let { loadRows(it) }
            }
        }
    }

    fun login() {
        if (!state.value.canLogin) return
        runAction {
            val active = requireCurrent()
            persist()
            handoff = selected?.let { drafts.beginLogin(active, it) }
            completedLogin = null
            eventChannel.send(DraftEffect.Login)
        }
    }

    fun save(row: DraftSummary? = null) = runAction {
        val active = requireCurrent()
        val target = getTarget(active, row)
        if (active == SessionSnapshot.Guest && state.value.online) throw IOException("请登录 Spark 后继续。")
        if (!state.value.online || state.value.access == DraftAccess.OFFLINE) {
            if (target.frozen) {
                mutableState.update { it.copy(error = "联网后可用原内容重试。") }
                return@runAction
            }
            queue(active, target)
            return@runAction
        }
        mutableState.update { it.copy(notice = "正在保存到收件箱…") }
        try {
            val remaining = submission.send(active, target) { updateImageProgress(target.id, it) }
            requireCurrent(active)
            if (remaining == null) completeSave("已保存到收件箱")
            else if (row == null || !remaining.frozen) showDraft(active, remaining)
            else loadRows(active)
        } catch (error: ApiError) {
            if (error.isSessionExpired) {
                markSignedOut(active)
                return@runAction
            }
            // Session verification failed before POST. A frozen row must stay frozen.
            if (error.code == "network_error" && !target.frozen &&
                drafts.read(active, target.id)?.revision == target.revision
            ) {
                queue(active, target)
                return@runAction
            }
            mutableState.update { it.copy(notice = null, error = "暂时无法连接 Spark，请稍后重试。") }
        }
    }

    fun retryImage(assetId: String) {
        val ui = state.value
        if (!ui.canEdit) return
        val asset = ui.images.firstOrNull { it.asset.id == assetId }?.asset ?: return
        if (asset.uploadState.importIncomplete) {
            if (!canRetryImport(asset) || ui.importStatus(asset) == DraftImageImport.READING) return
            runAction {
                val active = requireCurrent()
                getTarget(active, null)
                retryImport(active, asset)
                showDraft(active, drafts.read(active, asset.draftId) ?: throw DraftChanged())
            }
            return
        }
        if (!ui.canSend) return
        runAction {
            val active = requireCurrent()
            val draft = getTarget(active, null)
            try {
                val updated = submission.retryImage(active, draft, assetId) { updateImageProgress(draft.id, it) }
                showDraft(active, updated)
            } catch (error: ApiError) {
                if (error.isSessionExpired) markSignedOut(active) else throw error
            }
        }
    }

    fun removeImage(assetId: String) {
        if (!state.value.canEdit) return
        runAction {
            val active = requireCurrent()
            val draft = getTarget(active, null)
            showDraft(active, submission.removeImage(active, draft, assetId))
        }
    }

    private fun updateImageProgress(draftId: String, progress: AssetProgress) {
        mutableState.update { ui ->
            if (ui.draft?.id != draftId || !ui.busy) ui
            else ui.copy(imageProgress = ui.imageProgress + (progress.assetId to progress))
        }
    }

    fun delete(row: DraftSummary? = null) = runAction {
        val active = requireCurrent()
        val target = getTarget(active, row)
        submission.delete(active, target)
        completeSave("已删除本机草稿")
    }

    fun openPicker(kind: CatalogKind) {
        if (!state.value.canChoose) return
        val active = requireCurrentOrRefresh() ?: return
        val options = choices(state.value, kind)
        mutableState.update { it.copy(picker = DraftPicker(kind, options = options)) }
        loadPicker(active)
    }

    fun searchPicker(query: String, composing: Boolean): Boolean {
        val picker = state.value.picker ?: return false
        if (query.length > 100) return false
        val active = requireCurrentOrRefresh() ?: return false
        pickerRequest?.cancel()
        val options = choices(state.value, picker.kind).filter { it.name.contains(query.trim(), ignoreCase = true) }
        mutableState.update { it.copy(picker = DraftPicker(picker.kind, query, options)) }
        if (!composing) loadPicker(active, debounce = true)
        return true
    }

    fun nextPickerPage() {
        val picker = state.value.picker ?: return
        if (picker.loading) return
        val cursor = picker.cursor ?: return
        val active = requireCurrentOrRefresh() ?: return
        loadPicker(active, cursor = cursor)
    }

    fun retryPicker() {
        val active = requireCurrentOrRefresh() ?: return
        if (account == null) retrySession()
        else loadPicker(active, force = true)
    }

    fun closePicker() {
        pickerRequest?.cancel()
        mutableState.update { it.copy(picker = null) }
    }

    fun toggleChoice(kind: CatalogKind, id: String) {
        requireCurrentOrRefresh() ?: return
        val ui = state.value
        if (!ui.canEdit) return
        val ids = if (kind == CatalogKind.PROJECT) ui.content.projectIds else ui.content.tagIds
        val changed = if (id in ids) {
            ids - id
        } else {
            if (ui.picker?.takeIf { it.kind == kind }?.options?.any { it.id == id } != true) return
            if (ids.size >= AppConfig.MAX_COLLECTION_ASSOCIATIONS) {
                mutableState.update { it.copy(picker = it.picker?.copy(notice = "最多可选 50 个" + kind.label + "。")) }
                return
            }
            ids + id
        }
        edit(if (kind == CatalogKind.PROJECT) ui.content.copy(projectIds = changed) else ui.content.copy(tagIds = changed))
    }

    protected fun open(id: String) = runAction {
        val active = requireCurrent()
        val draft = drafts.openEditor(active, id)
        showDraft(active, draft)
    }

    protected fun newDraft(id: String) = runAction {
        val active = requireCurrent()
        val draft = drafts.create(active, id, DraftContent(""))
        showDraft(active, draft)
    }

    protected fun page(delta: Int) = runAction {
        loadRows(requireCurrent(), (state.value.page + delta).coerceIn(0, MAX_PAGE))
    }

    fun retrySession() = refresh(state.value.online)

    protected open suspend fun initialDraft(snapshot: SessionSnapshot): DraftEntity? = null

    protected open fun afterSelection(snapshot: SessionSnapshot, draft: DraftEntity) = Unit

    open fun canRetryImport(asset: DraftAssetEntity): Boolean = false

    protected fun setImageImportsActive(ids: Collection<String>, active: Boolean) {
        mutableState.update { ui ->
            ui.copy(activeImageImports = if (active) ui.activeImageImports + ids else ui.activeImageImports - ids)
        }
    }

    protected open suspend fun retryImport(snapshot: SessionSnapshot, asset: DraftAssetEntity) = Unit

    protected fun setShareNotice(notice: String?) {
        mutableState.update { it.copy(shareError = notice) }
    }

    protected fun replaceCapture(id: String?, error: String?, online: Boolean, prepare: () -> Unit) {
        replacement?.cancel()
        replacement = viewModelScope.launch(start = CoroutineStart.UNDISPATCHED) {
            action?.join()
            val previousRefresh = verification
            previousRefresh?.cancel()
            previousRefresh?.join()
            reportFailures {
                if (isCurrent()) persist()
                cancelAutosave()
                closePicker()
                selected = id
                handoff = null
                completedLogin = null
                prepare()
                val ui = state.value
                mutableState.value = DraftUiState(
                    identity = ui.identity, online = online, shareError = error, activeImageImports = ui.activeImageImports,
                )
                refresh(online)
            }
        }
    }

    private fun refresh(online: Boolean = state.value.online) {
        if (action?.isActive == true) {
            refreshPending = online
            return
        }
        verification?.cancel()
        verification = viewModelScope.launch {
            reportFailures {
                val active = credentials.currentSnapshot()
                val changed = snapshot != null && snapshot != active
                if (changed) {
                    closePicker()
                    account = null
                    mutableState.update {
                        DraftUiState(online = online, shareError = it.shareError, activeImageImports = it.activeImageImports)
                    }
                }
                snapshot = active
                if (completedLogin != null && completedLogin != active.provisionalScope) {
                    completedLogin = null
                    handoff = null
                }
                drafts.observeSession(active)
                submission.recoverInEditor(active)
                requireCurrent(active)
                val cached = drafts.verifiedSession(active)
                mutableState.update {
                    it.copy(
                        identity = cached?.let { stored -> DraftIdentity(SparkPalette.fromWire(stored.palette), stored.theme) }
                            ?: it.identity,
                        email = account?.email,
                        access = when {
                            active == SessionSnapshot.Guest -> DraftAccess.SIGNED_OUT
                            !online -> DraftAccess.OFFLINE
                            account != null -> DraftAccess.VERIFIED
                            else -> DraftAccess.CHECKING
                        },
                    )
                }
                restoreSelection(active)
                updateChoices(active)
                if (!online || active == SessionSnapshot.Guest) return@reportFailures
                try {
                    val verified = submission.verify(active)
                    requireCurrent(active)
                    account = verified
                    mutableState.update { it.copy(
                        identity = DraftIdentity(SparkPalette.fromWire(verified.palette), verified.theme),
                        email = verified.email,
                        access = DraftAccess.VERIFIED,
                    ) }
                    val pending = handoff
                    if (pending != null && completedLogin == active.provisionalScope) {
                        handoff = null
                        completedLogin = null
                        // After process recreation, the prior login may already have committed this claim.
                        if (state.value.draft?.let { it.id == pending.draftId && it.scope == verified.scope } != true) {
                            val claimed = drafts.claimAfterLogin(pending, verified)
                            requireCurrent(active)
                            showDraft(active, claimed)
                        }
                    } else if (selected != null && state.value.draft == null) {
                        val reopened = selected?.let { drafts.read(active, it) }
                        requireCurrent(active)
                        if (reopened != null) showDraft(active, reopened)
                    }
                    updateChoices(active)
                    if (state.value.draft == null) {
                        if (!capture) loadRows(active)
                        else if (selected != null && state.value.shareError == null) mutableState.update {
                            it.copy(error = "当前账号无法打开这条草稿。切回原账号后可在本机草稿中继续。")
                        }
                    }
                    if (state.value.picker != null) loadPicker(active)
                } catch (error: ApiError) {
                    requireCurrent(active)
                    if (error.isSessionExpired) markSignedOut(active) else {
                        account = null
                        mutableState.update { it.copy(
                            access = if (error.code == "network_error") DraftAccess.OFFLINE else DraftAccess.UNAVAILABLE,
                        ) }
                    }
                }
            }
        }
    }

    private suspend fun restoreSelection(active: SessionSnapshot) {
        val ui = state.value
        if (ui.initialized && ui.draft != null) {
            reloadDraftChanges()
            state.value.draft?.let { afterSelection(active, it) }
            return
        }
        val draft = initialDraft(active) ?: selected?.let { drafts.read(active, it) }
        requireCurrent(active)
        if (draft != null) showDraft(active, draft)
        else if (!capture) loadRows(active)
        mutableState.update { it.copy(initialized = true) }
        if (draft != null) afterSelection(active, draft)
    }

    private fun loadPicker(
        active: SessionSnapshot,
        cursor: String? = null,
        debounce: Boolean = false,
        force: Boolean = false,
    ) {
        val picker = state.value.picker ?: return
        val verified = account?.takeIf { it.snapshot == active && state.value.access == DraftAccess.VERIFIED }
        pickerRequest?.cancel()
        val online = state.value.online
        if (!online || verified == null) {
            mutableState.update { it.copy(picker = picker.copy(loading = false,
                notice = if (!online || state.value.access == DraftAccess.OFFLINE)
                    "离线 · 可使用已缓存的" + picker.kind.label else "联网验证账号后可刷新目录。")) }
            return
        }
        mutableState.update { it.copy(picker = picker.copy(loading = true, notice = null)) }
        pickerRequest = viewModelScope.launch {
            if (debounce) delay(280)
            try {
                val page = catalog.page(verified, picker.kind, picker.query.trim(), cursor, force)
                coroutineContext.ensureActive()
                requireCurrent(active)
                updateChoices(active)
                coroutineContext.ensureActive()
                val options = if (cursor == null) page.items else (picker.options + page.items).distinctBy { it.id }
                mutableState.update { it.copy(picker = picker.copy(options = options, cursor = page.nextCursor)) }
            } catch (error: ApiError) {
                if (current() != active) return@launch
                if (error.isSessionExpired) {
                    drafts.forgetVerification(active)
                    markSignedOut(active)
                } else {
                    mutableState.update { it.copy(picker = picker.copy(
                        notice = "无法刷新目录，可使用已缓存的" + picker.kind.label + "。",
                    )) }
                }
            } catch (_: DraftAccountChanged) {
                sessionMoved()
            } catch (_: SQLiteException) {
                mutableState.update { it.copy(picker = picker.copy(notice = "无法读取目录，请重试。")) }
            }
        }
    }

    private suspend fun queue(active: SessionSnapshot, target: DraftEntity) {
        submission.queue(active, target)
        requireCurrent(active)
        completeSave("已存为待发送草稿")
    }

    private suspend fun completeSave(message: String) {
        if (capture) eventChannel.send(DraftEffect.Finish(message))
        else {
            selected = null
            mutableState.update { it.copy(draft = null, content = DraftContent(""), images = emptyList(), dirty = false,
                notice = message, error = null) }
            loadRows(requireCurrent())
        }
    }

    private suspend fun getTarget(active: SessionSnapshot, row: DraftSummary?): DraftEntity {
        if (row == null) {
            persist()
            return state.value.draft ?: throw DraftChanged()
        }
        return drafts.read(active, row.id)?.takeIf { it.revision == row.revision } ?: throw DraftChanged()
    }

    private suspend fun loadRows(active: SessionSnapshot, page: Int = state.value.page) {
        var result = drafts.list(active, page * PAGE_SIZE, PAGE_SIZE + 1)
        val availablePage = if (result.isEmpty() && page > 0) 0 else page
        if (availablePage != page) result = drafts.list(active, limit = PAGE_SIZE + 1)
        requireCurrent(active)
        mutableState.update { it.copy(rows = result.take(PAGE_SIZE), page = availablePage, hasNextPage = result.size > PAGE_SIZE) }
    }

    private suspend fun updateChoices(active: SessionSnapshot) {
        val projects = catalog.cached(active, CatalogKind.PROJECT)
        val tags = catalog.cached(active, CatalogKind.TAG)
        requireCurrent(active)
        mutableState.update { it.copy(projects = projects, tags = tags) }
    }

    private suspend fun showDraft(active: SessionSnapshot, draft: DraftEntity) {
        val images = readImages(active, draft.id)
        requireCurrent(active)
        closePicker()
        selected = draft.id
        mutableState.update { it.copy(draft = draft, content = drafts.contentOf(draft), images = images,
            imageProgress = emptyMap(), dirty = false, notice = null, error = draft.lastError) }
    }

    private suspend fun readImages(active: SessionSnapshot, id: String): List<DraftImage> {
        val assets = drafts.readAssets(active, id)
        return withContext(Dispatchers.IO) {
            assets.map { asset ->
                val file = try {
                    media.file(asset).takeIf(File::isFile)
                } catch (_: IOException) {
                    null
                }
                DraftImage(asset, file)
            }
        }
    }

    private suspend fun reloadDraftChanges() {
        val ui = state.value
        if (!ui.initialized || ui.busy) return
        val active = current() ?: return
        val previous = ui.draft
        if (previous == null) {
            if (!capture && selected == null) loadRows(active, ui.page)
            return
        }
        val updated = drafts.read(active, previous.id)
        val images = if (updated == null) emptyList() else readImages(active, updated.id)
        requireCurrent(active)
        if (updated == null && state.value.draft == previous && !state.value.busy && !state.value.dirty) {
            if (capture) eventChannel.trySend(DraftEffect.Finish()) else completeSave("草稿已从本机列表移除")
            return
        }
        mutableState.update {
            if (it.busy || it.draft != previous) it
            else if (it.dirty || updated == null || updated == previous) it.copy(images = images)
            else it.copy(draft = updated, content = drafts.contentOf(updated), images = images,
                notice = null, error = updated.lastError)
        }
    }

    private suspend fun markSignedOut(active: SessionSnapshot) {
        account = null
        catalog.invalidate()
        closePicker()
        val opened = selected?.let { drafts.read(active, it) }
        requireCurrent(active)
        if (opened != null && !state.value.dirty) showDraft(active, opened)
        mutableState.update { ui ->
            ui.copy(
                access = DraftAccess.SIGNED_OUT, email = null, identity = DraftIdentity(), projects = emptyList(),
                tags = emptyList(), draft = ui.draft.takeIf { opened != null },
                content = if (opened == null) DraftContent("") else ui.content,
                images = if (opened == null) emptyList() else ui.images,
                dirty = ui.dirty && opened != null, notice = null,
                error = "会话已过期。请重新登录后继续。",
            )
        }
        if (!capture && opened == null) loadRows(active)
    }

    private fun scheduleAutosave() {
        autosave = viewModelScope.launch {
            delay(300)
            autosave = null
            reportFailures { persist() }
        }
    }

    private fun cancelAutosave() {
        autosave?.cancel()
        autosave = null
    }

    private suspend fun persist() = writeLock.withLock {
        val ui = state.value
        val draft = ui.draft ?: return@withLock
        if (!ui.dirty) return@withLock
        val active = requireCurrent()
        val saved = drafts.edit(active, draft.id, draft.revision, ui.content)
        requireCurrent(active)
        mutableState.update {
            if (it.draft?.id != saved.id) it
            else it.copy(draft = saved, dirty = it.content != ui.content, notice = null)
        }
    }

    private fun runAction(operation: suspend () -> Unit) {
        if (action?.isActive == true) return
        if (verification?.isActive == true && state.value.access == DraftAccess.CHECKING) {
            refreshPending = state.value.online
        }
        verification?.cancel()
        cancelAutosave()
        mutableState.update { it.copy(busy = true, error = null, notice = null) }
        action = viewModelScope.launch {
            try {
                reportFailures(operation)
            } finally {
                mutableState.update { it.copy(busy = false, imageProgress = emptyMap()) }
                action = null
                val pending = refreshPending
                refreshPending = null
                if (pending != null && foreground) refresh(pending)
                else if (state.value.dirty && foreground) scheduleAutosave()
                else if (foreground) reportFailures { reloadDraftChanges() }
            }
        }
    }

    protected suspend fun withDraftFailures(operation: suspend () -> Unit) = reportFailures(operation)

    private suspend fun reportFailures(operation: suspend () -> Unit) {
        try {
            operation()
        } catch (_: DraftAccountChanged) {
            sessionMoved()
        } catch (error: IOException) {
            mutableState.update { it.copy(error = error.message, notice = null, initialized = true) }
        } catch (_: SQLiteException) {
            mutableState.update { it.copy(error = "无法读写本机草稿，请检查可用空间后重试。", notice = null, initialized = true) }
        }
    }

    private fun sessionMoved(online: Boolean = state.value.online) {
        closePicker()
        account = null
        cancelAutosave()
        mutableState.update {
            DraftUiState(online = online, busy = action?.isActive == true, shareError = it.shareError,
                activeImageImports = it.activeImageImports)
        }
        if (foreground && snapshot != credentials.currentSnapshot()) refresh(online)
        else mutableState.update { it.copy(initialized = true, error = "账号状态已变更，请重新验证。") }
    }

    private fun current(): SessionSnapshot? = snapshot?.takeIf { credentials.currentSnapshot() == it }
    private fun isCurrent() = current() != null
    private fun requireCurrent(expected: SessionSnapshot? = snapshot): SessionSnapshot =
        current()?.takeIf { it == expected } ?: throw DraftAccountChanged()

    private fun requireCurrentOrRefresh(): SessionSnapshot? = current() ?: run {
        sessionMoved()
        null
    }

    private fun choices(ui: DraftUiState, kind: CatalogKind) = if (kind == CatalogKind.PROJECT) ui.projects else ui.tags

    private companion object {
        const val PAGE_SIZE = 20
        const val MAX_PAGE = Int.MAX_VALUE / PAGE_SIZE - 1
    }
}

internal data class DraftRestore(
    val draftId: String? = null,
    val page: Int = 0,
    val handoff: DraftLoginHandoff? = null,
    val completedLogin: String? = null,
    val captureScope: String? = null,
    val incoming: Boolean = false,
)

internal fun draftCharacterCount(content: DraftContent): Int =
    collectionCharacterCount(content.body, content.purpose)
