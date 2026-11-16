"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import {
  SendHorizontal,
  Hash,
  ImagePlus,
  Inbox as InboxIcon,
  X,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { Entry } from "@/lib/types";
import { extractUrl, validateContent, validateImage } from "@/lib/validation";
import {
  AutoTextarea,
  Button,
  ConfirmDialog,
  Notice,
  useUnsavedChanges,
} from "./ui";
import { WorkspaceShell } from "./workspace-shell";
import { EntryCard } from "./entry-card";

export function Inbox({ initialEntries }: { initialEntries: Entry[] }) {
  const [entries, setEntries] = useState(initialEntries);
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [leavePath, setLeavePath] = useState<string | null>(null);
  const [optimisticId, setOptimisticId] = useState<string | null>(null);
  const inputFile = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const mutationEpoch = useRef(0);
  const params = useSearchParams();
  const router = useRouter();
  const query = params.get("q") || "";
  const selectedTag = params.get("tag") || "";
  useUnsavedChanges(Boolean(content || file));

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (submitting.current) return;
    const epoch = mutationEpoch.current;
    try {
      const response = await fetch("/api/entries", {
        signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (
        !submitting.current &&
        !signal?.aborted &&
        epoch === mutationEpoch.current
      ) {
        setEntries(data.entries);
        setRefreshError("");
      }
    } catch {
      if (!signal?.aborted)
        setRefreshError("列表更新失败。已有记录仍可查看，请检查连接后重试。");
    }
  }, []);
  const pending = entries.some((e) => e.status === "pending");
  useEffect(() => {
    if (!pending || busy || refreshError) return;
    const abort = new AbortController();
    const timer = setTimeout(() => void refresh(abort.signal), 1600);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [entries, pending, busy, refreshError, refresh]);
  useEffect(() => {
    const abort = new AbortController();
    const onFocus = () => void refresh(abort.signal);
    window.addEventListener("focus", onFocus);
    return () => {
      abort.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  function filters(q: string, tag: string) {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (tag) next.set("tag", tag);
    window.history.replaceState(null, "", next.size ? `/?${next}` : "/");
  }

  function chooseFile(picked?: File) {
    if (!picked) return;
    const problem = validateImage(picked);
    if (problem) {
      setError(problem);
      return;
    }
    setFile(picked);
    setPreview(URL.createObjectURL(picked));
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    try {
      validateContent(content, Boolean(file));
    } catch (err) {
      setError((err as Error).message);
      document.getElementById("capture")?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    mutationEpoch.current++;
    const id = `pending-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const url = extractUrl(content);
    setOptimisticId(id);
    setEntries((previous) => [
      {
        id,
        content: content.trim(),
        source: file ? "image" : url ? "url" : "text",
        url,
        title: null,
        imageUrl: preview,
        imageName: file?.name || null,
        tags: [],
        summary: "",
        status: "pending",
        provider: "rules",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      ...previous,
    ]);
    filters("", "");
    try {
      const data = new FormData();
      data.set("content", content);
      if (file) data.set("image", file);
      const response = await fetch("/api/entries", {
        method: "POST",
        body: data,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存未完成，请重试。");
      setEntries((previous) => [
        result.entry,
        ...previous.filter((e) => e.id !== id && e.id !== result.entry.id),
      ]);
      setContent("");
      setFile(null);
      setPreview(null);
      if (inputFile.current) inputFile.current.value = "";
      setMessage("已保存。摘要和标签会自动补上。");
    } catch (err) {
      setEntries((previous) => previous.filter((e) => e.id !== id));
      setError(
        err instanceof Error && !(err instanceof TypeError)
          ? err.message
          : "连接中断，请重试。内容仍保留在输入框。",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
      setOptimisticId(null);
    }
  }

  const tagCounts = new Map<string, number>();
  entries
    .filter((e) => e.id !== optimisticId)
    .forEach((e) =>
      e.tags.forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)),
    );
  const tags = [...tagCounts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"),
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = entries.filter(
    (e) =>
      e.id === optimisticId ||
      ((!selectedTag || e.tags.includes(selectedTag)) &&
        (!needle ||
          [e.content, e.title || "", e.summary, ...e.tags]
            .join(" ")
            .toLocaleLowerCase()
            .includes(needle))),
  );
  const returnPath = `/${params.size ? `?${params}` : ""}`;
  const activity = useMemo(
    () =>
      entries
        .filter((entry) => entry.id !== optimisticId)
        .map((entry) => entry.createdAt),
    [entries, optimisticId],
  );

  return (
    <WorkspaceShell
      count={entries.filter((e) => e.id !== optimisticId).length}
      tags={tags}
      activity={activity}
      selectedTag={selectedTag}
      onInbox={() => {
        filters("", "");
        document.getElementById("records")?.scrollIntoView();
      }}
      onCapture={() => document.getElementById("capture")?.focus()}
      onTag={(tag) => filters(query, selectedTag === tag ? "" : tag)}
    >
      <header className="page-header">
        <h1>{selectedTag ? `# ${selectedTag}` : "全部笔记"}</h1>
        <div className="search-box">
          <label htmlFor="search" className="search-label">
            搜索
          </label>
          <input
            ref={search}
            id="search"
            type="search"
            placeholder="内容、摘要或标签"
            value={query}
            onChange={(e) => filters(e.target.value, selectedTag)}
          />
          {query && (
            <button
              className="icon-button"
              onClick={() => {
                filters("", selectedTag);
                search.current?.focus();
              }}
              aria-label="清除搜索"
            >
              <X size={17} />
            </button>
          )}
        </div>
      </header>

      <section className="capture-card" aria-labelledby="capture-label">
        <form
          noValidate
          onSubmit={submit}
          aria-busy={busy}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
        >
          <label id="capture-label" htmlFor="capture" className="sr-only">
            记录想法
          </label>
          <AutoTextarea
            id="capture"
            name="content"
            placeholder="现在的想法是…"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setError("");
            }}
            disabled={busy}
            aria-invalid={Boolean(error)}
            aria-describedby={
              error ? "capture-error capture-help" : "capture-help"
            }
            maxLength={50000}
            rows={2}
            minimumHeight={84}
          />
          {file && (
            <div className="upload-preview">
              {preview && (
                <Image
                  src={preview}
                  alt="待上传图片预览"
                  width={64}
                  height={64}
                  unoptimized
                />
              )}
              <div>
                <strong>{file.name}</strong>
                <span>{(file.size / 1024).toFixed(0)} KB · 待保存</span>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="移除待上传图片"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setPreview(null);
                  if (inputFile.current) inputFile.current.value = "";
                }}
              >
                <X size={17} />
              </button>
            </div>
          )}
          <div className="capture-actions">
            <input
              id="image-upload"
              ref={inputFile}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              hidden
              aria-label="选择图片"
              tabIndex={-1}
              onChange={(e) => chooseFile(e.target.files?.[0])}
              disabled={busy}
            />
            <button
              type="button"
              className="upload-button"
              title="添加标签"
              aria-label="添加标签"
              disabled={busy}
              onClick={() => {
                setContent(
                  (value) =>
                    `${value}${value && !/\s$/.test(value) ? " " : ""}#`,
                );
                requestAnimationFrame(() =>
                  document.getElementById("capture")?.focus(),
                );
              }}
            >
              <Hash size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="upload-button"
              aria-label="添加图片"
              title="添加图片"
              disabled={busy}
              onClick={() => inputFile.current?.click()}
            >
              <ImagePlus size={18} aria-hidden="true" />
            </button>
            <span className="sr-only" id="capture-help">
              单张图片 ≤ 5 MB
            </span>
            <span className="keyboard-hint" aria-hidden="true">
              <kbd>⌘ / Ctrl</kbd>
              <kbd>↵</kbd>
            </span>
            <Button type="submit" busy={busy} className="capture-submit">
              <span>记录</span>
              <SendHorizontal size={16} aria-hidden="true" />
            </Button>
          </div>
          {error && (
            <Notice id="capture-error" tone="error">
              {error}
            </Notice>
          )}
        </form>
      </section>
      <div className="feedback-slot" aria-live="polite">
        {message && <span className="save-feedback">✓ {message}</span>}
      </div>

      <section id="records" aria-labelledby="records-title">
        <div className="list-heading">
          <h2 id="records-title">最近记录</h2>
          <span>{visible.length} 条笔记</span>
        </div>
        <div className="mobile-tags" aria-label="按标签筛选">
          <button
            className={`tag ${!selectedTag ? "tag-active" : ""}`}
            onClick={() => filters(query, "")}
            aria-pressed={!selectedTag}
          >
            全部
          </button>
          {tags.map(([tag]) => (
            <button
              key={tag}
              className={`tag ${selectedTag === tag ? "tag-active" : ""}`}
              onClick={() => filters(query, selectedTag === tag ? "" : tag)}
              aria-pressed={selectedTag === tag}
            >
              # {tag}
            </button>
          ))}
        </div>
        {(query || selectedTag) && (
          <div className="filter-summary" role="status">
            <span>
              找到 {visible.length} 条记录{query ? ` · “${query}”` : ""}
            </span>
            <button onClick={() => filters("", "")}>清除筛选</button>
          </div>
        )}
        {refreshError && (
          <Notice tone="error">
            {refreshError}
            <button className="inline-action" onClick={() => void refresh()}>
              <RefreshCw size={14} />
              重试
            </button>
          </Notice>
        )}
        <div className="entries-list">
          {visible.map((entry) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              optimistic={entry.id === optimisticId}
              returnPath={returnPath}
              onOpen={(destination) => {
                if (content || file) setLeavePath(destination);
                else router.push(destination);
              }}
              onTag={(tag) => filters(query, tag)}
            />
          ))}
        </div>
        {!visible.length && (
          <div className="empty-state">
            <span className="empty-icon">
              <InboxIcon size={32} strokeWidth={1.3} />
            </span>
            <h3>
              {query || selectedTag ? "还没找到匹配的记录" : "还没有记录"}
            </h3>
            <p>
              {query || selectedTag
                ? "换个关键词，或清除筛选再看看。"
                : "从一句想法开始。文字、链接和图片都能保存。"}
            </p>
            <Button
              intent="neutral"
              onClick={() => {
                filters("", "");
                document.getElementById("capture")?.focus();
              }}
            >
              {query || selectedTag ? "清除筛选，记点新的" : "写下第一条"}
              <Plus size={16} />
            </Button>
          </div>
        )}
      </section>
      <ConfirmDialog
        open={Boolean(leavePath)}
        onClose={() => setLeavePath(null)}
        onConfirm={() => {
          if (leavePath) router.push(leavePath);
          setLeavePath(null);
        }}
        title="放弃未保存的记录？"
        confirmLabel="放弃记录"
      >
        <p>当前输入的文字和图片还未保存。返回后无法恢复，取消可继续记录。</p>
      </ConfirmDialog>
    </WorkspaceShell>
  );
}
