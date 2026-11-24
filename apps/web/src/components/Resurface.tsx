import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ApiError, getFriendlyErrorMessage } from '../api/errors';
import type { ResurfaceResult } from '../api/types';
import { canAnimateMotion } from '../lib/motion';
import { useLocalCalendar, useResurfacePreferences } from '../lib/revisit';
import { CollectionLink } from './CollectionLink';
import { ErrorBanner } from './StateBlocks';

export function ResurfaceSetting() {
  const api = useApi();
  const { user } = useAuth();
  const client = useQueryClient();
  const prefs = useResurfacePreferences();
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setResurfacePreferences({ enabled }),
    onSuccess: async data => {
      await client.cancelQueries({ queryKey: ['resurface-preferences', user?.id] });
      client.setQueryData(['resurface-preferences', user?.id], data);
      client.removeQueries({ queryKey: ['collections', 'resurface', user?.id] });
    },
  });
  return (
    <section className="sp-card" aria-label="回访偏好">
      <h2 className="sp-card-title">今日重现</h2>
      {prefs.isPending && <p role="status" className="sp-help">正在读取回访偏好…</p>}
      {prefs.isError && <ErrorBanner error={prefs.error} onRetry={() => void prefs.refetch()} />}
      {prefs.data && <label className="sp-revisit-setting">
          <input type="checkbox" checked={prefs.data?.enabled ?? false} disabled={save.isPending}
            onChange={e => save.mutate(e.target.checked)} />
          在收件箱显示值得回看的收藏
        </label>}
      {save.isError && <ErrorBanner error={save.error} />}
    </section>
  );
}

export function Resurface() {
  const api = useApi();
  const { user } = useAuth();
  const client = useQueryClient();
  const { pushToast } = useToast();
  const { pathname, search } = useLocation();
  const { tz, today } = useLocalCalendar();
  const prefs = useResurfacePreferences();
  const key = ['collections', 'resurface', user?.id, tz, today];
  const [exitingItems, setExitingItems] = useState<Array<{
    date: string;
    index: number;
    entry: ResurfaceResult['items'][number];
  }>>([]);
  const hideTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const timers = hideTimersRef.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);
  const result = useQuery({
    queryKey: key, queryFn: ({ signal }) => api.getResurface(tz, signal),
    enabled: !prefs.isFetching && prefs.data?.enabled === true,
  });
  const hide = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) => api.hideResurfaceItem(id, date, tz),
    onSuccess: async (_, { id, date }) => {
      await client.cancelQueries({ queryKey: key });
      const prev = client.getQueryData<ResurfaceResult>(key);
      const hiddenIndex =
        prev?.date === date ? prev.items.findIndex(item => item.collection.id === id) : -1;
      const hiddenEntry = hiddenIndex >= 0 ? prev?.items[hiddenIndex] : undefined;

      client.setQueryData<ResurfaceResult>(key, old => old?.date === date
        ? { ...old, items: old.items.filter(item => item.collection.id !== id) } : old);
      pushToast({ message: '今天先收起这条回看' });

      if (canAnimateMotion() && hiddenEntry) {
        setExitingItems(current => [
          ...current.filter(item => item.entry.collection.id !== id),
          { date, index: hiddenIndex, entry: hiddenEntry },
        ]);
        const prevTimer = hideTimersRef.current.get(id);
        if (prevTimer !== undefined) window.clearTimeout(prevTimer);
        const timer = window.setTimeout(() => {
          hideTimersRef.current.delete(id);
          setExitingItems(current => current.filter(item => item.entry.collection.id !== id));
        }, 160);
        hideTimersRef.current.set(id, timer);
      }
    },
    onError: error => {
      if (error instanceof ApiError && error.status === 409) {
        void client.invalidateQueries({ queryKey: ['collections', 'resurface', user?.id] });
        pushToast({ message: '日期已更新，正在刷新今日重现。' });
      } else pushToast({ message: getFriendlyErrorMessage(error), tone: 'error' });
    },
  });
  if (prefs.isError) return <ErrorBanner error={prefs.error} onRetry={() => void prefs.refetch()} />;
  if (!prefs.data?.enabled) return null;
  if (result.isError) return <ErrorBanner error={result.error} onRetry={() => void result.refetch()} />;
  const activeItems = result.data?.items ?? [];
  const activeDate = result.data?.date ?? today;
  const activeExiting = exitingItems.filter(
    ex => ex.date === activeDate && !activeItems.some(item => item.collection.id === ex.entry.collection.id),
  );
  if (!activeItems.length && !activeExiting.length) return null;

  const displayEntries: Array<{ entry: ResurfaceResult['items'][number]; isHiding: boolean }> = activeItems.map(entry => ({
    entry,
    isHiding: false,
  }));
  for (const ex of activeExiting.slice().sort((a, b) => a.index - b.index)) {
    displayEntries.splice(Math.min(ex.index, displayEntries.length), 0, {
      entry: ex.entry,
      isHiding: true,
    });
  }

  const date = activeDate;
  const state = { from: pathname + search };
  return (
    <section className="sp-resurface" aria-label="今日重现">
      <h2 className="sp-section-title">今日重现</h2>
      <div className="sp-resurface-strip">
        {displayEntries.map(({ entry: { collection, reason }, isHiding }) => {
          const createdYear = new Date(collection.created_at).getFullYear();
          const years = Number(date.slice(0, 4)) - createdYear;
          const project = collection.projects.find(p => ['manual', 'auto', 'confirmed'].includes(p.decision));
          const labels = {
            unclassified: project ? `已归入「${project.name}」` : '还在等待归类',
            inactive_project: '来自久未回看的项目收藏',
            anniversary: years === 1 ? '一年前的今天' : `${years} 年前的今天`,
          };
          return <article className={`sp-resurface-note ${isHiding ? 'is-hiding' : ''}`} aria-hidden={isHiding ? 'true' : undefined} key={collection.id}>
            <p className="sp-help sp-break-anywhere">{labels[reason]}</p>
            <h3><CollectionLink id={collection.id} state={state}>{collection.display_title || collection.excerpt || '未命名收藏'}</CollectionLink></h3>
            {collection.excerpt && collection.excerpt !== collection.display_title && <p className="sp-resurface-excerpt">{collection.excerpt}</p>}
            <div className="sp-resurface-actions">
              <CollectionLink className="sp-btn sp-btn--sm" id={collection.id} state={state} classify>归类</CollectionLink>
              <CollectionLink id={collection.id} state={state}>打开</CollectionLink>
              <button type="button" disabled={hide.isPending} onClick={() => hide.mutate({ id: collection.id, date })}>今天不再显示</button>
            </div>
          </article>;
        })}
      </div>
    </section>
  );
}
