import {
  useId,
  type KeyboardEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown, Pin, Search, X } from 'lucide-react';
import type { Choice } from './bridge';
import { Tool } from './shared';
import { projectToneClass } from '../../../web/src/lib/projectTone';

export function sidebarScope(origin: string, account?: string) {
  if (!account) return null;
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hostname = url.hostname.replace(/\.$/, '');
    return JSON.stringify([url.origin, account]);
  } catch {
    return null;
  }
}

function readPins(key: string | null): string[] | null {
  if (!key) return null;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(saved) && saved.every((id) => typeof id === 'string')
      ? [...new Set<string>(saved)]
      : null;
  } catch {
    return null;
  }
}

export function SidebarGroup({
  kind,
  scope,
  choices,
  selected,
  customizing,
  customize,
  onNavigate,
}: {
  kind: 'projects' | 'tags';
  scope: string | null;
  choices: Choice[];
  selected: string;
  customizing: boolean;
  customize: (open: boolean) => void;
  onNavigate: (id: string) => void;
}) {
  const projects = kind === 'projects';
  const title = projects ? '常用项目' : '置顶标签';
  const noun = projects ? '项目' : '标签';
  const key = scope && 'spark.desktop.sidebar.' + kind + '.' + scope;
  const [pins, setPins] = useState(() => readPins(key));
  const listId = useId();
  const [highlight, setHighlight] = useState<string>();
  const [expanded, expand] = useState(false);
  const [query, filter] = useState('');
  const [storageError, setStorageError] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const limit = 5;
  const catalog = useMemo(
    () => choices.filter((c) => !projects || !c.state || c.state === 'active'),
    [choices, projects],
  );
  const byId = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);
  const recommended = useMemo(
    () =>
      [...catalog]
        .sort((a, b) => {
          if (projects) {
            const recent =
              (Date.parse(b.updated_at ?? '') || 0) -
              (Date.parse(a.updated_at ?? '') || 0);
            if (recent) return recent;
          }
          return (b.collection_count ?? 0) - (a.collection_count ?? 0);
        })
        .slice(0, limit),
    [catalog, projects],
  );
  const picked =
    pins === null ? recommended : pins.flatMap((id) => byId.get(id) ?? []);
  const pickedIds = new Set(picked.map((c) => c.id));
  const shown = expanded
    ? [...picked, ...catalog.filter((c) => !pickedIds.has(c.id))]
    : picked;
  const term = query.trim().toLocaleLowerCase();
  const filtered =
    !customizing || !term
      ? catalog
      : catalog.filter((c) =>
          (c.path || c.name).toLocaleLowerCase().includes(term),
        );
  function save(ids: string[] | null) {
    setPins(ids);
    setStorageError(false);
    if (!key) return;
    try {
      if (ids === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      setStorageError(true);
    }
  }
  function toggle(id: string) {
    const ids = picked.map((item) => item.id);
    save(pickedIds.has(id) ? ids.filter((p) => p !== id) : [id, ...ids]);
  }
  const activeIndex = filtered.findIndex((choice) => choice.id === highlight);
  function move(e: KeyboardEvent) {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || !filtered.length)
      return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const choice = filtered[activeIndex < 0 ? 0 : activeIndex];
      setHighlight(choice.id);
      toggle(choice.id);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const last = filtered.length - 1;
    const index =
      e.key === 'ArrowDown'
        ? Math.min(activeIndex + 1, last)
        : activeIndex < 0
          ? last
          : Math.max(0, activeIndex - 1);
    setHighlight(filtered[index].id);
    input.current?.focus();
    document
      .getElementById(listId + '-' + index)
      ?.scrollIntoView({ block: 'nearest' });
  }
  useLayoutEffect(() => {
    if (!customizing || !dialog.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const el = dialog.current;
    el.style.setProperty('--pin-left', anchor.right + 12 + 'px');
    el.style.setProperty('--pin-top', anchor.top + 'px');
    el.showModal();
    input.current?.focus();
    return () => {
      el.close();
      trigger.current?.focus();
    };
  }, [customizing]);
  return (
    <section className="space-group" aria-label={title}>
      <div className="space-heading">
        <h3>{title}</h3>
        <button
          ref={trigger}
          aria-label={'自定义' + title}
          aria-haspopup="dialog"
          aria-expanded={customizing}
          onClick={() => {
            filter('');
            setHighlight(undefined);
            customize(true);
          }}
        >
          自定义
        </button>
      </div>
      <div className={projects ? 'space-projects' : 'space-tags'}>
        {shown.map((c) => (
          <button
            key={c.id}
            className={c.id === selected ? 'chosen' : ''}
            aria-current={c.id === selected ? 'page' : undefined}
            title={c.path || c.name}
            onClick={() => onNavigate(c.id)}
          >
            {projects && (
              <i
                aria-hidden="true"
                className={'project-dot ' + projectToneClass(c.id)}
              />
            )}
            <span className="nav-name">
              {projects ? c.name : '#' + (c.path || c.name)}
            </span>
            {projects && <small>{c.collection_count || ''}</small>}
          </button>
        ))}
      </div>
      {!shown.length && (
        <small className="space-empty">
          {catalog.length ? '尚未置顶' + noun : '暂无' + noun}
        </small>
      )}
      {catalog.length > picked.length && (
        <button
          className="space-more"
          aria-expanded={expanded}
          onClick={() => expand(!expanded)}
        >
          <ChevronDown aria-hidden="true" />
          {expanded ? '收起' : '全部' + noun + ' · ' + catalog.length}
        </button>
      )}
      {customizing && (
        <dialog
          ref={dialog}
          className="pins-popover"
          aria-label={'自定义' + title}
          onCancel={(e) => {
            e.preventDefault();
            customize(false);
          }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              customize(false);
          }}
        >
          <div className="pins-head">
            <strong>{title}</strong>
            <Tool label="关闭自定义" onClick={() => customize(false)}>
              <X />
            </Tool>
          </div>
          <label className="pins-filter">
            <Search />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeIndex < 0 ? undefined : listId + '-' + activeIndex
              }
              onKeyDown={move}
              ref={input}
              aria-label={'筛选' + noun}
              placeholder={'筛选' + noun}
              value={query}
              onChange={(e) => {
                filter(e.target.value);
                setHighlight(undefined);
              }}
            />
          </label>
          <div
            className="pins-options"
            role="listbox"
            aria-label={title}
            aria-multiselectable="true"
            id={listId}
            onKeyDown={move}
          >
            {filtered.map((c, index) => (
              <button
                key={c.id}
                id={listId + '-' + index}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={pickedIds.has(c.id)}
                className={activeIndex === index ? 'highlighted' : undefined}
                onFocus={() => setHighlight(c.id)}
                onClick={() => {
                  setHighlight(c.id);
                  toggle(c.id);
                  input.current?.focus();
                }}
              >
                {projects && (
                  <i
                    className={'project-dot ' + projectToneClass(c.id)}
                    aria-hidden="true"
                  />
                )}
                <span className="nav-name">{c.path || c.name}</span>
                <Pin aria-hidden="true" />
              </button>
            ))}
            {!filtered.length && (
              <small role="status">
                {catalog.length ? '没有匹配的' + noun : '暂无' + noun}
              </small>
            )}
          </div>
          <button
            className="pins-reset"
            disabled={pins === null}
            onClick={() => save(null)}
          >
            恢复自动推荐
          </button>
          {storageError && (
            <small role="status">偏好仅在本次打开期间有效。</small>
          )}
        </dialog>
      )}
    </section>
  );
}
