import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  actions?: ReactNode;
  showSearch?: boolean;
  /** Keep search visible on <768px mobile (used by /collections search page). */
  searchAlwaysVisible?: boolean;
  /** Controlled search props when used on /collections. */
  searchValue?: string;
  onSearchChange?: (next: string) => void;
  onSearchSubmit?: (trimmed: string) => void;
  onSearchClear?: () => void;
  searchLabel?: string;
  searchPlaceholder?: string;
  autoFocusSearch?: boolean;
}

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
  showSearch = true,
  searchAlwaysVisible = false,
  searchValue,
  onSearchChange,
  onSearchSubmit,
  onSearchClear,
  searchLabel = '搜索收藏',
  searchPlaceholder = '搜索收藏…',
  autoFocusSearch = false,
}: PageHeaderProps) {
  const navigate = useNavigate();
  const isControlled = searchValue !== undefined;

  const [localQ, setLocalQ] = useState('');
  const currentQ = isControlled ? searchValue : localQ;

  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isComposingRef = useRef(false);


  useEffect(() => {
    if (autoFocusSearch && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocusSearch]);

  const setQuery = (next: string) => {
    if (isControlled) {
      onSearchChange?.(next);
    } else {
      setLocalQ(next);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (isComposingRef.current) return;
    const trimmed = currentQ.trim();
    if (onSearchSubmit) {
      onSearchSubmit(trimmed);
      return;
    }
    if (!trimmed) return;
    navigate(`/collections?q=${encodeURIComponent(trimmed)}`);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || isComposingRef.current || event.keyCode === 229) {
      if (event.key === 'Enter') {
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const input = inputRef.current;
      input?.blur();
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && prev.isConnected && prev !== input) {
        prev.focus();
      }
    }
  };

  const handleClear = () => {
    if (onSearchClear) {
      onSearchClear();
    } else {
      setQuery('');
    }
    inputRef.current?.focus();
  };

  return (
    <header className="sp-pagehead">
      <div className="sp-pagehead-main">
        <div>
          <div className="sp-pagehead-title-row">
            <h1 className="sp-page-title sp-break-anywhere">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="sp-page-subtitle">{subtitle}</p>}
        </div>
      </div>

      {(showSearch || actions) && (
        <div className="sp-pagehead-controls">
          {showSearch && (
            <form
              ref={formRef}
              className={`sp-header-search-form ${
                searchAlwaysVisible ? 'sp-header-search-form--always' : 'sp-header-search-form--desktop-only'
              }`}
              role="search"
              onSubmit={handleSubmit}
            >
              <div
                className="sp-header-search-box"
                onMouseDown={() => {
                  const active = document.activeElement;
                  if (active instanceof HTMLElement && active !== inputRef.current) {
                    previousFocusRef.current = active;
                  }
                }}
              >
                <Search size={16} strokeWidth={2} aria-hidden="true" />
                <input
                  ref={inputRef}
                  type="search"
                  aria-label={searchLabel}
                  placeholder={searchPlaceholder}
                  value={currentQ}
                  onCompositionStart={() => {
                    isComposingRef.current = true;
                  }}
                  onCompositionEnd={() => {
                    isComposingRef.current = false;
                  }}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                />
                {currentQ && (
                  <button
                    type="button"
                    className="sp-search-clear"
                    aria-label="清空搜索"
                    onClick={handleClear}
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            </form>
          )}
          {actions}
        </div>
      )}
    </header>
  );
}
