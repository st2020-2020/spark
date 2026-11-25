import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import type { Accepted, CollectionPage, ResourceCondition } from '../api/types';
import { generateIdempotencyKey } from './idempotency';

export const TRASH_RETENTION_DAYS = 30;
export const MAX_COMPLETED_PURGE_HISTORY = 20;
export const TRASH_ENUMERATE_PAGE_LIMIT = 100;
export const PURGE_BATCH_CONCURRENCY = 3;

export interface AcceptedPurgeRecord {
  collectionId: string;
  operationId: string;
  status: Accepted['status'];
}

export interface PurgeTargetSnapshot {
  id: string;
  resourceVersion: number;
}

export type BatchPurgeOutcome =
  | 'pending'
  | 'running'
  | 'accepted'
  | 'failed_retryable'
  | 'skipped_conflict'
  | 'skipped_gone'
  | 'stopped_unconfigured'
  | 'stopped_aborted';

export interface BatchPurgeItemState {
  id: string;
  resourceVersion: number;
  idempotencyKey?: string;
  outcome: BatchPurgeOutcome;
  accepted?: Accepted;
  errorMessage?: string;
}

export interface BatchPurgeSummary {
  total: number;
  pending: number;
  running: number;
  acceptedTotal: number;
  acceptedCompleted: number;
  acceptedPending: number;
  failedRetryable: number;
  skippedConflict: number;
  skippedGone: number;
  stoppedUnconfigured: number;
  stoppedAborted: number;
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

/**
 * Keep all unfinished (queued/running) records intact so batches > 20 never lose
 * status tracking, while trimming only completed history to a bounded tail.
 */
function normalizeAcceptedPurges(items: readonly AcceptedPurgeRecord[]): AcceptedPurgeRecord[] {
  const seen = new Set<string>();
  let completedCount = 0;
  const result: AcceptedPurgeRecord[] = [];
  for (const item of items) {
    if (seen.has(item.collectionId)) continue;
    seen.add(item.collectionId);
    if (item.status === 'completed') {
      if (completedCount >= MAX_COMPLETED_PURGE_HISTORY) continue;
      completedCount += 1;
    }
    result.push({
      collectionId: item.collectionId,
      operationId: item.operationId,
      status: item.status,
    });
  }
  return result;
}

export function saveAcceptedPurges(
  userId: string | undefined,
  items: readonly AcceptedPurgeRecord[],
): AcceptedPurgeRecord[] {
  const sanitized = normalizeAcceptedPurges(items);
  if (!userId || typeof window === 'undefined') return sanitized;
  try {
    if (sanitized.length === 0) {
      window.sessionStorage.removeItem(storageKey(userId));
    } else {
      window.sessionStorage.setItem(storageKey(userId), JSON.stringify(sanitized));
    }
  } catch {
    // Ignore storage failures
  }
  return sanitized;
}

export function mergeAcceptedPurges(
  userId: string | undefined,
  updates: readonly AcceptedPurgeRecord[],
): AcceptedPurgeRecord[] {
  if (!userId) return [];
  if (updates.length === 0) return loadAcceptedPurges(userId);
  const existing = loadAcceptedPurges(userId);
  return saveAcceptedPurges(userId, [...updates, ...existing]);
}

export function upsertAcceptedPurge(userId: string | undefined, record: AcceptedPurgeRecord): void {
  mergeAcceptedPurges(userId, [record]);
}

export async function enumerateAllTrashTargets(
  listPage: (cursor: string | undefined, signal: AbortSignal) => Promise<CollectionPage>,
  options: {
    signal: AbortSignal;
    isSessionValid: () => boolean;
    excludeIds?: ReadonlySet<string>;
    onPageLoaded?: (countSoFar: number) => void;
  },
): Promise<PurgeTargetSnapshot[]> {
  const byId = new Map<string, PurgeTargetSnapshot>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined = undefined;

  while (true) {
    if (options.signal.aborted || !options.isSessionValid()) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const page = await listPage(cursor, options.signal);
    if (options.signal.aborted || !options.isSessionValid()) {
      throw new DOMException('Aborted', 'AbortError');
    }
    for (const col of page.items) {
      if (options.excludeIds?.has(col.id)) continue;
      byId.set(col.id, { id: col.id, resourceVersion: col.resource_version });
    }
    options.onPageLoaded?.(byId.size);

    const nextCursor = page.next_cursor;
    if (!nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error('分页游标重复，无法确认全部回收站内容，请刷新后重试。');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return Array.from(byId.values());
}

export function summarizeBatchPurge(items: readonly BatchPurgeItemState[]): BatchPurgeSummary {
  const summary: BatchPurgeSummary = {
    total: items.length,
    pending: 0,
    running: 0,
    acceptedTotal: 0,
    acceptedCompleted: 0,
    acceptedPending: 0,
    failedRetryable: 0,
    skippedConflict: 0,
    skippedGone: 0,
    stoppedUnconfigured: 0,
    stoppedAborted: 0,
  };
  for (const item of items) {
    switch (item.outcome) {
      case 'pending':
        summary.pending += 1;
        break;
      case 'running':
        summary.running += 1;
        break;
      case 'accepted':
        summary.acceptedTotal += 1;
        if (item.accepted?.status === 'completed') {
          summary.acceptedCompleted += 1;
        } else {
          summary.acceptedPending += 1;
        }
        break;
      case 'failed_retryable':
        summary.failedRetryable += 1;
        break;
      case 'skipped_conflict':
        summary.skippedConflict += 1;
        break;
      case 'skipped_gone':
        summary.skippedGone += 1;
        break;
      case 'stopped_unconfigured':
        summary.stoppedUnconfigured += 1;
        break;
      case 'stopped_aborted':
        summary.stoppedAborted += 1;
        break;
    }
  }
  return summary;
}

export async function runPurgeBatch(params: {
  initialItems: readonly BatchPurgeItemState[];
  purgeOne: (id: string, body: ResourceCondition, idempotencyKey: string) => Promise<Accepted>;
  concurrency?: number;
  shouldAbort: () => boolean;
  isSessionValid: () => boolean;
  onProgress?: (snapshot: BatchPurgeItemState[]) => void;
}): Promise<{
  items: BatchPurgeItemState[];
  newlyAccepted: AcceptedPurgeRecord[];
  acceptedIds: string[];
  goneIds: string[];
  shouldRefreshTrash: boolean;
  stoppedReason: 'unconfigured' | 'session_invalid' | 'aborted' | null;
}> {
  const items: BatchPurgeItemState[] = params.initialItems.map((item) =>
    item.outcome === 'pending' || item.outcome === 'failed_retryable'
      ? {
          id: item.id,
          resourceVersion: item.resourceVersion,
          idempotencyKey: item.idempotencyKey,
          outcome: 'pending',
        }
      : { ...item },
  );
  const dispatchQueue: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].outcome === 'pending') dispatchQueue.push(i);
  }

  const newlyAccepted: AcceptedPurgeRecord[] = [];
  const acceptedIds: string[] = [];
  const goneIds: string[] = [];
  let shouldRefreshTrash = false;
  let stoppedReason: 'unconfigured' | 'session_invalid' | 'aborted' | null = null;
  let cursor = 0;

  const notify = () => {
    params.onProgress?.(items.map((item) => ({ ...item })));
  };

  async function worker() {
    while (true) {
      if (stoppedReason !== null || params.shouldAbort() || !params.isSessionValid()) {
        if (stoppedReason === null) {
          stoppedReason = params.isSessionValid() ? 'aborted' : 'session_invalid';
        }
        return;
      }
      const qIdx = cursor;
      cursor += 1;
      if (qIdx >= dispatchQueue.length) return;

      const idx = dispatchQueue[qIdx];
      const current = items[idx];
      const idempotencyKey = current.idempotencyKey ?? generateIdempotencyKey();
      items[idx] = {
        ...current,
        idempotencyKey,
        outcome: 'running',
      };
      notify();

      try {
        const accepted = await params.purgeOne(
          current.id,
          { base_resource_version: current.resourceVersion },
          idempotencyKey,
        );
        if (!params.isSessionValid()) {
          stoppedReason = 'session_invalid';
          return;
        }
        items[idx] = {
          id: current.id,
          resourceVersion: current.resourceVersion,
          idempotencyKey,
          outcome: 'accepted',
          accepted,
        };
        newlyAccepted.unshift({
          collectionId: current.id,
          operationId: accepted.operation_id,
          status: accepted.status,
        });
        acceptedIds.push(current.id);
        shouldRefreshTrash = true;
      } catch (err) {
        if (!params.isSessionValid()) {
          stoppedReason = 'session_invalid';
          return;
        }
        if (isApiErrorCode(err, 'integration_not_configured')) {
          stoppedReason = 'unconfigured';
          items[idx] = {
            id: current.id,
            resourceVersion: current.resourceVersion,
            idempotencyKey,
            outcome: 'stopped_unconfigured',
            errorMessage: resolvePurgeActionError(err).message,
          };
        } else if (
          isApiErrorCode(err, 'resource_conflict') ||
          isApiErrorCode(err, 'collection_not_in_trash')
        ) {
          shouldRefreshTrash = true;
          items[idx] = {
            id: current.id,
            resourceVersion: current.resourceVersion,
            idempotencyKey,
            outcome: 'skipped_conflict',
            errorMessage: resolvePurgeActionError(err).message,
          };
        } else if (isApiErrorCode(err, 'not_found')) {
          shouldRefreshTrash = true;
          goneIds.push(current.id);
          items[idx] = {
            id: current.id,
            resourceVersion: current.resourceVersion,
            idempotencyKey,
            outcome: 'skipped_gone',
            errorMessage: resolvePurgeActionError(err).message,
          };
        } else if (
          isApiErrorCode(err, 'session_expired') ||
          isApiErrorCode(err, 'authentication_failed') ||
          isApiErrorCode(err, 'csrf_failed')
        ) {
          stoppedReason = 'session_invalid';
          items[idx] = {
            id: current.id,
            resourceVersion: current.resourceVersion,
            idempotencyKey,
            outcome: 'failed_retryable',
            errorMessage: getFriendlyErrorMessage(err),
          };
        } else {
          items[idx] = {
            id: current.id,
            resourceVersion: current.resourceVersion,
            idempotencyKey,
            outcome: 'failed_retryable',
            errorMessage: getFriendlyErrorMessage(err),
          };
        }
      }
      notify();
    }
  }

  const poolSize = Math.min(params.concurrency ?? PURGE_BATCH_CONCURRENCY, dispatchQueue.length);
  await Promise.all(Array.from({ length: Math.max(poolSize, 0) }, () => worker()));

  if (stoppedReason !== null) {
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].outcome === 'pending' || items[i].outcome === 'running') {
        if (stoppedReason === 'unconfigured') {
          items[i] = {
            ...items[i],
            outcome: 'stopped_unconfigured',
            errorMessage: '永久删除暂未开启，操作已停止。',
          };
        } else {
          items[i] = {
            ...items[i],
            outcome: 'stopped_aborted',
            errorMessage: '操作因页面切换或会话变更已停止。',
          };
        }
      }
    }
  }

  return {
    items,
    newlyAccepted,
    acceptedIds,
    goneIds,
    shouldRefreshTrash,
    stoppedReason,
  };
}
