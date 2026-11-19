import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Layers,
  RotateCcw,
  SkipForward,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  AssociationUpdate,
  Collection,
  CollectionSummary,
  Project,
  ProjectAssociation,
  ProjectUndoReceipt,
} from '../api/types';
import { ApiError, getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { JarScene } from '../components/Illustrations';
import { ProjectSuggestionEvidence } from '../components/ProjectSuggestionEvidence';
import { ErrorBanner, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { useToast } from '../context/ToastContext';
import { derivePlainText } from '../lib/document';
import { extractDomain, formatRelativeTime } from '../lib/format';
import { generateIdempotencyKey } from '../lib/idempotency';
import { buildTriageAssociationUpdate } from '../lib/organization';
import { projectToneClass } from '../lib/projectTone';

const QUEUE_PAGE_SIZE = 30;
const PROJECT_PAGE_SIZE = 50;
const PREFETCH_THRESHOLD = 5;
const INITIAL_VISIBLE_PROJECTS = 6;
const SWIPE_ACTIVATE_PX = 14;
const SWIPE_COMMIT_PX = 84;

type UndoEntry =
  | {
      kind: 'server';
      collectionId: string;
      receipt?: ProjectUndoReceipt;
    }
  | {
      kind: 'skip';
      collectionId: string;
    }
  | {
      kind: 'ignore';
      collectionId: string;
      summary: CollectionSummary;
    };

interface PendingRetryState {
  collectionId: string;
  payload: AssociationUpdate;
  idempotencyKey: string;
  summary: CollectionSummary;
}

interface CandidateProjectItem {
  id: string;
  name: string;
  state: Project['state'];
}

function hasActiveClassification(projects: ProjectAssociation[]): boolean {
  return projects.some(
    (p) => p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto',
  );
}

function isUncertainCommitOutcome(err: unknown): boolean {
  if (
    isApiErrorCode(err, 'network_error') ||
    isApiErrorCode(err, 'service_unavailable') ||
    isApiErrorCode(err, 'operation_in_progress')
  ) {
    return true;
  }
  if (err instanceof ApiError) {
    return err.status === 0 || err.status >= 500;
  }
  return false;
}

function collectionToSummary(col: Collection): CollectionSummary {
  const plain = derivePlainText(col.document).trim();
  const excerpt = plain || col.intent || col.original_url || '';
  return {
    id: col.id,
    display_title: col.display_title,
    excerpt: excerpt.slice(0, 180),
    content_types: col.content_types,
    projects: col.projects,
    tags: col.tags,
    organization_status: col.organization.status,
    read_at: col.read_at,
    created_at: col.created_at,
    updated_at: col.updated_at,
    resource_version: col.resource_version,
    has_suggestion: col.has_suggestion,
  };
}

function deduplicateQueueItems(
  base: CollectionSummary[],
  incoming: CollectionSummary[],
  handledIds: Set<string>,
): CollectionSummary[] {
  const seen = new Set(base.map((item) => item.id));
  const next = [...base];
  for (const item of incoming) {
    if (!seen.has(item.id) && !handledIds.has(item.id)) {
      seen.add(item.id);
      next.push(item);
    }
  }
  return next;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

export function TriagePage() {
  const api = useApi();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { markSuggestionPromptHandled } = useOrganizationEvents();
  const reducedMotion = usePrefersReducedMotion();

  const currentUserId = user?.id ?? null;

  const [queue, setQueue] = useState<CollectionSummary[]>([]);
  const [queueInitialized, setQueueInitialized] = useState(false);
  const [queueError, setQueueError] = useState<unknown>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [isLoadingQueue, setIsLoadingQueue] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [fetchMoreFailed, setFetchMoreFailed] = useState(false);

  const [processedCount, setProcessedCount] = useState(0);
  const [roundFinishedEarly, setRoundFinishedEarly] = useState(false);
  const [moreProjectsOpen, setMoreProjectsOpen] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [lastUndo, setLastUndo] = useState<UndoEntry | null>(null);
  const [pendingRetry, setPendingRetry] = useState<PendingRetryState | null>(null);
  const [skippedIds, setSkippedIds] = useState<Set<string>>(() => new Set());
  const [allSkippedCycleNotice, setAllSkippedCycleNotice] = useState(false);
  const [actionNotice, setActionNotice] = useState<{
    tone: 'warning' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pickerHighlighted, setPickerHighlighted] = useState(false);

  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [isDraggingHorizontal, setIsDraggingHorizontal] = useState(false);

  const handledIdsRef = useRef<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const sessionEpochRef = useRef(0);
  const userIdRef = useRef<string | null>(currentUserId);
  const queueAbortRef = useRef<AbortController | null>(null);
  const pointerStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    horizontal: boolean;
  } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionEpochRef.current += 1;
      queueAbortRef.current?.abort();
    };
  }, []);

  const isContextCurrent = useCallback((capturedEpoch: number, capturedUserId: string | null) => {
    return (
      mountedRef.current &&
      sessionEpochRef.current === capturedEpoch &&
      userIdRef.current === capturedUserId
    );
  }, []);

  const activeProjectsQuery = useInfiniteQuery({
    queryKey: ['projects', 'triage-active', currentUserId],
    queryFn: ({ pageParam }) =>
      api.listProjects({ state: 'active', limit: PROJECT_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
    enabled: Boolean(currentUserId),
  });

  const allProjectsQuery = useInfiniteQuery({
    queryKey: ['projects', 'triage-all', currentUserId],
    queryFn: ({ pageParam }) => api.listProjects({ limit: PROJECT_PAGE_SIZE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
    enabled: Boolean(currentUserId) && moreProjectsOpen,
  });

  const loadQueuePage = useCallback(
    async (cursor?: string, reset = false) => {
      const capturedEpoch = sessionEpochRef.current;
      const capturedUserId = userIdRef.current;
      if (!capturedUserId) return;

      if (reset) {
        queueAbortRef.current?.abort();
        setIsLoadingQueue(true);
        setQueueError(null);
      } else {
        setIsFetchingMore(true);
      }
      setFetchMoreFailed(false);

      const controller = new AbortController();
      if (reset) {
        queueAbortRef.current = controller;
      }

      try {
        const res = await api.listCollections(
          {
            scope: 'unclassified',
            limit: QUEUE_PAGE_SIZE,
            cursor,
          },
          controller.signal,
        );
        if (!isContextCurrent(capturedEpoch, capturedUserId)) return;

        setNextCursor(res.next_cursor);
        setQueue((prev) =>
          reset
            ? deduplicateQueueItems([], res.items, handledIdsRef.current)
            : deduplicateQueueItems(prev, res.items, handledIdsRef.current),
        );
        setQueueInitialized(true);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!isContextCurrent(capturedEpoch, capturedUserId)) return;

        if (reset) {
          setQueueError(err);
        } else {
          setFetchMoreFailed(true);
          setActionNotice({ tone: 'error', text: getFriendlyErrorMessage(err) });
        }
      } finally {
        if (isContextCurrent(capturedEpoch, capturedUserId)) {
          setIsLoadingQueue(false);
          setIsFetchingMore(false);
        }
      }
    },
    [api, isContextCurrent],
  );

  // Reset local triage state and load fresh queue whenever authenticated account changes.
  useEffect(() => {
    userIdRef.current = currentUserId;
    sessionEpochRef.current += 1;
    queueAbortRef.current?.abort();
    handledIdsRef.current = new Set();

    setQueue([]);
    setQueueInitialized(false);
    setQueueError(null);
    setNextCursor(undefined);
    setFetchMoreFailed(false);
    setProcessedCount(0);
    setRoundFinishedEarly(false);
    setMoreProjectsOpen(false);
    setMultiSelectMode(false);
    setSelectedProjectIds([]);
    setLastUndo(null);
    setPendingRetry(null);
    setSkippedIds(new Set());
    setAllSkippedCycleNotice(false);
    setActionNotice(null);
    setIsSubmitting(false);

    if (currentUserId) {
      void loadQueuePage(undefined, true);
    }
  }, [currentUserId, loadQueuePage]);

  // Auto-prefetch next cursor page only when previous prefetch did not fail.
  useEffect(() => {
    if (
      queueInitialized &&
      nextCursor &&
      !isFetchingMore &&
      !isLoadingQueue &&
      !fetchMoreFailed &&
      queue.length <= PREFETCH_THRESHOLD
    ) {
      void loadQueuePage(nextCursor, false);
    }
  }, [
    fetchMoreFailed,
    isFetchingMore,
    isLoadingQueue,
    loadQueuePage,
    nextCursor,
    queue.length,
    queueInitialized,
  ]);

  const currentSummary = !roundFinishedEarly ? queue[0] : undefined;
  const nextSummary = !roundFinishedEarly ? queue[1] : undefined;

  const detailQuery = useQuery({
    queryKey: ['collection', currentSummary?.id, currentUserId],
    queryFn: () => api.getCollection(currentSummary!.id),
    enabled: Boolean(currentSummary?.id) && Boolean(currentUserId),
  });

  const currentDetail = detailQuery.data?.id === currentSummary?.id ? detailQuery.data : undefined;
  const isDecisionReady = Boolean(currentDetail) && !detailQuery.isError;

  // Keep queue in sync if the front card was deleted or classified in another tab.
  useEffect(() => {
    if (!currentSummary || !currentDetail) return;
    if (currentDetail.deleted_at || hasActiveClassification(currentDetail.projects)) {
      const removedId = currentDetail.id;
      handledIdsRef.current.add(removedId);
      setQueue((prev) => prev.filter((item) => item.id !== removedId));
      setSelectedProjectIds([]);
      setPendingRetry((prev) => (prev?.collectionId === removedId ? null : prev));
      setActionNotice({ tone: 'info', text: '这条建议已在其他地方处理' });
    }
  }, [currentDetail, currentSummary]);

  const currentProjectsSource = currentDetail?.projects ?? currentSummary?.projects ?? [];

  const activeProjects = useMemo(
    () => activeProjectsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [activeProjectsQuery.data?.pages],
  );

  const allProjects = useMemo(
    () => allProjectsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [allProjectsQuery.data?.pages],
  );

  const suggestedAssociations = useMemo(() => {
    const nonActiveKnownIds = new Set(
      allProjects.filter((p) => p.state !== 'active').map((p) => p.id),
    );
    return currentProjectsSource.filter(
      (p) => p.decision === 'suggested' && !nonActiveKnownIds.has(p.project_id),
    );
  }, [allProjects, currentProjectsSource]);

  const orderedCandidateProjects = useMemo((): CandidateProjectItem[] => {
    const projectMap = new Map<string, Project>();
    for (const p of activeProjects) projectMap.set(p.id, p);
    for (const p of allProjects) {
      if (!projectMap.has(p.id)) projectMap.set(p.id, p);
    }

    const result: CandidateProjectItem[] = [];
    const included = new Set<string>();

    // Always surface valid suggested projects from the active card first, even if paginated beyond page 1.
    for (const assoc of suggestedAssociations) {
      if (included.has(assoc.project_id)) continue;
      const loaded = projectMap.get(assoc.project_id);
      if (loaded && loaded.state !== 'active' && !moreProjectsOpen) continue;
      included.add(assoc.project_id);
      result.push({
        id: assoc.project_id,
        name: loaded?.name ?? assoc.name,
        state: loaded?.state ?? 'active',
      });
    }

    for (const p of activeProjects) {
      if (included.has(p.id)) continue;
      included.add(p.id);
      result.push({ id: p.id, name: p.name, state: p.state });
    }

    if (moreProjectsOpen) {
      for (const p of allProjects) {
        if (included.has(p.id)) continue;
        included.add(p.id);
        result.push({ id: p.id, name: p.name, state: p.state });
      }
    }

    return result;
  }, [activeProjects, allProjects, moreProjectsOpen, suggestedAssociations]);

  const visibleCandidates = useMemo(() => {
    if (moreProjectsOpen) return orderedCandidateProjects;
    const minCount = Math.max(INITIAL_VISIBLE_PROJECTS, suggestedAssociations.length);
    return orderedCandidateProjects.slice(0, minCount);
  }, [moreProjectsOpen, orderedCandidateProjects, suggestedAssociations.length]);

  const suggestedAssocByProjectId = useMemo(() => {
    const map = new Map<string, ProjectAssociation>();
    for (const assoc of suggestedAssociations) {
      map.set(assoc.project_id, assoc);
    }
    return map;
  }, [suggestedAssociations]);

  const executeFrozenPatch = useCallback(
    async (
      collectionId: string,
      payload: AssociationUpdate,
      idempotencyKey: string,
      capturedSummary: CollectionSummary,
    ) => {
      if (isSubmitting) return;
      const capturedEpoch = sessionEpochRef.current;
      const capturedUserId = userIdRef.current;

      setIsSubmitting(true);
      setActionNotice(null);

      try {
        const updated = await api.updateProjectDecisions(collectionId, payload, idempotencyKey);
        if (!isContextCurrent(capturedEpoch, capturedUserId)) return;

        markSuggestionPromptHandled(updated.id);
        queryClient.setQueryData(['collection', updated.id], updated);
        queryClient.setQueryData(['collection', updated.id, capturedUserId], updated);
        void queryClient.invalidateQueries({ queryKey: ['collections'] });
        void queryClient.invalidateQueries({ queryKey: ['projects'] });

        handledIdsRef.current.add(updated.id);
        setPendingRetry(null);
        setQueue((prev) => prev.filter((item) => item.id !== updated.id));
        setSkippedIds((prev) => {
          if (!prev.has(updated.id)) return prev;
          const next = new Set(prev);
          next.delete(updated.id);
          return next;
        });
        setAllSkippedCycleNotice(false);
        setProcessedCount((n) => n + 1);
        setSelectedProjectIds([]);
        setPickerHighlighted(false);
        setLastUndo({
          kind: 'server',
          collectionId: updated.id,
          receipt: updated.undo_receipt,
        });
      } catch (err) {
        if (!isContextCurrent(capturedEpoch, capturedUserId)) return;

        if (isUncertainCommitOutcome(err)) {
          setPendingRetry({
            collectionId,
            payload,
            idempotencyKey,
            summary: capturedSummary,
          });
          setActionNotice({
            tone: 'error',
            text: `${getFriendlyErrorMessage(err)}（已保留当前提交键值，可点击「重试提交」核对结果并取回撤销回执）`,
          });
          return;
        }

        setPendingRetry(null);
        const isConflictOrStale =
          isApiErrorCode(err, 'decision_conflict') ||
          isApiErrorCode(err, 'suggestion_conflict') ||
          isApiErrorCode(err, 'collection_in_trash');

        if (isConflictOrStale) {
          setActionNotice({ tone: 'warning', text: '这条建议已在其他地方处理' });
          setSelectedProjectIds([]);
          try {
            const fresh = await api.getCollection(capturedSummary.id);
            if (!isContextCurrent(capturedEpoch, capturedUserId)) return;
            queryClient.setQueryData(['collection', fresh.id], fresh);
            queryClient.setQueryData(['collection', fresh.id, capturedUserId], fresh);
            if (fresh.deleted_at || hasActiveClassification(fresh.projects)) {
              handledIdsRef.current.add(fresh.id);
              setQueue((prev) => prev.filter((item) => item.id !== fresh.id));
            } else {
              const freshSummary = collectionToSummary(fresh);
              setQueue((prev) =>
                prev.map((item) => (item.id === freshSummary.id ? freshSummary : item)),
              );
            }
          } catch {
            if (isContextCurrent(capturedEpoch, capturedUserId)) {
              void queryClient.invalidateQueries({
                queryKey: ['collection', capturedSummary.id],
              });
            }
          }
        } else {
          setActionNotice({ tone: 'error', text: getFriendlyErrorMessage(err) });
        }
      } finally {
        if (isContextCurrent(capturedEpoch, capturedUserId)) {
          setIsSubmitting(false);
        }
      }
    },
    [api, isContextCurrent, isSubmitting, markSuggestionPromptHandled, queryClient],
  );

  const commitSelection = useCallback(
    async (projectIds: string[]) => {
      if (!currentSummary || !currentDetail || isSubmitting || projectIds.length === 0) return;

      // If user retries the same selection for the frozen uncertain submission, reuse frozen payload + key.
      if (pendingRetry && pendingRetry.collectionId === currentSummary.id) {
        const retryIds = pendingRetry.payload.operations.map((op) => op.id).sort();
        const reqIds = Array.from(new Set(projectIds)).sort();
        if (
          retryIds.length === reqIds.length &&
          retryIds.every((id, index) => id === reqIds[index])
        ) {
          await executeFrozenPatch(
            pendingRetry.collectionId,
            pendingRetry.payload,
            pendingRetry.idempotencyKey,
            pendingRetry.summary,
          );
          return;
        }
      }

      const frozenPayload = buildTriageAssociationUpdate(currentDetail, projectIds);
      const frozenKey = generateIdempotencyKey();
      await executeFrozenPatch(currentSummary.id, frozenPayload, frozenKey, currentSummary);
    },
    [currentDetail, currentSummary, executeFrozenPatch, isSubmitting, pendingRetry],
  );

  const handleSkip = useCallback(() => {
    if (!currentSummary || isSubmitting) return;
    setActionNotice(null);
    setPendingRetry(null);
    setSelectedProjectIds([]);
    setPickerHighlighted(false);

    const nextSkipped = new Set(skippedIds);
    nextSkipped.add(currentSummary.id);
    setSkippedIds(nextSkipped);

    const reordered =
      queue.length > 1 ? [...queue.slice(1), currentSummary] : [currentSummary];
    setQueue(reordered);
    setAllSkippedCycleNotice(reordered.every((item) => nextSkipped.has(item.id)));
    setLastUndo({ kind: 'skip', collectionId: currentSummary.id });
  }, [currentSummary, isSubmitting, queue, skippedIds]);

  const handleIgnoreForRound = useCallback(() => {
    if (!currentSummary || isSubmitting) return;
    setActionNotice(null);
    setPendingRetry(null);
    setSelectedProjectIds([]);
    setPickerHighlighted(false);

    const target = currentSummary;
    handledIdsRef.current.add(target.id);
    setQueue((prev) => prev.filter((item) => item.id !== target.id));
    setSkippedIds((prev) => {
      if (!prev.has(target.id)) return prev;
      const next = new Set(prev);
      next.delete(target.id);
      return next;
    });
    setAllSkippedCycleNotice(false);
    setProcessedCount((n) => n + 1);
    setLastUndo({ kind: 'ignore', collectionId: target.id, summary: target });
  }, [currentSummary, isSubmitting]);

  const handleUndo = useCallback(async () => {
    if (isSubmitting || !lastUndo) return;
    const targetUndo = lastUndo;
    setActionNotice(null);
    setPendingRetry(null);
    setSelectedProjectIds([]);
    setRoundFinishedEarly(false);

    if (targetUndo.kind === 'skip') {
      setLastUndo(null);
      setAllSkippedCycleNotice(false);
      setSkippedIds((prev) => {
        if (!prev.has(targetUndo.collectionId)) return prev;
        const next = new Set(prev);
        next.delete(targetUndo.collectionId);
        return next;
      });
      setQueue((prev) => {
        const target = prev.find((item) => item.id === targetUndo.collectionId);
        if (!target) return prev;
        return [target, ...prev.filter((item) => item.id !== targetUndo.collectionId)];
      });
      return;
    }

    if (targetUndo.kind === 'ignore') {
      setLastUndo(null);
      handledIdsRef.current.delete(targetUndo.collectionId);
      setAllSkippedCycleNotice(false);
      setProcessedCount((n) => Math.max(0, n - 1));
      setQueue((prev) => [
        targetUndo.summary,
        ...prev.filter((item) => item.id !== targetUndo.collectionId),
      ]);
      return;
    }

    if (!targetUndo.receipt) {
      setLastUndo(null);
      setActionNotice({ tone: 'warning', text: '当前操作未生成撤销回执，无法撤销。' });
      return;
    }

    if (Date.parse(targetUndo.receipt.expires_at) <= Date.now()) {
      setLastUndo(null);
      setActionNotice({ tone: 'warning', text: '撤销回执已过期，无法撤销上一步操作。' });
      return;
    }

    const capturedEpoch = sessionEpochRef.current;
    const capturedUserId = userIdRef.current;
    setIsSubmitting(true);

    try {
      const restored = await api.undoProjectDecisions(targetUndo.collectionId, {
        operation_key: targetUndo.receipt.operation_key,
        base_decision_version: targetUndo.receipt.decision_version,
      });
      if (!isContextCurrent(capturedEpoch, capturedUserId)) return;

      queryClient.setQueryData(['collection', restored.id], restored);
      queryClient.setQueryData(['collection', restored.id, capturedUserId], restored);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });

      handledIdsRef.current.delete(restored.id);
      const restoredSummary = collectionToSummary(restored);

      setLastUndo(null);
      setAllSkippedCycleNotice(false);
      setProcessedCount((n) => Math.max(0, n - 1));
      setQueue((prev) => [
        restoredSummary,
        ...prev.filter((item) => item.id !== restoredSummary.id),
      ]);
      pushToast({ message: '已撤销上一步决定' });
    } catch (err) {
      if (!isContextCurrent(capturedEpoch, capturedUserId)) return;

      const staleReceipt =
        isApiErrorCode(err, 'undo_unavailable') ||
        isApiErrorCode(err, 'decision_conflict') ||
        isApiErrorCode(err, 'suggestion_conflict') ||
        isApiErrorCode(err, 'collection_in_trash');
      if (staleReceipt) {
        setLastUndo(null);
      }
      setActionNotice({
        tone: staleReceipt ? 'warning' : 'error',
        text: getFriendlyErrorMessage(err),
      });
    } finally {
      if (isContextCurrent(capturedEpoch, capturedUserId)) {
        setIsSubmitting(false);
      }
    }
  }, [api, isContextCurrent, isSubmitting, lastUndo, pushToast, queryClient]);

  const handleToggleProjectSelection = useCallback(
    (projectId: string) => {
      if (!isDecisionReady || isSubmitting) return;
      setSelectedProjectIds((prev) =>
        prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId],
      );
    },
    [isDecisionReady, isSubmitting],
  );

  const handleTapeClick = useCallback(
    (projectId: string) => {
      if (!isDecisionReady || isSubmitting) return;
      if (multiSelectMode || selectedProjectIds.length > 0) {
        handleToggleProjectSelection(projectId);
      } else {
        void commitSelection([projectId]);
      }
    },
    [
      commitSelection,
      handleToggleProjectSelection,
      isDecisionReady,
      isSubmitting,
      multiSelectMode,
      selectedProjectIds.length,
    ],
  );

  const handleFocusPicker = useCallback(() => {
    setPickerHighlighted(true);
    const firstBtn = pickerRef.current?.querySelector<HTMLButtonElement>('button[data-triage-tape]');
    firstBtn?.focus();
  }, []);

  // Keyboard shortcuts: 1-9 select project, Enter confirm, S skip, Z undo, Esc exit.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return;
        }
        if (target.closest('[role="dialog"]')) {
          return;
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        navigate('/unclassified');
        return;
      }

      if (event.key === 'z' || event.key === 'Z') {
        if (lastUndo && !isSubmitting) {
          event.preventDefault();
          void handleUndo();
        }
        return;
      }

      if (!currentSummary || roundFinishedEarly || isSubmitting) return;

      if (event.key >= '1' && event.key <= '9') {
        if (!isDecisionReady) return;
        const idx = Number.parseInt(event.key, 10) - 1;
        const proj = visibleCandidates[idx];
        if (proj) {
          event.preventDefault();
          handleToggleProjectSelection(proj.id);
        }
        return;
      }

      if (event.key === 'Enter' && selectedProjectIds.length > 0 && isDecisionReady) {
        if (
          target instanceof HTMLElement &&
          target.closest('button:not([data-triage-tape]), a')
        ) {
          return;
        }
        event.preventDefault();
        void commitSelection(selectedProjectIds);
        return;
      }

      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        handleSkip();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    commitSelection,
    currentSummary,
    handleSkip,
    handleToggleProjectSelection,
    handleUndo,
    isDecisionReady,
    isSubmitting,
    lastUndo,
    navigate,
    roundFinishedEarly,
    selectedProjectIds,
    visibleCandidates,
  ]);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (isSubmitting) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;

    pointerStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: true,
      horizontal: false,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore synthetic pointer events without active pointer ids in tests
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const st = pointerStateRef.current;
    if (!st || !st.active || st.pointerId !== event.pointerId) return;
    const dx = event.clientX - st.startX;
    const dy = event.clientY - st.startY;
    if (!st.horizontal) {
      if (Math.abs(dx) > SWIPE_ACTIVATE_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
        st.horizontal = true;
        setIsDraggingHorizontal(true);
      } else {
        return;
      }
    }
    setDragOffsetX(dx);
  };

  const resetPointerGesture = (event: React.PointerEvent<HTMLElement>) => {
    pointerStateRef.current = null;
    setIsDraggingHorizontal(false);
    setDragOffsetX(0);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release errors on synthetic events
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const st = pointerStateRef.current;
    if (!st || !st.active || st.pointerId !== event.pointerId) return;
    const dx = st.horizontal ? event.clientX - st.startX : 0;
    const wasHorizontal = st.horizontal;
    resetPointerGesture(event);

    if (!wasHorizontal) return;
    if (dx <= -SWIPE_COMMIT_PX) {
      handleSkip();
    } else if (dx >= SWIPE_COMMIT_PX) {
      handleFocusPicker();
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    const st = pointerStateRef.current;
    if (!st || st.pointerId !== event.pointerId) return;
    resetPointerGesture(event);
  };

  const bodyText = currentDetail
    ? derivePlainText(currentDetail.document).trim()
    : currentSummary?.excerpt ?? '';
  const intentText = currentDetail?.intent?.trim() ?? '';
  const originalUrl = currentDetail?.original_url;
  const domain = extractDomain(originalUrl);
  const displayTitle = currentDetail?.display_title ?? currentSummary?.display_title ?? '';
  const showDistinctTitle =
    Boolean(displayTitle) &&
    displayTitle !== bodyText &&
    displayTitle !== domain &&
    !bodyText.startsWith(displayTitle);

  const isCompleted =
    queueInitialized && !isLoadingQueue && !queueError && (!currentSummary || roundFinishedEarly);

  const dragTransform =
    !reducedMotion && isDraggingHorizontal
      ? `translateX(${dragOffsetX}px) rotate(${(dragOffsetX * 0.025).toFixed(2)}deg)`
      : undefined;

  const canExpandMoreProjects =
    moreProjectsOpen ||
    Boolean(activeProjectsQuery.hasNextPage) ||
    orderedCandidateProjects.length > visibleCandidates.length ||
    !allProjectsQuery.isFetched ||
    allProjects.length > visibleCandidates.length;

  return (
    <div className="sp-triage-page">
      <header className="sp-triage-topbar">
        <div className="sp-triage-topbar-left">
          <Link to="/unclassified" className="sp-btn sp-btn--sm">
            <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
            <span>退出整理</span>
          </Link>
          <h1 className="sp-triage-title">快速整理</h1>
        </div>
        <div className="sp-triage-topbar-right">
          <span className="sp-triage-progress" role="status" aria-live="polite">
            本轮已处理 {processedCount} 条
          </span>
          <button
            type="button"
            className="sp-btn sp-btn--sm"
            disabled={!lastUndo || isSubmitting}
            onClick={() => void handleUndo()}
          >
            <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
            <span>撤销上一步</span>
          </button>
        </div>
      </header>

      {actionNotice && (
        <div
          className={`sp-banner sp-spaced ${
            actionNotice.tone === 'error'
              ? 'sp-banner--error'
              : actionNotice.tone === 'warning'
                ? 'sp-banner--warning'
                : 'sp-banner--info'
          }`}
          role={actionNotice.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{actionNotice.text}</span>
          {pendingRetry && pendingRetry.collectionId === currentSummary?.id && (
            <button
              type="button"
              className="sp-btn sp-btn--primary sp-btn--sm"
              disabled={isSubmitting}
              onClick={() =>
                void executeFrozenPatch(
                  pendingRetry.collectionId,
                  pendingRetry.payload,
                  pendingRetry.idempotencyKey,
                  pendingRetry.summary,
                )
              }
            >
              <span>重试提交</span>
            </button>
          )}
        </div>
      )}

      {fetchMoreFailed && nextCursor && !isCompleted && (
        <div className="sp-banner sp-banner--warning sp-spaced" role="status">
          <span>后续待归类列表加载失败，点击可手动继续加载。</span>
          <button
            type="button"
            className="sp-btn sp-btn--sm"
            disabled={isFetchingMore}
            onClick={() => void loadQueuePage(nextCursor, false)}
          >
            <span>继续加载更多</span>
          </button>
        </div>
      )}

      {allSkippedCycleNotice && !isCompleted && (
        <div className="sp-banner sp-banner--info sp-spaced" role="status">
          <span>剩余收藏已全部跳过一轮，可继续逐条处理或先结束本轮整理。</span>
          <button
            type="button"
            className="sp-btn sp-btn--sm"
            onClick={() => setRoundFinishedEarly(true)}
          >
            结束本轮整理
          </button>
        </div>
      )}

      {isLoadingQueue && !queueInitialized && <LoadingState message="正在准备待归类卡片…" />}
      {queueError !== null && !queueInitialized && (
        <ErrorBanner error={queueError} onRetry={() => void loadQueuePage(undefined, true)} />
      )}

      {isCompleted && (
        <section className="sp-triage-done sp-card" aria-label="本轮整理完成">
          <JarScene />
          <h2 className="sp-triage-done-title">本轮整理完成</h2>
          <p className="sp-help">
            {processedCount > 0
              ? `本轮共归类处理 ${processedCount} 条收藏，灵感罐已经理顺。`
              : '当前没有需要继续处理的待归类收藏。'}
          </p>
          <div className="sp-triage-done-actions">
            <Link to="/inbox" className="sp-btn sp-btn--primary">
              <span>返回收件箱</span>
            </Link>
            <Link to="/unclassified" className="sp-btn">
              <span>查看待归类</span>
            </Link>
          </div>
        </section>
      )}

      {currentSummary && !isCompleted && (
        <div className="sp-triage-stage">
          <div className="sp-triage-deck">
            {nextSummary && (
              <div className="sp-triage-card sp-triage-card--peek" aria-hidden="true" />
            )}

            <article
              className={`sp-triage-card sp-triage-card--front ${
                isDraggingHorizontal ? 'is-dragging' : ''
              }`}
              style={dragTransform ? { transform: dragTransform } : undefined}
              aria-label="当前待归类收藏"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            >
              <div className="sp-triage-card-meta">
                <span className="sp-tabular">
                  {formatRelativeTime(currentSummary.created_at)}
                </span>
                {domain && (
                  <span className="sp-pill">
                    <span>{domain}</span>
                  </span>
                )}
                {currentSummary.content_types.includes('image') && (
                  <span className="sp-pill">图片</span>
                )}
                <span className="sp-triage-remaining">剩余 {queue.length} 条</span>
              </div>

              {showDistinctTitle && (
                <h2 className="sp-triage-card-title sp-break-anywhere">{displayTitle}</h2>
              )}

              {bodyText && (
                <p className="sp-triage-card-body sp-break-anywhere">{bodyText}</p>
              )}

              {originalUrl && (
                <a
                  href={originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sp-url-chip"
                >
                  <ExternalLink size={14} strokeWidth={2} aria-hidden="true" />
                  <span className="sp-break-anywhere">{originalUrl}</span>
                </a>
              )}

              {intentText && (
                <div className="sp-triage-intent sp-break-anywhere">
                  <span className="sp-triage-intent-label">用途说明：</span>
                  <span>{intentText}</span>
                </div>
              )}

              {suggestedAssociations.length > 0 && (
                <div className="sp-triage-suggestions" aria-label="AI 归类建议">
                  {suggestedAssociations.map((assoc) => (
                    <div key={assoc.project_id} className="sp-triage-suggestion-box">
                      <div className="sp-row">
                        <span className="sp-pill sp-pill--green">
                          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
                          <span>建议归入：{assoc.name}</span>
                        </span>
                      </div>
                      <ProjectSuggestionEvidence association={assoc} />
                    </div>
                  ))}
                </div>
              )}

              <div className="sp-triage-card-footer">
                <Link
                  to={`/collections/${currentSummary.id}`}
                  className="sp-btn--quiet sp-btn--sm"
                >
                  <span>查看详情</span>
                  <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                </Link>
              </div>
            </article>
          </div>

          <section
            ref={pickerRef}
            className={`sp-triage-picker ${pickerHighlighted ? 'is-highlighted' : ''}`}
            aria-label="选择归属项目"
          >
            <div className="sp-triage-picker-head">
              <div className="sp-row">
                <Layers size={15} strokeWidth={2} aria-hidden="true" />
                <span className="sp-strong">归类到项目</span>
                <span className="sp-help">
                  {!isDecisionReady && detailQuery.isLoading
                    ? '正在核对最新决定版本…'
                    : multiSelectMode || selectedProjectIds.length > 0
                      ? '多选已启用，可一次归入多个项目'
                      : '点击纸胶带即刻归类，或按 1-9 多选后确认'}
                </span>
              </div>
              <button
                type="button"
                className="sp-btn sp-btn--sm"
                aria-pressed={multiSelectMode}
                disabled={!isDecisionReady || isSubmitting}
                onClick={() => {
                  setMultiSelectMode((prev) => {
                    const next = !prev;
                    if (!next) setSelectedProjectIds([]);
                    return next;
                  });
                }}
              >
                <span>多选项目</span>
              </button>
            </div>

            {detailQuery.isError ? (
              <ErrorBanner error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
            ) : activeProjectsQuery.isLoading && visibleCandidates.length === 0 ? (
              <div className="sp-help">正在加载项目列表…</div>
            ) : visibleCandidates.length === 0 && !moreProjectsOpen ? (
              <div className="sp-banner sp-banner--info">
                <span>
                  暂无活跃项目，可展开「更多项目」查看暂停项目或{' '}
                  <Link to="/projects?create=1" className="sp-strong">
                    新建项目
                  </Link>
                  。
                </span>
              </div>
            ) : visibleCandidates.length === 0 && moreProjectsOpen && allProjectsQuery.isLoading ? (
              <div className="sp-help">正在加载全部项目…</div>
            ) : visibleCandidates.length === 0 ? (
              <div className="sp-banner sp-banner--info">
                <span>
                  还没有可用项目，请先{' '}
                  <Link to="/projects?create=1" className="sp-strong">
                    新建项目
                  </Link>
                  。
                </span>
              </div>
            ) : (
              <div className="sp-triage-tapes" role="group" aria-label="候选项目纸胶带">
                {visibleCandidates.map((proj, index) => {
                  const isSuggested = suggestedAssocByProjectId.has(proj.id);
                  const isSelected = selectedProjectIds.includes(proj.id);
                  const shortcutNum = index < 9 ? index + 1 : null;
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      data-triage-tape={proj.id}
                      disabled={!isDecisionReady || isSubmitting}
                      aria-pressed={multiSelectMode || selectedProjectIds.length > 0 ? isSelected : undefined}
                      className={`sp-tape sp-triage-tape ${projectToneClass(proj.id)} ${
                        isSelected ? 'is-selected' : ''
                      }`}
                      onClick={() => handleTapeClick(proj.id)}
                    >
                      {shortcutNum !== null && (
                        <kbd className="sp-triage-key" aria-hidden="true">
                          {shortcutNum}
                        </kbd>
                      )}
                      <span>{proj.name}</span>
                      {isSuggested && <span className="sp-triage-suggested-tag">建议</span>}
                      {proj.state !== 'active' && (
                        <span className="sp-triage-state-tag">非活跃</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="sp-triage-picker-subactions">
              <div className="sp-row">
                {canExpandMoreProjects && (
                  <button
                    type="button"
                    className="sp-btn--quiet sp-btn--sm"
                    aria-expanded={moreProjectsOpen}
                    onClick={() => setMoreProjectsOpen((v) => !v)}
                  >
                    {moreProjectsOpen ? (
                      <>
                        <ChevronUp size={14} strokeWidth={2} aria-hidden="true" />
                        <span>收起更多项目</span>
                      </>
                    ) : (
                      <>
                        <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                        <span>更多项目</span>
                      </>
                    )}
                  </button>
                )}

                {moreProjectsOpen && allProjectsQuery.hasNextPage && (
                  <button
                    type="button"
                    className="sp-btn--quiet sp-btn--sm"
                    disabled={allProjectsQuery.isFetchingNextPage}
                    onClick={() => void allProjectsQuery.fetchNextPage()}
                  >
                    <span>加载更多项目</span>
                  </button>
                )}
              </div>

              {selectedProjectIds.length > 0 && (
                <button
                  type="button"
                  className="sp-btn sp-btn--primary sp-btn--sm"
                  disabled={!isDecisionReady || isSubmitting}
                  onClick={() => void commitSelection(selectedProjectIds)}
                >
                  <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                  <span>确认归入（{selectedProjectIds.length}）</span>
                </button>
              )}
            </div>
          </section>

          <div className="sp-triage-actions" role="group" aria-label="整理操作">
            <button
              type="button"
              className="sp-btn"
              disabled={isSubmitting}
              onClick={handleSkip}
            >
              <SkipForward size={15} strokeWidth={2} aria-hidden="true" />
              <span>跳过</span>
            </button>
            <button
              type="button"
              className="sp-btn"
              disabled={isSubmitting}
              onClick={handleFocusPicker}
            >
              <Layers size={15} strokeWidth={2} aria-hidden="true" />
              <span>选择项目</span>
            </button>
            <button
              type="button"
              className="sp-btn"
              disabled={isSubmitting}
              onClick={handleIgnoreForRound}
            >
              <X size={15} strokeWidth={2} aria-hidden="true" />
              <span>不属于任何项目</span>
            </button>
          </div>

          <p className="sp-triage-shortcuts-hint sp-help">
            快捷键：1-9 选择项目 · Enter 确认 · S 跳过 · Z 撤销 · Esc 退出（触摸可左滑跳过、右滑选项目）
          </p>
        </div>
      )}
    </div>
  );
}
