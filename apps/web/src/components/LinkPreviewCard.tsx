import { ExternalLink, Globe, Loader2, RefreshCw } from 'lucide-react';
import type { LinkPreview } from '../api/types';
import { isValidHttpUrl } from '../lib/document';

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function formatShortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    const full = `${host}${path}`;
    return full.length > 64 ? `${full.slice(0, 61)}…` : full;
  } catch {
    return url;
  }
}

export function LinkPreviewCard({
  originalUrl,
  preview,
  variant = 'card',
  isRefreshing = false,
  isCheckingStatus = false,
  refreshError = null,
  onRefresh,
  onCheckStatus,
  className = '',
  fallbackClassName,
}: {
  originalUrl: string;
  preview?: Pick<LinkPreview, 'status' | 'source_title' | 'site_name' | 'summary'> | null;
  variant?: 'card' | 'detail';
  isRefreshing?: boolean;
  isCheckingStatus?: boolean;
  refreshError?: string | null;
  onRefresh?: () => void;
  onCheckStatus?: () => void;
  className?: string;
  fallbackClassName?: string;
}) {
  if (!isValidHttpUrl(originalUrl)) {
    return null;
  }

  const status = preview?.status;
  const isPending = status === 'queued' || status === 'running';
  const siteName = preview?.site_name?.trim() || extractHost(originalUrl);
  const sourceTitle = preview?.source_title?.trim() || '';
  const summary = preview?.summary?.trim() || '';
  const hasRichPreview = status === 'succeeded' && Boolean(sourceTitle || summary);
  const shortUrl = formatShortUrl(originalUrl);

  const errorBlock =
    variant === 'detail' && refreshError ? (
      <div className="sp-banner sp-banner--error sp-link-card-error" role="alert">
        <span>{refreshError}</span>
      </div>
    ) : null;

  if (isPending) {
    return (
      <div
        className={`sp-link-card sp-link-card--pending sp-link-card--${variant} ${className}`.trim()}
      >
        <div className="sp-link-card-head">
          <span className="sp-link-card-status">
            <Loader2 size={13} strokeWidth={2} className="sp-spin" aria-hidden="true" />
            <span>正在获取网页信息</span>
          </span>
          {variant === 'detail' && onCheckStatus && (
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--ghost"
              disabled={isCheckingStatus}
              onClick={onCheckStatus}
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={isCheckingStatus ? 'sp-spin' : undefined}
                aria-hidden="true"
              />
              <span>{isCheckingStatus ? '刷新中…' : '刷新状态'}</span>
            </button>
          )}
        </div>
        <a
          href={originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={originalUrl}
          className="sp-link-card-raw sp-break-anywhere"
        >
          <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
          <span>{variant === 'card' ? shortUrl : originalUrl}</span>
        </a>
        {errorBlock}
      </div>
    );
  }

  if (hasRichPreview) {
    if (variant === 'card') {
      return (
        <div className={`sp-link-card sp-link-card--card ${className}`.trim()}>
          <div className="sp-link-card-bar">
            <span className="sp-link-card-site">
              <Globe size={12} strokeWidth={2} aria-hidden="true" />
              <span className="sp-truncate">{siteName}</span>
            </span>
            {sourceTitle ? (
              <>
                <span className="sp-link-card-sep" aria-hidden="true">·</span>
                <a
                  href={originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={originalUrl}
                  className="sp-link-card-title sp-link-card-title--inline"
                >
                  <span className="sp-truncate">{sourceTitle}</span>
                  <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
                </a>
              </>
            ) : (
              <a
                href={originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={originalUrl}
                className="sp-link-card-title sp-link-card-title--inline"
              >
                <span className="sp-truncate">{shortUrl}</span>
                <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
              </a>
            )}
          </div>
          {summary && (
            <p className="sp-link-card-summary sp-link-card-summary--one-line sp-break-anywhere">
              {summary}
            </p>
          )}
        </div>
      );
    }

    return (
      <div className={`sp-link-card sp-link-card--detail ${className}`.trim()}>
        <div className="sp-link-card-head">
          <span className="sp-link-card-site sp-truncate">
            <Globe size={13} strokeWidth={2} aria-hidden="true" />
            <span className="sp-truncate">{siteName}</span>
          </span>
          {onRefresh && (
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--ghost"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={isRefreshing ? 'sp-spin' : undefined}
                aria-hidden="true"
              />
              <span>{isRefreshing ? '获取中…' : '重新获取'}</span>
            </button>
          )}
        </div>

        <a
          href={originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="sp-link-card-title sp-break-anywhere"
        >
          <span>{sourceTitle || originalUrl}</span>
          <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
        </a>

        {summary && (
          <p className="sp-link-card-summary sp-break-anywhere">{summary}</p>
        )}

        <a
          href={originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="sp-link-card-raw sp-break-anywhere"
        >
          <span>{originalUrl}</span>
        </a>

        {errorBlock}
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <a
        href={originalUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={originalUrl}
        className={`${fallbackClassName ?? 'sp-note-url'} ${className}`.trim()}
      >
        <ExternalLink size={12} strokeWidth={2} aria-hidden="true" />
        <span className="sp-truncate">{shortUrl}</span>
      </a>
    );
  }

  return (
    <div className={`sp-link-fallback-wrap ${className}`.trim()}>
      <div className="sp-link-fallback-row">
        <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="sp-note-source">
          <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
          <span className="sp-break-anywhere">{originalUrl}</span>
        </a>
        {onRefresh && (
          <button
            type="button"
            className="sp-btn sp-btn--sm"
            disabled={isRefreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              className={isRefreshing ? 'sp-spin' : undefined}
              aria-hidden="true"
            />
            <span>{isRefreshing ? '获取中…' : '重新获取'}</span>
          </button>
        )}
      </div>
      {errorBlock}
    </div>
  );
}
