import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import type { Accepted } from '../api/types';

export const TRASH_RETENTION_DAYS = 30;

export interface AcceptedPurgeRecord {
  collectionId: string;
  operationId: string;
  status: Accepted['status'];
}

export function estimateTrashPurgeAfter(trashedAtIso: string): string | undefined {
  const ms = new Date(trashedAtIso).getTime();
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + TRASH_RETENTION_DAYS * 86400_000).toISOString();
}

export function purgeStatusLabel(status: Accepted['status']): string {
  switch (status) {
    case 'queued':
      return '已受理，等待持久化回执';
    case 'running':
      return '清理中（正在清理数据库或对象）';
    case 'completed':
      return '永久删除已完成';
  }
}

export function purgeStatusDescription(status: Accepted['status']): string {
  switch (status) {
    case 'queued':
      return '已移出回收站，等待清理附件。可点击「刷新状态」确认结果。';
    case 'running':
      return '已移出回收站，正在清理附件。清理失败会自动重试，可点击「刷新状态」查看结果。';
    case 'completed':
      return '笔记和附件已永久删除，无法恢复。';
  }
}

export function resolvePurgeActionError(err: unknown): {
  message: string;
  shouldRefresh: boolean;
} {
  if (isApiErrorCode(err, 'resource_conflict')) {
    return {
      message: '收藏版本已变更（可能已在其他页面恢复或更新），已刷新列表，请确认后再试。',
      shouldRefresh: true,
    };
  }
  if (isApiErrorCode(err, 'not_found')) {
    return {
      message: '目标收藏已不存在或已进入永久删除流程，已刷新列表。',
      shouldRefresh: true,
    };
  }
  if (isApiErrorCode(err, 'collection_not_in_trash')) {
    return {
      message: getFriendlyErrorMessage(err),
      shouldRefresh: true,
    };
  }
  if (isApiErrorCode(err, 'integration_not_configured')) {
    return {
      message:
        err instanceof Error && err.message.trim()
          ? err.message
          : '永久删除能力暂未开启，收藏仍保留在回收站中，可继续恢复或稍后再试。',
      shouldRefresh: false,
    };
  }
  return {
    message: getFriendlyErrorMessage(err),
    shouldRefresh: false,
  };
}

function storageKey(userId: string): string {
  return `spark:accepted-purges:v1:${userId}`;
}

export function loadAcceptedPurges(userId?: string): AcceptedPurgeRecord[] {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is AcceptedPurgeRecord =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as AcceptedPurgeRecord).collectionId === 'string' &&
        typeof (item as AcceptedPurgeRecord).operationId === 'string' &&
        ((item as AcceptedPurgeRecord).status === 'queued' ||
          (item as AcceptedPurgeRecord).status === 'running' ||
          (item as AcceptedPurgeRecord).status === 'completed'),
    );
  } catch {
    return [];
  }
}

export function saveAcceptedPurges(userId: string | undefined, items: AcceptedPurgeRecord[]): void {
  if (!userId || typeof window === 'undefined') return;
  const sanitized = items.slice(0, 20).map(({ collectionId, operationId, status }) => ({
    collectionId,
    operationId,
    status,
  }));
  try {
    if (sanitized.length === 0) {
      window.sessionStorage.removeItem(storageKey(userId));
    } else {
      window.sessionStorage.setItem(storageKey(userId), JSON.stringify(sanitized));
    }
  } catch {
    // Ignore storage failures
  }
}

export function upsertAcceptedPurge(userId: string | undefined, record: AcceptedPurgeRecord): void {
  if (!userId) return;
  const existing = loadAcceptedPurges(userId);
  const minimal: AcceptedPurgeRecord = {
    collectionId: record.collectionId,
    operationId: record.operationId,
    status: record.status,
  };
  saveAcceptedPurges(userId, [minimal, ...existing.filter((item) => item.collectionId !== record.collectionId)]);
}
