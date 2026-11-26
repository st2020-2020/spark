import { CollectionLink } from '../components/CollectionLink';
import { useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { ExternalLink, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import type { Accepted, CollectionPage, CollectionSummary } from '../api/types';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { PageHeader } from '../components/PageHeader';
import { PurgeConfirmModal } from '../components/PurgeConfirmModal';
import { EmptyState, ErrorBanner, LoadMore, LoadingState } from '../components/StateBlocks';
import { useFlipList } from '../lib/motion';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { captureAuthSession, isSameAuthSession, type AuthSessionSnapshot } from '../lib/authSession';
import { isValidHttpUrl } from '../lib/document';
import { formatDateTime, formatRemainingTrashDays } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import {
  enumerateAllTrashTargets,
  estimateTrashPurgeAfter,
  loadAcceptedPurges,
  mergeAcceptedPurges,
  PURGE_BATCH_CONCURRENCY,
  purgeStatusDescription,
  purgeStatusLabel,
  resolvePurgeActionError,
  runPurgeBatch,
  saveAcceptedPurges,
  summarizeBatchPurge,
  TRASH_ENUMERATE_PAGE_LIMIT,
  type AcceptedPurgeRecord,
  type BatchPurgeItemState,
  type PurgeTargetSnapshot,
} from '../lib/purge';

type TrashConfirmState =
  | null
  | { kind: 'single'; col: CollectionSummary }
  | { kind: 'batch'; mode: 'selected' | 'all'; targets: PurgeTargetSnapshot[] };

interface BatchRunState {
  mode: 'selected' | 'all';
  isRunning: boolean;
  items: BatchPurgeItemState[];
  stoppedReason: 'unconfigured' | 'session_invalid' | 'aborted' | null;
}

function removeCollectionsFromPages(
  old: InfiniteData<CollectionPage> | undefined,
  collectionIds: ReadonlySet<string>,
): InfiniteData<CollectionPage> | undefined {
  if (!old || !('pages' in old) || collectionIds.size === 0) return old;
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      items: page.items.filter((item) => !collectionIds.has(item.id)),
    })),
  };
}

function formatSelectionLabel(col: CollectionSummary): string {
  const raw = col.display_title?.trim() || col.excerpt.trim();
  if (!raw) return col.id.slice(0, 8);
  return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
}

export function TrashPage() {
  const api = useApi();
  const { user, purgeEnabled } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<TrashConfirmState>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isEnumeratingAll, setIsEnumeratingAll] = useState(false);
  const [enumeratedCount, setEnumeratedCount] = useState(0);
  const [batchRun, setBatchRun] = useState<BatchRunState | null>(null);
  const [isRefreshingAllStatuses, setIsRefreshingAllStatuses] = useState(false);
  const [acceptedPurges, setAcceptedPurges] = useState<AcceptedPurgeRecord[]>(() =>
    loadAcceptedPurges(user?.id),
  );
  const [checkingById, setCheckingById] = useState<Record<string, boolean>>({});
  const [statusErrorById, setStatusErrorById] = useState<Record<string, string | null>>({});

  const purgeKeysRef = useRef<Map<string, string>>(new Map());
  const loadedUserIdRef = useRef<string | undefined>(user?.id);
  const mountedRef = useRef(true);
  const enumerateAbortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef(0);
  const inFlightBatchRef = useRef(false);
  const inFlightEnumerateRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRunIdRef.current += 1;
      inFlightBatchRef.current = false;
      inFlightEnumerateRef.current = false;
      enumerateAbortRef.current?.abort();
      enumerateAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (loadedUserIdRef.current !== user?.id) {
      loadedUserIdRef.current = user?.id;
      activeRunIdRef.current += 1;
      inFlightBatchRef.current = false;
      inFlightEnumerateRef.current = false;
      enumerateAbortRef.current?.abort();
      enumerateAbortRef.current = null;
      setAcceptedPurges(loadAcceptedPurges(user?.id));
      setCheckingById({});
      setStatusErrorById({});
      setIsRefreshingAllStatuses(false);
      setConfirmState(null);
      setSelectedIds(new Set());
      setIsEnumeratingAll(false);
      setEnumeratedCount(0);
      setBatchRun(null);
      setActionError(null);
      purgeKeysRef.current.clear();
    }
  }, [user?.id]);

  useEffect(() => {
    if (!purgeEnabled) {
      setSelectedIds((prev) => (prev.size > 0 ? new Set() : prev));
      setConfirmState((prev) => (prev ? null : prev));
    }
  }, [purgeEnabled]);

  function dismissAcceptedPurge(collectionId: string) {
    const next = acceptedPurges.filter((item) => item.collectionId !== collectionId);
    const saved = saveAcceptedPurges(user?.id, next);
    setAcceptedPurges(saved);
  }

  function dismissCompletedAccepted() {
    const next = acceptedPurges.filter((item) => item.status !== 'completed');
    const saved = saveAcceptedPurges(user?.id, next);
    setAcceptedPurges(saved);
  }

  function dismissAllAccepted() {
    saveAcceptedPurges(user?.id, []);
    setAcceptedPurges([]);
  }

  const trashQuery = useInfiniteQuery({
    queryKey: ['collections', 'trash'],
    queryFn: ({ pageParam, signal }) =>
      api.listCollections({ scope: 'trash', cursor: pageParam, limit: 30 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  function invalidateRelatedQueries(collectionId?: string) {
    void queryClient.invalidateQueries({ queryKey: ['collections'] });
    if (collectionId) {
      void queryClient.invalidateQueries({ queryKey: ['collection', collectionId] });
    } else {
      void queryClient.invalidateQueries({ queryKey: ['collection'] });
    }
    void queryClient.invalidateQueries({ queryKey: ['collection-thread'] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['project'] });
    void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
  }

  const restoreMutation = useMutation({
    mutationFn: async (
      col: CollectionSummary,
    ): Promise<{ session: AuthSessionSnapshot; col: CollectionSummary }> => {
      const session = captureAuthSession();
      await api.restoreCollection(col.id, { base_resource_version: col.resource_version });
      return { session, col };
    },
    onSuccess: ({ session, col }) => {
      if (!isSameAuthSession(session)) return;
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      setActionError(null);
      setSelectedIds((prev) => {
        if (!prev.has(col.id)) return prev;
        const next = new Set(prev);
        next.delete(col.id);
        return next;
      });
      queryClient.setQueryData<InfiniteData<CollectionPage>>(
        ['collections', 'trash'],
        (old) => removeCollectionsFromPages(old, new Set([col.id])),
      );
      pushToast({ message: '已恢复到收件箱' });
      invalidateRelatedQueries(col.id);
    },
    onError: (err) => {
      if (!mountedRef.current || loadedUserIdRef.current !== user?.id) return;
      setActionError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'resource_conflict') || isApiErrorCode(err, 'not_found')) {
        void queryClient.invalidateQueries({ queryKey: ['collections', 'trash'] });
      }
    },
  });

  const purgeMutation = useMutation({
    mutationFn: async ({
      col,
      idempotencyKey,
    }: {
      col: CollectionSummary;
      idempotencyKey: string;
    }): Promise<{ accepted: Accepted; col: CollectionSummary; session: AuthSessionSnapshot }> => {
      const session = captureAuthSession();
      const accepted = await api.purgeCollection(
        col.id,
        { base_resource_version: col.resource_version },
        idempotencyKey,
      );
      return { accepted, col, session };
    },
    onSuccess: ({ accepted, col, session }) => {
      let nextStored: AcceptedPurgeRecord[] | null = null;
      if (session.userId && isSameAuthSession(session)) {
        nextStored = mergeAcceptedPurges(session.userId, [
          {
            collectionId: col.id,
            operationId: accepted.operation_id,
            status: accepted.status,
          },
        ]);
      }
      if (!mountedRef.current || !isSameAuthSession(session)) return;
      purgeKeysRef.current.delete(`${col.id}:${col.resource_version}`);
      setActionError(null);
      setConfirmState(null);
      setSelectedIds((prev) => {
        if (!prev.has(col.id)) return prev;
        const next = new Set(prev);
        next.delete(col.id);
        return next;
      });
      if (nextStored) {
        setAcceptedPurges(nextStored);
      }
      queryClient.setQueryData<InfiniteData<CollectionPage>>(
        ['collections', 'trash'],
        (old) => removeCollectionsFromPages(old, new Set([col.id])),
      );
      pushToast({
        message: accepted.status === 'completed' ? '已永久删除收藏' : '已受理永久删除，正在清理',
      });
      invalidateRelatedQueries(col.id);
    },
    onError: (err) => {
      if (!mountedRef.current || loadedUserIdRef.current !== user?.id) return;
      const resolved = resolvePurgeActionError(err);
      setActionError(resolved.message);
      setConfirmState(null);
      if (resolved.shouldRefresh) {
        void queryClient.invalidateQueries({ queryKey: ['collections', 'trash'] });
      }
    },
  });

  async function handleCheckPurgeStatus(collectionId: string) {
    const session = captureAuthSession();
    setCheckingById((prev) => ({ ...prev, [collectionId]: true }));
    setStatusErrorById((prev) => ({ ...prev, [collectionId]: null }));
    try {
      const latest = await api.getCollectionPurgeStatus(collectionId);
      if (!isSameAuthSession(session)) return;
      let saved: AcceptedPurgeRecord[] | null = null;
      if (session.userId) {
        const currentStored = loadAcceptedPurges(session.userId);
        saved = saveAcceptedPurges(
          session.userId,
          currentStored.map((item) =>
            item.collectionId === collectionId
              ? { collectionId, operationId: latest.operation_id, status: latest.status }
              : item,
          ),
        );
      }
      if (!mountedRef.current || !isSameAuthSession(session)) return;
      if (saved) setAcceptedPurges(saved);
    } catch (err) {
      if (!mountedRef.current || !isSameAuthSession(session)) return;
      setStatusErrorById((prev) => ({
        ...prev,
        [collectionId]: getFriendlyErrorMessage(err),
      }));
    } finally {
      if (mountedRef.current && isSameAuthSession(session)) {
        setCheckingById((prev) => ({ ...prev, [collectionId]: false }));
      }
    }
  }

  async function handleRefreshAllAccepted() {
    if (isRefreshingAllStatuses) return;
    const session = captureAuthSession();
    const pendingIds = acceptedPurges
      .filter((rec) => rec.status !== 'completed')
      .map((rec) => rec.collectionId);
    if (pendingIds.length === 0) return;

    setIsRefreshingAllStatuses(true);
    const updates = new Map<string, Accepted>();
    const errors = new Map<string, string | null>();
    let cursor = 0;

    async function worker() {
      while (true) {
        if (!mountedRef.current || !isSameAuthSession(session)) return;
        const idx = cursor;
        cursor += 1;
        if (idx >= pendingIds.length) return;
        const id = pendingIds[idx];
        try {
          const latest = await api.getCollectionPurgeStatus(id);
          if (!isSameAuthSession(session)) return;
          updates.set(id, latest);
          errors.set(id, null);
        } catch (err) {
          if (!isSameAuthSession(session)) return;
          errors.set(id, getFriendlyErrorMessage(err));
        }
      }
    }

    try {
      const pool = Math.min(PURGE_BATCH_CONCURRENCY, pendingIds.length);
      await Promise.all(Array.from({ length: pool }, () => worker()));
      if (!mountedRef.current || !isSameAuthSession(session)) return;

      if (session.userId && updates.size > 0) {
        const currentStored = loadAcceptedPurges(session.userId);
        const saved = saveAcceptedPurges(
          session.userId,
          currentStored.map((item) => {
            const latest = updates.get(item.collectionId);
            return latest
              ? { collectionId: item.collectionId, operationId: latest.operation_id, status: latest.status }
              : item;
          }),
        );
        setAcceptedPurges(saved);
      }
      if (errors.size > 0) {
        setStatusErrorById((prev) => {
          const next = { ...prev };
          for (const [id, msg] of errors) {
            next[id] = msg;
          }
          return next;
        });
      }
    } finally {
      if (mountedRef.current && isSameAuthSession(session)) {
        setIsRefreshingAllStatuses(false);
      }
    }
  }

  async function executeBatchRun(mode: 'selected' | 'all', initialItems: BatchPurgeItemState[]) {
    if (!purgeEnabled || initialItems.length === 0 || inFlightBatchRef.current) return;
    const session = captureAuthSession();
    const runId = ++activeRunIdRef.current;
    inFlightBatchRef.current = true;

    setActionError(null);
    setConfirmState(null);
    setBatchRun({
      mode,
      isRunning: true,
      items: initialItems,
      stoppedReason: null,
    });

    try {
      const result = await runPurgeBatch({
        initialItems,
        purgeOne: (id, body, idempotencyKey) => api.purgeCollection(id, body, idempotencyKey),
        concurrency: PURGE_BATCH_CONCURRENCY,
        shouldAbort: () =>
          !mountedRef.current || runId !== activeRunIdRef.current || !isSameAuthSession(session),
        isSessionValid: () => isSameAuthSession(session),
        onProgress: (snapshot) => {
          if (!mountedRef.current || runId !== activeRunIdRef.current || !isSameAuthSession(session)) {
            return;
          }
          setBatchRun((prev) => (prev ? { ...prev, items: snapshot } : prev));
        },
      });

      let updatedAccepted: AcceptedPurgeRecord[] | null = null;
      if (session.userId && isSameAuthSession(session) && result.newlyAccepted.length > 0) {
        updatedAccepted = mergeAcceptedPurges(session.userId, result.newlyAccepted);
      }

      if (!mountedRef.current || runId !== activeRunIdRef.current || !isSameAuthSession(session)) {
        return;
      }

      if (updatedAccepted) {
        setAcceptedPurges(updatedAccepted);
      }

      const removedIds = new Set([...result.acceptedIds, ...result.goneIds]);
      if (removedIds.size > 0) {
        setSelectedIds((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const id of removedIds) {
            if (next.delete(id)) changed = true;
          }
          return changed ? next : prev;
        });
        queryClient.setQueryData<InfiniteData<CollectionPage>>(
          ['collections', 'trash'],
          (old) => removeCollectionsFromPages(old, removedIds),
        );
      }

      setBatchRun({
        mode,
        isRunning: false,
        items: result.items,
        stoppedReason: result.stoppedReason,
      });

      if (result.stoppedReason === 'unconfigured') {
        setActionError('永久删除暂未开启，操作已停止。回收站内剩余收藏仍可恢复或稍后再试。');
      }

      if (result.shouldRefreshTrash) {
        invalidateRelatedQueries();
      }

      const summary = summarizeBatchPurge(result.items);
      if (
        summary.acceptedTotal > 0 &&
        summary.failedRetryable === 0 &&
        summary.stoppedUnconfigured === 0 &&
        summary.skippedConflict === 0
      ) {
        pushToast({
          message:
            summary.acceptedPending === 0
              ? `已永久删除 ${summary.acceptedCompleted} 条收藏`
              : `已受理 ${summary.acceptedTotal} 条永久删除，附件正在后台清理`,
        });
      }
    } finally {
      if (runId === activeRunIdRef.current) {
        inFlightBatchRef.current = false;
      }
    }
  }

  async function handleStartPurgeAll() {
    if (
      !purgeEnabled ||
      inFlightEnumerateRef.current ||
      inFlightBatchRef.current ||
      isEnumeratingAll ||
      batchRun?.isRunning ||
      restoreMutation.isPending ||
      purgeMutation.isPending ||
      confirmState !== null
    ) {
      return;
    }
    const session = captureAuthSession();
    const runId = ++activeRunIdRef.current;
    const controller = new AbortController();
    inFlightEnumerateRef.current = true;
    enumerateAbortRef.current?.abort();
    enumerateAbortRef.current = controller;

    setActionError(null);
    setIsEnumeratingAll(true);
    setEnumeratedCount(0);

    try {
      const targets = await enumerateAllTrashTargets(
        (cursor, signal) =>
          api.listCollections(
            { scope: 'trash', cursor, limit: TRASH_ENUMERATE_PAGE_LIMIT },
            signal,
          ),
        {
          signal: controller.signal,
          isSessionValid: () =>
            mountedRef.current && runId === activeRunIdRef.current && isSameAuthSession(session),
          excludeIds: acceptedIds,
          onPageLoaded: (countSoFar) => {
            if (
              mountedRef.current &&
              runId === activeRunIdRef.current &&
              isSameAuthSession(session)
            ) {
              setEnumeratedCount(countSoFar);
            }
          },
        },
      );

      if (!mountedRef.current || runId !== activeRunIdRef.current || !isSameAuthSession(session)) {
        return;
      }

      if (targets.length === 0) {
        pushToast({ message: '回收站中没有可永久删除的收藏' });
        void queryClient.invalidateQueries({ queryKey: ['collections', 'trash'] });
        return;
      }

      setConfirmState({ kind: 'batch', mode: 'all', targets });
    } catch (err) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        runId !== activeRunIdRef.current ||
        !isSameAuthSession(session)
      ) {
        return;
      }
      setActionError(
        `获取全部回收站列表失败，未执行任何删除：${getFriendlyErrorMessage(err)}`,
      );
    } finally {
      if (runId === activeRunIdRef.current) {
        inFlightEnumerateRef.current = false;
      }
      if (enumerateAbortRef.current === controller) {
        enumerateAbortRef.current = null;
      }
      if (mountedRef.current && runId === activeRunIdRef.current && isSameAuthSession(session)) {
        setIsEnumeratingAll(false);
      }
    }
  }

  function handleOpenBatchSelectedConfirm() {
    if (!purgeEnabled || isGlobalActionLocked) return;
    const targets: PurgeTargetSnapshot[] = selectedLoadedItems.map((col) => ({
      id: col.id,
      resourceVersion: col.resource_version,
    }));
    if (targets.length === 0) return;
    setActionError(null);
    setConfirmState({ kind: 'batch', mode: 'selected', targets });
  }

  function handleConfirmModal() {
    if (!purgeEnabled || !confirmState || restoreMutation.isPending || purgeMutation.isPending) {
      return;
    }
    if (confirmState.kind === 'single') {
      const col = confirmState.col;
      if (acceptedIds.has(col.id)) return;
      const keySlot = `${col.id}:${col.resource_version}`;
      let idempotencyKey = purgeKeysRef.current.get(keySlot);
      if (!idempotencyKey) {
        idempotencyKey = generateIdempotencyKey();
        purgeKeysRef.current.set(keySlot, idempotencyKey);
      }
      purgeMutation.mutate({ col, idempotencyKey });
      return;
    }

    const initialItems: BatchPurgeItemState[] = confirmState.targets.map((target) => ({
      id: target.id,
      resourceVersion: target.resourceVersion,
      outcome: 'pending',
    }));
    void executeBatchRun(confirmState.mode, initialItems);
  }

  function handleRetryFailedBatch() {
    if (!purgeEnabled || !batchRun || batchRun.isRunning || isGlobalActionLocked) return;
    void executeBatchRun(batchRun.mode, batchRun.items);
  }

  const items = trashQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const listRef = useRef<HTMLDivElement | null>(null);
  useFlipList(listRef, items.map((c) => c.id).join('|'));
  const restoringId = restoreMutation.isPending ? restoreMutation.variables?.id : undefined;
  const purgingId = purgeMutation.isPending ? purgeMutation.variables?.col.id : undefined;
  const acceptedIds = new Set(acceptedPurges.map((item) => item.collectionId));

  const selectableLoadedItems = items.filter((col) => !acceptedIds.has(col.id));
  const selectedLoadedItems = selectableLoadedItems.filter((col) => selectedIds.has(col.id));
  const selectedCount = selectedLoadedItems.length;
  const allLoadedSelected =
    selectableLoadedItems.length > 0 && selectedCount === selectableLoadedItems.length;

  const isBatchRunning = Boolean(batchRun?.isRunning);
  const isSingleBusy = restoreMutation.isPending || purgeMutation.isPending;
  const isGlobalActionLocked =
    isEnumeratingAll || isBatchRunning || isSingleBusy || confirmState !== null;

  function toggleSelectOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllLoaded() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allLoadedSelected) {
        for (const col of selectableLoadedItems) next.delete(col.id);
      } else {
        for (const col of selectableLoadedItems) next.add(col.id);
      }
      return next;
    });
  }

  const batchSummary = batchRun ? summarizeBatchPurge(batchRun.items) : null;
  const batchProcessed = batchSummary
    ? batchSummary.total - batchSummary.pending - batchSummary.running
    : 0;
  const unfinishedAcceptedCount = acceptedPurges.filter((r) => r.status !== 'completed').length;
  const completedAcceptedCount = acceptedPurges.length - unfinishedAcceptedCount;

  return (
    <div>
      <PageHeader
        title="回收站"
        subtitle={
          purgeEnabled
            ? '保留期 30 天，到期后自动清理。永久删除后无法恢复。'
            : '当前未开启永久删除，可在这里查看或恢复已删除的收藏。'
        }
      />

      {!purgeEnabled && (
        <div className="sp-banner sp-banner--info sp-spaced" role="status">
          <span>当前环境未开启永久删除功能，暂时无法彻底清除；你仍可将收藏恢复到收件箱。</span>
        </div>
      )}

      {actionError && (
        <div className="sp-banner sp-banner--error sp-spaced" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {batchRun && batchSummary && (
        <section
          className={`sp-banner sp-purge-status-card sp-spaced ${
            batchSummary.failedRetryable > 0 || batchSummary.stoppedUnconfigured > 0
              ? 'sp-banner--warning'
              : ''
          }`}
          aria-label="批量永久删除进度与结果"
          aria-live="polite"
        >
          <div className="sp-purge-status-main">
            <strong>
              {batchRun.isRunning
                ? `${batchRun.mode === 'all' ? '正在清空回收站' : '正在批量永久删除'}（${batchProcessed} / ${batchSummary.total}）`
                : batchSummary.failedRetryable > 0 ||
                    batchSummary.stoppedUnconfigured > 0 ||
                    batchSummary.skippedConflict > 0
                  ? '批量永久删除部分完成'
                  : batchSummary.acceptedPending > 0
                    ? `已受理 ${batchSummary.acceptedTotal} 条永久删除，附件正在后台清理`
                    : batchSummary.acceptedTotal > 0
                      ? `已永久删除 ${batchSummary.acceptedCompleted} 条收藏`
                      : '本次批量操作未删除任何收藏'}
            </strong>
            <div className="sp-banner-detail">
              本批共 {batchSummary.total} 条：已受理 {batchSummary.acceptedTotal} 条
              {batchSummary.acceptedTotal > 0 &&
                (batchSummary.acceptedPending > 0
                  ? `（${batchSummary.acceptedCompleted} 条已清除，${batchSummary.acceptedPending} 条等待或正在清理附件，暂未确认全部附件清完）`
                  : '（笔记与附件均已永久删除）')}
              {batchSummary.failedRetryable > 0 &&
                `，可重试失败 ${batchSummary.failedRetryable} 条（保留原幂等键）`}
              {batchSummary.skippedConflict > 0 &&
                `，版本冲突或已恢复 ${batchSummary.skippedConflict} 条（未删除）`}
              {batchSummary.skippedGone > 0 && `，已不存在 ${batchSummary.skippedGone} 条`}
              {batchSummary.stoppedUnconfigured > 0 &&
                `，因功能未开启已停止 ${batchSummary.stoppedUnconfigured} 条`}
            </div>
          </div>
          {!batchRun.isRunning && (
            <div className="sp-row">
              {purgeEnabled && batchSummary.failedRetryable > 0 && (
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  disabled={isGlobalActionLocked}
                  onClick={handleRetryFailedBatch}
                >
                  原键重试失败项 ({batchSummary.failedRetryable})
                </button>
              )}
              <button
                type="button"
                className="sp-btn sp-btn--sm sp-btn--ghost"
                onClick={() => setBatchRun(null)}
              >
                关闭摘要
              </button>
            </div>
          )}
        </section>
      )}

      {acceptedPurges.length > 0 && (
        <section className="sp-purge-status-list sp-spaced" aria-label="已受理永久删除任务">
          {acceptedPurges.length > 1 && (
            <div className="sp-row-between sp-purge-status-toolbar">
              <span className="sp-help">
                已跟踪 {acceptedPurges.length} 条任务（清理中 {unfinishedAcceptedCount} 条，已完成{' '}
                {completedAcceptedCount} 条）
              </span>
              <div className="sp-row">
                {unfinishedAcceptedCount > 0 && (
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm"
                    disabled={isRefreshingAllStatuses}
                    onClick={() => void handleRefreshAllAccepted()}
                  >
                    <RefreshCw
                      size={14}
                      strokeWidth={2}
                      className={isRefreshingAllStatuses ? 'sp-spin' : undefined}
                      aria-hidden="true"
                    />
                    <span>{isRefreshingAllStatuses ? '刷新中…' : '全部刷新状态'}</span>
                  </button>
                )}
                {completedAcceptedCount > 0 && (
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm sp-btn--ghost"
                    onClick={dismissCompletedAccepted}
                  >
                    收起已完成
                  </button>
                )}
                <button
                  type="button"
                  className="sp-btn sp-btn--sm sp-btn--ghost"
                  onClick={dismissAllAccepted}
                >
                  全部收起
                </button>
              </div>
            </div>
          )}
          {acceptedPurges.map((rec) => {
            const isChecking = Boolean(checkingById[rec.collectionId]);
            const statusErr = statusErrorById[rec.collectionId];
            return (
              <div
                key={rec.collectionId}
                className="sp-banner sp-purge-status-card"
                role="status"
              >
                <div className="sp-purge-status-main">
                  <div className="sp-row">
                    <strong>{purgeStatusLabel(rec.status)}</strong>
                  </div>
                  <div className="sp-banner-detail">
                    {purgeStatusDescription(rec.status)}
                  </div>
                  {statusErr && (
                    <div className="sp-banner-detail sp-text-danger" role="alert">
                      {statusErr}
                    </div>
                  )}
                </div>
                <div className="sp-row">
                  {rec.status !== 'completed' && (
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm"
                      disabled={isChecking || isRefreshingAllStatuses}
                      onClick={() => void handleCheckPurgeStatus(rec.collectionId)}
                    >
                      <RefreshCw
                        size={14}
                        strokeWidth={2}
                        className={isChecking ? 'sp-spin' : undefined}
                        aria-hidden="true"
                      />
                      <span>{isChecking ? '刷新中…' : '刷新状态'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm sp-btn--ghost"
                    aria-label={`关闭操作 ${rec.operationId.slice(0, 8)} 提示`}
                    onClick={() => dismissAcceptedPurge(rec.collectionId)}
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                    <span>收起</span>
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {trashQuery.isLoading && <LoadingState message="正在加载回收站…" />}
      {trashQuery.isError && (
        <ErrorBanner error={trashQuery.error} onRetry={() => void trashQuery.refetch()} />
      )}
      {!trashQuery.isLoading && !trashQuery.isError && items.length === 0 && (
        <EmptyState title="回收站是空的" description="移入回收站的收藏会暂时保留在这里。" />
      )}

      {purgeEnabled && !trashQuery.isLoading && !trashQuery.isError && items.length > 0 && (
        <div className="sp-trash-toolbar sp-spaced" role="region" aria-label="回收站批量操作">
          <div className="sp-row">
            <label className="sp-trash-select-all">
              <input
                type="checkbox"
                checked={allLoadedSelected}
                disabled={isGlobalActionLocked || selectableLoadedItems.length === 0}
                onChange={toggleSelectAllLoaded}
              />
              <span>
                全选已加载 ({selectableLoadedItems.length}
                {trashQuery.hasNextPage ? '+' : ''})
              </span>
            </label>
            {selectedCount > 0 && (
              <>
                <span className="sp-help">已选 {selectedCount} 条</span>
                <button
                  type="button"
                  className="sp-btn--quiet sp-btn--sm"
                  disabled={isGlobalActionLocked}
                  onClick={() => setSelectedIds(new Set())}
                >
                  取消选择
                </button>
              </>
            )}
          </div>
          <div className="sp-row sp-trash-toolbar-actions">
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--danger"
              disabled={selectedCount === 0 || isGlobalActionLocked}
              onClick={handleOpenBatchSelectedConfirm}
            >
              彻底清除所选{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </button>
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--danger"
              disabled={isGlobalActionLocked}
              onClick={() => void handleStartPurgeAll()}
            >
              {isEnumeratingAll ? `统计全部中 (${enumeratedCount})…` : '清空回收站'}
            </button>
          </div>
        </div>
      )}

      <div className="sp-note-list" ref={listRef}>
        {items.map((col) => {
          const estExpiry = estimateTrashPurgeAfter(col.updated_at);
          const showTitle =
            Boolean(col.display_title?.trim()) &&
            col.display_title.trim() !== '未命名收藏' &&
            col.display_title.trim() !== col.excerpt.trim();
          const isRowSelected = purgeEnabled && selectedIds.has(col.id);
          const isBusy =
            restoringId === col.id ||
            purgingId === col.id ||
            (purgeEnabled && confirmState?.kind === 'single' && confirmState.col.id === col.id) ||
            acceptedIds.has(col.id);

          return (
            <article
              key={col.id}
              data-flip-key={col.id}
              className={`sp-note ${restoringId === col.id ? 'is-leaving' : ''} ${
                isRowSelected ? 'sp-trash-note--selected' : ''
              }`}
            >
              <div className="sp-note-meta sp-trash-meta">
                {purgeEnabled && (
                  <label className="sp-trash-card-select">
                    <input
                      type="checkbox"
                      aria-label={`选择「${formatSelectionLabel(col)}」`}
                      checked={isRowSelected}
                      disabled={isBusy || isGlobalActionLocked}
                      onChange={() => toggleSelectOne(col.id)}
                    />
                  </label>
                )}
                <time dateTime={col.updated_at}>移入于 {formatDateTime(col.updated_at)}</time>
                {purgeEnabled && estExpiry && (
                  <span className="sp-trash-expiry" title={`预计 ${formatDateTime(estExpiry)} 自动清理`}>
                    {formatRemainingTrashDays(estExpiry)}后自动清理
                  </span>
                )}
              </div>

              {showTitle && (
                <h3 className="sp-note-title">
                  <CollectionLink id={col.id} state={{ from: '/trash' }}>
                    {col.display_title}
                  </CollectionLink>
                </h3>
              )}

              {col.excerpt && <p className="sp-note-body sp-note-body--clamped">{col.excerpt}</p>}

              {col.original_url && isValidHttpUrl(col.original_url) && (
                <a
                  href={col.original_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sp-note-url"
                >
                  <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
                  <span className="sp-break-anywhere">{col.original_url}</span>
                </a>
              )}

              <div className="sp-note-footer">
                <CollectionLink id={col.id} state={{ from: '/trash' }} className="sp-help">
                  查看详情
                </CollectionLink>
                <div className="sp-row sp-note-footer-action">
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm"
                    disabled={isBusy || isGlobalActionLocked}
                    onClick={() => restoreMutation.mutate(col)}
                  >
                    <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{restoringId === col.id ? '恢复中…' : '恢复'}</span>
                  </button>
                  {purgeEnabled && (
                    <button
                      type="button"
                      className="sp-btn--quiet sp-btn--sm sp-btn--danger-text sp-trash-purge"
                      disabled={isBusy || isGlobalActionLocked}
                      onClick={() => {
                        setActionError(null);
                        setConfirmState({ kind: 'single', col });
                      }}
                    >
                      <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                      <span>{purgingId === col.id ? '删除中…' : '永久删除'}</span>
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <LoadMore
        hasNextPage={trashQuery.hasNextPage}
        isFetching={trashQuery.isFetching}
        isError={trashQuery.isFetchNextPageError}
        onLoad={() => void trashQuery.fetchNextPage({ cancelRefetch: false })}
      />

      <PurgeConfirmModal
        open={purgeEnabled && confirmState !== null}
        title={
          confirmState?.kind === 'batch'
            ? confirmState.mode === 'all'
              ? '确认清空回收站'
              : '确认永久删除所选收藏'
            : '确认永久删除收藏'
        }
        warningMessage={
          confirmState?.kind === 'batch'
            ? confirmState.mode === 'all'
              ? `即将对本次统计到的全部 ${confirmState.targets.length} 条回收站收藏发起永久删除，此操作不可恢复。仅清除本次已确认的收藏（确认后新移入回收站或已在其他端恢复的收藏不会被误删），正在清理中的附件将由后台异步清除。`
              : `即将对已选中的 ${confirmState.targets.length} 条回收站收藏发起永久删除，此操作不可恢复。仅清除本次已确认的收藏，正在清理中的附件将由后台异步清除。`
            : '永久删除后，这条笔记和附件将无法恢复。'
        }
        confirmLabel={
          confirmState?.kind === 'batch'
            ? confirmState.mode === 'all'
              ? `确认清空 (${confirmState.targets.length} 条)`
              : `确认永久删除 (${confirmState.targets.length} 条)`
            : '确认永久删除'
        }
        targetSummary={
          confirmState?.kind === 'single'
            ? confirmState.col.display_title || confirmState.col.excerpt
            : undefined
        }
        isSubmitting={purgeMutation.isPending}
        onCancel={() => setConfirmState(null)}
        onConfirm={handleConfirmModal}
      />
    </div>
  );
}
