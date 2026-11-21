import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Search, X } from 'lucide-react';
import type { CollectionType, ProjectState } from '../api/types';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { CollectionCard } from '../components/CollectionCard';
import { CollectionComposer } from '../components/CollectionComposer';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { projectStateLabel } from '../lib/format';
import { projectToneClass } from '../lib/projectTone';

export function ProjectDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const api = useApi();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [typeFilter, setTypeFilter] = useState<CollectionType | ''>('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const [editOpen, setEditOpen] = useState(false);

  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editState, setEditState] = useState<ProjectState>('active');
  const [editFocusInput, setEditFocusInput] = useState('');
  const [editFocusPoints, setEditFocusPoints] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [conflictLatestVersion, setConflictLatestVersion] = useState<number | null>(null);

  useEffect(() => {
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

  if (projectQuery.isLoading) return <LoadingState message="正在加载项目…" />;
  if (projectQuery.isError) {
    return <ErrorBanner error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />;
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
          <button type="button" className="sp-btn--quiet" onClick={openEditModal}>
            <Pencil size={16} strokeWidth={2} aria-hidden="true" />
            <span className="sp-collapse-label">编辑项目</span>
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

      <CollectionComposer key={project.id} defaultProjectId={project.id} />

      <div className="sp-list-toolbar">
        <div className="sp-search-bar">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            aria-label="在当前项目内搜索"
            placeholder="在项目内搜索…"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="sp-btn--quiet"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
        >
          未读
        </button>
        <select
          aria-label="筛选类型"
          className="sp-select sp-select--compact"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as CollectionType | '')}
        >
          <option value="">全部类型</option>
          <option value="text">文字</option>
          <option value="url">网址</option>
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
    </div>
  );
}
