import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { SlidersHorizontal } from 'lucide-react';
import type { CollectionType } from '../api/types';
import { CollectionCard } from '../components/CollectionCard';
import { CollectionComposer } from '../components/CollectionComposer';
import { PageHeader } from '../components/PageHeader';
import { PendingSuggestionsBanner } from '../components/PendingSuggestionsBanner';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';

export function InboxPage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showSecondaryFilter, setShowSecondaryFilter] = useState(
    Boolean(searchParams.get('type')),
  );

  const unreadOnly = searchParams.get('read') === 'false';
  const typeFilter = (searchParams.get('type') as CollectionType | null) ?? undefined;
  const shouldFocusComposer = searchParams.get('focus') === 'composer';

  const collectionsQuery = useInfiniteQuery({
    queryKey: ['collections', 'inbox', { unreadOnly, typeFilter }],
    queryFn: ({ pageParam, signal }) =>
      api.listCollections(
        {
          scope: 'active',
          read: unreadOnly ? false : undefined,
          type: typeFilter,
          cursor: pageParam,
          limit: 30,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
  });

  const items = collectionsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  const updateFilter = (next: { unreadOnly?: boolean; type?: CollectionType | '' }) => {
    const params = new URLSearchParams(searchParams);
    params.delete('focus');
    if (next.unreadOnly !== undefined) {
      if (next.unreadOnly) params.set('read', 'false');
      else params.delete('read');
    }
    if (next.type !== undefined) {
      if (next.type) params.set('type', next.type);
      else params.delete('type');
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <div>
      <PageHeader title="收件箱" />

      <CollectionComposer autoFocus={shouldFocusComposer} />

      <PendingSuggestionsBanner />

      <div className="sp-filter-tabs" aria-label="收件箱筛选">
        <button
          type="button"
          className={`sp-filter-tab ${!unreadOnly ? 'active' : ''}`}
          aria-pressed={!unreadOnly}
          onClick={() => updateFilter({ unreadOnly: false })}
        >
          全部
        </button>
        <button
          type="button"
          className={`sp-filter-tab ${unreadOnly ? 'active' : ''}`}
          aria-pressed={unreadOnly}
          onClick={() => updateFilter({ unreadOnly: true })}
        >
          未读
        </button>
        <button
          type="button"
          className="sp-btn--quiet sp-btn--icon"
          style={{ marginLeft: 'auto' }}
          aria-label="展开类型筛选"
          aria-expanded={showSecondaryFilter}
          onClick={() => setShowSecondaryFilter((v) => !v)}
        >
          <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {showSecondaryFilter && (
        <div className="sp-row" style={{ marginBottom: 14 }}>
          <label htmlFor="inbox-type-filter" className="sp-help">
            内容类型
          </label>
          <select
            id="inbox-type-filter"
            className="sp-select"
            value={typeFilter ?? ''}
            onChange={(e) => updateFilter({ type: e.target.value as CollectionType | '' })}
            style={{ width: 'auto', padding: '5px 10px', fontSize: 13 }}
          >
            <option value="">全部</option>
            <option value="text">文字</option>
            <option value="url">网址</option>
          </select>
          {typeFilter && (
            <button
              type="button"
              className="sp-btn--quiet sp-btn--sm"
              onClick={() => updateFilter({ type: '' })}
            >
              清除
            </button>
          )}
        </div>
      )}

      {collectionsQuery.isLoading && <LoadingState message="正在加载收件箱…" />}
      {collectionsQuery.isError && (
        <ErrorBanner
          error={collectionsQuery.error}
          onRetry={() => void collectionsQuery.refetch()}
        />
      )}
      {!collectionsQuery.isLoading &&
        !collectionsQuery.isError &&
        items.length === 0 &&
        (unreadOnly || typeFilter ? (
          <EmptyState
            title="当前筛选下没有收藏"
            description="可以切换回全部，或先在上方记下新的内容。"
            action={
              <button
                type="button"
                className="sp-btn"
                onClick={() => updateFilter({ unreadOnly: false, type: '' })}
              >
                清除筛选
              </button>
            }
          />
        ) : (
          <div className="sp-inbox-empty">
            <p className="sp-inbox-empty-title">保存的内容会出现在这里。</p>
            <p className="sp-inbox-empty-hint">先记下来，项目可以稍后再选。</p>
          </div>
        ))}

      <div className="sp-stack">
        {items.map((col) => (
          <CollectionCard key={col.id} collection={col} />
        ))}
      </div>

      {collectionsQuery.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            type="button"
            className="sp-btn"
            disabled={collectionsQuery.isFetchingNextPage}
            onClick={() => void collectionsQuery.fetchNextPage()}
          >
            {collectionsQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
