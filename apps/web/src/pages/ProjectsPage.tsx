import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Folder, Plus, X } from 'lucide-react';
import type { ProjectState } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { projectStateLabel } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import { projectToneClass } from '../lib/projectTone';

export function ProjectsPage() {
  const api = useApi();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();
  const [stateFilter, setStateFilter] = useState<ProjectState | 'all'>('all');
  const [modalOpen, setModalOpen] = useState(() => searchParams.get('create') === '1');

  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setModalOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('create');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [focusInput, setFocusInput] = useState('');
  const [focusPoints, setFocusPoints] = useState<string[]>([]);
  const [createIdempotencyKey, setCreateIdempotencyKey] = useState(() => generateIdempotencyKey());
  const [formError, setFormError] = useState<string | null>(null);

  const projectsQuery = useInfiniteQuery({
    queryKey: ['projects', { stateFilter }],
    queryFn: ({ pageParam }) =>
      api.listProjects({
        state: stateFilter === 'all' ? undefined : stateFilter,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      api.createProject(
        {
          name: name.trim(),
          description: description.trim(),
          focus_points: focusPoints,
        },
        createIdempotencyKey,
      ),
    onSuccess: (created) => {
      setModalOpen(false);
      setName('');
      setDescription('');
      setFocusInput('');
      setFocusPoints([]);
      setFormError(null);
      setCreateIdempotencyKey(generateIdempotencyKey());
      pushToast({ message: `项目「${created.name}」已创建` });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: (err) => {
      setFormError(getFriendlyErrorMessage(err));
    },
  });

  const addFocusPoint = () => {
    const trimmed = focusInput.trim();
    if (!trimmed) return;
    if (focusPoints.length >= 20) {
      setFormError('关注点最多添加 20 项');
      return;
    }
    if (!focusPoints.includes(trimmed)) {
      setFocusPoints((prev) => [...prev, trimmed.slice(0, 100)]);
    }
    setFocusInput('');
  };

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError('请填写项目名称');
      return;
    }
    createMutation.mutate();
  };

  const items = projectsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader
        title="项目"
        actions={
          <button type="button" className="sp-btn sp-btn--primary" onClick={() => setModalOpen(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
            <span>新建项目</span>
          </button>
        }
      />

      <div className="sp-filter-tabs" role="tablist" aria-label="项目状态筛选">
        {(['all', 'active', 'paused', 'completed'] as const).map((st) => (
          <button
            key={st}
            type="button"
            role="tab"
            aria-selected={stateFilter === st}
            className={`sp-filter-tab ${stateFilter === st ? 'active' : ''}`}
            onClick={() => setStateFilter(st)}
          >
            {st === 'all' ? '全部' : projectStateLabel(st)}
          </button>
        ))}
      </div>

      {projectsQuery.isLoading && <LoadingState message="正在加载项目…" />}
      {projectsQuery.isError && (
        <ErrorBanner error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
      )}
      {!projectsQuery.isLoading && !projectsQuery.isError && items.length === 0 && (
        <EmptyState
          art="notebook"
          title="还没有项目"
          description="先建立一个你正在持续关注的事情，也可以在收件箱直接开始记录。"
          action={
            <button type="button" className="sp-btn sp-btn--primary" onClick={() => setModalOpen(true)}>
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              <span>新建项目</span>
            </button>
          }
        />
      )}

      {items.length > 0 && (
        <ul className="sp-project-list">
          {items.map((proj) => (
            <li key={proj.id} className="sp-project-row">
              <Link to={`/projects/${proj.id}`} className="sp-project-row-link">
                <span
                  className={`sp-project-tile ${projectToneClass(proj.id)} ${
                    proj.state === 'active' ? '' : 'sp-project-tile--idle'
                  }`}
                  aria-hidden="true"
                >
                  <Folder size={18} strokeWidth={2} />
                </span>
                <div className="sp-project-row-body">
                  <h2 className="sp-project-row-title sp-break-anywhere">{proj.name}</h2>
                  {proj.description && (
                    <p className="sp-project-row-desc sp-break-anywhere">{proj.description}</p>
                  )}
                  <div className="sp-project-meta">
                    <span
                      className={`sp-project-state ${
                        proj.state === 'active' ? 'sp-project-state--active' : ''
                      }`}
                    >
                      {projectStateLabel(proj.state)}
                    </span>
                    {typeof proj.collection_count === 'number' && (
                      <span>{proj.collection_count} 条收藏</span>
                    )}
                  </div>
                </div>
                <ChevronRight size={18} strokeWidth={2} className="sp-project-row-chevron" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {projectsQuery.hasNextPage && (
        <div className="sp-load-more">
          <button
            type="button"
            className="sp-btn"
            disabled={projectsQuery.isFetchingNextPage}
            onClick={() => void projectsQuery.fetchNextPage()}
          >
            加载更多项目
          </button>
        </div>
      )}

      <Modal open={modalOpen} title="新建项目" onClose={() => setModalOpen(false)}>
        <form onSubmit={handleCreateSubmit} className="sp-stack sp-stack--loose">
          {formError && (
            <div className="sp-banner sp-banner--error" role="alert">
              <span>{formError}</span>
            </div>
          )}

          <div className="sp-field">
            <label htmlFor="proj-name" className="sp-label">
              项目名称（必填）
            </label>
            <input
              id="proj-name"
              type="text"
              required
              maxLength={100}
              className="sp-input"
              placeholder="例如：Spark 产品开发"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="proj-desc" className="sp-label">
              项目描述（可选，补充说明有助于自动关联）
            </label>
            <textarea
              id="proj-desc"
              rows={3}
              maxLength={2000}
              className="sp-textarea"
              placeholder="例如：收集个人知识工具的多端同步、搜索交互与离线冲突设计参考"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="sp-field">
            <label htmlFor="proj-focus-input" className="sp-label">
              关注点（最多 20 项）
            </label>
            <div className="sp-input-group">
              <input
                id="proj-focus-input"
                type="text"
                maxLength={100}
                className="sp-input"
                placeholder="例如：多端同步、搜索交互"
                value={focusInput}
                onChange={(e) => setFocusInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addFocusPoint();
                  }
                }}
              />
              <button type="button" className="sp-btn" onClick={addFocusPoint}>
                添加
              </button>
            </div>
            {focusPoints.length > 0 && (
              <div className="sp-composer-chips">
                {focusPoints.map((fp) => (
                  <span key={fp} className="sp-pill sp-pill--green">
                    <span>{fp}</span>
                    <button
                      type="button"
                      className="sp-chip-remove"
                      aria-label={`移除关注点 ${fp}`}
                      onClick={() => setFocusPoints((prev) => prev.filter((x) => x !== fp))}
                    >
                      <X size={12} strokeWidth={2.4} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="sp-form-actions">
            <button type="button" className="sp-btn" onClick={() => setModalOpen(false)}>
              取消
            </button>
            <button
              type="submit"
              className="sp-btn sp-btn--primary"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? '创建中…' : '创建项目'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
