import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Check,
  ExternalLink,
  Folder,
  History,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { Collection, SparkDocument } from '../api/types';
import { ApiError, getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { AttachmentImage } from '../components/AttachmentImage';
import { Modal } from '../components/Modal';
import { ProjectSuggestionEvidence } from '../components/ProjectSuggestionEvidence';
import { RichTextEditor } from '../components/RichTextEditor';
import { SafeDocumentView } from '../components/SafeDocumentView';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  MAX_TEXT_AND_INTENT_CHARS,
  countUnicodeChars,
  derivePlainText,
  inspectSparkDocumentSupport,
  isValidHttpUrl,
} from '../lib/document';
import { loadDraft, removeDraft, saveDraft, useBeforeUnloadWarning } from '../lib/drafts';
import { formatDateTime, formatRemainingTrashDays } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import {
  classifyOrganizationDisplay,
  isOrganizationActiveStatus,
  stageNameLabel,
  stageStatusLabel,
} from '../lib/organization';

interface EditDraft {
  baseContentVersion: number;
  document: SparkDocument;
  intent: string;
  originalUrl: string;
  manualTitle: string;
  keptAttachmentIds: string[];
}

export function CollectionDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const api = useApi();
  const { user, aiTrialEligible, aiPlatformEnabled } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const routeState = (location.state as { from?: string; edit?: boolean } | null) ?? null;
  const backTo = routeState?.from || '/inbox';
  const userId = user?.id ?? '';
  const editDraftScope = `edit:${id}`;

  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflictServerDoc, setConflictServerDoc] = useState<Collection | null>(null);
  const [editorResetToken, setEditorResetToken] = useState(0);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [selectedProjectToAdd, setSelectedProjectToAdd] = useState('');
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const [orgActionError, setOrgActionError] = useState<string | null>(null);

  const autoReadMarkedRef = useRef<string | null>(null);
  const autoEditOpenedRef = useRef<string | null>(null);
  const orgRetryKeyRef = useRef<string>(generateIdempotencyKey());
  const orgRetryContextRef = useRef<string>('');

  const collectionQuery = useQuery({
    queryKey: ['collection', id],
    queryFn: () => api.getCollection(id),
    enabled: Boolean(id),
  });

  const extractionsQuery = useQuery({
    queryKey: ['collection-extractions', id],
    queryFn: () => api.getExtractions(id),
    enabled: secondaryExpanded && Boolean(id) && Boolean(collectionQuery.data),
  });

  const projectsQuery = useQuery({
    queryKey: ['projects', 'all-for-select'],
    queryFn: () => api.listProjects({ limit: 100 }),
  });

  const revisionsQuery = useQuery({
    queryKey: ['collection-revisions', id],
    queryFn: () => api.listRevisions(id, { limit: 30 }),
    enabled: revisionsOpen && Boolean(id),
  });

  const collection = collectionQuery.data;

  useEffect(() => {
    if (!collection || collection.read_at || collection.deleted_at) return;
    if (autoReadMarkedRef.current === collection.id) return;
    autoReadMarkedRef.current = collection.id;
    void api
      .setReadState(collection.id, { read: true })
      .then((updated) => {
        queryClient.setQueryData(['collection', id], updated);
        void queryClient.invalidateQueries({ queryKey: ['collections'] });
      })
      .catch(() => {
        // Non-fatal
      });
  }, [api, collection, id, queryClient]);

  const orgRetryContext = collection
    ? `${collection.id}:${collection.content_version}:${collection.ai_excluded ? '1' : '0'}`
    : '';
  useEffect(() => {
    if (orgRetryContext && orgRetryContextRef.current !== orgRetryContext) {
      orgRetryContextRef.current = orgRetryContext;
      orgRetryKeyRef.current = generateIdempotencyKey();
    }
  }, [orgRetryContext]);

  useBeforeUnloadWarning(isEditing && Boolean(editDraft));

  useEffect(() => {
    if (!userId || !isEditing || !editDraft) return;
    saveDraft(userId, editDraftScope, editDraft);
  }, [userId, editDraftScope, isEditing, editDraft]);

  const startEditing = (col: Collection) => {
    const restored = loadDraft<EditDraft>(userId, editDraftScope);
    if (restored.data && restored.data.baseContentVersion === col.content_version) {
      setEditDraft(restored.data);
    } else {
      setEditDraft({
        baseContentVersion: col.content_version,
        document: col.document,
        intent: col.intent,
        originalUrl: col.original_url ?? '',
        manualTitle: col.manual_title ?? '',
        keptAttachmentIds: col.attachments.map((a) => a.id),
      });
    }
    setConflictServerDoc(null);
    setEditError(null);
    setEditorResetToken((n) => n + 1);
    setIsEditing(true);
  };

  useEffect(() => {
    if (
      routeState?.edit &&
      collection &&
      !collection.deleted_at &&
      autoEditOpenedRef.current !== collection.id
    ) {
      autoEditOpenedRef.current = collection.id;
      startEditing(collection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeState?.edit, collection?.id]);

  const cancelEditing = () => {
    setIsEditing(false);
    setEditDraft(null);
    setConflictServerDoc(null);
    setEditError(null);
    removeDraft(userId, editDraftScope);
  };

  const editCharCount = useMemo(() => {
    if (!editDraft) return 0;
    return (
      countUnicodeChars(derivePlainText(editDraft.document)) +
      countUnicodeChars(editDraft.intent)
    );
  }, [editDraft]);

  const saveEditMutation = useMutation({
    mutationFn: async (overrideBaseVersion?: number) => {
      if (!editDraft || !collection) throw new Error('编辑状态不可用');
      if (editCharCount > MAX_TEXT_AND_INTENT_CHARS) {
        throw new Error(`正文与用途说明合计不能超过 ${MAX_TEXT_AND_INTENT_CHARS} 字`);
      }
      const trimmedUrl = editDraft.originalUrl.trim();
      if (trimmedUrl && !isValidHttpUrl(trimmedUrl)) {
        throw new Error('来源网址仅支持无凭据的 http:// 或 https:// 地址');
      }
      const docSupport = inspectSparkDocumentSupport(editDraft.document);
      const plain = derivePlainText(editDraft.document).trim();
      if (!plain && !trimmedUrl && editDraft.keptAttachmentIds.length === 0) {
        throw new Error('正文或有效网址至少保留一项');
      }

      return api.updateCollection(collection.id, {
        base_content_version: overrideBaseVersion ?? editDraft.baseContentVersion,
        document: docSupport.supported ? editDraft.document : undefined,
        intent: editDraft.intent.trim(),
        original_url: trimmedUrl,
        manual_title: editDraft.manualTitle.trim(),
        attachment_ids: editDraft.keptAttachmentIds,
        upload_ids: [],
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['collection', id], updated);
      setIsEditing(false);
      setEditDraft(null);
      setConflictServerDoc(null);
      setEditError(null);
      removeDraft(userId, editDraftScope);
      pushToast({ message: '已保存修改' });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: async (err) => {
      setEditError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'content_conflict')) {
        const latest = await api.getCollection(id);
        queryClient.setQueryData(['collection', id], latest);
        setConflictServerDoc(latest);
      }
    },
  });

  const toggleReadMutation = useMutation({
    mutationFn: (read: boolean) => api.setReadState(id, { read }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['collection', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
  });

  const projectDecisionMutation = useMutation({
    mutationFn: (params: {
      baseVersion: number;
      projectId: string;
      action: 'include' | 'exclude' | 'reset';
    }) =>
      api.updateProjectDecisions(id, {
        base_decision_version: params.baseVersion,
        operations: [{ id: params.projectId, action: params.action }],
      }),
    onSuccess: (updated) => {
      setDecisionError(null);
      queryClient.setQueryData(['collection', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: async (err) => {
      setDecisionError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'decision_conflict')) {
        const latest = await api.getCollection(id);
        queryClient.setQueryData(['collection', id], latest);
      }
    },
  });

  const trashMutation = useMutation({
    mutationFn: () => {
      if (!collection) throw new Error('收藏不存在');
      return api.trashCollection(id, { base_resource_version: collection.resource_version });
    },
    onSuccess: (trashed) => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({
        message: '已移入回收站',
        actionLabel: '撤销',
        onAction: async () => {
          await api.restoreCollection(id, { base_resource_version: trashed.resource_version });
          void queryClient.invalidateQueries({ queryKey: ['collections'] });
          void queryClient.invalidateQueries({ queryKey: ['collection', id] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          void queryClient.invalidateQueries({ queryKey: ['project'] });
          void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
          pushToast({ message: '已恢复收藏' });
        },
      });
      navigate(backTo);
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const restoreMutation = useMutation({
    mutationFn: () => {
      if (!collection) throw new Error('收藏不存在');
      return api.restoreCollection(id, { base_resource_version: collection.resource_version });
    },
    onSuccess: (restored) => {
      queryClient.setQueryData(['collection', id], restored);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({ message: '已从回收站恢复' });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const aiExclusionMutation = useMutation({
    mutationFn: (excluded: boolean) => api.setAIExclusion(id, { excluded }),
    onSuccess: (updated) => {
      setOrgActionError(null);
      queryClient.setQueryData(['collection', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({
        message: updated.ai_excluded
          ? '已将该条排除在 AI 整理之外'
          : '已允许该条参与 AI 整理（可点击重新整理立即处理）',
      });
    },
    onError: (err) => setOrgActionError(getFriendlyErrorMessage(err)),
  });

  const restartOrgMutation = useMutation({
    mutationFn: () => api.restartOrganization(id, orgRetryKeyRef.current),
    onSuccess: async (org) => {
      setOrgActionError(null);
      orgRetryKeyRef.current = generateIdempotencyKey();
      queryClient.setQueryData<Collection | undefined>(['collection', id], (prev) =>
        prev ? { ...prev, organization: org } : prev,
      );
      if (isOrganizationActiveStatus(org.status)) {
        pushToast({ message: '已加入后台整理队列' });
      } else {
        try {
          const refreshed = await api.getCollection(id);
          queryClient.setQueryData(['collection', id], refreshed);
        } catch {
          // Organization already updated in cache
        }
      }
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => {
      setOrgActionError(getFriendlyErrorMessage(err));
    },
  });

  if (collectionQuery.isLoading) return <LoadingState message="正在加载收藏…" />;
  if (collectionQuery.isError) {
    return (
      <div className="sp-stack">
        <Link to={backTo} className="sp-btn--quiet sp-back-link" style={{ alignSelf: 'flex-start' }}>
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          <span>返回</span>
        </Link>
        <ErrorBanner
          error={collectionQuery.error}
          onRetry={() => void collectionQuery.refetch()}
        />
      </div>
    );
  }
  if (!collection) return null;

  const isInTrash = Boolean(collection.deleted_at);
  const allProjects = projectsQuery.data?.items ?? [];
  const associatedProjectIds = new Set(collection.projects.map((p) => p.project_id));
  const availableProjects = allProjects.filter((p) => !associatedProjectIds.has(p.id));
  const orgDisplay = classifyOrganizationDisplay({
    organization: collection.organization,
    aiEnabled: Boolean(user?.ai_enabled),
    aiExcluded: Boolean(collection.ai_excluded),
    projects: collection.projects,
  });
  const orgPillClass =
    orgDisplay.pillTone === 'green'
      ? 'sp-pill sp-pill--green'
      : orgDisplay.pillTone === 'warning'
        ? 'sp-pill sp-pill--warning'
        : orgDisplay.pillTone === 'danger'
          ? 'sp-pill sp-pill--danger'
          : 'sp-pill';

  return (
    <div className="sp-stack" style={{ gap: 16 }}>
      <div className="sp-row-between">
        <Link to={backTo} className="sp-btn--quiet sp-back-link">
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          <span>返回</span>
        </Link>

        {!isInTrash && (
          <div className="sp-row">
            <button
              type="button"
              className="sp-btn--quiet"
              onClick={() => toggleReadMutation.mutate(!collection.read_at)}
              disabled={toggleReadMutation.isPending}
            >
              <span>{collection.read_at ? '标为未读' : '标为已读'}</span>
            </button>
            {!isEditing && (
              <button type="button" className="sp-btn--quiet" onClick={() => startEditing(collection)}>
                <Pencil size={15} strokeWidth={2} aria-hidden="true" />
                <span>编辑</span>
              </button>
            )}
            <button
              type="button"
              className="sp-btn--quiet"
              style={{ color: 'var(--sp-danger)' }}
              onClick={() => trashMutation.mutate()}
              disabled={trashMutation.isPending}
            >
              <Trash2 size={15} strokeWidth={2} aria-hidden="true" />
              <span>移入回收站</span>
            </button>
          </div>
        )}
      </div>

      {isInTrash && (
        <div className="sp-banner sp-banner--warning" role="status">
          <div>
            <strong>此收藏位于回收站</strong>
            <div className="sp-help" style={{ color: 'inherit', marginTop: 2 }}>
              删除于 {formatDateTime(collection.deleted_at!)} ·{' '}
              {formatRemainingTrashDays(collection.purge_after)}
            </div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn--sm sp-btn--primary"
            disabled={restoreMutation.isPending}
            onClick={() => restoreMutation.mutate()}
          >
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
            <span>恢复</span>
          </button>
        </div>
      )}

      {/* Reading / Editing Card: Body & Source first */}
      <article className="sp-card">
        <div className="sp-note-meta">
          <time dateTime={collection.created_at}>{formatDateTime(collection.created_at)}</time>
          {collection.updated_at !== collection.created_at && (
            <span>· 编辑于 {formatDateTime(collection.updated_at)}</span>
          )}
        </div>

        {!isEditing ? (
          <div>
            {collection.manual_title && (
              <h1 className="sp-page-title sp-break-anywhere" style={{ marginBottom: 12 }}>
                {collection.manual_title}
              </h1>
            )}

            <SafeDocumentView document={collection.document} />

            {collection.original_url && (
              <a
                href={collection.original_url}
                target="_blank"
                rel="noopener noreferrer"
                className="sp-note-source"
                style={{ marginTop: 16 }}
              >
                <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                <span className="sp-break-anywhere">{collection.original_url}</span>
              </a>
            )}
          </div>
        ) : (
          editDraft && (
            <div className="sp-stack" style={{ gap: 14 }}>
              {editError && (
                <div className="sp-banner sp-banner--error" role="alert">
                  <span>{editError}</span>
                </div>
              )}

              {conflictServerDoc && (
                <div
                  className="sp-card"
                  style={{
                    borderColor: 'var(--sp-warning)',
                    background: 'var(--sp-warning-bg)',
                    padding: 16,
                  }}
                >
                  <h2 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--sp-warning)' }}>
                    检测到内容版本冲突（服务器已更新至 v{conflictServerDoc.content_version}）
                  </h2>
                  <p className="sp-help" style={{ marginTop: 0, color: 'var(--sp-fg)' }}>
                    你的本地草稿已完整保留在右侧，请对比后选择处理方式：
                  </p>
                  <div className="sp-conflict-grid">
                    <div className="sp-card" style={{ padding: 14 }}>
                      <div className="sp-label" style={{ marginBottom: 6 }}>
                        服务器最新版本 (v{conflictServerDoc.content_version})
                      </div>
                      <SafeDocumentView document={conflictServerDoc.document} />
                      {conflictServerDoc.intent && (
                        <p className="sp-help" style={{ marginTop: 8, marginBottom: 0 }}>
                          用途：{conflictServerDoc.intent}
                        </p>
                      )}
                    </div>
                    <div className="sp-card" style={{ padding: 14 }}>
                      <div className="sp-label" style={{ marginBottom: 6 }}>你的本地草稿</div>
                      <SafeDocumentView document={editDraft.document} />
                      {editDraft.intent && (
                        <p className="sp-help" style={{ marginTop: 8, marginBottom: 0 }}>
                          用途：{editDraft.intent}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="sp-row" style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(derivePlainText(editDraft.document));
                        pushToast({ message: '已复制本地正文' });
                      }}
                    >
                      复制本地正文
                    </button>
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm sp-btn--primary"
                      disabled={saveEditMutation.isPending}
                      onClick={() => {
                        setEditDraft((d) =>
                          d ? { ...d, baseContentVersion: conflictServerDoc.content_version } : d,
                        );
                        saveEditMutation.mutate(conflictServerDoc.content_version);
                      }}
                    >
                      基于服务器 v{conflictServerDoc.content_version} 覆盖提交
                    </button>
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm"
                      onClick={() => {
                        setEditDraft({
                          baseContentVersion: conflictServerDoc.content_version,
                          document: conflictServerDoc.document,
                          intent: conflictServerDoc.intent,
                          originalUrl: conflictServerDoc.original_url ?? '',
                          manualTitle: conflictServerDoc.manual_title ?? '',
                          keptAttachmentIds: conflictServerDoc.attachments.map((a) => a.id),
                        });
                        setConflictServerDoc(null);
                        setEditError(null);
                        setEditorResetToken((n) => n + 1);
                      }}
                    >
                      放弃本地修改
                    </button>
                  </div>
                </div>
              )}

              <div className="sp-field">
                <span className="sp-label">正文</span>
                <div className="sp-detail-editor">
                  <RichTextEditor
                    value={editDraft.document}
                    onChange={(doc) => setEditDraft((d) => (d ? { ...d, document: doc } : d))}
                    resetToken={editorResetToken}
                  />
                </div>
              </div>

              <div className="sp-field">
                <label htmlFor="edit-intent" className="sp-label">
                  用途说明
                </label>
                <textarea
                  id="edit-intent"
                  rows={2}
                  className="sp-textarea"
                  value={editDraft.intent}
                  onChange={(e) => setEditDraft((d) => (d ? { ...d, intent: e.target.value } : d))}
                />
              </div>

              <div className="sp-field">
                <label htmlFor="edit-original-url" className="sp-label">
                  来源网址（留空则清除）
                </label>
                <input
                  id="edit-original-url"
                  type="url"
                  className="sp-input"
                  value={editDraft.originalUrl}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, originalUrl: e.target.value } : d))
                  }
                />
              </div>

              <div className="sp-field">
                <label htmlFor="edit-manual-title" className="sp-label">
                  可选标题（留空恢复默认）
                </label>
                <input
                  id="edit-manual-title"
                  type="text"
                  maxLength={200}
                  className="sp-input"
                  value={editDraft.manualTitle}
                  onChange={(e) =>
                    setEditDraft((d) => (d ? { ...d, manualTitle: e.target.value } : d))
                  }
                />
              </div>

              <div className="sp-row-between">
                <span className="sp-help">
                  {editCharCount.toLocaleString()} / {MAX_TEXT_AND_INTENT_CHARS.toLocaleString()} 字
                </span>
                <div className="sp-row">
                  <button type="button" className="sp-btn" onClick={cancelEditing}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="sp-btn sp-btn--primary"
                    disabled={saveEditMutation.isPending}
                    onClick={() => saveEditMutation.mutate(undefined)}
                  >
                    {saveEditMutation.isPending ? '保存中…' : '保存修改'}
                  </button>
                </div>
              </div>
            </div>
          )
        )}

        {/* Existing attachments (kept for read protection) */}
        {collection.attachments.length > 0 && (
          <section style={{ borderTop: '1px solid var(--sp-border)', paddingTop: 18, marginTop: 22 }}>
            <h2 className="sp-help" style={{ margin: '0 0 10px' }}>
              图片附件 ({collection.attachments.length})
            </h2>
            <div className="sp-attachment-grid">
              {collection.attachments.map((att) => (
                <AttachmentImage key={att.id} attachment={att} />
              ))}
            </div>
          </section>
        )}

        {/* Intent */}
        {!isEditing && (
          <section style={{ borderTop: '1px solid var(--sp-border)', paddingTop: 18, marginTop: 22 }}>
            <h2 className="sp-help" style={{ margin: '0 0 6px' }}>
              用途
            </h2>
            <p
              className="sp-break-anywhere"
              style={{ margin: 0, color: collection.intent ? 'var(--sp-fg)' : 'var(--sp-muted)' }}
            >
              {collection.intent || '尚未填写'}
            </p>
          </section>
        )}

        {/* Project Associations */}
        <section style={{ borderTop: '1px solid var(--sp-border)', paddingTop: 18, marginTop: 22 }}>
          <div className="sp-row-between" style={{ marginBottom: 10 }}>
            <h2 className="sp-help" style={{ margin: 0 }}>
              关联项目
            </h2>
            <span className="sp-help" style={{ fontSize: 12 }}>
              决定版本 v{collection.decision_version}
            </span>
          </div>

          {decisionError && (
            <div className="sp-banner sp-banner--error" style={{ marginBottom: 10 }} role="alert">
              <span>{decisionError}</span>
            </div>
          )}

          {collection.projects.length === 0 && (
            <p className="sp-help" style={{ margin: '0 0 10px' }}>
              暂未关联项目
            </p>
          )}

          <div className="sp-stack" style={{ gap: 10, marginBottom: 12 }}>
            {collection.projects.map((pa) => {
              const isSuggested = pa.decision === 'suggested';
              const isAuto = pa.decision === 'auto';
              return (
                <div
                  key={pa.project_id}
                  id={isSuggested ? 'ai-suggestion-section' : undefined}
                  className={`sp-suggestion-card ${
                    isSuggested ? 'sp-suggestion-card--highlighted' : ''
                  }`}
                >
                  <div className="sp-row-between">
                    <div className="sp-row">
                      <Link to={`/projects/${pa.project_id}`} className="sp-project-link">
                        <Folder size={15} strokeWidth={2} aria-hidden="true" />
                        <span>{pa.name}</span>
                      </Link>
                      <span
                        className={`sp-pill ${
                          isSuggested || isAuto || pa.decision === 'confirmed'
                            ? 'sp-pill--green'
                            : ''
                        }`}
                      >
                        {pa.decision === 'manual' && '手动关联'}
                        {pa.decision === 'confirmed' && '已确认'}
                        {pa.decision === 'auto' && '自动关联'}
                        {pa.decision === 'suggested' && 'AI 建议'}
                        {pa.decision === 'rejected' && '已忽略'}
                      </span>
                    </div>

                    {!isInTrash && (
                      <div className="sp-row">
                        {(isSuggested || isAuto) && (
                          <button
                            type="button"
                            className="sp-btn sp-btn--sm sp-btn--primary"
                            disabled={projectDecisionMutation.isPending}
                            onClick={() =>
                              projectDecisionMutation.mutate({
                                baseVersion: collection.decision_version,
                                projectId: pa.project_id,
                                action: 'include',
                              })
                            }
                          >
                            <Check size={13} strokeWidth={2} aria-hidden="true" />
                            <span>{isSuggested ? '加入项目' : '确认'}</span>
                          </button>
                        )}
                        {pa.decision !== 'rejected' && (
                          <button
                            type="button"
                            className="sp-btn sp-btn--sm"
                            disabled={projectDecisionMutation.isPending}
                            onClick={() =>
                              projectDecisionMutation.mutate({
                                baseVersion: collection.decision_version,
                                projectId: pa.project_id,
                                action: 'exclude',
                              })
                            }
                          >
                            <X size={13} strokeWidth={2} aria-hidden="true" />
                            <span>{isSuggested ? '忽略' : '移除'}</span>
                          </button>
                        )}
                        {pa.decision === 'rejected' && (
                          <button
                            type="button"
                            className="sp-btn sp-btn--sm"
                            disabled={projectDecisionMutation.isPending}
                            onClick={() =>
                              projectDecisionMutation.mutate({
                                baseVersion: collection.decision_version,
                                projectId: pa.project_id,
                                action: 'reset',
                              })
                            }
                          >
                            恢复自动判断
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <ProjectSuggestionEvidence association={pa} />
                </div>
              );
            })}
          </div>

          {!isInTrash && availableProjects.length > 0 && (
            <div className="sp-row">
              <select
                aria-label="手动添加到项目"
                className="sp-select sp-select--compact"
                value={selectedProjectToAdd}
                onChange={(e) => setSelectedProjectToAdd(e.target.value)}
                style={{ minWidth: 180 }}
              >
                <option value="">添加到项目…</option>
                {availableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="sp-btn sp-btn--sm sp-btn--primary"
                disabled={!selectedProjectToAdd || projectDecisionMutation.isPending}
                onClick={() => {
                  if (!selectedProjectToAdd) return;
                  projectDecisionMutation.mutate(
                    {
                      baseVersion: collection.decision_version,
                      projectId: selectedProjectToAdd,
                      action: 'include',
                    },
                    { onSuccess: () => setSelectedProjectToAdd('') },
                  );
                }}
              >
                加入项目
              </button>
            </div>
          )}
        </section>

        {/* AI Organization Status, Controls & Results */}
        <section
          aria-label="AI 自动整理"
          style={{ borderTop: '1px solid var(--sp-border)', paddingTop: 18, marginTop: 22 }}
        >
          <div className="sp-org-box">
            <div className="sp-row-between">
              <div className="sp-row">
                <h2 className="sp-help" style={{ margin: 0, color: 'var(--sp-fg)', fontWeight: 500 }}>
                  AI 自动整理
                </h2>
                <span className={orgPillClass}>
                  {orgDisplay.kind === 'active' && (
                    <Loader2 size={12} strokeWidth={2} className="sp-spin" aria-hidden="true" />
                  )}
                  <span>{orgDisplay.badgeLabel}</span>
                </span>
              </div>

              {!isInTrash && (
                <div className="sp-row">
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm"
                    disabled={aiExclusionMutation.isPending}
                    onClick={() => aiExclusionMutation.mutate(!collection.ai_excluded)}
                  >
                    {collection.ai_excluded ? (
                      <>
                        <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
                        <span>允许 AI 整理</span>
                      </>
                    ) : (
                      <>
                        <Ban size={13} strokeWidth={2} aria-hidden="true" />
                        <span>不参与 AI 整理</span>
                      </>
                    )}
                  </button>

                  {orgDisplay.canTrigger && (
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm sp-btn--primary"
                      disabled={restartOrgMutation.isPending}
                      onClick={() => restartOrgMutation.mutate()}
                    >
                      <RefreshCw
                        size={13}
                        strokeWidth={2}
                        className={restartOrgMutation.isPending ? 'sp-spin' : undefined}
                        aria-hidden="true"
                      />
                      <span>
                        {restartOrgMutation.isPending ? '提交中…' : orgDisplay.triggerLabel}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>

            <p className="sp-help" style={{ margin: 0 }}>
              {orgDisplay.description}
              {orgDisplay.kind === 'disabled' && aiTrialEligible && aiPlatformEnabled && (
                <>
                  {' '}
                  <Link to="/settings" style={{ fontWeight: 500 }}>
                    前往设置开启
                  </Link>
                </>
              )}
            </p>

            {orgActionError && (
              <div className="sp-banner sp-banner--error" role="alert">
                <span>{orgActionError}</span>
              </div>
            )}

            {collection.organization.stages.length > 0 && (
              <div className="sp-org-stages" aria-label="整理阶段进度">
                {collection.organization.stages.map((stage) => (
                  <span
                    key={stage.name}
                    className={`sp-org-stage sp-org-stage--${stage.status}`}
                  >
                    <span>{stageNameLabel(stage.name)}</span>
                    <span>· {stageStatusLabel(stage.status)}</span>
                    {stage.attempts > 1 && <span>({stage.attempts}次)</span>}
                  </span>
                ))}
              </div>
            )}

            {(collection.organization.generated_title || collection.organization.summary) && (
              <div className="sp-org-summary-card sp-stack" style={{ gap: 8 }}>
                {collection.organization.generated_title && (
                  <div>
                    <div className="sp-help" style={{ marginBottom: 2 }}>
                      AI 建议标题
                      {collection.manual_title ? '（当前展示你的自定义标题）' : ''}
                    </div>
                    <div className="sp-break-anywhere" style={{ fontWeight: 500, fontSize: 14 }}>
                      {collection.organization.generated_title}
                    </div>
                  </div>
                )}
                {collection.organization.summary && (
                  <div>
                    <div className="sp-help" style={{ marginBottom: 2 }}>AI 摘要</div>
                    <p className="sp-break-anywhere" style={{ margin: 0, fontSize: 14 }}>
                      {collection.organization.summary}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Secondary / Collapsed Extractions & Revisions */}
        <section style={{ borderTop: '1px solid var(--sp-border)', paddingTop: 14, marginTop: 18 }}>
          <details
            className="sp-details"
            open={secondaryExpanded}
            onToggle={(e) => setSecondaryExpanded((e.target as HTMLDetailsElement).open)}
          >
            <summary>提取内容与修订历史</summary>
            <div className="sp-stack" style={{ gap: 10, paddingTop: 10 }}>
              {extractionsQuery.isSuccess && extractionsQuery.data.items.length > 0 && (
                <div className="sp-stack" style={{ gap: 6 }}>
                  {extractionsQuery.data.items.map((ext) => (
                    <div key={ext.id} className="sp-help">
                      {ext.source_kind === 'url' ? '网页正文' : '图片文字'}：{ext.text || ext.status}
                    </div>
                  ))}
                </div>
              )}

              <div>
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  onClick={() => setRevisionsOpen(true)}
                >
                  <History size={14} strokeWidth={2} aria-hidden="true" />
                  <span>查看修订历史 (v{collection.content_version})</span>
                </button>
              </div>
            </div>
          </details>
        </section>
      </article>

      <Modal open={revisionsOpen} title="内容修订历史" onClose={() => setRevisionsOpen(false)}>
        {revisionsQuery.isLoading && <LoadingState message="加载历史版本…" />}
        {revisionsQuery.isError && (
          <div className="sp-help">
            {revisionsQuery.error instanceof ApiError && revisionsQuery.error.status === 404
              ? '历史版本接口暂未开放。'
              : getFriendlyErrorMessage(revisionsQuery.error)}
          </div>
        )}
        {!revisionsQuery.isLoading &&
          !revisionsQuery.isError &&
          (revisionsQuery.data?.items ?? []).length === 0 && (
            <EmptyState title="暂无历史版本记录" />
          )}
        <div className="sp-stack">
          {(revisionsQuery.data?.items ?? []).map((rev) => (
            <div key={rev.content_version} className="sp-card" style={{ padding: 14 }}>
              <div className="sp-row-between" style={{ marginBottom: 6 }}>
                <strong>内容 v{rev.content_version}</strong>
                <span className="sp-help">{formatDateTime(rev.created_at)}</span>
              </div>
              <SafeDocumentView document={rev.document} />
              {rev.intent && (
                <p className="sp-help" style={{ marginTop: 6, marginBottom: 0 }}>
                  用途：{rev.intent}
                </p>
              )}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
