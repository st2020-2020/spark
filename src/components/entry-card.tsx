"use client";

import Link from "next/link";
import Image from "next/image";
import {
  ArrowUpRight,
  FileText,
  ImageIcon,
  Link2,
  LoaderCircle,
} from "lucide-react";
import { sourceLabels, type Entry } from "@/lib/types";
import { EntryTime } from "./ui";

const icons = { text: FileText, url: Link2, image: ImageIcon };

export function EntryCard({
  entry,
  onTag,
  returnPath,
  onOpen,
  optimistic = false,
}: {
  entry: Entry;
  onTag: (tag: string) => void;
  returnPath: string;
  onOpen: (destination: string) => void;
  optimistic?: boolean;
}) {
  const Icon = icons[entry.source];
  return (
    <article
      className={`entry-card card ${optimistic ? "entry-saving m-nolift" : ""}`}
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
        <div className="entry-image m-zoom">
          <Image
            src={entry.imageUrl}
            alt={entry.imageName || "上传的图片"}
            fill
            unoptimized
            sizes="(max-width: 600px) 100vw, (min-width: 1180px) 40vw, 700px"
          />
        </div>
      )}
      {entry.content && (
        <p className="entry-content line-clamp-8">{entry.content}</p>
      )}
      {(optimistic || entry.status === "pending") && (
        <p className="entry-pending">
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
          {optimistic ? "正在保存…" : "正在整理…"}
        </p>
      )}
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
            prefetch={false}
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey ||
                event.button !== 0
              )
                return;
              event.preventDefault();
              onOpen(
                `/entries/${entry.id}?from=${encodeURIComponent(returnPath)}`,
              );
            }}
          >
            打开记录
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
