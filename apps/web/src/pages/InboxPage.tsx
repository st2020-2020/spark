import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { CollectionType } from '../api/types';
import { CollectionCard } from '../components/CollectionCard';
import { CollectionComposer } from '../components/CollectionComposer';
import { PageHeader } from '../components/PageHeader';
import { PendingSuggestionsBanner } from '../components/PendingSuggestionsBanner';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { JarScene } from '../components/Illustrations';
import { useApi } from '../context/ApiContext';
import { greeting, groupByDay, todayLine } from '../lib/journal';

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
  const hasUnclassifiedInLoaded = useMemo(
    () =>
      items.some(
        (c) =>
          !c.projects.some(
            (p) => p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto',
          ),
      ),
    [items],
  );
  const dayGroups = useMemo(() => groupByDay(items, (c) => c.created_at), [items]);
  const headerLine = `${greeting()}，${todayLine()}`;

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
      <PageHeader title="收件箱" subtitle={headerLine} />

      <CollectionComposer autoFocus={shouldFocusComposer} />

      <PendingSuggestionsBanner />

      <div className="sp-filter-bar">
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
        </div>
        <button
          type="button"
          className="sp-btn--quiet sp-btn--icon sp-note-footer-action"
          aria-label="展开类型筛选"
          aria-expanded={showSecondaryFilter}
          onClick={() => setShowSecondaryFilter((v) => !v)}
        >
          <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {showSecondaryFilter && (
        <div className="sp-filter-panel">
          <label htmlFor="inbox-type-filter" className="sp-filter-panel-label">
            内容类型
          </label>
          <select
            id="inbox-type-filter"
            className="sp-select sp-select--compact"
            value={typeFilter ?? ''}
            onChange={(e) => updateFilter({ type: e.target.value as CollectionType | '' })}
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

      {!collectionsQuery.isLoading && !collectionsQuery.isError && hasUnclassifiedInLoaded && (
        <div className="sp-triage-hint-bar">
          <Link to="/unclassified/triage" className="sp-triage-hint">
            <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
            <span>有待归类的收藏，开始整理</span>
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </Link>
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
            <JarScene className="sp-inbox-empty-art" />
            <p className="sp-inbox-empty-title">保存的内容会出现在这里。</p>
            <p className="sp-inbox-empty-hint">先记下来，项目可以稍后再选。</p>
          </div>
        ))}

      <div className="sp-journal">
        {dayGroups.map((group) => (
          <section key={group.stamp.key} className="sp-day">
            <h2
              className={`sp-day-stamp ${group.stamp.relative === '今天' ? 'sp-day-stamp--today' : ''}`}
              aria-label={group.stamp.label}
            >
              <span className="sp-day-top" aria-hidden="true">
                {group.stamp.relative || group.stamp.month}
              </span>
              <span className="sp-day-num" aria-hidden="true">
                {group.stamp.day}
              </span>
              <span className="sp-day-week" aria-hidden="true">
                {group.stamp.weekday}
              </span>
            </h2>
            <div className="sp-note-list">
              {group.items.map((col) => (
                <CollectionCard key={col.id} collection={col} timeStyle="clock" />
              ))}
            </div>
          </section>
        ))}
      </div>

      {collectionsQuery.hasNextPage && (
        <div className="sp-load-more">
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
