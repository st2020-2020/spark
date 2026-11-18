import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import type { CollectionType } from '../api/types';
import { CollectionCard } from '../components/CollectionCard';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';

export function CollectionsPage() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  const urlQ = searchParams.get('q') ?? '';
  const projectId = searchParams.get('project_id') ?? '';
  const typeFilter = (searchParams.get('type') as CollectionType | null) ?? '';
  const readFilter = searchParams.get('read') ?? '';
  const shouldAutoFocusSearch = searchParams.get('focus') === 'search';

  const [inputQ, setInputQ] = useState(urlQ);
  const [debouncedQ, setDebouncedQ] = useState(urlQ.trim());
  const [filtersOpen, setFiltersOpen] = useState(Boolean(projectId || typeFilter || readFilter));

  useEffect(() => {
    setInputQ(urlQ);
    setDebouncedQ(urlQ.trim());
  }, [urlQ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextTrimmed = inputQ.trim();
      setDebouncedQ(nextTrimmed);
      const currentUrlQ = (searchParams.get('q') ?? '').trim();
      if (nextTrimmed !== currentUrlQ) {
        const nextParams = new URLSearchParams(searchParams);
        if (nextTrimmed) nextParams.set('q', nextTrimmed);
        else nextParams.delete('q');
        setSearchParams(nextParams, { replace: true });
      }
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputQ]);

  const projectsQuery = useQuery({
    queryKey: ['projects', 'all-for-select'],
    queryFn: () => api.listProjects({ limit: 100 }),
  });

  const listOrSearchQuery = useInfiniteQuery({
    queryKey: ['collections', 'all', { q: debouncedQ, projectId, typeFilter, readFilter }],
    queryFn: async ({ pageParam, signal }) => {
      const readVal = readFilter === 'false' ? false : readFilter === 'true' ? true : undefined;
      if (debouncedQ) {
        const res = await api.searchCollections(
          {
            q: debouncedQ,
            project_id: projectId || undefined,
            type: typeFilter || undefined,
            read: readVal,
            scope: 'active',
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
          project_id: projectId || undefined,
          type: typeFilter || undefined,
          read: readVal,
          scope: 'active',
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
  });

  const setFilterParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const clearAllFilters = () => {
    setInputQ('');
    setDebouncedQ('');
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const projects = projectsQuery.data?.items ?? [];
  const activeProjectName = projects.find((p) => p.id === projectId)?.name;
  const hasFilters = Boolean(debouncedQ || projectId || typeFilter || readFilter);
  const hits = listOrSearchQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader
        title="全部收藏"
        searchAlwaysVisible
        searchValue={inputQ}
        onSearchChange={setInputQ}
        onSearchSubmit={(trimmed) => {
          setDebouncedQ(trimmed);
          setFilterParam('q', trimmed);
        }}
        onSearchClear={() => {
          setInputQ('');
          setDebouncedQ('');
          setFilterParam('q', '');
        }}
        searchPlaceholder="搜索文字或网址…"
        autoFocusSearch={shouldAutoFocusSearch}
        actions={
          <button
            type="button"
            className="sp-btn--quiet"
            aria-expanded={filtersOpen}
            aria-pressed={Boolean(projectId || typeFilter || readFilter)}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <SlidersHorizontal size={16} strokeWidth={2} aria-hidden="true" />
            <span>筛选</span>
          </button>
        }
      />

      {filtersOpen && (
        <div className="sp-row" style={{ marginBottom: 14 }}>
          <select
            aria-label="按项目筛选"
            className="sp-select sp-select--compact"
            value={projectId}
            onChange={(e) => setFilterParam('project_id', e.target.value)}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <select
            aria-label="按类型筛选"
            className="sp-select sp-select--compact"
            value={typeFilter}
            onChange={(e) => setFilterParam('type', e.target.value)}
          >
            <option value="">全部类型</option>
            <option value="text">文字</option>
            <option value="url">网址</option>
          </select>

          <select
            aria-label="按阅读状态筛选"
            className="sp-select sp-select--compact"
            value={readFilter}
            onChange={(e) => setFilterParam('read', e.target.value)}
          >
            <option value="">全部阅读状态</option>
            <option value="false">未读</option>
            <option value="true">已读</option>
          </select>
        </div>
      )}

      {(projectId || typeFilter || readFilter) && (
        <div className="sp-row" style={{ marginBottom: 14 }}>
          {projectId && (
            <span className="sp-pill sp-pill--green">
              项目：{activeProjectName ?? '已选项目'}
              <button
                type="button"
                aria-label="清除项目筛选"
                onClick={() => setFilterParam('project_id', '')}
                style={{ padding: '0 2px' }}
              >
                ×
              </button>
            </span>
          )}
          {typeFilter && (
            <span className="sp-pill sp-pill--green">
              类型：{typeFilter === 'text' ? '文字' : typeFilter === 'url' ? '网址' : '图片'}
              <button
                type="button"
                aria-label="清除类型筛选"
                onClick={() => setFilterParam('type', '')}
                style={{ padding: '0 2px' }}
              >
                ×
              </button>
            </span>
          )}
          {readFilter && (
            <span className="sp-pill sp-pill--green">
              {readFilter === 'false' ? '未读' : '已读'}
              <button
                type="button"
                aria-label="清除阅读状态筛选"
                onClick={() => setFilterParam('read', '')}
                style={{ padding: '0 2px' }}
              >
                ×
              </button>
            </span>
          )}
          <button type="button" className="sp-btn--quiet sp-btn--sm" onClick={clearAllFilters}>
            全部清除
          </button>
        </div>
      )}

      {debouncedQ && !listOrSearchQuery.isLoading && !listOrSearchQuery.isError && (
        <div className="sp-help" style={{ marginBottom: 12 }} role="status">
          {listOrSearchQuery.hasNextPage
            ? `搜索「${debouncedQ}」结果：已加载 ${hits.length} 条（可继续加载更多）`
            : `搜索「${debouncedQ}」结果：共 ${hits.length} 条`}
        </div>
      )}

      {listOrSearchQuery.isLoading && <LoadingState message="正在检索收藏…" />}
      {listOrSearchQuery.isError && (
        <ErrorBanner
          error={listOrSearchQuery.error}
          onRetry={() => void listOrSearchQuery.refetch()}
        />
      )}

      {!listOrSearchQuery.isLoading && !listOrSearchQuery.isError && hits.length === 0 && (
        <EmptyState
          title={hasFilters ? '没有找到相关收藏' : '还没有任何收藏'}
          description={
            hasFilters
              ? '换一个关键词试试，或清除筛选条件后查看。'
              : '去收件箱记下你的第一条资料。'
          }
          action={
            <div className="sp-row" style={{ justifyContent: 'center' }}>
              {hasFilters && (
                <button type="button" className="sp-btn" onClick={clearAllFilters}>
                  清除筛选
                </button>
              )}
              <Link to="/unclassified" className="sp-btn">
                查看待归类
              </Link>
              <Link to="/inbox" className="sp-btn sp-btn--primary">
                去收件箱
              </Link>
            </div>
          }
        />
      )}

      <div className="sp-stack">
        {hits.map((hit) => (
          <CollectionCard
            key={hit.collection.id}
            collection={hit.collection}
            snippets={hit.snippets}
            searchQuery={debouncedQ}
          />
        ))}
      </div>

      {listOrSearchQuery.hasNextPage && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button
            type="button"
            className="sp-btn"
            disabled={listOrSearchQuery.isFetchingNextPage}
            onClick={() => void listOrSearchQuery.fetchNextPage()}
          >
            {listOrSearchQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
