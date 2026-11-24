import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Monitor, Moon, Palette, Search, Sun } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { PALETTES, type ThemePref } from '../lib/appearance';
import { getFriendlyErrorMessage } from '../api/errors';
import { useRecordOpened } from './CollectionLink';
import { confirmLeavingImageDraft } from '../lib/drafts';
import { projectToneClass } from '../lib/projectTone';
import { Modal } from './Modal';
import { HighlightText } from './StateBlocks';

interface CommandOption {
  ariaLabel: string;
  content: ReactNode;
  run: () => void;
}

export function CommandPalette({
  open = true,
  onClose,
}: {
  open?: boolean;
  onClose: () => void;
}) {
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
    if (!open) return;
    setText('');
    setQ('');
    setIndex(0);
  }, [open]);

  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setQ(text.trim()), 180);
    return () => clearTimeout(timer);
  }, [text, composing]);
  const projects = useQuery({
    queryKey: ['projects', 'commands', user?.id, q],
    queryFn: () => api.listProjects({ q, limit: 5 }),
    enabled: open,
  });
  const collections = useQuery({
    queryKey: ['collections-command', user?.id, q],
    queryFn: ({ signal }) => api.searchCollections({ q, scope: 'active', limit: 5 }, signal),
    enabled: open && !!q,
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
  const currentPalette = user?.palette ?? 'mint';
  const currentTheme = user?.theme ?? 'system';
  const searchLabel = term ? `搜索全部收藏「${term}」` : '搜索全部收藏';
  const options: CommandOption[] = [{
    ariaLabel: searchLabel,
    content: (
      <>
        <Search size={15} strokeWidth={2} className="sp-command-row-icon" aria-hidden="true" />
        <span className="sp-command-row-main sp-truncate">{searchLabel}</span>
      </>
    ),
    run: () => go(term ? '/collections?q=' + encodeURIComponent(term) : '/collections?focus=search'),
  }];
  if (term === q && !composing) {
    for (const { collection } of collections.data?.items ?? []) {
      const label = '收藏 · ' + collection.display_title;
      options.push({
        ariaLabel: label,
        content: (
          <>
            <FileText size={15} strokeWidth={2} className="sp-command-row-icon" aria-hidden="true" />
            <span className="sp-command-row-main sp-truncate">
              <span className="sp-command-row-meta">收藏 · </span>
              <HighlightText text={collection.display_title} query={term} />
            </span>
          </>
        ),
        run: () => go('/collections/' + collection.id, collection.id),
      });
    }
    for (const p of projects.data?.items ?? []) {
      const label = '项目 · ' + p.name;
      options.push({
        ariaLabel: label,
        content: (
          <>
            <span className={`sp-command-row-dot sp-tape ${projectToneClass(p.id)}`} aria-hidden="true" />
            <span className="sp-command-row-main sp-truncate">
              <span className="sp-command-row-meta">项目 · </span>
              <HighlightText text={p.name} query={term} />
            </span>
          </>
        ),
        run: () => go('/projects/' + p.id),
      });
    }
  }
  for (const p of PALETTES) {
    const name = '配色 · ' + p.label;
    if (name.includes(term)) {
      const activePalette = currentPalette === p.id;
      options.push({
        ariaLabel: name,
        content: (
          <>
            <Palette size={15} strokeWidth={2} className="sp-command-row-icon" aria-hidden="true" />
            <span className="sp-command-row-main sp-truncate">
              <HighlightText text={name} query={term} />
            </span>
            {activePalette && (
              <Check size={14} strokeWidth={2.2} className="sp-command-row-check" aria-hidden="true" />
            )}
          </>
        ),
        run: () => void appearance({ palette: p.id }),
      });
    }
  }
  for (const [id, label, Icon] of [
    ['system', '跟随系统', Monitor],
    ['light', '浅色', Sun],
    ['dark', '深色', Moon],
  ] as [ThemePref, string, typeof Sun][]) {
    const name = '明暗 · ' + label;
    if (name.includes(term)) {
      const activeTheme = currentTheme === id;
      options.push({
        ariaLabel: name,
        content: (
          <>
            <Icon size={15} strokeWidth={2} className="sp-command-row-icon" aria-hidden="true" />
            <span className="sp-command-row-main sp-truncate">
              <HighlightText text={name} query={term} />
            </span>
            {activeTheme && (
              <Check size={14} strokeWidth={2.2} className="sp-command-row-check" aria-hidden="true" />
            )}
          </>
        ),
        run: () => void appearance({ theme: id }),
      });
    }
  }
  const active = Math.min(index, options.length - 1);
  useEffect(() => { document.getElementById(list + '-' + active)?.scrollIntoView?.({ block: 'nearest' }); }, [active, list]);
  return <Modal open={open} title="命令面板" onClose={onClose}>
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
        aria-label={o.ariaLabel}
        id={list + '-' + i} tabIndex={-1} disabled={appearancePending} onMouseDown={e => e.preventDefault()}
        onClick={o.run}>{o.content}</button>)}
    </div>
    {term && term === q && (collections.isLoading || projects.isLoading) && <p className="sp-help" role="status">正在查找…</p>}
    {term && term === q && !composing && collections.isSuccess && projects.isSuccess && options.length === 1 &&
      <p className="sp-help" role="status">没有匹配的收藏、项目或命令。</p>}
    {(projects.isError || collections.isError) && <p role="alert">部分结果加载失败。<button onClick={() => {
      void projects.refetch(); if (q) void collections.refetch();
    }}>重试</button></p>}
  </Modal>;
}
