import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Sparkles, X } from 'lucide-react';
import { generateUuid } from '../lib/idempotency';
import { canAnimateMotion, TOAST_EXIT_MS } from '../lib/motion';

export interface ToastItem {
  id: string;
  message: string;
  tone?: 'default' | 'error';
  variant?: 'default' | 'ai-suggestion';
  dedupeKey?: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface InternalToastItem extends ToastItem {
  closing?: boolean;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, 'id'>, durationMs?: number) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<InternalToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const exitTimersRef = useRef<Map<string, number>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    const exitTimer = exitTimersRef.current.get(id);
    if (exitTimer !== undefined) {
      window.clearTimeout(exitTimer);
      exitTimersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      if (!canAnimateMotion()) {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        return;
      }
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, closing: true } : t)));
      const exitTimer = window.setTimeout(() => {
        exitTimersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_EXIT_MS);
      exitTimersRef.current.set(id, exitTimer);
    },
    [clearTimer],
  );

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>, durationMs = 5000) => {
      const nextId = generateUuid();
      setToasts((prev) => {
        if (toast.dedupeKey) {
          const existing = prev.find((item) => item.dedupeKey === toast.dedupeKey);
          if (existing) {
            clearTimer(existing.id);
            if (durationMs > 0) {
              const timer = window.setTimeout(() => dismissToast(existing.id), durationMs);
              timersRef.current.set(existing.id, timer);
            }
            return prev.map((item) =>
              item.id === existing.id ? { ...toast, id: existing.id, closing: false } : item,
            );
          }
        }
        if (durationMs > 0) {
          const timer = window.setTimeout(() => dismissToast(nextId), durationMs);
          timersRef.current.set(nextId, timer);
        }
        return [...prev, { ...toast, id: nextId, closing: false }];
      });
    },
    [clearTimer, dismissToast],
  );

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
      for (const timer of exitTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      exitTimersRef.current.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast, dismissToast }}>
      {children}
      <div className="sp-toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`sp-toast ${toast.tone === 'error' ? 'sp-toast--error' : ''} ${
              toast.variant === 'ai-suggestion' ? 'sp-toast--ai' : ''
            } ${toast.closing ? 'is-closing' : ''}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <div className="sp-toast-body">
              {toast.variant === 'ai-suggestion' && (
                <Sparkles
                  size={15}
                  strokeWidth={2}
                  className="sp-toast-ai-icon"
                  aria-hidden="true"
                />
              )}
              <span>{toast.message}</span>
            </div>
            <div className="sp-toast-actions">
              {toast.actionLabel && toast.onAction && (
                <button
                  type="button"
                  className="sp-toast-action"
                  onClick={() => {
                    void toast.onAction?.();
                    dismissToast(toast.id);
                  }}
                >
                  {toast.actionLabel}
                </button>
              )}
              <button
                type="button"
                className="sp-toast-close"
                aria-label="关闭提示"
                onClick={() => dismissToast(toast.id)}
              >
                <X size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
