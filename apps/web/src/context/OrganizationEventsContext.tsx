import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { type InfiniteData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Collection, CollectionPage, CollectionSummary, OrganizationEvent } from '../api/types';
import { useRecordOpened } from '../components/CollectionLink';
import { isOrganizationActiveStatus } from '../lib/organization';
import { useApi } from './ApiContext';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';

export interface OrganizationEventsContextValue {
  pendingSuggestionsCount: number;
  pendingSuggestions: CollectionSummary[];
  isPendingSuggestionsLoading: boolean;
  refetchPendingSuggestions: () => Promise<unknown>;
  markSuggestionPromptHandled: (collectionId: string) => void;
}

const OrganizationEventsContext = createContext<OrganizationEventsContextValue | null>(null);

const MAX_NOTIFIED_HISTORY = 200;

function patchInfiniteCollectionItem(
  data: InfiniteData<CollectionPage> | undefined,
  collectionId: string,
  updater: (item: CollectionSummary) => CollectionSummary,
): InfiniteData<CollectionPage> | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((item) => {
      if (item.id !== collectionId) return item;
      pageChanged = true;
      changed = true;
      return updater(item);
    });
    return pageChanged ? { ...page, items } : page;
  });
  return changed ? { ...data, pages } : data;
}

export function OrganizationEventsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user, refreshSession } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const recordOpened = useRecordOpened();
  const location = useLocation();

  const notifiedSuggestionsRef = useRef<Set<string>>(new Set());
  const sessionCheckedOnCloseRef = useRef(false);
  const subscriptionGeneration = useRef(0);
  const lastSyncAtRef = useRef(0);
  const locationPathRef = useRef(location.pathname);
  const navigateRef = useRef(navigate);
  locationPathRef.current = location.pathname;
  navigateRef.current = navigate;

  const pendingSuggestionsQuery = useQuery({
    queryKey: ['collections', 'pending-suggestions'],
    queryFn: ({ signal }) =>
      api.listCollections({ scope: 'active', has_suggestion: true, limit: 20 }, signal),
    enabled: Boolean(user?.id),
    staleTime: 60_000,
  });

  const syncOrganizationViews = useCallback(() => {
    const now = Date.now();
    if (now - lastSyncAtRef.current < 200) {
      return;
    }
    lastSyncAtRef.current = now;
    void queryClient.invalidateQueries({ queryKey: ['collections'], refetchType: 'active' });
    void queryClient.invalidateQueries({ queryKey: ['collection'], refetchType: 'active' });
    void queryClient.invalidateQueries({
      queryKey: ['collection-extractions'],
      refetchType: 'active',
    });
    void queryClient.invalidateQueries({ queryKey: ['project-collections'], refetchType: 'active' });
    void queryClient.invalidateQueries({ queryKey: ['me', 'usage'], refetchType: 'active' });
  }, [queryClient]);

  const markSuggestionPromptHandled = useCallback((collectionId: string) => {
    notifiedSuggestionsRef.current.add(collectionId);
  }, []);

  const rememberSuggestionNotified = useCallback((collectionId: string): boolean => {
    const seen = notifiedSuggestionsRef.current;
    if (seen.has(collectionId)) {
      return false;
    }
    if (seen.size >= MAX_NOTIFIED_HISTORY) {
      const oldest = seen.values().next().value;
      if (oldest) seen.delete(oldest);
    }
    seen.add(collectionId);
    return true;
  }, []);

  const applyEventStatusToCaches = useCallback(
    (event: OrganizationEvent) => {
      queryClient.setQueryData<Collection | undefined>(
        ['collection', event.collection_id],
        (prev) =>
          prev
            ? {
                ...prev,
                has_suggestion: event.has_suggestion,
                organization: {
                  ...prev.organization,
                  status: event.status,
                },
              }
            : prev,
      );

      queryClient.setQueriesData<InfiniteData<CollectionPage>>(
        { queryKey: ['collections'] },
        (old) => {
          if (!old || !('pages' in old)) return old;
          return patchInfiniteCollectionItem(old, event.collection_id, (item) => ({
            ...item,
            organization_status: event.status,
            has_suggestion: event.has_suggestion,
          }));
        },
      );

      queryClient.setQueriesData<InfiniteData<CollectionPage>>(
        { queryKey: ['project-collections'] },
        (old) => {
          if (!old || !('pages' in old)) return old;
          return patchInfiniteCollectionItem(old, event.collection_id, (item) => ({
            ...item,
            organization_status: event.status,
            has_suggestion: event.has_suggestion,
          }));
        },
      );
    },
    [queryClient],
  );

  const handleOrganizationEvent = useCallback(
    (event: OrganizationEvent) => {
      applyEventStatusToCaches(event);

      if (isOrganizationActiveStatus(event.status)) {
        notifiedSuggestionsRef.current.delete(event.collection_id);
        return;
      }

      // Refresh only the affected collection detail (or targeted item state) without reloading full list pages.
      const hadDetailMounted =
        queryClient.getQueryState(['collection', event.collection_id]) !== undefined;
      const isInAnyLoadedList = queryClient
        .getQueriesData<InfiniteData<CollectionPage>>({ queryKey: ['collections'] })
        .some(([, data]) =>
          Boolean(
            data &&
              'pages' in data &&
              data.pages.some((p) => p.items.some((i) => i.id === event.collection_id)),
          ),
        );

      if (hadDetailMounted || isInAnyLoadedList) {
        const generation = subscriptionGeneration.current;
        void api
          .getCollection(event.collection_id)
          .then((fresh) => {
            if (subscriptionGeneration.current !== generation) return;
            queryClient.setQueryData(['collection', event.collection_id], fresh);
            const sortedAttachments = [...fresh.attachments].sort(
              (a, b) => a.position - b.position,
            );
            const patchItem = (item: CollectionSummary): CollectionSummary => ({
              ...item,
              display_title: fresh.display_title,
              projects: fresh.projects,
              tags: fresh.tags,
              organization_status: fresh.organization.status,
              has_suggestion: fresh.has_suggestion,
              original_url: fresh.original_url ?? undefined,
              cover_attachment_id: sortedAttachments[0]?.id,
              attachment_count: sortedAttachments.length,
              read_at: fresh.read_at,
              updated_at: fresh.updated_at,
              resource_version: fresh.resource_version,
            });
            queryClient.setQueriesData<InfiniteData<CollectionPage>>(
              { queryKey: ['collections'] },
              (old) =>
                old && 'pages' in old
                  ? patchInfiniteCollectionItem(old, fresh.id, patchItem)
                  : old,
            );
            queryClient.setQueriesData<InfiniteData<CollectionPage>>(
              { queryKey: ['project-collections'] },
              (old) =>
                old && 'pages' in old
                  ? patchInfiniteCollectionItem(old, fresh.id, patchItem)
                  : old,
            );
          })
          .catch(() => {
            // Non-fatal: cache already patched with status/has_suggestion
          });
      }

      const cachedPending = queryClient.getQueryData<CollectionPage>([
        'collections',
        'pending-suggestions',
      ]);
      const wasInPendingList = Boolean(
        cachedPending?.items.some((item) => item.id === event.collection_id),
      );
      if (event.has_suggestion || wasInPendingList) {
        void queryClient.invalidateQueries({ queryKey: ['collections', 'pending-suggestions'] });
      }
      void queryClient.invalidateQueries({ queryKey: ['me', 'usage'] });
      void queryClient.invalidateQueries({
        queryKey: ['collection-extractions', event.collection_id],
        refetchType: 'active',
      });

      if (!event.has_suggestion) {
        return;
      }

      if (!rememberSuggestionNotified(event.collection_id)) {
        return;
      }

      pushToast(
        {
          variant: 'ai-suggestion',
          dedupeKey: `ai-suggestion:${event.collection_id}`,
          message: 'AI 已整理完成并生成项目建议，等待你的确认',
          actionLabel: '查看并确认',
          onAction: () => {
            const targetPath = `/collections/${event.collection_id}`;
            if (locationPathRef.current === targetPath) {
              const targetEl = document.getElementById('ai-suggestion-section');
              if (targetEl) {
                const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
                targetEl.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
                return;
              }
            }
            recordOpened(event.collection_id);
            navigateRef.current(targetPath);
          },
        },
        12000,
      );
    },
    [api, applyEventStatusToCaches, pushToast, queryClient, recordOpened, rememberSuggestionNotified],
  );

  const handleEventRef = useRef(handleOrganizationEvent);
  const syncViewsRef = useRef(syncOrganizationViews);
  const refreshSessionRef = useRef(refreshSession);
  handleEventRef.current = handleOrganizationEvent;
  syncViewsRef.current = syncOrganizationViews;
  refreshSessionRef.current = refreshSession;

  useEffect(() => {
    if (!user?.id) return undefined;

    notifiedSuggestionsRef.current.clear();
    lastSyncAtRef.current = 0;
    sessionCheckedOnCloseRef.current = false;
    const connectStartedAt = Date.now();
    let initialReadySeen = false;

    const unsubscribe = api.subscribeOrganizationEvents({
      onReady: () => {
        sessionCheckedOnCloseRef.current = false;
        if (!initialReadySeen) {
          initialReadySeen = true;
          // Initial mount queries already run freshly; only compensate if connection setup took noticeable time.
          if (Date.now() - connectStartedAt < 250) {
            return;
          }
        }
        syncViewsRef.current();
      },
      onOrganization: (event) => {
        handleEventRef.current(event);
      },
      onError: () => {
        if (!sessionCheckedOnCloseRef.current) {
          sessionCheckedOnCloseRef.current = true;
          if (typeof navigator === 'undefined' || navigator.onLine !== false) {
            void refreshSessionRef.current();
          }
        }
      },
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncViewsRef.current();
      }
    };

    const handleOnline = () => {
      syncViewsRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);

    return () => {
      subscriptionGeneration.current += 1;
      notifiedSuggestionsRef.current.clear();
      lastSyncAtRef.current = 0;
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
    };
  }, [api, user?.id]);

  const pendingSuggestions = pendingSuggestionsQuery.data?.items ?? [];
  const pendingSuggestionsCount =
    pendingSuggestionsQuery.data?.total ?? pendingSuggestions.length;

  return (
    <OrganizationEventsContext.Provider
      value={{
        pendingSuggestionsCount,
        pendingSuggestions,
        isPendingSuggestionsLoading: pendingSuggestionsQuery.isLoading,
        refetchPendingSuggestions: () => pendingSuggestionsQuery.refetch(),
        markSuggestionPromptHandled,
      }}
    >
      {children}
    </OrganizationEventsContext.Provider>
  );
}

export function useOrganizationEvents(): OrganizationEventsContextValue {
  const ctx = useContext(OrganizationEventsContext);
  if (!ctx) {
    throw new Error('useOrganizationEvents must be used inside OrganizationEventsProvider');
  }
  return ctx;
}
