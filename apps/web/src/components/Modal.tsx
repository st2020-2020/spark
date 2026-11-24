import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { canAnimateMotion, SHEET_EXIT_MS, useSheetSwipeDismiss } from '../lib/motion';

/** Centered dialog on desktop, bottom sheet on phones (see .sp-modal in global.css). */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [rendered, setRendered] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const exitTimerRef = useRef<number | null>(null);

  const { isDragging, settledAfterDrag, swipeStyle, swipeHandlers } = useSheetSwipeDismiss({
    enabled: open && !closing,
    onDismiss: () => onCloseRef.current(),
  });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel) {
      panel.inert = closing;
    }
  }, [closing]);

  useEffect(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    if (!canAnimateMotion()) {
      setClosing(false);
      setRendered(false);
      return;
    }
    setClosing(true);
    exitTimerRef.current = window.setTimeout(() => {
      exitTimerRef.current = null;
      setClosing(false);
      setRendered(false);
    }, SHEET_EXIT_MS);
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [open, rendered]);

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      panel.inert = false;
    }
    (panel?.querySelector<HTMLElement>('[data-dialog-autofocus]') ?? panel)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === 'Tab' && panel) {
        const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], select, textarea, [tabindex="0"]')).filter(el => el.tabIndex >= 0 && !el.hidden);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      prevActive?.focus?.();
    };
  }, [open]);

  if (!open && !rendered) return null;

  return (
    <div
      className={`sp-modal-backdrop ${closing ? 'is-closing' : ''}`}
      role="presentation"
      onMouseDown={(e) => {
        if (!closing && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        className={`sp-modal ${closing ? 'is-closing' : ''} ${
          isDragging ? 'is-dragging' : ''
        } ${settledAfterDrag ? 'is-swipe-settled' : ''}`}
        style={swipeStyle}
        role="dialog"
        aria-modal={!closing ? 'true' : undefined}
        aria-hidden={closing ? 'true' : undefined}
        aria-label={title}
        tabIndex={-1}
      >
        <div className="sp-sheet-swipe-zone" {...swipeHandlers}>
          <span className="sp-sheet-grabber" aria-hidden="true" />
          <div className="sp-modal-head">
            <h2 className="sp-modal-title">{title}</h2>
            <button
              type="button"
              className="sp-icon-btn"
              onClick={() => onCloseRef.current()}
              aria-label="关闭弹窗"
            >
              <X size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
