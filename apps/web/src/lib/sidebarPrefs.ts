import type { Project, Tag } from '../api/types';

export interface SidebarPrefs {
  pinnedProjectIds: string[] | null;
  pinnedTagIds: string[] | null;
}

const STORAGE_PREFIX = 'spark:sidebar-prefs:v1:';
const MAX_PINNED_ITEMS = 50;
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
    return {
      pinnedProjectIds: sanitizeIdList(obj.pinnedProjectIds),
      pinnedTagIds: sanitizeIdList(obj.pinnedTagIds),
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
  const next: SidebarPrefs = {
    pinnedProjectIds:
      patch.pinnedProjectIds !== undefined
        ? sanitizeIdList(patch.pinnedProjectIds)
        : current.pinnedProjectIds,
    pinnedTagIds:
      patch.pinnedTagIds !== undefined
        ? sanitizeIdList(patch.pinnedTagIds)
        : current.pinnedTagIds,
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

export function resolveSidebarProjects(
  activeProjects: readonly Project[],
  pinnedIds: readonly string[] | null,
  limit = DEFAULT_SIDEBAR_ITEMS,
): { visible: Project[]; isCustomized: boolean; validPinnedIds: string[] } {
  if (pinnedIds && pinnedIds.length > 0) {
    const byId = new Map(activeProjects.map((p) => [p.id, p]));
    const pinned: Project[] = [];
    const validIds: string[] = [];
    for (const id of pinnedIds) {
      const match = byId.get(id);
      if (match) {
        pinned.push(match);
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
    .slice(0, limit);
  return { visible: recent, isCustomized: false, validPinnedIds: [] };
}

export function resolveSidebarTags(
  allTags: readonly Tag[],
  pinnedIds: readonly string[] | null,
  limit = DEFAULT_SIDEBAR_ITEMS,
): { visible: Tag[]; isCustomized: boolean; validPinnedIds: string[] } {
  if (pinnedIds && pinnedIds.length > 0) {
    const byId = new Map(allTags.map((t) => [t.id, t]));
    const pinned: Tag[] = [];
    const validIds: string[] = [];
    for (const id of pinnedIds) {
      const match = byId.get(id);
      if (match) {
        pinned.push(match);
        validIds.push(id);
      }
    }
    if (pinned.length > 0) {
      return { visible: pinned, isCustomized: true, validPinnedIds: validIds };
    }
  }

  const frequent = [...allTags]
    .sort((a, b) => b.collection_count - a.collection_count)
    .slice(0, limit);
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
