import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, SlidersHorizontal } from 'lucide-react';
import type { Collection } from '../api/types';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { isApiErrorCode } from '../api/errors';
import {
  DEFAULT_SIDEBAR_ITEMS,
  resolveSidebarTags,
  togglePinnedWithMeta,
} from '../lib/sidebarPrefs';
import { SidebarCustomizePopover } from './SidebarCustomizePopover';
import { ErrorBanner } from './StateBlocks';

function useTags(q: string, enabled: boolean) {
  const api = useApi();
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['tags', 'list', user?.id, q], enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listTags({ cursor: pageParam, q, limit: 24 }),
    getNextPageParam: page => page.next_cursor,
  });
}

export function TagNavigation({
  pinnedTagIds,
  pinnedTagMeta,
  onUpdatePinnedTags,
  onOpenAllTags,
  onNavigate,
}: {
  pinnedTagIds: string[] | null;
  pinnedTagMeta?: Record<string, string>;
  onUpdatePinnedTags: (nextIds: string[] | null, nextMeta: Record<string, string>) => void;
  onOpenAllTags: () => void;
  onNavigate?: () => void;
}) {
  const api = useApi();
  const { user } = useAuth();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [popoverSearch, setPopoverSearch] = useState('');
  const customizeBtnRef = useRef<HTMLButtonElement | null>(null);
  const location = useLocation();
  const selected =
    location.pathname === '/collections' && new URLSearchParams(location.search).get('tag_id');

  const tagsQuery = useInfiniteQuery({
    queryKey: ['tags', 'sidebar', user?.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listTags({ cursor: pageParam, limit: 50 }),
    getNextPageParam: (page) => page.next_cursor,
    enabled: Boolean(user),
    staleTime: 30_000,
  });

  const remoteTerm = popoverSearch.trim();
  const remoteSearchQuery = useQuery({
    queryKey: ['tags', 'sidebar-search', user?.id, remoteTerm],
    queryFn: () => api.listTags({ q: remoteTerm, limit: 50 }),
    enabled: Boolean(user) && customizeOpen && Boolean(remoteTerm) && Boolean(tagsQuery.hasNextPage),
    staleTime: 15_000,
  });

  const allTags = useMemo(() => {
    const pages = tagsQuery.data?.pages.flatMap((p) => p.items) ?? [];
    const searched = remoteSearchQuery.data?.items ?? [];
    if (searched.length === 0) return pages;
    const seen = new Set(pages.map((t) => t.id));
    return [...pages, ...searched.filter((t) => !seen.has(t.id))];
  }, [tagsQuery.data, remoteSearchQuery.data]);

  const allTagsLoaded = tagsQuery.isSuccess && !tagsQuery.hasNextPage;
  const { visible, isCustomized, validPinnedIds } = useMemo(
    () =>
      resolveSidebarTags(allTags, pinnedTagIds, DEFAULT_SIDEBAR_ITEMS, {
        meta: pinnedTagMeta,
        allTagsLoaded,
      }),
    [allTags, pinnedTagIds, pinnedTagMeta, allTagsLoaded],
  );
  const validPinnedSet = useMemo(() => new Set(validPinnedIds), [validPinnedIds]);
  const tagMap = useMemo(() => new Map(allTags.map((t) => [t.id, t])), [allTags]);
  const popoverTagItems = useMemo(() => {
    const base = allTags.map((t) => ({
      id: t.id,
      label: `#${t.name}`,
      count: t.collection_count,
      pinned: validPinnedSet.has(t.id),
    }));
    const seen = new Set(allTags.map((t) => t.id));
    for (const id of validPinnedIds) {
      if (!seen.has(id) && pinnedTagMeta?.[id]) {
        base.push({
          id,
          label: `#${pinnedTagMeta[id]}`,
          count: 0,
          pinned: true,
        });
      }
    }
    return base;
  }, [allTags, validPinnedIds, validPinnedSet, pinnedTagMeta]);

  return (
    <div className="sp-sidebar-section sp-tag-nav">
      <div className="sp-sidebar-group-head">
        <span className="sp-sidebar-group-label">标签</span>
        <div className="sp-sidebar-group-actions">
          {allTags.length > 0 && (
            <button
              ref={customizeBtnRef}
              type="button"
              className="sp-icon-btn sp-icon-btn--sm"
              aria-label="自定义置顶标签"
              aria-expanded={customizeOpen}
              title="自定义置顶标签"
              onClick={() => setCustomizeOpen((v) => !v)}
            >
              <SlidersHorizontal size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="sp-sidebar-all-btn"
            aria-label="查看全部标签"
            onClick={onOpenAllTags}
          >
            <span>全部</span>
            <ArrowRight size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>

      <SidebarCustomizePopover
        open={customizeOpen}
        title="自定义置顶标签"
        searchLabel="搜索标签"
        searchPlaceholder="搜索标签…"
        emptyText="没有匹配的标签"
        items={popoverTagItems}
        isCustomized={isCustomized}
        hasMore={Boolean(tagsQuery.hasNextPage)}
        isLoadingMore={tagsQuery.isFetchingNextPage}
        onLoadMore={() => void tagsQuery.fetchNextPage()}
        onQueryChange={setPopoverSearch}
        onTogglePin={(id) => {
          const name = tagMap.get(id)?.name ?? pinnedTagMeta?.[id] ?? '';
          const next = togglePinnedWithMeta(pinnedTagIds, pinnedTagMeta, id, name);
          onUpdatePinnedTags(next.ids, next.meta);
        }}
        onReset={() => onUpdatePinnedTags(null, {})}
        onClose={() => setCustomizeOpen(false)}
        anchorRef={customizeBtnRef}
      />

      {tagsQuery.isError && (
        <ErrorBanner error={tagsQuery.error} onRetry={() => void tagsQuery.refetch()} />
      )}

      {visible.length > 0 ? (
        <nav aria-label="按标签查看收藏" className="sp-sidebar-tags-wrap">
          {visible.map((t) => (
            <Link
              key={t.id}
              className={`sp-sidebar-tag-chip ${selected === t.id ? 'active' : ''}`}
              aria-current={selected === t.id ? 'page' : undefined}
              to={`/collections?tag_id=${encodeURIComponent(t.id)}`}
              state={{ tagName: t.name }}
              title={`#${t.name}（${t.collection_count} 条）`}
              onClick={onNavigate}
            >
              <span className="sp-truncate">#{t.name}</span>
            </Link>
          ))}
        </nav>
      ) : (
        tagsQuery.isSuccess && (
          <p className="sp-sidebar-empty-hint">输入 # 创建标签</p>
        )
      )}
    </div>
  );
}

export function CollectionTags({ collection }: { collection: Collection }) {
  const api = useApi();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const tags = useTags(q, editing);
  const effective = collection.tags.filter(t => t.decision !== 'rejected');
  const update = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'include' | 'exclude' }) => api.updateTagDecisions(collection.id, {
      base_decision_version: collection.decision_version, operations: [{ id, action }],
    }),
    onSuccess: updated => {
      client.setQueryData(['collection', collection.id], updated);
      for (const prefix of ['collections', 'tags', 'project-collections']) void client.invalidateQueries({ queryKey: [prefix] });
    },
    onError: error => {
      if (isApiErrorCode(error, 'decision_conflict')) void client.invalidateQueries({ queryKey: ['collection', collection.id] });
    },
  });
  return <section className="sp-section" aria-label="收藏标签">
    <div className="sp-section-head"><h2 className="sp-section-title">标签</h2>
      {!collection.deleted_at && <button type="button" className="sp-btn--quiet" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? '收起标签' : '管理标签'}</button>}
    </div>
    <div className="sp-row">
      {effective.map(t => <Link className="sp-tag" key={t.tag_id} to={`/collections?tag_id=${t.tag_id}`} state={{ tagName: t.path }}>#{t.path}</Link>)}
      {!effective.length && <span className="sp-help">暂无标签</span>}
    </div>
    {editing && !collection.deleted_at && <div className="sp-stack">
      <input className="sp-input" aria-label="查找标签" placeholder="查找标签" value={q} onChange={e => setQ(e.target.value)} />
      {tags.isLoading && <p role="status">正在查找…</p>}
      {tags.isError && <ErrorBanner error={tags.error} onRetry={() => void tags.refetch()} />}
      {tags.data?.pages[0].items.length === 0 && <p className="sp-help">没有匹配的标签</p>}
      <div className="sp-row">{tags.data?.pages.flatMap(page => page.items).map(t => {
        const active = effective.some(a => a.tag_id === t.id);
        return <button className="sp-btn sp-btn--sm" key={t.id} disabled={update.isPending} aria-pressed={active}
          onClick={() => update.mutate({ id: t.id, action: active ? 'exclude' : 'include' })}>#{t.name}</button>;
      })}</div>
      {tags.hasNextPage && <button className="sp-btn--quiet" disabled={tags.isFetchingNextPage} onClick={() => void tags.fetchNextPage()}>更多标签</button>}
      {update.isError && <ErrorBanner error={update.error} />}
    </div>}
  </section>;
}
