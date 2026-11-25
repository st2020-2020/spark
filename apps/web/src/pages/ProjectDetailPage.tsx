import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Search, Trash2, X } from 'lucide-react';
import type { CollectionType, ProjectState } from '../api/types';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { CollectionCard } from '../components/CollectionCard';
import { CollectionComposer, type ComposerDraftSnapshot } from '../components/CollectionComposer';
import { DeleteProjectConfirmModal } from '../components/DeleteProjectConfirmModal';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { captureAuthSession, isSameAuthSession, type AuthSessionSnapshot } from '../lib/authSession';
import {
  isDraftMeaningful,
  loadDraft,
  reconcileProjectDraftsOnDelete,
  type CollectionDraft,
} from '../lib/drafts';
import { contentTypeLabels, projectStateLabel } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import { projectToneClass } from '../lib/projectTone';
import { removeSidebarPinnedId } from '../lib/sidebarPrefs';

export function ProjectDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { user } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [params, setParams] = useSearchParams();
  const typeFilter = (params.get('type') ?? '') as CollectionType | '';
  const unreadOnly = params.get('read') === 'false';
  const searchKeyword = params.get('q') ?? '';
  const [searchText, setSearchText] = useState(searchKeyword);
  const [debouncedKeyword, setDebouncedKeyword] = useState(searchKeyword.trim());
  const searchComposingRef = useRef(false);

  useEffect(() => {
    if (!searchComposingRef.current) {
      setSearchText(searchKeyword);
    }
  }, [searchKeyword]);

  function updateFilter(name: string, value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(name, value);
      else next.delete(name);
      return next;
    }, { replace: true });
  }
  const [editOpen, setEditOpen] = useState(false);

  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editState, setEditState] = useState<ProjectState>('active');
  const [editFocusInput, setEditFocusInput] = useState('');
  const [editFocusPoints, setEditFocusPoints] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflictLatestVersion, setConflictLatestVersion] = useState<number | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteConflictVersion, setDeleteConflictVersion] = useState<number | null>(null);
  const [deleteDraftState, setDeleteDraftState] = useState<{
    hasUnsavedDraft: boolean;
    hasPendingImageFiles: boolean;
    readyImageCount: number;
    inboxHasDraft: boolean;
  }>({
    hasUnsavedDraft: false,
    hasPendingImageFiles: false,
    readyImageCount: 0,
    inboxHasDraft: false,
  });
  const composerSnapshotRef = useRef<ComposerDraftSnapshot | null>(null);
  const deleteKeyRef = useRef<{ version: number; key: string } | null>(null);
  const deleteAttemptSessionRef = useRef<AuthSessionSnapshot | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (searchComposingRef.current) return;
    const timer = window.setTimeout(() => setDebouncedKeyword(searchKeyword.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchKeyword]);

  const projectQuery = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.getProject(id),
    enabled: Boolean(id),
  });

  const openEditModal = () => {
    if (!projectQuery.data) return;
    setEditName(projectQuery.data.name);
    setEditDesc(projectQuery.data.description);
    setEditState(projectQuery.data.state);
    setEditFocusPoints(projectQuery.data.focus_points);
    setEditError(null);
    setConflictLatestVersion(null);
    setEditOpen(true);
  };

  const openDeleteModal = () => {
    if (!projectQuery.data) return;
    const live = composerSnapshotRef.current;
    const diskProjectDraft = loadDraft<CollectionDraft>(user?.id ?? '', `project:${id}`).data;
    const diskInboxDraft = loadDraft<CollectionDraft>(user?.id ?? '', 'inbox').data;
    const readyFromDisk = (diskProjectDraft?.images ?? []).filter((img) => Boolean(img.uploadId)).length;
    setDeleteDraftState({
      hasUnsavedDraft: Boolean(live?.hasUnsavedContent) || isDraftMeaningful(diskProjectDraft),
      hasPendingImageFiles: Boolean(live?.hasPendingImageFiles),
      readyImageCount: Math.max(live?.readyImageCount ?? 0, readyFromDisk),
      inboxHasDraft: isDraftMeaningful(diskInboxDraft),
    });
    setDeleteError(null);
    setDeleteConflictVersion(null);
    setDeleteOpen(true);
  };

  const collectionsQuery = useInfiniteQuery({
    queryKey: ['project-collections', id, { typeFilter, unreadOnly, debouncedKeyword }],
    queryFn: async ({ pageParam, signal }) => {
      if (debouncedKeyword) {
        const res = await api.searchCollections(
          {
            q: debouncedKeyword,
            project_id: id,
            type: typeFilter || undefined,
            read: unreadOnly ? false : undefined,
            cursor: pageParam,
            limit: 30,
          },
          signal,
        );
        return {
          items: res.items,
          next_cursor: res.next_cursor,
        };
      }
      const res = await api.listCollections(
        {
          project_id: id,
          type: typeFilter || undefined,
          read: unreadOnly ? false : undefined,
          cursor: pageParam,
          limit: 30,
        },
        signal,
      );
      return {
        items: res.items.map((collection) => ({ collection, snippets: [] })),
        next_cursor: res.next_cursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
    enabled: Boolean(id),
  });

  const updateMutation = useMutation({
    mutationFn: (baseVersion: number) =>
      api.updateProject(id, {
        base_version: baseVersion,
        name: editName.trim(),
        description: editDesc.trim(),
        focus_points: editFocusPoints,
        state: editState,
      }),
    onSuccess: (updated) => {
      setEditOpen(false);
      setConflictLatestVersion(null);
      pushToast({
        message:
          updated.description !== projectQuery.data?.description
            ? '项目已更新；后续自动整理将使用最新描述'
            : '项目已更新',
      });
      void queryClient.invalidateQueries({ queryKey: ['project', id] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: async (err) => {
      setEditError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'resource_conflict')) {
        const latest = await api.getProject(id);
        queryClient.setQueryData(['project', id], latest);
        setConflictLatestVersion(latest.version);
      }
    },
  });

  const handleEditSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!projectQuery.data) return;
    setEditError(null);
    updateMutation.mutate(conflictLatestVersion ?? projectQuery.data.version);
  };

  const finishProjectDeletionNavigation = (
    targetUserId: string | null,
    deletedProjectId: string,
    draftTransferResult: { movedToInbox: boolean },
    customToast?: {
      message: string;
      tone?: 'default' | 'error';
    },
  ) => {
    const projectName = projectQuery.data?.name;
    deleteKeyRef.current = null;
    setDeleteOpen(false);
    setEditOpen(false);
    void queryClient.cancelQueries({ queryKey: ['project', deletedProjectId] });
    queryClient.removeQueries({ queryKey: ['project', deletedProjectId] });
    queryClient.removeQueries({ queryKey: ['project-collections', deletedProjectId] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['project'] });
    void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    void queryClient.invalidateQueries({ queryKey: ['collections'] });
    void queryClient.invalidateQueries({ queryKey: ['collection'] });
    void queryClient.invalidateQueries({ queryKey: ['collection-thread'] });
    void queryClient.invalidateQueries({ queryKey: ['collections-command'] });
    void queryClient.invalidateQueries({ queryKey: ['tags'] });
    const defaultMessage = draftTransferResult.movedToInbox
      ? `项目${projectName ? `「${projectName}」` : ''}已删除，未保存草稿已转存到收件箱`
      : `项目${projectName ? `「${projectName}」` : ''}已删除，原关联收藏与图片已保留`;
    pushToast(customToast ?? { message: defaultMessage });
    if (targetUserId) {
      // Drafts and sidebar pins already updated for targetUserId prior to UI unmount
    }
    navigate('/projects', { replace: true });
  };

  const deleteMutation = useMutation({
    mutationFn: async (baseVersion: number): Promise<{ session: AuthSessionSnapshot; deletedId: string }> => {
      const session = captureAuthSession();
      deleteAttemptSessionRef.current = session;
      if (!deleteKeyRef.current || deleteKeyRef.current.version !== baseVersion) {
        deleteKeyRef.current = { version: baseVersion, key: generateIdempotencyKey() };
      }
      await api.deleteProject(id, baseVersion, deleteKeyRef.current.key);
      return { session, deletedId: id };
    },
    onSuccess: ({ session, deletedId }) => {
      const activeSnapshot = isSameAuthSession(session) ? composerSnapshotRef.current?.currentDraft : null;
      const transferResult = session.userId
        ? reconcileProjectDraftsOnDelete(session.userId, deletedId, activeSnapshot)
        : { movedToInbox: false };
      if (session.userId) {
        removeSidebarPinnedId(session.userId, 'project', deletedId);
      }
      if (!mountedRef.current || !isSameAuthSession(session)) return;
      finishProjectDeletionNavigation(session.userId, deletedId, transferResult);
    },
    onError: async (err, baseVersion) => {
      const session = deleteAttemptSessionRef.current ?? captureAuthSession();
      if (!mountedRef.current || !isSameAuthSession(session)) return;
      if (isApiErrorCode(err, 'not_found')) {
        const transferResult = session.userId
          ? reconcileProjectDraftsOnDelete(session.userId, id, composerSnapshotRef.current?.currentDraft)
          : { movedToInbox: false };
        if (session.userId) {
          removeSidebarPinnedId(session.userId, 'project', id);
        }
        finishProjectDeletionNavigation(session.userId, id, transferResult, {
          message: '该项目已不存在或已被删除，原关联收藏仍保留。',
          tone: 'error',
        });
        return;
      }
      if (isApiErrorCode(err, 'resource_conflict')) {
        setDeleteError(null);
        try {
          const latest = await api.getProject(id);
          if (!mountedRef.current || !isSameAuthSession(session)) return;
          queryClient.setQueryData(['project', id], latest);
          setDeleteConflictVersion(latest.version);
        } catch (refreshErr) {
          if (!mountedRef.current || !isSameAuthSession(session)) return;
          if (isApiErrorCode(refreshErr, 'not_found')) {
            const transferResult = session.userId
              ? reconcileProjectDraftsOnDelete(session.userId, id, composerSnapshotRef.current?.currentDraft)
              : { movedToInbox: false };
            if (session.userId) {
              removeSidebarPinnedId(session.userId, 'project', id);
            }
            finishProjectDeletionNavigation(session.userId, id, transferResult, {
              message: '该项目已不存在或已被删除，原关联收藏仍保留。',
              tone: 'error',
            });
            return;
          }
          setDeleteError(getFriendlyErrorMessage(refreshErr));
        }
        return;
      }
      if (isApiErrorCode(err, 'idempotency_mismatch') || deleteKeyRef.current?.version !== baseVersion) {
        deleteKeyRef.current = null;
      }
      setDeleteError(getFriendlyErrorMessage(err));
    },
  });

  if (projectQuery.isLoading) {
    return (
      <div>
        <div className="sp-detail-bar">
          <Link to="/projects" className="sp-btn--quiet sp-back-link">
            <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
            <span>项目</span>
          </Link>
        </div>
        <LoadingState message="正在加载项目…" />
      </div>
    );
  }
  if (projectQuery.isError) {
    return (
      <div>
        <div className="sp-detail-bar">
          <Link to="/projects" className="sp-btn--quiet sp-back-link">
            <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
            <span>项目</span>
          </Link>
        </div>
        <ErrorBanner error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />
      </div>
    );
  }

  const project = projectQuery.data;
  if (!project) return null;

  const hits = collectionsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <div className="sp-detail-bar">
        <Link to="/projects" className="sp-btn--quiet sp-back-link">
          <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
          <span>项目</span>
        </Link>
        <div className="sp-detail-actions">
          <button type="button" className="sp-btn--quiet" title="编辑项目" onClick={openEditModal}>
            <Pencil size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sp-collapse-label">编辑项目</span>
          </button>
          <button
            type="button"
            className="sp-btn--quiet sp-btn--danger-text"
            title="删除项目"
            onClick={openDeleteModal}
          >
            <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sp-collapse-label">删除项目</span>
          </button>
        </div>
      </div>

      <span className={`sp-tape sp-tape--header ${projectToneClass(project.id)}`} aria-hidden="true" />
      <PageHeader
        title={project.name}
        badge={
          <span
            className={`sp-project-state ${
              project.state === 'active' ? 'sp-project-state--active' : ''
            }`}
          >
            {projectStateLabel(project.state)}
          </span>
        }
      />

      {(project.description || project.focus_points.length > 0) && (
        <details className="sp-details sp-project-about">
          <summary>项目说明与关注点</summary>
          <div className="sp-project-about-body">
            {project.description && <p className="sp-break-anywhere">{project.description}</p>}
            {project.focus_points.length > 0 && (
              <div className="sp-row">
                {project.focus_points.map((fp) => (
                  <span key={fp} className="sp-pill sp-pill--outline">
                    {fp}
                  </span>
                ))}
              </div>
            )}
          </div>
        </details>
      )}

      {project.state !== 'active' && (
        <div className="sp-banner sp-banner--info sp-spaced">
          <span>
            该项目当前为「{projectStateLabel(project.state)}」：既有资料可继续浏览，仍可手动收集至此项目。
          </span>
        </div>
      )}

      <CollectionComposer
        key={project.id}
        defaultProjectId={project.id}
        draftSnapshotRef={composerSnapshotRef}
      />

      <div className="sp-list-toolbar">
        <div className="sp-search-bar">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            aria-label="在当前项目内搜索"
            placeholder="在项目内搜索…"
            value={searchText}
            onCompositionStart={() => {
              searchComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              searchComposingRef.current = false;
              const next = e.currentTarget.value;
              setSearchText(next);
              updateFilter('q', next);
            }}
            onKeyDown={(e) => {
              if (searchComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            onChange={(e) => {
              const next = e.target.value;
              setSearchText(next);
              if (searchComposingRef.current || (e.nativeEvent as InputEvent).isComposing) {
                return;
              }
              updateFilter('q', next);
            }}
          />
          {searchText && (
            <button
              type="button"
              className="sp-search-clear"
              aria-label="清空项目内搜索"
              onClick={() => {
                searchComposingRef.current = false;
                setSearchText('');
                updateFilter('q', '');
              }}
            >
              <X size={14} strokeWidth={2.2} aria-hidden="true" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="sp-btn--quiet"
          aria-pressed={unreadOnly}
          onClick={() => updateFilter('read', unreadOnly ? '' : 'false')}
        >
          未读
        </button>
        <select
          aria-label="筛选类型"
          className="sp-select sp-select--compact"
          value={typeFilter}
          onChange={(e) => updateFilter('type', e.target.value)}
        >
          <option value="">全部类型</option>
          {Object.entries(contentTypeLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {collectionsQuery.isLoading && <LoadingState message="正在加载关联收藏…" />}
      {collectionsQuery.isError && (
        <ErrorBanner error={collectionsQuery.error} onRetry={() => void collectionsQuery.refetch()} />
      )}
      {!collectionsQuery.isLoading && !collectionsQuery.isError && hits.length === 0 && (
        <EmptyState
          title="该项目下暂无匹配的收藏"
          description="可以在上方直接向此项目记一条资料，或在收件箱与待归类中把既有收藏关联过来。"
        />
      )}

      <div className="sp-note-list">
        {hits.map((hit) => (
          <CollectionCard
            key={hit.collection.id}
            collection={hit.collection}
            snippets={hit.snippets}
            searchQuery={debouncedKeyword}
          />
        ))}
      </div>

      <Modal open={editOpen} title="编辑项目" onClose={() => setEditOpen(false)}>
        <form onSubmit={handleEditSubmit} className="sp-stack sp-stack--loose">
          {editError && (
            <div className="sp-banner sp-banner--error" role="alert">
              <span>{editError}</span>
            </div>
          )}

          {conflictLatestVersion && (
            <div className="sp-banner sp-banner--warning">
              <span>
                服务器版本已更新至 v{conflictLatestVersion}。再次点击保存将基于最新版本提交你的修改。
              </span>
            </div>
          )}

          <div className="sp-field">
            <label htmlFor="edit-proj-name" className="sp-label">
              项目名称
            </label>
            <input
              id="edit-proj-name"
              type="text"
              required
              maxLength={100}
              className="sp-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="edit-proj-state" className="sp-label">
              状态
            </label>
            <select
              id="edit-proj-state"
              className="sp-select"
              value={editState}
              onChange={(e) => setEditState(e.target.value as ProjectState)}
            >
              <option value="active">进行中</option>
              <option value="paused">已暂停</option>
              <option value="completed">已结束</option>
            </select>
            <p className="sp-help">
              进行中：参与自动归类并显示在快捷列表；暂停或结束后停止自动归类，历史收藏完整保留
            </p>
          </div>

          <div className="sp-field">
            <label htmlFor="edit-proj-desc" className="sp-label">
              项目描述
            </label>
            <textarea
              id="edit-proj-desc"
              rows={3}
              maxLength={2000}
              className="sp-textarea"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="edit-proj-focus" className="sp-label">
              关注点
            </label>
            <div className="sp-input-group">
              <input
                id="edit-proj-focus"
                type="text"
                maxLength={100}
                className="sp-input"
                value={editFocusInput}
                onChange={(e) => setEditFocusInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter' && editFocusInput.trim()) {
                    e.preventDefault();
                    if (!editFocusPoints.includes(editFocusInput.trim())) {
                      setEditFocusPoints((prev) => [...prev, editFocusInput.trim()]);
                    }
                    setEditFocusInput('');
                  }
                }}
              />
              <button
                type="button"
                className="sp-btn"
                onClick={() => {
                  if (editFocusInput.trim() && !editFocusPoints.includes(editFocusInput.trim())) {
                    setEditFocusPoints((prev) => [...prev, editFocusInput.trim()]);
                    setEditFocusInput('');
                  }
                }}
              >
                添加
              </button>
            </div>
            {editFocusPoints.length > 0 && (
              <div className="sp-composer-chips">
                {editFocusPoints.map((fp) => (
                  <span key={fp} className="sp-pill sp-pill--green">
                    <span>{fp}</span>
                    <button
                      type="button"
                      className="sp-chip-remove"
                      aria-label={`移除 ${fp}`}
                      onClick={() => setEditFocusPoints((prev) => prev.filter((x) => x !== fp))}
                    >
                      <X size={12} strokeWidth={2.4} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="sp-form-actions">
            <button type="button" className="sp-btn" onClick={() => setEditOpen(false)}>
              取消
            </button>
            <button type="submit" className="sp-btn sp-btn--primary" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? '保存中…' : '保存修改'}
            </button>
          </div>
        </form>
      </Modal>

      <DeleteProjectConfirmModal
        open={deleteOpen}
        projectName={project.name}
        collectionCount={project.collection_count}
        hasUnsavedDraft={deleteDraftState.hasUnsavedDraft}
        hasPendingImageFiles={deleteDraftState.hasPendingImageFiles}
        readyImageCount={deleteDraftState.readyImageCount}
        inboxHasDraft={deleteDraftState.inboxHasDraft}
        isSubmitting={deleteMutation.isPending}
        errorMessage={deleteError}
        conflictVersion={deleteConflictVersion}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteOpen(false);
        }}
        onConfirm={() => {
          if (deleteMutation.isPending) return;
          setDeleteError(null);
          deleteMutation.mutate(deleteConflictVersion ?? project.version);
        }}
      />
    </div>
  );
}
