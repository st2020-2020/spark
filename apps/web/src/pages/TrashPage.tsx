import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import type { CollectionSummary } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { formatDateTime } from '../lib/format';

export function TrashPage() {
  const api = useApi();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const trashQuery = useInfiniteQuery({
    queryKey: ['collections', 'trash'],
    queryFn: ({ pageParam, signal }) =>
      api.listCollections({ scope: 'trash', cursor: pageParam, limit: 30 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const restoreMutation = useMutation({
    mutationFn: (col: CollectionSummary) =>
      api.restoreCollection(col.id, { base_resource_version: col.resource_version }),
    onSuccess: () => {
      setActionError(null);
      pushToast({ message: '已恢复到收件箱' });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => setActionError(getFriendlyErrorMessage(err)),
  });

  const items = trashQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader
        title="回收站"
        subtitle="保留期 30 天内可随时恢复；永久删除能力暂未开放"
      />

      {actionError && (
        <div className="sp-banner sp-banner--error sp-spaced" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {trashQuery.isLoading && <LoadingState message="正在加载回收站…" />}
      {trashQuery.isError && (
        <ErrorBanner error={trashQuery.error} onRetry={() => void trashQuery.refetch()} />
      )}
      {!trashQuery.isLoading && !trashQuery.isError && items.length === 0 && (
        <EmptyState title="回收站是空的" description="移入回收站的收藏会暂时保留在这里。" />
      )}

      <div className="sp-note-list">
        {items.map((col) => (
          <article key={col.id} className="sp-note">
            <div className="sp-note-meta">
              <time dateTime={col.updated_at}>删除/更新于 {formatDateTime(col.updated_at)}</time>
            </div>
            {col.excerpt && <p className="sp-note-body sp-note-body--clamped">{col.excerpt}</p>}
            <div className="sp-note-footer">
              <Link to={`/collections/${col.id}`} state={{ from: '/trash' }} className="sp-help">
                查看详情
              </Link>
              <button
                type="button"
                className="sp-btn sp-btn--sm sp-note-footer-action"
                disabled={restoreMutation.isPending}
                onClick={() => restoreMutation.mutate(col)}
              >
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                <span>恢复</span>
              </button>
            </div>
          </article>
        ))}
      </div>

      {trashQuery.hasNextPage && (
        <div className="sp-load-more">
          <button
            type="button"
            className="sp-btn"
            disabled={trashQuery.isFetchingNextPage}
            onClick={() => void trashQuery.fetchNextPage()}
          >
            加载更多
          </button>
        </div>
      )}
    </div>
  );
}
