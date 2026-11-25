import { useRef, type ReactNode } from 'react';
import { getFriendlyErrorMessage } from '../api/errors';
import { ApiError } from '../api/errors';
import { splitHighlightSegments } from '../lib/highlight';
import { useAutoLoadMore } from '../lib/motion';
import { SparkGlyph } from './Brand';
import { JarScene, NotebookScene, SearchScene } from './Illustrations';

/** Skeleton placeholder shaped like the note cards it stands in for. */
export function LoadingState({ message = '正在加载…' }: { message?: string }) {
  return (
    <div className="sp-loading" role="status" aria-live="polite">
      {[0, 1].map((i) => (
        <div key={i} className="sp-skeleton-card" aria-hidden="true">
          <span className="sp-skeleton-line sp-skeleton-line--short" />
          <span className="sp-skeleton-line" />
          <span className="sp-skeleton-line sp-skeleton-line--mid" />
        </div>
      ))}
      <span className="sp-loading-text">{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  art = 'mark',
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Illustration above the title; "mark" is a small spark for secondary empty states. */
  art?: 'mark' | 'jar' | 'notebook' | 'search';
}) {
  return (
    <div className={`sp-empty ${art === 'mark' ? '' : 'sp-empty--art'}`}>
      {art === 'mark' && (
        <span className="sp-empty-mark" aria-hidden="true">
          <SparkGlyph size={18} />
        </span>
      )}
      {art === 'jar' && <JarScene className="sp-empty-art" />}
      {art === 'notebook' && <NotebookScene className="sp-empty-art" />}
      {art === 'search' && <SearchScene className="sp-empty-art" />}
      <p className="sp-empty-title">{title}</p>
      {description && <p className="sp-empty-desc">{description}</p>}
      {action && <div className="sp-empty-actions">{action}</div>}
    </div>
  );
}

export function ErrorBanner({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  const message = getFriendlyErrorMessage(error);
  const requestId = error instanceof ApiError ? error.requestId : '';

  return (
    <div className="sp-banner sp-banner--error sp-spaced" role="alert">
      <div>
        <div>{message}</div>
        {requestId && (
          <div className="sp-banner-detail sp-banner-detail--quiet sp-mono">
            请求标识：{requestId}
          </div>
        )}
      </div>
      {onRetry && (
        <button type="button" className="sp-btn sp-btn--sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/**
 * Pagination for long lists: the next page loads by itself as the end comes into view.
 * The button stays for keyboard users, failed loads and browsers without IntersectionObserver.
 */
export function LoadMore({
  hasNextPage,
  isFetching,
  isError = false,
  onLoad,
  label = '加载更多',
}: {
  hasNextPage: boolean | undefined;
  isFetching: boolean;
  isError?: boolean;
  onLoad: () => void;
  label?: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useAutoLoadMore(sentinelRef, {
    enabled: Boolean(hasNextPage) && !isFetching && !isError,
    onLoad,
  });
  if (!hasNextPage) return null;
  return (
    <div className="sp-load-more" ref={sentinelRef}>
      <button type="button" className="sp-btn sp-btn--quiet" disabled={isFetching} onClick={onLoad}>
        {isFetching ? (
          <>
            <span className="sp-load-more-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>加载中…</span>
          </>
        ) : isError ? (
          '加载失败，重试'
        ) : (
          label
        )}
      </button>
    </div>
  );
}

export function HighlightText({ text, query }: { text: string; query: string }) {
  const segments = splitHighlightSegments(text, query);
  return (
    <>
      {segments.map((seg, idx) =>
        seg.match ? (
          <mark key={idx} className="sp-mark-highlight">
            {seg.text}
          </mark>
        ) : (
          <span key={idx}>{seg.text}</span>
        ),
      )}
    </>
  );
}
