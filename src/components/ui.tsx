"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { LoaderCircle, Sparkles, CircleCheck, CircleAlert } from "lucide-react";

export function Button({
  children,
  busy,
  intent = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  intent?: "primary" | "neutral" | "danger" | "ghost";
}) {
  return (
    <button
      {...props}
      className={`button btn button-${intent} ${className}`}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
    >
      <span
        className="button-content"
        style={{ opacity: busy ? 0 : undefined }}
      >
        {children}
      </span>
      {busy && (
        <LoaderCircle
          size={18}
          className="button-spinner spin"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export function Notice({
  children,
  tone = "info",
  id,
}: {
  children: React.ReactNode;
  tone?: "info" | "success" | "error";
  id?: string;
}) {
  const Icon =
    tone === "error"
      ? CircleAlert
      : tone === "success"
        ? CircleCheck
        : Sparkles;
  return (
    <div
      id={id}
      className={`notice notice-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon size={17} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export function AutoTextarea({
  value,
  className = "",
  minimumHeight = 132,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { minimumHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(Math.max(el.scrollHeight, minimumHeight), 600)}px`;
    }
  }, [value, minimumHeight]);
  return (
    <textarea
      {...props}
      value={value}
      ref={ref}
      className={`resize-none auto-textarea ${className}`}
    />
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  busy = false,
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      dialog.current?.showModal();
      cancel.current?.focus();
    } else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="confirm-dialog"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-description"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2 id="dialog-title">{title}</h2>
      <div id="dialog-description">{children}</div>
      <div className="dialog-actions">
        <button
          ref={cancel}
          type="button"
          className="button btn button-neutral"
          onClick={onClose}
          disabled={busy}
        >
          取消
        </button>
        <Button
          intent={danger ? "danger" : "primary"}
          busy={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
}

export function EntryTime({ value }: { value: string }) {
  // Client locale/timezone avoids hydration mismatches with the Node host.
  const ref = useRef<HTMLTimeElement>(null);
  useEffect(() => {
    if (ref.current)
      ref.current.textContent = new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value));
  }, [value]);
  return (
    <time ref={ref} dateTime={value} title={value} suppressHydrationWarning>
      {value.slice(0, 10)}
    </time>
  );
}
