"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  ArrowLeft,
  ExternalLink,
  PencilLine,
  Sparkles,
  Trash2,
} from "lucide-react";
import { type Entry, sourceLabels } from "@/lib/types";
import { validateContent } from "@/lib/validation";
import {
  AutoTextarea,
  Button,
  ConfirmDialog,
  EntryTime,
  Notice,
  useUnsavedChanges,
} from "./ui";
import { Brand } from "./brand";

export function EntryDetail({
  initialEntry,
  returnPath,
}: {
  initialEntry: Entry;
  returnPath: string;
}) {
  const [entry, setEntry] = useState(initialEntry);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(initialEntry.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<"delete" | "leave" | "cancel" | null>(
    null,
  );
  const [refreshError, setRefreshError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [leaveDestination, setLeaveDestination] = useState(returnPath);
  const submitting = useRef(false);
  const router = useRouter();
  const dirty = editing && content !== entry.content;
  useUnsavedChanges(dirty);

  useEffect(() => {
    if (entry.status !== "pending" || busy || editing) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/entries/${entry.id}`, {
          signal: abort.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!abort.signal.aborted && !submitting.current) {
          setEntry(data.entry);
          setRefreshError(false);
        }
      } catch {
        if (!abort.signal.aborted) setRefreshError(true);
      }
    }, 1600);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [entry, busy, editing, retry]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    try {
      validateContent(content, Boolean(entry.imageUrl));
    } catch (err) {
      setError((err as Error).message);
      document.getElementById("edit-content")?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/entries/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, version: entry.version }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存未完成，请重试。");
      setEntry(data.entry);
      setContent(data.entry.content);
      setEditing(false);
      setMessage("修改已保存，摘要与标签会重新整理。");
    } catch (err) {
      setError(
        err instanceof Error && !(err instanceof TypeError)
          ? err.message
          : "连接中断，请重试。输入内容仍保留。",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/entries/${entry.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error);
      }
      setDialog(null);
      setEditing(false);
      router.push(returnPath);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error && !(err instanceof TypeError)
          ? err.message
          : "删除未完成，请检查连接后重试。",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function cancelEdit() {
    setContent(entry.content);
    setEditing(false);
    setError("");
    setDialog(null);
  }
  function navigate(destination: string) {
    if (dirty) {
      setLeaveDestination(destination);
      setDialog("leave");
    } else router.push(destination);
  }
  function goBack() {
    navigate(returnPath);
  }
  function confirmAction() {
    if (dialog === "delete") void remove();
    else if (dialog === "leave") {
      setDialog(null);
      setEditing(false);
      router.push(leaveDestination);
    } else cancelEdit();
  }

  return (
    <main id="main-content" className="detail-shell">
      <header className="detail-topbar">
        <button className="back-button" onClick={goBack} disabled={busy}>
          <ArrowLeft size={17} />
          返回收件箱
        </button>
        <Brand />
      </header>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">让每个想法，都有后续</p>
          <h1>记录详情</h1>
        </div>
        <span className={`source-badge source-${entry.source}`}>
          {sourceLabels[entry.source]}
        </span>
      </div>
      <article className="detail-card">
        <div className="detail-meta">
          <span>
            创建于 <EntryTime value={entry.createdAt} />
          </span>
          {entry.updatedAt !== entry.createdAt && (
            <span>
              编辑于 <EntryTime value={entry.updatedAt} />
            </span>
          )}
        </div>
        {entry.title && <h2 className="detail-title">{entry.title}</h2>}
        {entry.imageUrl && (
          <div className="detail-image">
            <Image
              src={entry.imageUrl}
              alt={entry.imageName || "记录图片"}
              width={1200}
              height={900}
              unoptimized
              className="detail-photo"
            />
            <span>{entry.imageName}</span>
          </div>
        )}
        {editing ? (
          <form noValidate onSubmit={save} aria-busy={busy}>
            <label htmlFor="edit-content" className="field-label">
              原始内容
            </label>
            <AutoTextarea
              autoFocus
              id="edit-content"
              name="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={50000}
              rows={8}
              disabled={busy}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "edit-error" : undefined}
              className="edit-textarea"
            />
            {error && (
              <Notice id="edit-error" tone="error">
                {error}
              </Notice>
            )}
            <div className="edit-actions">
              <Button
                type="button"
                intent="neutral"
                disabled={busy}
                onClick={() => (dirty ? setDialog("cancel") : cancelEdit())}
              >
                取消编辑
              </Button>
              <Button type="submit" busy={busy}>
                保存修改
              </Button>
            </div>
          </form>
        ) : (
          <>
            <h2 className="section-label">原始内容</h2>
            <p className="detail-content">
              {entry.content || "这条记录只有图片。可添加说明，帮助自动整理。"}
            </p>
            {entry.url && (
              <a
                className="original-link"
                href={entry.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开原网页
                <ExternalLink size={14} />
              </a>
            )}
            <div className="detail-actions">
              <Button
                intent="neutral"
                onClick={() => {
                  setContent(entry.content);
                  setEditing(true);
                  setMessage("");
                  setError("");
                }}
              >
                <PencilLine size={16} />
                编辑内容
              </Button>
              <button
                className="delete-button"
                onClick={() => {
                  setDialog("delete");
                  setError("");
                }}
              >
                <Trash2 size={16} />
                删除记录
              </button>
            </div>
          </>
        )}
      </article>
      {message && <Notice tone="success">{message}</Notice>}
      <section
        className="organization-card"
        aria-labelledby="organization-title"
      >
        <div className="organization-heading">
          <span>
            <Sparkles size={19} />
            <h2 id="organization-title">自动整理</h2>
          </span>
          <span className="organizer-label">
            {entry.status === "pending"
              ? "整理中"
              : entry.provider === "rules"
                ? "规则整理"
                : entry.provider === "openai"
                  ? "OpenAI"
                  : "Anthropic"}
          </span>
        </div>
        <p className="detail-summary">
          {entry.status === "pending"
            ? "原始内容已保存，摘要和标签正在整理中…"
            : entry.summary}
        </p>
        <div className="tags">
          {entry.tags.map((tag) => (
            <button
              className="tag"
              key={tag}
              onClick={() => navigate(`/?tag=${encodeURIComponent(tag)}`)}
            >
              # {tag}
            </button>
          ))}
        </div>
        {entry.status === "fallback" && (
          <p className="subtle mt-4">
            模型暂时不可用，已使用本地规则完成整理。
          </p>
        )}
        {entry.source === "image" && (
          <p className="subtle mt-4">
            标签根据文字说明生成；当前版本不识别图片内容。
          </p>
        )}
        {entry.url && entry.status !== "pending" && !entry.title && (
          <p className="subtle mt-4">暂未获取到网页标题，原始链接已保留。</p>
        )}
        {refreshError && (
          <Notice tone="error">
            整理状态更新失败。
            <button
              className="inline-action"
              onClick={() => {
                setRefreshError(false);
                setRetry((n) => n + 1);
              }}
            >
              重试
            </button>
          </Notice>
        )}
      </section>
      <footer className="page-footer">
        <span>Spark · 留住每一个小念头</span>
      </footer>
      <ConfirmDialog
        open={Boolean(dialog)}
        onClose={() => {
          setDialog(null);
          setError("");
        }}
        onConfirm={confirmAction}
        busy={busy}
        danger={dialog === "delete"}
        title={dialog === "delete" ? "删除这条记录？" : "放弃未保存的修改？"}
        confirmLabel={dialog === "delete" ? "删除记录" : "放弃修改"}
      >
        <p>
          {dialog === "delete"
            ? "原始内容、图片、摘要和标签将永久删除，无法恢复。"
            : "你的修改还未保存。放弃后，仍会保留上一次保存的内容。"}
        </p>
        {error && dialog === "delete" && <Notice tone="error">{error}</Notice>}
      </ConfirmDialog>
    </main>
  );
}
