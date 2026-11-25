import type { Project, Tag } from '../api/types';

export interface SidebarPrefs {
  pinnedProjectIds: string[] | null;
  pinnedTagIds: string[] | null;
  pinnedProjectMeta?: Record<string, string>;
  pinnedTagMeta?: Record<string, string>;
}

const STORAGE_PREFIX = 'spark:sidebar-prefs:v1:';
const MAX_PINNED_ITEMS = 200;
export const DEFAULT_SIDEBAR_ITEMS = 5;

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function sanitizeIdList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_PINNED_ITEMS) break;
  }
  return out.length > 0 ? out : null;
}

function sanitizeMetaMap(raw: unknown, allowedIds: readonly string[] | null): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !allowedIds) return {};
  const allowed = new Set(allowedIds);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed) out[k] = trimmed;
  }
  return out;
}

export function loadSidebarPrefs(userId?: string): SidebarPrefs {
  if (!userId || typeof window === 'undefined') {
    return { pinnedProjectIds: null, pinnedTagIds: null };
  }
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return { pinnedProjectIds: null, pinnedTagIds: null };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { pinnedProjectIds: null, pinnedTagIds: null };
    }
    const obj = parsed as Record<string, unknown>;
    const pinnedProjectIds = sanitizeIdList(obj.pinnedProjectIds);
    const pinnedTagIds = sanitizeIdList(obj.pinnedTagIds);
    return {
      pinnedProjectIds,
      pinnedTagIds,
      pinnedProjectMeta: sanitizeMetaMap(obj.pinnedProjectMeta, pinnedProjectIds),
      pinnedTagMeta: sanitizeMetaMap(obj.pinnedTagMeta, pinnedTagIds),
    };
  } catch {
    return { pinnedProjectIds: null, pinnedTagIds: null };
  }
}

export function saveSidebarPrefs(
  userId: string | undefined,
  patch: Partial<SidebarPrefs>,
): SidebarPrefs {
  const current = loadSidebarPrefs(userId);
  const nextProjectIds =
    patch.pinnedProjectIds !== undefined
      ? sanitizeIdList(patch.pinnedProjectIds)
      : current.pinnedProjectIds;
  const nextTagIds =
    patch.pinnedTagIds !== undefined
      ? sanitizeIdList(patch.pinnedTagIds)
      : current.pinnedTagIds;
  const next: SidebarPrefs = {
    pinnedProjectIds: nextProjectIds,
    pinnedTagIds: nextTagIds,
    pinnedProjectMeta: sanitizeMetaMap(
      patch.pinnedProjectMeta !== undefined ? patch.pinnedProjectMeta : current.pinnedProjectMeta,
      nextProjectIds,
    ),
    pinnedTagMeta: sanitizeMetaMap(
      patch.pinnedTagMeta !== undefined ? patch.pinnedTagMeta : current.pinnedTagMeta,
      nextTagIds,
    ),
  };
  if (!userId || typeof window === 'undefined') return next;
  try {
    if (!next.pinnedProjectIds && !next.pinnedTagIds) {
      window.localStorage.removeItem(storageKey(userId));
    } else {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(next));
    }
  } catch {
    // Ignore storage quota/private mode errors; keep UI responsive.
  }
  return next;
}

export interface SidebarProjectDisplay {
  id: string;
  name: string;
}

export function resolveSidebarProjects(
  activeProjects: readonly Project[],
  pinnedIds: readonly string[] | null,
  limit = DEFAULT_SIDEBAR_ITEMS,
  options?: { meta?: Record<string, string>; allActiveLoaded?: boolean },
): { visible: SidebarProjectDisplay[]; isCustomized: boolean; validPinnedIds: string[] } {
  if (pinnedIds && pinnedIds.length > 0) {
    const byId = new Map(activeProjects.map((p) => [p.id, p]));
    const pinned: SidebarProjectDisplay[] = [];
    const validIds: string[] = [];
    for (const id of pinnedIds) {
      const match = byId.get(id);
      if (match) {
        pinned.push({ id: match.id, name: match.name });
        validIds.push(id);
      } else if (options?.allActiveLoaded === false && options.meta?.[id]) {
        // Off-page pinned item while pagination has more items: keep display entry from cached label.
        pinned.push({ id, name: options.meta[id] });
        validIds.push(id);
      }
    }
    if (pinned.length > 0) {
      return { visible: pinned, isCustomized: true, validPinnedIds: validIds };
    }
  }

  const recent = [...activeProjects]
    .sort((a, b) => {
      const ta = Date.parse(a.updated_at);
      const tb = Date.parse(b.updated_at);
      if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
      return tb - ta;
    })
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name }));
  return { visible: recent, isCustomized: false, validPinnedIds: [] };
}

export interface SidebarTagDisplay {
  id: string;
  name: string;
  collection_count?: number;
}

export function resolveSidebarTags(
  allTags: readonly Tag[],
  pinnedIds: readonly string[] | null,
  limit = DEFAULT_SIDEBAR_ITEMS,
  options?: { meta?: Record<string, string>; allTagsLoaded?: boolean },
): { visible: SidebarTagDisplay[]; isCustomized: boolean; validPinnedIds: string[] } {
  if (pinnedIds && pinnedIds.length > 0) {
    const byId = new Map(allTags.map((t) => [t.id, t]));
    const pinned: SidebarTagDisplay[] = [];
    const validIds: string[] = [];
    for (const id of pinnedIds) {
      const match = byId.get(id);
      if (match) {
        pinned.push({ id: match.id, name: match.name, collection_count: match.collection_count });
        validIds.push(id);
      } else if (options?.allTagsLoaded === false && options.meta?.[id]) {
        pinned.push({ id, name: options.meta[id] });
        validIds.push(id);
      }
    }
    if (pinned.length > 0) {
      return { visible: pinned, isCustomized: true, validPinnedIds: validIds };
    }
  }

  const frequent = [...allTags]
    .sort((a, b) => b.collection_count - a.collection_count)
    .slice(0, limit)
    .map((t) => ({ id: t.id, name: t.name, collection_count: t.collection_count }));
  return { visible: frequent, isCustomized: false, validPinnedIds: [] };
}

export function togglePinnedId(
  currentPinned: readonly string[] | null,
  id: string,
): string[] | null {
  const existing = currentPinned ?? [];
  const next = existing.includes(id)
    ? existing.filter((item) => item !== id)
    : [...existing, id];
  return next.length > 0 ? next : null;
}

export function togglePinnedWithMeta(
  currentPinned: readonly string[] | null,
  currentMeta: Record<string, string> | undefined,
  id: string,
  name: string,
): { ids: string[] | null; meta: Record<string, string> } {
  const ids = togglePinnedId(currentPinned, id);
  const nextMeta: Record<string, string> = { ...(currentMeta ?? {}) };
  if (ids?.includes(id)) {
    nextMeta[id] = name;
  } else {
    delete nextMeta[id];
  }
  return { ids, meta: nextMeta };
}
