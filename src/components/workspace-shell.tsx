"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, Hash, Inbox, Plus, ShieldCheck } from "lucide-react";
import { Brand } from "./brand";

export function WorkspaceShell({
  children,
  detail = false,
  busy = false,
  count,
  tags = [],
  activity,
  selectedTag = "",
  onInbox,
  onCapture,
  onTag,
}: {
  children: ReactNode;
  detail?: boolean;
  busy?: boolean;
  count?: number;
  tags?: [string, number | null][];
  activity?: string[];
  selectedTag?: string;
  onInbox: () => void;
  onCapture: () => void;
  onTag: (tag: string) => void;
}) {
  return (
    <div className="workspace">
      <aside className="sidebar" aria-label="工作空间导航">
        <Brand />
        {count !== undefined && (
          <div className="sidebar-stats">
            <div>
              <strong>{count}</strong>
              <span>笔记</span>
            </div>
            <div>
              <strong>{tags.length}</strong>
              <span>标签</span>
            </div>
          </div>
        )}
        {activity && <ActivityCalendar dates={activity} />}
        <button
          className="button btn button-neutral sidebar-create"
          onClick={onCapture}
          disabled={busy}
        >
          <Plus size={17} aria-hidden="true" />
          新建记录
        </button>
        <nav aria-label="记录导航">
          <button
            className={`nav-item ${!detail && !selectedTag ? "active" : ""}`}
            onClick={onInbox}
            disabled={busy}
            aria-current={!detail && !selectedTag ? "page" : undefined}
          >
            <Inbox size={18} aria-hidden="true" />
            <span>全部笔记</span>
            {count !== undefined && <span className="nav-count">{count}</span>}
          </button>
        </nav>
        <div className="sidebar-section-title">
          <span>{detail ? "这条记录的标签" : "标签"}</span>
          <span>{tags.length}</span>
        </div>
        <div className="sidebar-tags">
          {tags.length ? (
            tags.map(([tag, total]) => (
              <button
                key={tag}
                className={`tag-nav ${selectedTag === tag ? "selected" : ""}`}
                aria-pressed={selectedTag === tag}
                onClick={() => onTag(tag)}
                disabled={busy}
              >
                <Hash size={15} aria-hidden="true" />
                <span>{tag}</span>
                {total !== null && <span className="nav-count">{total}</span>}
              </button>
            ))
          ) : (
            <p className="subtle">保存记录后，标签会自动出现在这里。</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>保存在本机</span>
            <span className="status-dot" />
          </div>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar">
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="breadcrumbs">
            <span>我的空间</span>
            <ChevronRight size={14} aria-hidden="true" />
            {detail ? (
              <>
                <button onClick={onInbox} disabled={busy}>
                  收件箱
                </button>
                <ChevronRight size={14} aria-hidden="true" />
                <span aria-current="page">记录详情</span>
              </>
            ) : (
              <span aria-current="page">收件箱</span>
            )}
          </div>
          <span className="topbar-local">
            <span className="status-dot" />
            个人空间
          </span>
        </header>
        <main
          id="main-content"
          className={`main-workspace ${detail ? "detail-workspace" : ""}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function ActivityCalendar({ dates }: { dates: string[] }) {
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dayKey = (date: Date) =>
      `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const counts = new Map<string, number>();
    for (const value of dates) {
      const key = dayKey(new Date(value));
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const today = new Date();
    const cells = Array.from({ length: 84 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() - 83 + index);
      const count = counts.get(dayKey(date)) || 0;
      const cell = document.createElement("span");
      cell.className = `activity-cell activity-level-${Math.min(count, 4)}`;
      cell.title = `${date.toLocaleDateString("zh-CN")} · ${count} 条记录`;
      return cell;
    });
    grid.current?.replaceChildren(...cells);
  }, [dates]);
  return (
    <div className="activity-calendar">
      <div
        className="activity-grid"
        ref={grid}
        role="img"
        aria-label="最近十二周的记录活跃情况"
      />
      <div className="activity-legend">
        <span>近 12 周</span>
        <span>
          少 <i className="activity-cell activity-level-0" />
          <i className="activity-cell activity-level-2" />
          <i className="activity-cell activity-level-4" /> 多
        </span>
      </div>
    </div>
  );
}
