import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, Loader2, SendHorizontal, WifiOff, X } from 'lucide-react';
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
import { RichTextEditor } from './RichTextEditor';

export function CollectionComposer({
  defaultProjectId,
  autoFocus = false,
  onCreated,
}: {
  defaultProjectId?: string;
  autoFocus?: boolean;
  onCreated?: () => void;
}) {
  const api = useApi();
  const { user } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

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
  const [aiExcluded, setAiExcluded] = useState(Boolean(initialDraft.aiExcluded));

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

  const composerRef = useRef<HTMLElement | null>(null);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const projectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectSearchInputRef = useRef<HTMLInputElement | null>(null);
  const saveBtnRef = useRef<HTMLButtonElement | null>(null);
  const pendingCollapseAfterSaveRef = useRef(false);

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

  const projectsQuery = useQuery({
    queryKey: ['projects', 'all-for-select'],
    queryFn: () => api.listProjects({ limit: 100 }),
  });

  const allProjects = projectsQuery.data?.items ?? [];
  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return allProjects;
    return allProjects.filter((p) => p.name.toLowerCase().includes(q));
  }, [allProjects, projectSearch]);

  const selectedProjects = useMemo(
    () => allProjects.filter((p) => projectIds.includes(p.id)),
    [allProjects, projectIds],
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
    Boolean(inferredUrl);

  const isDirty =
    hasContent ||
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
      projectIds,
      tagIds: [],
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
    projectIds,
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
    setAiExcluded(false);
    setShowIntentField(false);
    setShowUrlField(false);
    setShowTitleField(false);
    setProjectPickerOpen(false);
    setProjectSearch('');
    setSubmitError(null);
    removeDraft(userId, draftScope);
    setResetToken((n) => n + 1);
  }, [defaultProjectId, draftScope, userId]);

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
      if (!hasContent) {
        throw new Error('请填写文字或有效网址后再保存。');
      }

      return api.createCollection(
        {
          id: collectionId,
          document: documentValue,
          intent: intent.trim(),
          original_url: trimmedUrl || undefined,
          manual_title: manualTitle.trim() || undefined,
          upload_ids: [],
          project_ids: projectIds,
          tag_ids: [],
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
    if (saveMutation.isPending) return;
    setSubmitError(null);
    saveMutation.mutate();
  }, [saveMutation]);

  const toggleProject = (pid: string) => {
    setProjectIds((prev) => (prev.includes(pid) ? prev.filter((id) => id !== pid) : [...prev, pid]));
  };

  const activateComposer = useCallback(() => {
    pendingCollapseAfterSaveRef.current = false;
    setIsActivated(true);
  }, []);

  const handleFocusCapture = () => {
    activateComposer();
  };

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
    showIntentField ||
    showUrlField ||
    showTitleField ||
    Boolean(submitError) ||
    projectPickerOpen;

  const saveDisabled =
    saveMutation.isPending || !hasContent || totalChars > MAX_TEXT_AND_INTENT_CHARS;
  const showCharCounter = totalChars > 0;
  const isNearLimit = totalChars > MAX_TEXT_AND_INTENT_CHARS - 5000;

  return (
    <section
      ref={composerRef}
      className={`sp-composer ${effectiveActivated ? 'sp-composer--active' : ''}`}
      aria-label="快速收集"
      onFocusCapture={handleFocusCapture}
      onBlurCapture={handleBlurCapture}
    >
      {!isOnline && (
        <div className="sp-banner sp-banner--warning" style={{ marginBottom: 10 }} role="status">
          <span className="sp-row">
            <WifiOff size={15} strokeWidth={2} aria-hidden="true" />
            <span>当前离线：已保留本地草稿，待联网后继续保存。</span>
          </span>
        </div>
      )}

      {storageWarning && (
        <div className="sp-banner sp-banner--warning" style={{ marginBottom: 10 }} role="alert">
          <span>{storageWarning}</span>
        </div>
      )}

      <RichTextEditor
        value={documentValue}
        onChange={setDocumentValue}
        onShortcutSubmit={handleSubmit}
        onFocusChange={(focused) => {
          if (focused) activateComposer();
        }}
        onToolbarInteract={activateComposer}
        autoFocus={autoFocus}
        disabled={saveMutation.isPending}
        resetToken={resetToken}
        externalMenuOpen={projectPickerOpen}
        onCloseExternalMenus={() => setProjectPickerOpen(false)}
        leadingTools={
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
                <div className="sp-stack" style={{ gap: 6, padding: 4 }}>
                  <input
                    ref={projectSearchInputRef}
                    type="search"
                    aria-label="筛选已有项目"
                    className="sp-input"
                    placeholder="搜索项目…"
                    value={projectSearch}
                    onChange={(e) => setProjectSearch(e.target.value)}
                    style={{ padding: '6px 8px', fontSize: 13 }}
                  />
                  {filteredProjects.length === 0 ? (
                    <span className="sp-help" style={{ padding: '4px 6px' }}>
                      {allProjects.length === 0 ? '暂无项目，保存后可在待归类查看' : '没有匹配的项目'}
                    </span>
                  ) : (
                    <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                      {filteredProjects.map((proj) => {
                        const checked = projectIds.includes(proj.id);
                        return (
                          <button
                            key={proj.id}
                            type="button"
                            className="sp-menu-item"
                            aria-pressed={checked}
                            onClick={() => toggleProject(proj.id)}
                          >
                            <Folder
                              size={15}
                              strokeWidth={2}
                              style={{ color: checked ? 'var(--sp-primary)' : undefined }}
                            />
                            <span
                              style={{
                                flex: 1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {proj.name}
                            </span>
                            {checked && (
                              <span style={{ color: 'var(--sp-primary)', fontSize: 12 }}>已选</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        }
        betweenEditorAndToolbar={
          <>
            {(selectedProjects.length > 0 || aiExcluded) && (
              <div className="sp-row" style={{ marginTop: 10 }}>
                {selectedProjects.map((proj) => (
                  <span key={proj.id} className="sp-pill sp-pill--green">
                    <Folder size={13} strokeWidth={2} aria-hidden="true" />
                    <span>{proj.name}</span>
                    <button
                      type="button"
                      aria-label={`移除项目 ${proj.name}`}
                      onClick={() => toggleProject(proj.id)}
                      style={{ padding: '0 2px', display: 'inline-flex', alignItems: 'center' }}
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  </span>
                ))}
                {aiExcluded && (
                  <span className="sp-pill">
                    <span>不参与 AI 整理</span>
                    <button
                      type="button"
                      aria-label="取消排除 AI 整理"
                      onClick={() => setAiExcluded(false)}
                      style={{ padding: '0 2px', display: 'inline-flex', alignItems: 'center' }}
                    >
                      <X size={12} strokeWidth={2} />
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
              <div className="sp-banner sp-banner--error" style={{ marginTop: 10 }} role="alert">
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
            {(user?.ai_enabled || aiExcluded) && (
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
                className="sp-help"
                style={{
                  fontSize: 12,
                  color:
                    totalChars > MAX_TEXT_AND_INTENT_CHARS
                      ? 'var(--sp-danger)'
                      : 'var(--sp-muted)',
                }}
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
                <SendHorizontal size={18} strokeWidth={2} aria-hidden="true" />
              )}
            </button>
          </div>
        }
      />
    </section>
  );
}
