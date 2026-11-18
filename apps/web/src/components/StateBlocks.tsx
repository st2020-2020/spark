import type { ReactNode } from 'react';
import { getFriendlyErrorMessage } from '../api/errors';
import { ApiError } from '../api/errors';
import { splitHighlightSegments } from '../lib/highlight';

export function LoadingState({ message = '正在加载…' }: { message?: string }) {
  return (
    <div className="sp-card" role="status" aria-live="polite" style={{ textAlign: 'center', padding: 28 }}>
      <span className="sp-help">{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sp-card" style={{ textAlign: 'center', padding: '28px 20px' }}>
      <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
      {description && (
        <p className="sp-help" style={{ marginTop: 6, marginBottom: action ? 14 : 0 }}>
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
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
    <div className="sp-banner sp-banner--error" role="alert">
      <div style={{ minWidth: 0 }}>
        <div>{message}</div>
        {requestId && (
          <div className="sp-help sp-mono" style={{ marginTop: 4, color: 'inherit', opacity: 0.85 }}>
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
