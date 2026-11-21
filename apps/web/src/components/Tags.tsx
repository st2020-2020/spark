import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Collection } from '../api/types';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { isApiErrorCode } from '../api/errors';
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

export function TagNavigation() {
  const [open, setOpen] = useState(false);
  const tags = useTags('', open);
  const location = useLocation();
  const selected = location.pathname === '/collections' && new URLSearchParams(location.search).get('tag_id');
  return <div className="sp-tag-nav">
    <button type="button" className="sp-nav-link" aria-expanded={open} onClick={() => setOpen(!open)}>标签 {open ? '▴' : '▾'}</button>
    {open && <nav aria-label="按标签查看收藏">
      {tags.isLoading && <p className="sp-help">正在加载标签…</p>}
      {tags.isError && <ErrorBanner error={tags.error} onRetry={() => void tags.refetch()} />}
      {tags.data?.pages[0].items.length === 0 && <p className="sp-help">暂无标签，可在收集时输入 # 新建。</p>}
      {tags.data?.pages.flatMap(p => p.items).map(t => <Link key={t.id}
        className={`sp-nav-link ${selected === t.id ? 'active' : ''}`}
        aria-current={selected === t.id ? 'page' : undefined}
        to={`/collections?tag_id=${encodeURIComponent(t.id)}`} state={{ tagName: t.name }}>
        <span className="sp-truncate">#{t.name}</span><small>{t.collection_count}</small>
      </Link>)}
      {tags.hasNextPage && <button className="sp-btn--quiet" disabled={tags.isFetchingNextPage} onClick={() => void tags.fetchNextPage()}>更多标签</button>}
    </nav>}
  </div>;
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
