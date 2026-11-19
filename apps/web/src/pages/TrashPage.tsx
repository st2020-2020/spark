import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
import { EmptyState, ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidHttpUrl } from '../lib/document';
import { formatDateTime, formatRemainingTrashDays } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import {
  estimateTrashPurgeAfter,
  loadAcceptedPurges,
  purgeStatusLabel,
  resolvePurgeActionError,
  saveAcceptedPurges,
  type AcceptedPurgeRecord,
} from '../lib/purge';

function removeCollectionFromPages(
  old: InfiniteData<CollectionPage> | undefined,
  collectionId: string,
): InfiniteData<CollectionPage> | undefined {
  if (!old || !('pages' in old)) return old;
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      items: page.items.filter((item) => item.id !== collectionId),
    })),
  };
}

export function TrashPage() {
  const api = useApi();
  const { user } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<CollectionSummary | null>(null);
  const [acceptedPurges, setAcceptedPurges] = useState<AcceptedPurgeRecord[]>(() =>
    loadAcceptedPurges(user?.id),
  );
  const [checkingById, setCheckingById] = useState<Record<string, boolean>>({});
  const [statusErrorById, setStatusErrorById] = useState<Record<string, string | null>>({});

  const purgeKeysRef = useRef<Map<string, string>>(new Map());
  const loadedUserIdRef = useRef<string | undefined>(user?.id);

  useEffect(() => {
    if (loadedUserIdRef.current !== user?.id) {
      loadedUserIdRef.current = user?.id;
      setAcceptedPurges(loadAcceptedPurges(user?.id));
      setCheckingById({});
      setStatusErrorById({});
      setConfirmTarget(null);
      setActionError(null);
      purgeKeysRef.current.clear();
    }
  }, [user?.id]);

  useEffect(() => {
    saveAcceptedPurges(user?.id, acceptedPurges);
  }, [user?.id, acceptedPurges]);

  const trashQuery = useInfiniteQuery({
    queryKey: ['collections', 'trash'],
    queryFn: ({ pageParam, signal }) =>
      api.listCollections({ scope: 'trash', cursor: pageParam, limit: 30 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const restoreMutation = useMutation({
    mutationFn: (col: CollectionSummary) =>
      api.restoreCollection(col.id, { base_resource_version: col.resource_version }),
    onSuccess: (_restored, col) => {
      setActionError(null);
      queryClient.setQueryData<InfiniteData<CollectionPage>>(
        ['collections', 'trash'],
        (old) => removeCollectionFromPages(old, col.id),
      );
      pushToast({ message: '已恢复到收件箱' });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => {
      setActionError(getFriendlyErrorMessage(err));
      if (isApiErrorCode(err, 'resource_conflict') || isApiErrorCode(err, 'not_found')) {
        void queryClient.invalidateQueries({ queryKey: ['collections', 'trash'] });
      }
    },
  });

  const purgeMutation = useMutation({
    mutationFn: ({ col, idempotencyKey }: { col: CollectionSummary; idempotencyKey: string }) =>
      api.purgeCollection(col.id, { base_resource_version: col.resource_version }, idempotencyKey),
    onSuccess: (accepted: Accepted, { col }) => {
      purgeKeysRef.current.delete(`${col.id}:${col.resource_version}`);
      setActionError(null);
      setConfirmTarget(null);
      setAcceptedPurges((prev) => [
        {
          collectionId: col.id,
          operationId: accepted.operation_id,
          status: accepted.status,
        },
        ...prev.filter((item) => item.collectionId !== col.id),
      ]);
      queryClient.setQueryData<InfiniteData<CollectionPage>>(
        ['collections', 'trash'],
        (old) => removeCollectionFromPages(old, col.id),
      );
      pushToast({
        message: accepted.status === 'completed' ? '已永久删除收藏' : '已受理永久删除，正在清理',
      });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => {
      const resolved = resolvePurgeActionError(err);
      setActionError(resolved.message);
      setConfirmTarget(null);
      if (resolved.shouldRefresh) {
        void queryClient.invalidateQueries({ queryKey: ['collections', 'trash'] });
      }
    },
  });

  async function handleCheckPurgeStatus(collectionId: string) {
    setCheckingById((prev) => ({ ...prev, [collectionId]: true }));
    setStatusErrorById((prev) => ({ ...prev, [collectionId]: null }));
    try {
      const latest = await api.getCollectionPurgeStatus(collectionId);
      setAcceptedPurges((prev) =>
        prev.map((item) =>
          item.collectionId === collectionId
            ? { ...item, operationId: latest.operation_id, status: latest.status }
            : item,
        ),
      );
    } catch (err) {
      setStatusErrorById((prev) => ({
        ...prev,
        [collectionId]: getFriendlyErrorMessage(err),
      }));
    } finally {
      setCheckingById((prev) => ({ ...prev, [collectionId]: false }));
    }
  }

  function handleConfirmPurge() {
    if (!confirmTarget || restoreMutation.isPending || purgeMutation.isPending) return;
    const keySlot = `${confirmTarget.id}:${confirmTarget.resource_version}`;
    let idempotencyKey = purgeKeysRef.current.get(keySlot);
    if (!idempotencyKey) {
      idempotencyKey = generateIdempotencyKey();
      purgeKeysRef.current.set(keySlot, idempotencyKey);
    }
    purgeMutation.mutate({ col: confirmTarget, idempotencyKey });
  }

  const items = trashQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const restoringId = restoreMutation.isPending ? restoreMutation.variables?.id : undefined;
  const purgingId = purgeMutation.isPending ? purgeMutation.variables?.col.id : undefined;
  const acceptedIds = new Set(acceptedPurges.map((item) => item.collectionId));

  return (
    <div>
      <PageHeader
        title="回收站"
        subtitle="保留期 30 天内可随时恢复，到期后自动清理；永久删除不可恢复"
      />

      {actionError && (
        <div className="sp-banner sp-banner--error sp-spaced" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {acceptedPurges.length > 0 && (
        <section className="sp-purge-status-list sp-spaced" aria-label="已受理永久删除任务">
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
                    <span className="sp-pill sp-tabular">
                      操作 {rec.operationId.slice(0, 8)}
                    </span>
                  </div>
                  <div className="sp-banner-detail">
                    已从回收站、详情与搜索移除；后台清理完成后会更新为已完成。
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
                      disabled={isChecking}
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
                    onClick={() =>
                      setAcceptedPurges((prev) =>
                        prev.filter((item) => item.collectionId !== rec.collectionId),
                      )
                    }
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

      <div className="sp-note-list">
        {items.map((col) => {
          const estExpiry = estimateTrashPurgeAfter(col.updated_at);
          const showTitle =
            Boolean(col.display_title?.trim()) &&
            col.display_title.trim() !== '未命名收藏' &&
            col.display_title.trim() !== col.excerpt.trim();
          const isBusy =
            restoringId === col.id ||
            purgingId === col.id ||
            confirmTarget?.id === col.id ||
            acceptedIds.has(col.id);

          return (
            <article key={col.id} className="sp-note">
              <div className="sp-note-meta sp-trash-meta">
                <time dateTime={col.updated_at}>删除/更新于 {formatDateTime(col.updated_at)}</time>
                {estExpiry && (
                  <span className="sp-trash-expiry">
                    预计到期：{formatDateTime(estExpiry)}（{formatRemainingTrashDays(estExpiry)}）
                  </span>
                )}
              </div>

              {showTitle && (
                <h3 className="sp-note-title">
                  <Link to={`/collections/${col.id}`} state={{ from: '/trash' }}>
                    {col.display_title}
                  </Link>
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
                <Link to={`/collections/${col.id}`} state={{ from: '/trash' }} className="sp-help">
                  查看详情
                </Link>
                <div className="sp-row sp-note-footer-action">
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm"
                    disabled={isBusy}
                    onClick={() => restoreMutation.mutate(col)}
                  >
                    <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{restoringId === col.id ? '恢复中…' : '恢复'}</span>
                  </button>
                  <button
                    type="button"
                    className="sp-btn sp-btn--sm sp-btn--danger"
                    disabled={isBusy}
                    onClick={() => {
                      setActionError(null);
                      setConfirmTarget(col);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                    <span>{purgingId === col.id ? '删除中…' : '永久删除'}</span>
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {trashQuery.hasNextPage && (
        <div className="sp-load-more">
          <button
            type="button"
            className="sp-btn"
            disabled={trashQuery.isFetchingNextPage}
            onClick={() => void trashQuery.fetchNextPage()}
          >
            加载更多
          </button>
        </div>
      )}

      <PurgeConfirmModal
        open={Boolean(confirmTarget)}
        targetSummary={
          confirmTarget ? confirmTarget.display_title || confirmTarget.excerpt : undefined
        }
        isSubmitting={purgeMutation.isPending}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={handleConfirmPurge}
      />
    </div>
  );
}
