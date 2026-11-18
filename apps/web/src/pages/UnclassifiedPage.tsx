import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FolderPlus, X } from 'lucide-react';
import type { CollectionSummary } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import { CollectionCard } from '../components/CollectionCard';
import { PageHeader } from '../components/PageHeader';
import { ProjectSuggestionEvidence } from '../components/ProjectSuggestionEvidence';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';

export function UnclassifiedPage() {
  const api = useApi();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [selectedProjectByCol, setSelectedProjectByCol] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const unclassifiedQuery = useInfiniteQuery({
    queryKey: ['collections', 'unclassified'],
    queryFn: ({ pageParam, signal }) =>
      api.listCollections({ scope: 'unclassified', cursor: pageParam, limit: 30 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const projectsQuery = useQuery({
    queryKey: ['projects', 'all-for-select'],
    queryFn: () => api.listProjects({ limit: 100 }),
  });

  const decideMutation = useMutation({
    mutationFn: async (params: {
      collectionId: string;
      projectId: string;
      action: 'include' | 'exclude';
    }) => {
      const fresh = await api.getCollection(params.collectionId);
      return api.updateProjectDecisions(params.collectionId, {
        base_decision_version: fresh.decision_version,
        operations: [{ id: params.projectId, action: params.action }],
      });
    },
    onSuccess: (_res, vars) => {
      setActionError(null);
      pushToast({
        message: vars.action === 'include' ? '已归入项目' : '已忽略建议关联',
      });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => {
      setActionError(getFriendlyErrorMessage(err));
    },
  });

  const items = unclassifiedQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const projects = projectsQuery.data?.items ?? [];

  const renderQuickClassify = (col: CollectionSummary) => {
    const suggested = col.projects.filter((p) => p.decision === 'suggested');
    const chosenId = selectedProjectByCol[col.id] ?? '';

    if (suggested.length === 0 && projects.length === 0) return null;

    return (
      <div
        className="sp-stack"
        style={{
          gap: 8,
          marginTop: 6,
          padding: '10px 14px',
          background: 'var(--sp-surface)',
          border: '1px solid var(--sp-border)',
          borderRadius: 'var(--sp-radius-card)',
        }}
      >
        {suggested.map((sug) => (
          <div key={sug.project_id} className="sp-suggestion-card sp-suggestion-card--highlighted">
            <div className="sp-row-between">
              <div className="sp-row">
                <span className="sp-pill sp-pill--green">AI 建议</span>
                <strong className="sp-break-anywhere" style={{ fontSize: 13 }}>
                  建议归入：{sug.name}
                </strong>
              </div>
              <div className="sp-row">
                <button
                  type="button"
                  className="sp-btn sp-btn--sm sp-btn--primary"
                  disabled={decideMutation.isPending}
                  onClick={() =>
                    decideMutation.mutate({
                      collectionId: col.id,
                      projectId: sug.project_id,
                      action: 'include',
                    })
                  }
                >
                  <Check size={13} strokeWidth={2} aria-hidden="true" />
                  <span>加入项目</span>
                </button>
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  disabled={decideMutation.isPending}
                  onClick={() =>
                    decideMutation.mutate({
                      collectionId: col.id,
                      projectId: sug.project_id,
                      action: 'exclude',
                    })
                  }
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                  <span>忽略</span>
                </button>
              </div>
            </div>
            <ProjectSuggestionEvidence association={sug} />
          </div>
        ))}

        {projects.length > 0 && (
          <div className="sp-row">
            <select
              aria-label={`为「${col.display_title}」选择项目`}
              className="sp-select"
              value={chosenId}
              onChange={(e) =>
                setSelectedProjectByCol((prev) => ({ ...prev, [col.id]: e.target.value }))
              }
              style={{ flex: 1, minWidth: 160, padding: '6px 10px', fontSize: 13 }}
            >
              <option value="">选择要关联的项目…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--primary"
              disabled={!chosenId || decideMutation.isPending}
              onClick={() =>
                decideMutation.mutate({
                  collectionId: col.id,
                  projectId: chosenId,
                  action: 'include',
                })
              }
            >
              确认关联
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="待归类"
        actions={
          <Link to="/projects" className="sp-btn--quiet">
            <FolderPlus size={16} strokeWidth={2} aria-hidden="true" />
            <span>管理项目</span>
          </Link>
        }
      />

      {projects.length === 0 && !projectsQuery.isLoading && (
        <div className="sp-banner sp-banner--info" style={{ marginBottom: 14 }}>
          <span>
            还没有项目，尚未归类的资料会暂时保留在这里。随时可以去{' '}
            <Link to="/projects" style={{ fontWeight: 500 }}>
              新建项目
            </Link>
            。
          </span>
        </div>
      )}

      {actionError && (
        <div className="sp-banner sp-banner--error" style={{ marginBottom: 14 }} role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {unclassifiedQuery.isLoading && <LoadingState message="正在加载待归类资料…" />}
      {unclassifiedQuery.isError && (
        <ErrorBanner
          error={unclassifiedQuery.error}
          onRetry={() => void unclassifiedQuery.refetch()}
        />
      )}
      {!unclassifiedQuery.isLoading && !unclassifiedQuery.isError && items.length === 0 && (
        <EmptyState
          title="没有待归类的收藏"
          description="所有有效收藏都已经关联到项目了。"
          action={
            <Link to="/inbox" className="sp-btn sp-btn--primary">
              返回收件箱
            </Link>
          }
        />
      )}

      <div className="sp-stack" style={{ gap: 16 }}>
        {items.map((col) => (
          <div key={col.id}>
            <CollectionCard collection={col} />
            {renderQuickClassify(col)}
          </div>
        ))}
      </div>

      {unclassifiedQuery.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            type="button"
            className="sp-btn"
            disabled={unclassifiedQuery.isFetchingNextPage}
            onClick={() => void unclassifiedQuery.fetchNextPage()}
          >
            加载更多
          </button>
        </div>
      )}
    </div>
  );
}
