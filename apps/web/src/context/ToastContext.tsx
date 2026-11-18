import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { generateUuid } from '../lib/idempotency';

export interface ToastItem {
  id: string;
  message: string;
  tone?: 'default' | 'error';
  variant?: 'default' | 'ai-suggestion';
  dedupeKey?: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface ToastContextValue {
  pushToast: (toast: Omit<ToastItem, 'id'>, durationMs?: number) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
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
              item.id === existing.id ? { ...toast, id: existing.id } : item,
            );
          }
        }
        if (durationMs > 0) {
          const timer = window.setTimeout(() => dismissToast(nextId), durationMs);
          timersRef.current.set(nextId, timer);
        }
        return [...prev, { ...toast, id: nextId }];
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
            }`}
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
            <div className="sp-row" style={{ flexShrink: 0 }}>
              {toast.actionLabel && toast.onAction && (
                <button
                  type="button"
                  className={`sp-btn sp-btn--sm ${
                    toast.variant === 'ai-suggestion' ? 'sp-btn--primary' : ''
                  }`}
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
                className="sp-btn sp-btn--sm sp-btn--quiet"
                aria-label="关闭提示"
                onClick={() => dismissToast(toast.id)}
              >
                ×
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
