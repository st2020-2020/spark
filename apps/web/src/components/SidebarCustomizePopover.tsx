import { useEffect, useRef, useState } from 'react';
import { RotateCcw, Search, Star } from 'lucide-react';

export interface CustomizePopoverItem {
  id: string;
  label: string;
  count?: number;
  pinned: boolean;
  accentClass?: string;
}

export function SidebarCustomizePopover({
  open,
  title,
  searchLabel,
  searchPlaceholder,
  emptyText,
  items,
  isCustomized,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onQueryChange,
  onTogglePin,
  onReset,
  onClose,
  anchorRef,
}: {
  open: boolean;
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  emptyText: string;
  items: readonly CustomizePopoverItem[];
  isCustomized: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onQueryChange?: (q: string) => void;
  onTogglePin: (id: string) => void;
  onReset: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onQueryChangeRef = useRef(onQueryChange);
  onQueryChangeRef.current = onQueryChange;
  const anchorElRef = useRef(anchorRef);
  anchorElRef.current = anchorRef;

  useEffect(() => {
    if (!open) {
      setQuery('');
      onQueryChangeRef.current?.('');
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        anchorElRef.current.current?.contains(target)
      ) {
        return;
      }
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      anchorElRef.current.current?.focus?.();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  if (!open) return null;

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? items.filter((item) => item.label.toLowerCase().includes(trimmed))
    : items;

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('button.sp-sidebar-customize-item') ?? [],
    );
    if (buttons.length === 0) return;

    event.preventDefault();
    const active = document.activeElement;
    const currentIndex = buttons.findIndex((btn) => btn === active);
    if (currentIndex === -1) {
      const next = event.key === 'ArrowDown' ? buttons[0] : buttons[buttons.length - 1];
      next.focus();
      return;
    }
    if (event.key === 'ArrowUp' && currentIndex === 0) {
      inputRef.current?.focus();
      return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (currentIndex + delta + buttons.length) % buttons.length;
    buttons[nextIndex].focus();
  };

  return (
    <div
      ref={panelRef}
      className="sp-sidebar-customize-popover"
      role="dialog"
      aria-label={title}
      onKeyDown={handlePanelKeyDown}
    >
      <div className="sp-sidebar-customize-head">
        <span className="sp-sidebar-customize-title">{title}</span>
        {isCustomized && (
          <button
            type="button"
            className="sp-sidebar-customize-reset"
            onClick={onReset}
          >
            <RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
            <span>恢复自动推荐</span>
          </button>
        )}
      </div>

      <div className="sp-sidebar-customize-search">
        <Search size={14} strokeWidth={2} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label={searchLabel}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            onQueryChangeRef.current?.(next);
          }}
        />
      </div>

      <div ref={listRef} className="sp-sidebar-customize-list" role="group" aria-label={`${title}列表`}>
        {filtered.length === 0 ? (
          <p className="sp-sidebar-customize-empty">{emptyText}</p>
        ) : (
          filtered.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sp-sidebar-customize-item ${item.pinned ? 'is-pinned' : ''}`}
              aria-pressed={item.pinned}
              onClick={() => onTogglePin(item.id)}
            >
              {item.accentClass && (
                <span className={`sp-project-dot ${item.accentClass}`} aria-hidden="true" />
              )}
              <span className="sp-sidebar-customize-item-label sp-truncate">{item.label}</span>
              {typeof item.count === 'number' && (
                <span className="sp-sidebar-customize-item-count">{item.count}</span>
              )}
              <Star
                size={14}
                strokeWidth={2}
                className="sp-sidebar-customize-star"
                fill={item.pinned ? 'currentColor' : 'none'}
                aria-hidden="true"
              />
            </button>
          ))
        )}
        {hasMore && onLoadMore && (
          <button
            type="button"
            className="sp-sidebar-customize-more"
            disabled={isLoadingMore}
            onClick={onLoadMore}
          >
            {isLoadingMore ? '正在加载…' : '加载更多'}
          </button>
        )}
      </div>
    </div>
  );
}
