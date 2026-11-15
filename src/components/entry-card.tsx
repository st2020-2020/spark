"use client";

import Link from "next/link";
import Image from "next/image";
import {
  ArrowUpRight,
  FileText,
  ImageIcon,
  Link2,
  Sparkles,
  LoaderCircle,
} from "lucide-react";
import { sourceLabels, type Entry } from "@/lib/types";
import { EntryTime } from "./ui";

const icons = { text: FileText, url: Link2, image: ImageIcon };

export function EntryCard({
  entry,
  onTag,
  returnPath,
  optimistic = false,
}: {
  entry: Entry;
  onTag: (tag: string) => void;
  returnPath: string;
  optimistic?: boolean;
}) {
  const Icon = icons[entry.source];
  return (
    <article
      className={`entry-card ${optimistic ? "entry-saving" : ""}`}
      aria-label={entry.title || entry.content.slice(0, 60) || "图片记录"}
    >
      <div className="entry-meta">
        <span className={`source-badge source-${entry.source}`}>
          <Icon size={14} aria-hidden="true" />
          {sourceLabels[entry.source]}
        </span>
        <EntryTime value={entry.createdAt} />
        <span className="entry-open">
          {optimistic ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <ArrowUpRight size={19} />
          )}
        </span>
      </div>
      {entry.title && <h3 className="entry-title">{entry.title}</h3>}
      {entry.imageUrl && (
        <div className="entry-image">
          <Image
            src={entry.imageUrl}
            alt={entry.imageName || "上传的图片"}
            fill
            unoptimized
            sizes="(max-width: 600px) 100vw, 700px"
          />
        </div>
      )}
      {entry.content && (
        <p className="entry-content line-clamp-4">{entry.content}</p>
      )}
      <div className="entry-summary">
        <Sparkles size={14} aria-hidden="true" />
        <p>
          {optimistic
            ? "正在保存原始内容…"
            : entry.status === "pending"
              ? "已保存，正在整理摘要和标签…"
              : entry.summary}
        </p>
      </div>
      <div className="entry-bottom">
        <div className="tags">
          {entry.tags.map((tag) => (
            <button
              className="tag"
              key={tag}
              onClick={() => onTag(tag)}
              aria-label={`筛选标签 ${tag}`}
            >
              # {tag}
            </button>
          ))}
        </div>
        {!optimistic && (
          <Link
            className="detail-link"
            href={`/entries/${entry.id}?from=${encodeURIComponent(returnPath)}`}
          >
            查看详情
            <span className="sr-only">
              ：{entry.title || entry.content.slice(0, 30) || "图片"}
            </span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>
    </article>
  );
}
