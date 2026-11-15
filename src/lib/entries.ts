import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { extractUrl, InputError, validateContent } from "./validation";
import { organize } from "./ai";
import { fetchUrlTitle } from "./url-title";
import type { Entry, Source } from "./types";

type Row = {
  id: string;
  content: string;
  source: Source;
  url: string | null;
  title: string | null;
  image_name: string | null;
  summary: string;
  tags: string;
  status: Entry["status"];
  provider: string;
  version: number;
  created_at: string;
  updated_at: string;
};
const columns =
  "id,content,source,url,title,image_name,summary,tags,status,provider,version,created_at,updated_at";
function toEntry(row: Row): Entry {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    url: row.url,
    title: row.title,
    imageUrl: row.image_name ? `/api/entries/${row.id}/image` : null,
    imageName: row.image_name,
    summary: row.summary,
    tags: JSON.parse(row.tags),
    status: row.status,
    provider: row.provider,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function listEntries(): Entry[] {
  return (
    getDb()
      .prepare(
        `SELECT ${columns} FROM entries ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as Row[]
  ).map(toEntry);
}
export function getEntry(id: string): Entry | null {
  const row = getDb()
    .prepare(`SELECT ${columns} FROM entries WHERE id=?`)
    .get(id) as Row | undefined;
  return row ? toEntry(row) : null;
}
export function createEntry(
  content: string,
  image?: { data: Buffer; type: string; name: string },
) {
  content = validateContent(content, Boolean(image));
  const id = randomUUID();
  const url = extractUrl(content);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO entries (id, content, source, url, image, image_type, image_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      content,
      image ? "image" : url ? "url" : "text",
      url,
      image?.data || null,
      image?.type || null,
      image?.name || null,
      now,
      now,
    );
  return getEntry(id)!;
}
export function updateEntry(id: string, content: string, version: number) {
  const entry = getEntry(id);
  if (!entry) throw new InputError("这条记录不存在或已被删除。", 404);
  content = validateContent(content, Boolean(entry.imageUrl));
  const url = extractUrl(content);
  const result = getDb()
    .prepare(
      `UPDATE entries SET content=?, url=?, source=?, title=NULL, summary='', tags='[]', status='pending', version=version+1, updated_at=? WHERE id=? AND version=?`,
    )
    .run(
      content,
      url,
      entry.imageUrl ? "image" : url ? "url" : "text",
      new Date().toISOString(),
      id,
      version,
    );
  if (!result.changes)
    throw new InputError(
      "记录已在其他页面更新，请刷新后再编辑。当前输入仍保留。",
      409,
    );
  return getEntry(id)!;
}
export function deleteEntry(id: string) {
  if (!getDb().prepare("DELETE FROM entries WHERE id=?").run(id).changes)
    throw new InputError("这条记录不存在或已被删除。", 404);
}

const active = new Map<string, Promise<void>>();
export function enrichEntry(id: string): Promise<void> {
  if (active.has(id)) return active.get(id)!;
  const promise = (async () => {
    const entry = getEntry(id);
    if (!entry || entry.status !== "pending") return;
    const title = entry.url ? await fetchUrlTitle(entry.url) : null;
    const result = await organize({
      content: entry.content,
      title,
      source: entry.source,
      imageName: entry.imageName,
    });
    getDb()
      .prepare(
        `UPDATE entries SET title=?, summary=?, tags=?, status=?, provider=? WHERE id=? AND version=? AND status='pending'`,
      )
      .run(
        title,
        result.summary,
        JSON.stringify(result.tags),
        result.status,
        result.provider,
        id,
        entry.version,
      );
  })()
    .catch(() => {
      /* Keep pending for the next read to retry. */
    })
    .finally(() => active.delete(id));
  active.set(id, promise);
  return promise;
}
export async function resumePending() {
  const pending = getDb()
    .prepare(
      "SELECT id FROM entries WHERE status='pending' ORDER BY created_at DESC",
    )
    .all() as { id: string }[];
  // Bounded concurrency, also handles records saved just before a process restart.
  for (let i = 0; i < pending.length; i += 3)
    await Promise.all(pending.slice(i, i + 3).map((e) => enrichEntry(e.id)));
}
