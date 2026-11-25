import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { GitCommitHorizontal, MessageSquarePlus } from 'lucide-react';
import type { Collection, CollectionThreadItem } from '../api/types';
import { useApi } from '../context/ApiContext';
import { useFollowUp } from '../context/FollowUpContext';
import { formatDateTime } from '../lib/format';
import { toFollowUpSourceFromCollection } from '../lib/followUp';
import { CollectionLink } from './CollectionLink';
import { ErrorBanner, LoadingState } from './StateBlocks';

export function CollectionThreadTimeline({
  collection,
}: {
  collection: Collection;
}) {
  const api = useApi();
  const location = useLocation();
  const { openFollowUp } = useFollowUp();
  const isInTrash = Boolean(collection.deleted_at);
  const hasKnownThread =
    (collection.follow_up_count ?? 0) > 0 || Boolean(collection.source_collection_id);

  const threadQuery = useInfiniteQuery({
    queryKey: ['collection-thread', collection.id],
    queryFn: ({ pageParam, signal }) =>
      api.getCollectionThread(collection.id, { limit: 20, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled: Boolean(collection.id) && !isInTrash,
    retry: false,
  });

  const items = useMemo(() => {
    const pages = threadQuery.data?.pages ?? [];
    const seen = new Set<string>();
    const merged: CollectionThreadItem[] = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          merged.push(item);
        }
      }
    }
    return merged;
  }, [threadQuery.data?.pages]);

  if (isInTrash) {
    return null;
  }

  const hasCurrentInLoaded = items.some((item) => item.id === collection.id);
  const shouldShow =
    hasKnownThread || items.length > 1 || Boolean(threadQuery.hasNextPage);

  if (threadQuery.isLoading) {
    if (!hasKnownThread) return null;
    return (
      <section id="follow-up-thread" tabIndex={-1} className="sp-section" aria-label="续写线索">
        <div className="sp-section-head">
          <h2 className="sp-section-title">续写线索</h2>
        </div>
        <LoadingState message="正在加载续写线索…" />
      </section>
    );
  }

  if (threadQuery.isError && items.length === 0) {
    if (!hasKnownThread) return null;
    return (
      <section id="follow-up-thread" tabIndex={-1} className="sp-section" aria-label="续写线索">
        <div className="sp-section-head">
          <h2 className="sp-section-title">续写线索</h2>
        </div>
        <ErrorBanner error={threadQuery.error} onRetry={() => void threadQuery.refetch()} />
      </section>
    );
  }

  if (!shouldShow) {
    return null;
  }

  const totalCountHint =
    collection.follow_up_count !== undefined && collection.follow_up_count >= 0
      ? `可查看 ${collection.follow_up_count + 1} 条`
      : undefined;

  return (
    <section id="follow-up-thread" tabIndex={-1} className="sp-section" aria-label="续写线索">
      <div className="sp-section-head">
        <div className="sp-row">
          <h2 className="sp-section-title sp-thread-heading">
            <GitCommitHorizontal size={16} strokeWidth={2} aria-hidden="true" />
            <span>续写线索</span>
          </h2>
          {totalCountHint && <span className="sp-section-note">{totalCountHint}</span>}
        </div>
        <button
          type="button"
          className="sp-btn sp-btn--sm"
          onClick={() => openFollowUp(toFollowUpSourceFromCollection(collection))}
        >
          <MessageSquarePlus size={14} strokeWidth={2} aria-hidden="true" />
          <span>续写</span>
        </button>
      </div>

      <ol className="sp-thread-list">
        {items.map((item) => {
          if (item.status === 'deleted') {
            return (
              <li key={item.id} className="sp-thread-item sp-thread-item--deleted">
                <span className="sp-thread-dot" aria-hidden="true" />
                <div className="sp-thread-body">
                  <span className="sp-thread-deleted">有一条已删除</span>
                </div>
              </li>
            );
          }

          const isCurrent = item.id === collection.id;
          const isSource = Boolean(
            collection.source_collection_id && item.id === collection.source_collection_id,
          );
          const titleText =
            item.display_title?.trim() || (isCurrent ? collection.display_title : '未命名收藏');

          return (
            <li
              key={item.id}
              className={`sp-thread-item ${isCurrent ? 'sp-thread-item--current' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="sp-thread-dot" aria-hidden="true" />
              <div className="sp-thread-body">
                <div className="sp-thread-meta">
                  <time className="sp-tabular" dateTime={item.created_at}>
                    {formatDateTime(item.created_at)}
                  </time>
                  {isCurrent && <span className="sp-pill sp-pill--green">当前</span>}
                  {isSource && !isCurrent && <span className="sp-pill">来源</span>}
                </div>
                {isCurrent ? (
                  <span className="sp-thread-current-title sp-break-anywhere">{titleText}</span>
                ) : (
                  <CollectionLink
                    id={item.id}
                    state={{ from: `${location.pathname}${location.search}` }}
                    className="sp-thread-link sp-break-anywhere"
                  >
                    {titleText}
                  </CollectionLink>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {!hasCurrentInLoaded && threadQuery.hasNextPage && (
        <p className="sp-help sp-thread-more-hint">当前笔记位于更靠后的位置，可继续加载查看。</p>
      )}

      {(threadQuery.isFetchNextPageError || threadQuery.isError) && (
        <div className="sp-thread-more">
          <ErrorBanner
            error={threadQuery.error}
            onRetry={() =>
              void (threadQuery.isFetchNextPageError
                ? threadQuery.fetchNextPage()
                : threadQuery.refetch())
            }
          />
        </div>
      )}

      {threadQuery.hasNextPage && !threadQuery.isFetchNextPageError && (
        <div className="sp-thread-more">
          <button
            type="button"
            className="sp-btn sp-btn--sm"
            disabled={threadQuery.isFetchingNextPage}
            onClick={() => void threadQuery.fetchNextPage()}
          >
            {threadQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </section>
  );
}
