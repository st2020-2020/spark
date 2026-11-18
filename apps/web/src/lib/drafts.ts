import { useEffect } from 'react';
import type { SparkDocument } from '../api/types';

export interface CollectionDraft {
  collectionId: string;
  idempotencyKey: string;
  document: SparkDocument;
  intent: string;
  originalUrl: string;
  manualTitle: string;
  projectIds: string[];
  tagIds: string[];
  aiExcluded: boolean;
  updatedAt: string;
}

const DRAFT_PREFIX = 'spark:draft:v1';

function buildKey(userId: string, scope: string): string {
  return `${DRAFT_PREFIX}:${userId}:${scope}`;
}

export function loadDraft<T>(userId: string, scope: string): { data: T | null; error?: string } {
  if (!userId) return { data: null };
  try {
    const raw = window.localStorage.getItem(buildKey(userId, scope));
    if (!raw) return { data: null };
    return { data: JSON.parse(raw) as T };
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
