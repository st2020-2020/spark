import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prevActive = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
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

  if (!open) return null;

  return (
    <div
      className="sp-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        className="sp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
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
        {children}
      </div>
    </div>
  );
}
