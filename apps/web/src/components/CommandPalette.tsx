import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { PALETTES, type ThemePref } from '../lib/appearance';
import { getFriendlyErrorMessage } from '../api/errors';
import { useRecordOpened } from './CollectionLink';
import { confirmLeavingImageDraft } from '../lib/drafts';
import { Modal } from './Modal';

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const { user, saveAppearance, appearancePending } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const opened = useRecordOpened();
  const list = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setQ(text.trim()), 180);
    return () => clearTimeout(timer);
  }, [text, composing]);
  const projects = useQuery({
    queryKey: ['projects', 'commands', user?.id, q],
    queryFn: () => api.listProjects({ q, limit: 5 }),
  });
  const collections = useQuery({
    queryKey: ['collections-command', user?.id, q],
    queryFn: ({ signal }) => api.searchCollections({ q, scope: 'active', limit: 5 }, signal),
    enabled: !!q,
  });
  function go(path: string, collectionId?: string) {
    if (!confirmLeavingImageDraft()) return;
    if (collectionId) opened(collectionId);
    onClose();
    navigate(path);
  }
  async function appearance(patch: Parameters<typeof saveAppearance>[0]) {
    try { await saveAppearance(patch); onClose(); }
    catch (error) { pushToast({ message: getFriendlyErrorMessage(error), tone: 'error' }); }
  }
  const term = text.trim();
  const options: { name: string; run: () => void }[] = [{
    name: term ? `搜索全部收藏「${term}」` : '搜索全部收藏',
    run: () => go(term ? '/collections?q=' + encodeURIComponent(term) : '/collections?focus=search'),
  }];
  if (term === q && !composing) {
    for (const { collection } of collections.data?.items ?? []) options.push({
      name: '收藏 · ' + collection.display_title, run: () => go('/collections/' + collection.id, collection.id),
    });
    for (const p of projects.data?.items ?? []) options.push({ name: '项目 · ' + p.name, run: () => go('/projects/' + p.id) });
  }
  for (const p of PALETTES) {
    const name = '配色 · ' + p.label;
    if (name.includes(term)) options.push({ name, run: () => void appearance({ palette: p.id }) });
  }
  for (const [id, label] of [['system', '跟随系统'], ['light','浅色'], ['dark','深色']] as [ThemePref,string][]) {
    const name = '明暗 · ' + label;
    if (name.includes(term)) options.push({ name, run: () => void appearance({ theme: id }) });
  }
  const active = Math.min(index, options.length - 1);
  useEffect(() => { document.getElementById(list + '-' + active)?.scrollIntoView?.({ block: 'nearest' }); }, [active, list]);
  return <Modal open title="命令面板" onClose={onClose}>
    <input data-dialog-autofocus className="sp-input" role="combobox" aria-label="搜索收藏、项目或命令"
      aria-expanded aria-controls={list} aria-activedescendant={list + '-' + active} autoComplete="off"
      placeholder="搜索收藏、项目或外观设置…" value={text}
      onChange={e => { setText(e.target.value); setIndex(0); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={e => {
        if (composing || e.nativeEvent.isComposing || e.keyCode === 229 || appearancePending) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (e.key === 'Enter') { e.preventDefault(); options[active].run(); }
      }} />
    <div className="sp-command-list" role="listbox" id={list} aria-label="可用命令">
      {options.map((o,i) => <button key={i} type="button" role="option" aria-selected={i === active}
        id={list + '-' + i} tabIndex={-1} disabled={appearancePending} onMouseDown={e => e.preventDefault()}
        onClick={o.run}>{o.name}</button>)}
    </div>
    {term && term === q && (collections.isLoading || projects.isLoading) && <p className="sp-help" role="status">正在查找…</p>}
    {term && term === q && !composing && collections.isSuccess && projects.isSuccess && options.length === 1 &&
      <p className="sp-help" role="status">没有匹配的收藏、项目或命令。</p>}
    {(projects.isError || collections.isError) && <p role="alert">部分结果加载失败。<button onClick={() => {
      void projects.refetch(); if (q) void collections.refetch();
    }}>重试</button></p>}
  </Modal>;
}
