import { MoreProjectChoices, useProjectChoices } from './ProjectChoices';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, Folder, ImagePlus, Loader2, Sparkles, WifiOff, X } from 'lucide-react';
import type { SparkDocument } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  EMPTY_DOCUMENT,
  MAX_TEXT_AND_INTENT_CHARS,
  countUnicodeChars,
  derivePlainText,
  extractFirstHttpUrl,
  isValidHttpUrl,
} from '../lib/document';
import {
  loadDraft,
  removeDraft,
  saveDraft,
  useBeforeUnloadWarning,
  type CollectionDraft,
} from '../lib/drafts';
import { generateIdempotencyKey, generateUuid } from '../lib/idempotency';
import { MAX_ATTACHMENTS_PER_COLLECTION, useImageUploader } from '../lib/uploads';
import { AIConsentModal } from './AIConsentModal';
import { projectToneClass } from '../lib/projectTone';
import { MentionPicker } from './MentionPicker';
import { RichTextEditor } from './RichTextEditor';
import { UploadQueueTray } from './UploadQueueTray';

export function CollectionComposer({
  defaultProjectId,
  autoFocus = false,
  showAiEntry = !defaultProjectId,
  variant = 'card',
  onCreated,
}: {
  defaultProjectId?: string;
  autoFocus?: boolean;
  showAiEntry?: boolean;
  /** "sheet" drops the outer card chrome when the composer lives inside the quick-capture sheet. */
  variant?: 'card' | 'sheet';
  onCreated?: () => void;
}) {
  const api = useApi();
  const { user, aiTrialEligible, aiPlatformEnabled } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [aiConsentOpen, setAiConsentOpen] = useState(false);

  const userId = user?.id ?? '';
  const draftScope = defaultProjectId ? `project:${defaultProjectId}` : 'inbox';

  const initialDraft = useMemo((): CollectionDraft => {
    const loaded = loadDraft<CollectionDraft>(userId, draftScope);
    if (loaded.data) {
      return loaded.data;
    }
    return {
      collectionId: generateUuid(),
      idempotencyKey: generateIdempotencyKey(),
      document: EMPTY_DOCUMENT,
      intent: '',
      originalUrl: '',
      manualTitle: '',
      projectIds: defaultProjectId ? [defaultProjectId] : [],
      tagIds: [],
      aiExcluded: false,
      updatedAt: new Date().toISOString(),
    };
  }, [userId, draftScope, defaultProjectId]);

  const [collectionId, setCollectionId] = useState(initialDraft.collectionId);
  const [idempotencyKey, setIdempotencyKey] = useState(initialDraft.idempotencyKey);
  const [documentValue, setDocumentValue] = useState<SparkDocument>(initialDraft.document);
  const [intent, setIntent] = useState(initialDraft.intent);
  const [originalUrl, setOriginalUrl] = useState(initialDraft.originalUrl);
  const [manualTitle, setManualTitle] = useState(initialDraft.manualTitle);
  const [projectIds, setProjectIds] = useState<string[]>(initialDraft.projectIds);
  const [tagIds, setTagIds] = useState<string[]>(initialDraft.tagIds ?? []);
  const [names, setNames] = useState(initialDraft.associationNames ?? {});
  const [creatingTag, setCreatingTag] = useState(false);
  const [aiExcluded, setAiExcluded] = useState(Boolean(initialDraft.aiExcluded));

  const imageAnalysisQuery = useQuery({
    queryKey: ['me', 'image-analysis'],
    queryFn: () => api.getImageAnalysisPreferences(),
    enabled: Boolean(user),
  });

  const [showIntentField, setShowIntentField] = useState(Boolean(initialDraft.intent));
  const [showUrlField, setShowUrlField] = useState(Boolean(initialDraft.originalUrl));
  const [showTitleField, setShowTitleField] = useState(Boolean(initialDraft.manualTitle));

  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [isActivated, setIsActivated] = useState(() => {
    const draftText = derivePlainText(initialDraft.document).trim();
    return Boolean(
      draftText ||
        initialDraft.intent.trim() ||
        initialDraft.originalUrl.trim() ||
        initialDraft.manualTitle.trim() ||
        autoFocus,
    );
  });

  const [storageWarning, setStorageWarning] = useState<string | null>(() => {
    const loaded = loadDraft<CollectionDraft>(userId, draftScope);
    return loaded.error ?? null;
  });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  const composerRef = useRef<HTMLDivElement | null>(null);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const projectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectSearchInputRef = useRef<HTMLInputElement | null>(null);
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCollapseAfterSaveRef = useRef(false);
  const uploader = useImageUploader(api, { accountKey: userId, draftImages: initialDraft.images,
    draftCollectionId: initialDraft.collectionId });
  const hasLocalFiles = uploader.items.some(item => item.file && item.status !== 'ready');
  const images = useMemo(() => uploader.items.map(item => ({
    name: item.name, size: item.size,
    uploadId: item.restored || item.status === 'ready' ? item.uploadId : undefined,
  })), [uploader.items]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!projectPickerOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (projectPickerRef.current && !projectPickerRef.current.contains(event.target as Node)) {
        setProjectPickerOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const active = document.activeElement;
        setProjectPickerOpen(false);
        if (projectPickerRef.current?.contains(active)) {
          projectTriggerRef.current?.focus();
        }
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [projectPickerOpen]);

  useEffect(() => {
    if (projectPickerOpen) {
      window.requestAnimationFrame(() => {
        projectSearchInputRef.current?.focus();
      });
    }
  }, [projectPickerOpen]);

  const projectsQuery = useProjectChoices();

  const allProjects = projectsQuery.data?.pages.flatMap(page => page.items) ?? [];
  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return allProjects;
    return allProjects.filter((p) => p.name.toLowerCase().includes(q));
  }, [allProjects, projectSearch]);

  const selectedProjects = useMemo(
    () => projectIds.map(id => ({ id, name: allProjects.find(p => p.id === id)?.name ?? names[id] ?? '已选项目' })),
    [allProjects, projectIds, names],
  );

  const plainText = useMemo(() => derivePlainText(documentValue), [documentValue]);
  const totalChars = useMemo(
    () => countUnicodeChars(plainText) + countUnicodeChars(intent),
    [plainText, intent],
  );
  const inferredUrl = useMemo(() => extractFirstHttpUrl(documentValue), [documentValue]);

  const hasContent =
    plainText.trim().length > 0 ||
    originalUrl.trim().length > 0 ||
    Boolean(inferredUrl) ||
    uploader.readyUploadIds.length > 0;

  const isDirty =
    hasContent || tagIds.length > 0 || projectIds.some(id => id !== defaultProjectId) ||
    uploader.items.length > 0 ||
    intent.trim().length > 0 ||
    manualTitle.trim().length > 0;

  useBeforeUnloadWarning(isDirty);

  useEffect(() => {
    if (!userId) return;
    if (!isDirty) {
      removeDraft(userId, draftScope);
      return;
    }
    pendingCollapseAfterSaveRef.current = false;
    const res = saveDraft<CollectionDraft>(userId, draftScope, {
      collectionId,
      idempotencyKey,
      document: documentValue,
      intent,
      originalUrl,
      manualTitle,
      projectIds, tagIds, associationNames: names, images,
      aiExcluded,
      updatedAt: new Date().toISOString(),
    });
    setStorageWarning(res.ok ? null : (res.error ?? null));
  }, [
    userId,
    draftScope,
    isDirty,
    collectionId,
    idempotencyKey,
    documentValue,
    intent,
    originalUrl,
    manualTitle,
    projectIds, tagIds, names, images,
    aiExcluded,
  ]);

  const resetForm = useCallback(() => {
    setCollectionId(generateUuid());
    setIdempotencyKey(generateIdempotencyKey());
    setDocumentValue(EMPTY_DOCUMENT);
    setIntent('');
    setOriginalUrl('');
    setManualTitle('');
    setProjectIds(defaultProjectId ? [defaultProjectId] : []);
    setTagIds([]);
    setNames({});
    setAiExcluded(false);
    setShowIntentField(false);
    setShowUrlField(false);
    setShowTitleField(false);
    setProjectPickerOpen(false);
    setProjectSearch('');
    setSubmitError(null);
    uploader.clearAll();
    removeDraft(userId, draftScope);
    setResetToken((n) => n + 1);
  }, [defaultProjectId, draftScope, uploader, userId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!isOnline) {
        throw new Error('当前处于离线状态，已保留为本地草稿，待联网后可继续保存。');
      }
      if (totalChars > MAX_TEXT_AND_INTENT_CHARS) {
        throw new Error(`正文与用途说明合计不能超过 ${MAX_TEXT_AND_INTENT_CHARS} 字。`);
      }
      const trimmedUrl = originalUrl.trim();
      if (trimmedUrl && !isValidHttpUrl(trimmedUrl)) {
        throw new Error('来源网址仅支持无凭据的 http:// 或 https:// 地址。');
      }
      if (uploader.hasInFlight) {
        throw new Error('请等待图片上传完成或取消后再保存。');
      }
      if (uploader.hasFailed) {
        throw new Error('存在上传失败的图片，请重试或移除后再保存。');
      }
      if (!hasContent) {
        throw new Error('请填写文字、有效网址或上传图片后再保存。');
      }

      return api.createCollection(
        {
          id: collectionId,
          document: documentValue,
          intent: intent.trim(),
          original_url: trimmedUrl || undefined,
          manual_title: manualTitle.trim() || undefined,
          upload_ids: uploader.readyUploadIds,
          project_ids: projectIds,
          tag_ids: tagIds,
          ai_excluded: aiExcluded,
        },
        idempotencyKey,
      );
    },
    onSuccess: (created) => {
      const activeEl = document.activeElement;
      const focusInsideEditor =
        activeEl instanceof HTMLElement &&
        activeEl !== saveBtnRef.current &&
        Boolean(composerRef.current?.contains(activeEl));

      resetForm();
      if (focusInsideEditor) {
        // Stay activated while cursor stays inside editor; collapse smoothly once focus leaves
        pendingCollapseAfterSaveRef.current = true;
      } else {
        pendingCollapseAfterSaveRef.current = false;
        setIsActivated(false);
      }

      const isQueued =
        created.organization.status === 'queued' || created.organization.status === 'running';
      pushToast({ message: isQueued ? '已保存，正在后台整理' : '已保存' });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      onCreated?.();
    },
    onError: (err) => {
      pendingCollapseAfterSaveRef.current = false;
      setIsActivated(true);
      setSubmitError(getFriendlyErrorMessage(err));
    },
  });

  const handleSubmit = useCallback(() => {
    if (saveMutation.isPending || creatingTag) return;
    if (uploader.hasInFlight) {
      setSubmitError('请等待图片上传完成或取消后再保存。');
      return;
    }
    if (uploader.hasFailed) {
      setSubmitError('存在上传失败的图片，请重试或移除后再保存。');
      return;
    }
    setSubmitError(null);
    saveMutation.mutate();
  }, [saveMutation, creatingTag, uploader.hasFailed, uploader.hasInFlight]);

  const toggleProject = (pid: string) => {
    setProjectIds((prev) => (prev.includes(pid) ? prev.filter((id) => id !== pid) : [...prev, pid]));
  };

  const activateComposer = useCallback(() => {
    pendingCollapseAfterSaveRef.current = false;
    setIsActivated(true);
  }, []);

  const handleBlurCapture = (event: FocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && composerRef.current?.contains(nextTarget)) {
      return;
    }
    if (
      pendingCollapseAfterSaveRef.current &&
      !isDirty &&
      !showIntentField &&
      !showUrlField &&
      !showTitleField &&
      !submitError &&
      !projectPickerOpen
    ) {
      pendingCollapseAfterSaveRef.current = false;
      setIsActivated(false);
    }
  };

  const effectiveActivated =
    isActivated ||
    isDirty ||
    Boolean(uploader.validationError) ||
    showIntentField ||
    showUrlField ||
    showTitleField ||
    Boolean(submitError) ||
    projectPickerOpen;

  const saveDisabled =
    saveMutation.isPending || creatingTag ||
    !hasContent ||
    uploader.hasInFlight ||
    uploader.hasFailed ||
    totalChars > MAX_TEXT_AND_INTENT_CHARS;
  const showCharCounter = totalChars > 0;
  const isNearLimit = totalChars > MAX_TEXT_AND_INTENT_CHARS - 5000;

  return (
    <section
      data-pending-images={hasLocalFiles || (storageWarning && isDirty) || undefined}
      className={`sp-composer ${effectiveActivated ? 'sp-composer--active' : ''} ${
        variant === 'sheet' ? 'sp-composer--sheet' : ''
      }`}
      aria-label="快速收集"
    >
      {!isOnline && (
        <div className="sp-banner sp-banner--warning sp-composer-notice" role="status">
          <span className="sp-banner-icon">
            <WifiOff size={15} strokeWidth={2} aria-hidden="true" />
            <span>当前离线：已保留本地草稿，待联网后继续保存。</span>
          </span>
        </div>
      )}

      {storageWarning && (
        <div className="sp-banner sp-banner--warning sp-composer-notice" role="alert">
          <span>{storageWarning}</span>
        </div>
      )}

      <div ref={composerRef} onFocusCapture={activateComposer} onBlurCapture={handleBlurCapture}>
      <RichTextEditor
        suggestions={editor => <MentionPicker editor={editor} onBusy={setCreatingTag} onChoose={choice => {
          setNames(old => ({ ...old, [choice.id]: choice.name }));
          const setIds = choice.kind === '#' ? setTagIds : setProjectIds;
          setIds(old => old.includes(choice.id) ? old : [...old, choice.id]);
        }} />}
        value={documentValue}
        onChange={setDocumentValue}
        onShortcutSubmit={handleSubmit}
        onFocusChange={(focused) => {
          if (focused) activateComposer();
        }}
        onToolbarInteract={activateComposer}
        onFilesAdded={(files) => {
          activateComposer();
          uploader.addFiles(files);
        }}
        autoFocus={autoFocus}
        disabled={saveMutation.isPending}
        resetToken={resetToken}
        externalMenuOpen={projectPickerOpen}
        onCloseExternalMenus={() => setProjectPickerOpen(false)}
        leadingTools={
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="sp-sr-file-input"
              aria-label="选择图片文件"
              tabIndex={-1}
              onChange={(e) => {
                const picked = e.target.files ? Array.from(e.target.files) : [];
                e.target.value = '';
                if (picked.length > 0) {
                  activateComposer();
                  uploader.addFiles(picked);
                }
              }}
            />
            <button
              type="button"
              className="sp-tool-btn"
              aria-label="添加图片"
              data-tooltip="添加图片"
              aria-pressed={uploader.items.length > 0}
              disabled={
                saveMutation.isPending || uploader.items.length >= MAX_ATTACHMENTS_PER_COLLECTION
              }
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                activateComposer();
                fileInputRef.current?.click();
              }}
            >
              <ImagePlus size={18} strokeWidth={2} aria-hidden="true" />
            </button>

            <div className="sp-popover-anchor sp-popover-anchor--mobile-span" ref={projectPickerRef}>
              <button
                ref={projectTriggerRef}
                type="button"
                className="sp-tool-btn"
                aria-label="添加项目"
                data-tooltip="添加项目"
                aria-haspopup="dialog"
                aria-expanded={projectPickerOpen}
                aria-pressed={projectIds.length > 0}
                disabled={saveMutation.isPending}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  activateComposer();
                  setProjectPickerOpen((v) => !v);
                }}
              >
                <Folder size={18} strokeWidth={2} aria-hidden="true" />
              </button>

              {projectPickerOpen && (
                <div className="sp-popover sp-popover--above" role="dialog" aria-label="选择关联项目">
                  <div className="sp-stack sp-stack--tight">
                    <input
                      ref={projectSearchInputRef}
                      type="search"
                      aria-label="筛选已有项目"
                      className="sp-input sp-picker-search"
                      placeholder="搜索项目…"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                    />
                    {filteredProjects.length === 0 ? (
                      <span className="sp-picker-empty">
                        {projectsQuery.isLoading ? '正在加载项目…' : projectsQuery.hasNextPage ? '已加载的项目中没有匹配项' : allProjects.length ? '没有匹配的项目' : '暂无项目'}
                      </span>
                    ) : (
                      <div className="sp-picker-list">
                        {filteredProjects.map((proj) => {
                          const checked = projectIds.includes(proj.id);
                          return (
                            <button
                              key={proj.id}
                              type="button"
                              className="sp-menu-item"
                              aria-pressed={checked}
                              onClick={() => {
                                setNames(old => ({ ...old, [proj.id]: proj.name }));
                                toggleProject(proj.id);
                              }}
                            >
                              <Folder size={16} strokeWidth={2} aria-hidden="true" />
                              <span className="sp-truncate">{proj.name}</span>
                              {checked && (
                                <Check
                                  size={16}
                                  strokeWidth={2.4}
                                  className="sp-picker-check"
                                  aria-hidden="true"
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <MoreProjectChoices query={projectsQuery} />
                  </div>
                </div>
              )}
            </div>
          </>
        }
        betweenEditorAndToolbar={
          <>
            {hasLocalFiles && <p className="sp-help">上传完成前离开，未就绪的图片需要重新选择。</p>}
            <UploadQueueTray
              pendingItems={uploader.items}
              validationError={uploader.validationError}
              onDismissValidationError={uploader.clearValidationError}
              onCancelPending={uploader.cancelItem}
              onRetryPending={uploader.retryItem}
              onRemovePending={uploader.removeItem}
              onMovePending={uploader.moveItem}
              disabled={saveMutation.isPending}
            />

            {(selectedProjects.length > 0 || tagIds.length > 0 || aiExcluded) && (
              <div className="sp-composer-chips">
                {tagIds.map(id => <button type="button" className="sp-tag" key={id} disabled={saveMutation.isPending}
                  aria-label={`移除标签 ${names[id] ?? '已选标签'}`}
                  onClick={() => setTagIds(old => old.filter(t => t !== id))}>#{names[id] ?? '已选标签'} ×</button>)}
                {selectedProjects.map((proj) => (
                  <span key={proj.id} className={`sp-tape ${projectToneClass(proj.id)}`}>
                    <Folder size={13} strokeWidth={2} aria-hidden="true" />
                    <span className="sp-truncate">{proj.name}</span>
                    <button
                      type="button"
                      className="sp-chip-remove"
                      disabled={saveMutation.isPending}
                      aria-label={`移除项目 ${proj.name}`}
                      onClick={() => toggleProject(proj.id)}
                    >
                      <X size={12} strokeWidth={2.4} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {aiExcluded && (
                  <span className="sp-pill">
                    <span>不参与 AI 整理</span>
                    <button
                      type="button"
                      className="sp-chip-remove"
                      aria-label="取消排除 AI 整理"
                      onClick={() => setAiExcluded(false)}
                    >
                      <X size={12} strokeWidth={2.4} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </div>
            )}

            {(showIntentField || showUrlField || showTitleField) && (
              <div className="sp-composer-extra">
                {showIntentField && (
                  <div className="sp-field">
                    <div className="sp-row-between">
                      <label htmlFor="composer-intent" className="sp-label">
                        用途说明
                      </label>
                      <button
                        type="button"
                        className="sp-btn--quiet sp-btn--sm"
                        onClick={() => setShowIntentField(false)}
                      >
                        收起
                      </button>
                    </div>
                    <input
                      id="composer-intent"
                      type="text"
                      className="sp-input"
                      placeholder="以后可能用在哪儿？"
                      value={intent}
                      onChange={(e) => setIntent(e.target.value)}
                    />
                  </div>
                )}

                {showUrlField && (
                  <div className="sp-field">
                    <div className="sp-row-between">
                      <label htmlFor="composer-original-url" className="sp-label">
                        附加网址
                      </label>
                      <button
                        type="button"
                        className="sp-btn--quiet sp-btn--sm"
                        onClick={() => setShowUrlField(false)}
                      >
                        收起
                      </button>
                    </div>
                    <input
                      id="composer-original-url"
                      type="url"
                      className="sp-input"
                      placeholder="https://example.com/article"
                      value={originalUrl}
                      onChange={(e) => setOriginalUrl(e.target.value)}
                    />
                  </div>
                )}

                {showTitleField && (
                  <div className="sp-field">
                    <div className="sp-row-between">
                      <label htmlFor="composer-manual-title" className="sp-label">
                        可选标题
                      </label>
                      <button
                        type="button"
                        className="sp-btn--quiet sp-btn--sm"
                        onClick={() => setShowTitleField(false)}
                      >
                        收起
                      </button>
                    </div>
                    <input
                      id="composer-manual-title"
                      type="text"
                      maxLength={200}
                      className="sp-input"
                      placeholder="留空则直接以正文展示"
                      value={manualTitle}
                      onChange={(e) => setManualTitle(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            {submitError && (
              <div className="sp-banner sp-banner--error sp-composer-error" role="alert">
                <span>{submitError}</span>
                <button type="button" className="sp-btn sp-btn--sm" onClick={handleSubmit}>
                  重试保存
                </button>
              </div>
            )}
          </>
        }
        extraMoreItems={(closeMenu) => (
          <>
            <button
              type="button"
              role="menuitem"
              className="sp-menu-item"
              onClick={() => {
                activateComposer();
                setShowIntentField(true);
                closeMenu();
              }}
            >
              补一句用途
            </button>
            <button
              type="button"
              role="menuitem"
              className="sp-menu-item"
              onClick={() => {
                activateComposer();
                setShowUrlField(true);
                closeMenu();
              }}
            >
              附加网址
            </button>
            <button
              type="button"
              role="menuitem"
              className="sp-menu-item"
              onClick={() => {
                activateComposer();
                setShowTitleField(true);
                closeMenu();
              }}
            >
              可选标题
            </button>
            {(user?.ai_enabled || imageAnalysisQuery.data?.enabled || aiExcluded) && (
              <>
                <div className="sp-menu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={aiExcluded}
                  className="sp-menu-item"
                  onClick={() => {
                    activateComposer();
                    setAiExcluded((v) => !v);
                    closeMenu();
                  }}
                >
                  {aiExcluded ? '允许本条参与 AI 整理' : '本条不参与 AI 整理'}
                </button>
              </>
            )}
          </>
        )}
        trailingSlot={
          <div className="sp-composer-save-right">
            {showCharCounter && (
              <span
                className={`sp-char-count ${
                  totalChars > MAX_TEXT_AND_INTENT_CHARS
                    ? 'sp-char-count--over'
                    : isNearLimit
                      ? 'sp-char-count--near'
                      : ''
                }`}
              >
                {isNearLimit
                  ? `${totalChars.toLocaleString()} / ${MAX_TEXT_AND_INTENT_CHARS.toLocaleString()}`
                  : `${totalChars.toLocaleString()} 字`}
              </span>
            )}
            <button
              ref={saveBtnRef}
              type="button"
              className={`sp-send-btn ${saveMutation.isPending ? 'sp-send-btn--pending' : ''}`}
              aria-label={saveMutation.isPending ? '正在保存收藏' : '保存收藏'}
              aria-busy={saveMutation.isPending}
              data-tooltip="保存收藏 (⌘/Ctrl+Enter)"
              data-tooltip-placement="right"
              disabled={saveDisabled}
              onClick={handleSubmit}
            >
              {saveMutation.isPending ? (
                <Loader2 size={18} strokeWidth={2} className="sp-spin" aria-hidden="true" />
              ) : (
                <ArrowUp size={19} strokeWidth={2.4} aria-hidden="true" />
              )}
            </button>
          </div>
        }
      />
      </div>

      {showAiEntry && user && aiPlatformEnabled && aiTrialEligible && (
        user.ai_enabled ? (
          <div
            className="sp-composer-ai-bar sp-composer-ai-bar--active"
            role="status"
            aria-label="AI 自动整理状态"
          >
            <div className="sp-composer-ai-status">
              <span className="sp-ai-status-dot" aria-hidden="true" />
              <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
              <span>{aiExcluded ? 'AI 已开启（本条暂不参与）' : 'AI 自动整理已开启'}</span>
            </div>
            <Link to="/settings" className="sp-composer-ai-link">
              设置
            </Link>
          </div>
        ) : (
          <div
            className="sp-composer-ai-bar sp-composer-ai-bar--invite"
            role="region"
            aria-label="AI 自动整理入口"
          >
            <div className="sp-composer-ai-copy">
              <span className="sp-composer-ai-badge" aria-hidden="true">
                <Sparkles size={14} strokeWidth={2} />
              </span>
              <div className="sp-composer-ai-text">
                <strong>AI 自动整理</strong>
                <span>保存后自动提炼标题、摘要并推荐归属项目</span>
              </div>
            </div>
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--primary sp-ai-enable-btn"
              onClick={() => setAiConsentOpen(true)}
            >
              <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
              <span>开启 AI 整理</span>
            </button>
          </div>
        )
      )}

      <AIConsentModal open={aiConsentOpen} onClose={() => setAiConsentOpen(false)} />
    </section>
  );
}
