import { useEffect, useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Hash, Monitor, Moon, Palette, Search, Sun } from 'lucide-react';
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
  initialQuery = '',
  onClose,
}: {
  open?: boolean;
  initialQuery?: string;
  onClose: () => void;
}) {
  const api = useApi();
  const { user, saveAppearance, appearancePending } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const opened = useRecordOpened();
  const list = useId();
  const [text, setText] = useState(initialQuery);
  const [q, setQ] = useState(initialQuery.trim());
  const [index, setIndex] = useState(0);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText(initialQuery);
    setQ(initialQuery.trim());
    setIndex(0);
  }, [open, initialQuery]);

  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => setQ(text.trim()), 180);
    return () => clearTimeout(timer);
  }, [text, composing]);

  const isTagQuery = q.startsWith('#');
  const tagSearchTerm = (isTagQuery ? q.slice(1) : q).trim();
  const contentSearchTerm = isTagQuery ? '' : q;

  const projects = useQuery({
    queryKey: ['projects', 'commands', user?.id, contentSearchTerm],
    queryFn: () => api.listProjects({ q: contentSearchTerm, limit: 5 }),
    enabled: open && !isTagQuery,
  });
  const tags = useQuery({
    queryKey: ['tags', 'commands', user?.id, isTagQuery, tagSearchTerm],
    queryFn: () => api.listTags({ q: tagSearchTerm || undefined, limit: isTagQuery ? 24 : 5 }),
    enabled: open && (isTagQuery || Boolean(tagSearchTerm)),
  });
  const collections = useQuery({
    queryKey: ['collections-command', user?.id, contentSearchTerm],
    queryFn: ({ signal }) =>
      api.searchCollections({ q: contentSearchTerm, scope: 'active', limit: 5 }, signal),
    enabled: open && !isTagQuery && Boolean(contentSearchTerm),
  });

  function go(path: string, collectionId?: string, state?: unknown) {
    if (!confirmLeavingImageDraft()) return;
    if (collectionId) opened(collectionId);
    onClose();
    navigate(path, state !== undefined ? { state } : undefined);
  }
  async function appearance(patch: Parameters<typeof saveAppearance>[0]) {
    try { await saveAppearance(patch); onClose(); }
    catch (error) { pushToast({ message: getFriendlyErrorMessage(error), tone: 'error' }); }
  }
  const term = text.trim();
  const termIsTag = term.startsWith('#');
  const displayTagTerm = termIsTag ? term.slice(1).trim() : term;
  const currentPalette = user?.palette ?? 'mint';
  const currentTheme = user?.theme ?? 'system';
  const searchLabel = term && !termIsTag ? `搜索全部收藏「${term}」` : '搜索全部收藏';
  const options: CommandOption[] = termIsTag
    ? []
    : [{
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
    if (!termIsTag) {
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
    for (const t of tags.data?.items ?? []) {
      const label = `标签 · #${t.name}`;
      options.push({
        ariaLabel: label,
        content: (
          <>
            <Hash size={15} strokeWidth={2} className="sp-command-row-icon" aria-hidden="true" />
            <span className="sp-command-row-main sp-truncate">
              <span className="sp-command-row-meta">标签 · </span>
              <HighlightText text={t.name} query={displayTagTerm} />
            </span>
            <span className="sp-command-row-meta">{t.collection_count}</span>
          </>
        ),
        run: () => go(`/collections?tag_id=${encodeURIComponent(t.id)}`, undefined, { tagName: t.name }),
      });
    }
  }
  if (!termIsTag) {
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
  }
  const active = options.length > 0 ? Math.min(index, options.length - 1) : 0;
  useEffect(() => { document.getElementById(list + '-' + active)?.scrollIntoView?.({ block: 'nearest' }); }, [active, list]);
  return <Modal open={open} title="命令面板" onClose={onClose}>
    <input data-dialog-autofocus className="sp-input" role="combobox" aria-label="搜索收藏、项目或命令"
      aria-expanded aria-controls={list} aria-activedescendant={options.length > 0 ? list + '-' + active : undefined} autoComplete="off"
      placeholder="搜索收藏、项目、#标签或外观设置…" value={text}
      onChange={e => { setText(e.target.value); setIndex(0); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onKeyDown={e => {
        if (composing || e.nativeEvent.isComposing || e.keyCode === 229 || appearancePending || options.length === 0) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (e.key === 'Enter') { e.preventDefault(); options[active]?.run(); }
      }} />
    <div className="sp-command-list" role="listbox" id={list} aria-label="可用命令">
      {options.map((o,i) => <button key={i} type="button" role="option" aria-selected={i === active}
        aria-label={o.ariaLabel}
        id={list + '-' + i} tabIndex={-1} disabled={appearancePending} onMouseDown={e => e.preventDefault()}
        onClick={o.run}>{o.content}</button>)}
    </div>
    {term && term === q && (collections.isLoading || projects.isLoading || tags.isLoading) && <p className="sp-help" role="status">正在查找…</p>}
    {term && term === q && !composing &&
      (termIsTag
        ? tags.isSuccess && options.length === 0 && <p className="sp-help" role="status">没有匹配的标签。</p>
        : collections.isSuccess && projects.isSuccess && options.length === 1 &&
          <p className="sp-help" role="status">没有匹配的收藏、项目或命令。</p>)}
    {(projects.isError || collections.isError || tags.isError) && <p role="alert">部分结果加载失败。<button onClick={() => {
      if (!isTagQuery) void projects.refetch();
      if (isTagQuery || tagSearchTerm) void tags.refetch();
      if (contentSearchTerm) void collections.refetch();
    }}>重试</button></p>}
  </Modal>;
}
