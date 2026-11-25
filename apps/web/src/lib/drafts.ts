import { useEffect } from 'react';
import type { SparkDocument } from '../api/types';
import { derivePlainText, inspectSparkDocumentSupport } from './document';

export interface DraftImage {
  uploadId?: string;
  name: string;
  size: number;
}

export interface CollectionDraft {
  images?: DraftImage[];
  followUpSourceId?: string;
  collectionId: string;
  idempotencyKey: string;
  document: SparkDocument;
  intent: string;
  originalUrl: string;
  manualTitle: string;
  projectIds: string[];
  tagIds: string[];
  associationNames?: Record<string, string>;
  aiExcluded: boolean;
  updatedAt: string;
}

const DRAFT_PREFIX = 'spark:draft:v1';

function buildKey(userId: string, scope: string): string {
  return `${DRAFT_PREFIX}:${userId}:${scope}`;
}

export function loadDraft<T extends { document: SparkDocument }>(userId: string, scope: string): { data: T | null; error?: string } {
  if (!userId) return { data: null };
  try {
    const raw = window.localStorage.getItem(buildKey(userId, scope));
    if (!raw) return { data: null };
    const draft = JSON.parse(raw) as T;
    const checked = inspectSparkDocumentSupport(draft.document);
    // Keep future document versions intact for the existing read-only fallback.
    if (checked.supported) draft.document = checked.document;
    return { data: draft };
  } catch {
    return { data: null, error: '无法读取本地草稿存储（浏览器存储受限或数据已损坏）。' };
  }
}

export function saveDraft<T>(userId: string, scope: string, value: T): { ok: boolean; error?: string } {
  if (!userId) return { ok: false, error: '未登录账号，无法保存本地草稿。' };
  try {
    window.localStorage.setItem(buildKey(userId, scope), JSON.stringify(value));
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: '本地草稿存储失败（可能空间已满或无痕模式受限），请及时保存或复制内容。',
    };
  }
}

export function removeDraft(userId: string, scope: string): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(buildKey(userId, scope));
  } catch {
    // Ignore storage removal failure
  }
}

export function clearUserDrafts(userId: string): void {
  if (!userId) return;
  try {
    const prefix = `${DRAFT_PREFIX}:${userId}:`;
    const toDelete: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failure during logout cleanup
  }
}

export function isDraftMeaningful(draft: Partial<CollectionDraft> | null | undefined): boolean {
  if (!draft) return false;
  const text = draft.document ? derivePlainText(draft.document).trim() : '';
  const hasImages = Array.isArray(draft.images) && draft.images.length > 0;
  return Boolean(
    text ||
      draft.intent?.trim() ||
      draft.originalUrl?.trim() ||
      draft.manualTitle?.trim() ||
      hasImages ||
      (Array.isArray(draft.tagIds) && draft.tagIds.length > 0),
  );
}

function stripProjectReferenceFromDraft(
  draft: CollectionDraft,
  projectId: string,
): CollectionDraft {
  const nextProjectIds = Array.isArray(draft.projectIds)
    ? draft.projectIds.filter((pid) => pid !== projectId)
    : [];
  const nextNames = draft.associationNames ? { ...draft.associationNames } : undefined;
  if (nextNames) delete nextNames[projectId];
  return {
    ...draft,
    projectIds: nextProjectIds,
    ...(nextNames ? { associationNames: nextNames } : {}),
  };
}

export function removeProjectFromUserDrafts(
  userId: string | undefined,
  projectId: string,
  options?: { removeProjectScope?: boolean },
): void {
  if (!userId || !projectId || typeof window === 'undefined') return;
  const projectScope = `project:${projectId}`;
  const projectStorageKey = buildKey(userId, projectScope);

  // Strip deleted project references from all other drafts without touching their content/images.
  try {
    const prefix = `${DRAFT_PREFIX}:${userId}:`;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix) || key === projectStorageKey) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Partial<CollectionDraft>;
        if (!Array.isArray(parsed.projectIds) || !parsed.projectIds.includes(projectId)) continue;
        const nextNames = parsed.associationNames ? { ...parsed.associationNames } : undefined;
        if (nextNames) delete nextNames[projectId];
        window.localStorage.setItem(
          key,
          JSON.stringify({
            ...parsed,
            projectIds: parsed.projectIds.filter((pid) => pid !== projectId),
            ...(nextNames ? { associationNames: nextNames } : {}),
          }),
        );
      } catch {
        // Skip malformed individual draft entries
      }
    }
  } catch {
    // Ignore storage failure during reference cleanup
  }

  if (options?.removeProjectScope !== false) {
    removeDraft(userId, projectScope);
  }
}

export function moveProjectDraftToInboxSafely(
  userId: string | undefined,
  projectId: string,
  activeSnapshotDraft?: CollectionDraft | null,
): { ok: true } | { ok: false; reason: 'empty' | 'inbox_occupied' | 'storage_failed'; error: string } {
  if (!userId || !projectId || typeof window === 'undefined') {
    return { ok: false, reason: 'storage_failed', error: '未登录账号，无法转存草稿。' };
  }
  const projectScope = `project:${projectId}`;
  const diskDraft = loadDraft<CollectionDraft>(userId, projectScope).data;
  const sourceDraft =
    activeSnapshotDraft && isDraftMeaningful(activeSnapshotDraft) ? activeSnapshotDraft : diskDraft;

  if (!sourceDraft || !isDraftMeaningful(sourceDraft)) {
    removeDraft(userId, projectScope);
    return { ok: false, reason: 'empty', error: '当前没有需要转存的草稿。' };
  }

  const readyImages = (sourceDraft.images ?? []).filter((img) => Boolean(img.uploadId));
  const sanitized = stripProjectReferenceFromDraft(
    { ...sourceDraft, images: readyImages },
    projectId,
  );
  if (!isDraftMeaningful(sanitized)) {
    removeDraft(userId, projectScope);
    return { ok: false, reason: 'empty', error: '当前仅包含未完成的临时图片，无法转存。' };
  }

  const existingInbox = loadDraft<CollectionDraft>(userId, 'inbox').data;
  if (isDraftMeaningful(existingInbox)) {
    return {
      ok: false,
      reason: 'inbox_occupied',
      error: '收件箱已有未保存草稿，无法自动转存；请先点击「取消」保存或清空。',
    };
  }

  const saved = saveDraft(userId, 'inbox', sanitized);
  if (!saved.ok) {
    // Keep original project draft untouched when storage fails.
    return {
      ok: false,
      reason: 'storage_failed',
      error: saved.error ?? '转存到收件箱失败，已保留原项目草稿，请先点击「取消」保存或复制内容。',
    };
  }

  removeDraft(userId, projectScope);
  return { ok: true };
}

/** File objects in an open upload queue cannot be recovered from the text draft. */
export function confirmLeavingImageDraft(root: ParentNode = document): boolean {
  return !root.querySelector('[data-pending-images]') ||
    window.confirm('离开后，未保存的图片需要重新选择。仍要离开吗？');
}

export function useBeforeUnloadWarning(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled]);
}
