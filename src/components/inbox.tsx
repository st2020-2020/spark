"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import {
  ArrowUp,
  Hash,
  ImagePlus,
  Inbox as InboxIcon,
  Search,
  Sparkles,
  X,
  Layers3,
  ShieldCheck,
  ArrowDown,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { Entry } from "@/lib/types";
import { extractUrl, validateContent, validateImage } from "@/lib/validation";
import { AutoTextarea, Button, Notice, useUnsavedChanges } from "./ui";
import { Brand } from "./brand";
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
  const [optimisticId, setOptimisticId] = useState<string | null>(null);
  const inputFile = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const mutationEpoch = useRef(0);
  const params = useSearchParams();
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

  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <p className="workspace-label">我的灵感空间</p>
        <button
          className="nav-item active"
          onClick={() => {
            filters("", "");
            document
              .getElementById("records")
              ?.scrollIntoView({ behavior: "smooth" });
          }}
        >
          <InboxIcon size={19} />
          收件箱
          <span>{entries.filter((e) => e.id !== optimisticId).length}</span>
        </button>
        <div className="sidebar-section-title">
          <span>自动整理的标签</span>
          <Hash size={14} />
        </div>
        <div className="sidebar-tags">
          {tags.length ? (
            tags.map(([tag, count]) => (
              <button
                key={tag}
                onClick={() => filters(query, selectedTag === tag ? "" : tag)}
                className={`tag-nav ${selectedTag === tag ? "selected" : ""}`}
                aria-pressed={selectedTag === tag}
              >
                <span># {tag}</span>
                <span>{count}</span>
              </button>
            ))
          ) : (
            <p className="subtle">记下第一条，标签就会在这里出现。</p>
          )}
        </div>
        <div className="sidebar-note">
          <span className="small-spark">
            <Sparkles size={18} />
          </span>
          <strong>先记下，再整理。</strong>
          <p>一句灵感、一篇文章、一张图片，都值得留下。</p>
        </div>
        <div className="local-note">
          <ShieldCheck size={14} />
          保存在本机 · 个人空间
        </div>
      </aside>

      <main id="main-content" className="main-workspace">
        <div className="mobile-brand">
          <Brand />
          <span className="local-chip">我的灵感空间</span>
        </div>
        <header className="page-header">
          <div>
            <p className="eyebrow">
              <span className="status-dot" />
              给想法一个落脚点
            </p>
            <h1>
              随手记，<span>慢慢想。</span>
            </h1>
            <p className="page-description">
              把零散的灵感留下，让整理自然发生。
            </p>
          </div>
          <div className="header-symbol" aria-hidden="true">
            <Sparkles size={38} strokeWidth={1.3} />
          </div>
        </header>

        <section className="stats-row" aria-label="记录统计">
          <div className="stat">
            <span className="stat-icon">
              <Layers3 size={18} />
            </span>
            <div>
              <strong>
                {entries.filter((e) => e.id !== optimisticId).length}
                <small>条</small>
              </strong>
              <span>全部记录</span>
            </div>
          </div>
          <div className="stat">
            <span className="stat-icon lavender">
              <Hash size={18} />
            </span>
            <div>
              <strong>
                {tags.length}
                <small>个</small>
              </strong>
              <span>自动整理的标签</span>
            </div>
          </div>
          <div className="stats-caption">
            <Sparkles size={15} />
            <span>
              灵感负责出现
              <br />
              Spark 负责归拢
            </span>
          </div>
        </section>

        <section className="capture-card" aria-labelledby="capture-label">
          <form noValidate onSubmit={submit} aria-busy={busy}>
            <label
              id="capture-label"
              htmlFor="capture"
              className="capture-label"
            >
              <Plus size={18} />
              此刻，想记点什么？
            </label>
            <AutoTextarea
              id="capture"
              name="content"
              placeholder="一个想法、一段文字，或粘贴一个链接…"
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
              rows={4}
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
                disabled={busy}
                onClick={() => inputFile.current?.click()}
              >
                <ImagePlus size={18} />
                添加图片
              </button>
              <span className="capture-hint" id="capture-help">
                单张图片 ≤ 5 MB
              </span>
              <Button type="submit" busy={busy} className="capture-submit">
                <span>{busy ? "保存中" : "记下来"}</span>
                {!busy && <ArrowUp size={17} />}
              </Button>
            </div>
            {error && (
              <Notice id="capture-error" tone="error">
                {error}
              </Notice>
            )}
          </form>
          <div className="organize-hint">
            <Sparkles size={14} />
            <span>自动生成摘要与标签，先记录，不必想好分类。</span>
          </div>
        </section>
        <div className="feedback-slot" aria-live="polite">
          {message && <span className="save-feedback">✓ {message}</span>}
        </div>

        <section id="records" aria-labelledby="records-title">
          <div className="list-heading">
            <div>
              <h2 id="records-title">
                {selectedTag ? `# ${selectedTag}` : "收件箱"}
                <span>{visible.length}</span>
              </h2>
              <p>每一条灵感，都在这里。</p>
            </div>
            <span className="sort-label">
              <ArrowDown size={13} />
              最近记录
            </span>
          </div>
          <div className="search-box">
            <Search size={18} aria-hidden="true" />
            <label htmlFor="search" className="sr-only">
              搜索记录
            </label>
            <input
              ref={search}
              id="search"
              type="search"
              placeholder="搜索内容、摘要或标签"
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
                {query || selectedTag
                  ? "还没找到匹配的记录"
                  : "你的下一次灵感，从这里开始"}
              </h3>
              <p>
                {query || selectedTag
                  ? "换个关键词，或清除筛选再看看。"
                  : "记下一句想法，收藏一篇文章，或留住一张图片。"}
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
        <footer className="page-footer">
          <span>Spark · 留住每一个小念头</span>
          <span>不必完整，先记下来。</span>
        </footer>
      </main>
    </div>
  );
}
