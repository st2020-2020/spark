import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { Attachment } from '../api/types';
import { formatBytes } from '../lib/format';
import { AttachmentImage } from './AttachmentImage';

export function AttachmentGallery({
  attachments,
  compact = false,
  className = '',
}: {
  attachments: Attachment[];
  compact?: boolean;
  className?: string;
}) {
  const sorted = useMemo(
    () => [...attachments].sort((a, b) => a.position - b.position),
    [attachments],
  );
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const prevFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (activeIndex === null) return;
    if (activeIndex >= sorted.length) {
      setActiveIndex(sorted.length > 0 ? sorted.length - 1 : null);
    }
  }, [activeIndex, sorted.length]);

  useEffect(() => {
    if (activeIndex === null) return;
    prevFocusedRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex(null);
      } else if (event.key === 'ArrowLeft' && sorted.length > 1) {
        event.preventDefault();
        setActiveIndex((prev) => (prev === null ? null : (prev - 1 + sorted.length) % sorted.length));
      } else if (event.key === 'ArrowRight' && sorted.length > 1) {
        event.preventDefault();
        setActiveIndex((prev) => (prev === null ? null : (prev + 1) % sorted.length));
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      prevFocusedRef.current?.focus?.();
    };
  }, [activeIndex, sorted.length]);

  if (sorted.length === 0) return null;

  const isSingle = sorted.length === 1;
  const variant = compact ? (isSingle ? 'compact' : 'grid') : isSingle ? 'single' : 'grid';
  const gridCountClass =
    isSingle
      ? 'sp-attachment-gallery--single'
      : sorted.length === 2 || sorted.length === 4
        ? 'sp-attachment-gallery--two'
        : 'sp-attachment-gallery--three';

  const activeAttachment = activeIndex !== null ? sorted[activeIndex] ?? null : null;

  return (
    <>
      <div
        className={`sp-attachment-gallery ${gridCountClass} ${
          compact ? 'sp-attachment-gallery--compact' : ''
        } ${className}`.trim()}
        aria-label={`图片附件，共 ${sorted.length} 张`}
      >
        {sorted.map((att, idx) => (
          <div key={att.id} className="sp-attachment-cell">
            <AttachmentImage
              attachment={att}
              variant={variant}
              onZoom={() => setActiveIndex(idx)}
            />
          </div>
        ))}
      </div>

      {activeAttachment && activeIndex !== null && (
        <div
          className="sp-lightbox-backdrop"
          role="presentation"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setActiveIndex(null);
          }}
        >
          <div
            ref={dialogRef}
            className="sp-lightbox-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`图片预览 ${activeAttachment.filename}`}
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="sp-lightbox-head">
              <div className="sp-lightbox-meta">
                <span className="sp-strong sp-truncate">{activeAttachment.filename}</span>
                <span className="sp-help">
                  {activeIndex + 1} / {sorted.length} · {formatBytes(activeAttachment.size_bytes)}
                </span>
              </div>
              <button
                type="button"
                className="sp-icon-btn"
                aria-label="关闭图片预览"
                onClick={() => setActiveIndex(null)}
              >
                <X size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            <div className="sp-lightbox-stage">
              {sorted.length > 1 && (
                <button
                  type="button"
                  className="sp-lightbox-nav sp-lightbox-nav--prev"
                  aria-label="上一张图片"
                  onClick={() =>
                    setActiveIndex((activeIndex - 1 + sorted.length) % sorted.length)
                  }
                >
                  <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
                </button>
              )}

              <AttachmentImage
                attachment={activeAttachment}
                variant="lightbox"
                showOpenOriginal
              />

              {sorted.length > 1 && (
                <button
                  type="button"
                  className="sp-lightbox-nav sp-lightbox-nav--next"
                  aria-label="下一张图片"
                  onClick={() => setActiveIndex((activeIndex + 1) % sorted.length)}
                >
                  <ChevronRight size={20} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
