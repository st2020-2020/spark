import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { generateUuid } from '../lib/idempotency';

export interface ToastItem {
  id: string;
  message: string;
  tone?: 'default' | 'error';
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

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, 'id'>, durationMs = 5000) => {
      const id = generateUuid();
      setToasts((prev) => [...prev, { ...toast, id }]);
      if (durationMs > 0) {
        window.setTimeout(() => {
          dismissToast(id);
        }, durationMs);
      }
    },
    [dismissToast],
  );

  return (
    <ToastContext.Provider value={{ pushToast, dismissToast }}>
      {children}
      <div className="sp-toast-region" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`sp-toast ${toast.tone === 'error' ? 'sp-toast--error' : ''}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <span>{toast.message}</span>
            <div className="sp-row">
              {toast.actionLabel && toast.onAction && (
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
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
