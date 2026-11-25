import { MoreProjectChoices, useProjectChoices } from '../components/ProjectChoices';
import { useRef, useState } from 'react';
import { useFlipList, useSegmentIndicator } from '../lib/motion';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FolderPlus, Sparkles, X } from 'lucide-react';
import type { CollectionSummary, ExpectedProjectSuggestion } from '../api/types';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { captureAuthSession, isSameAuthSession, type AuthSessionSnapshot } from '../lib/authSession';
import {
  pendingSuggestionOptions,
  decideCollectionProjectSafely,
  StaleSuggestionError,
  toExpectedSuggestion,
  undoCollectionProjectReceipt,
} from '../lib/organization';
import { projectToneClass } from '../lib/projectTone';
import { CollectionCard } from '../components/CollectionCard';
import { PageHeader } from '../components/PageHeader';
import { ProjectSuggestionEvidence } from '../components/ProjectSuggestionEvidence';
import { EmptyState, ErrorBanner, LoadMore, LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { useToast } from '../context/ToastContext';

export function UnclassifiedPage() {
  const api = useApi();
  const { pushToast } = useToast();
  const { pendingSuggestionsCount, markSuggestionPromptHandled } = useOrganizationEvents();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedProjectByCol, setSelectedProjectByCol] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const activeTab = searchParams.get('tab') === 'suggested' ? 'suggested' : 'all';

  const unclassifiedQuery = useInfiniteQuery(activeTab === 'suggested' ? pendingSuggestionOptions(api) : {
    queryKey: ['collections', 'unclassified', 'all'],
    queryFn: ({ pageParam, signal }) => api.listCollections({ scope: 'unclassified', cursor: pageParam, limit: 30 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor,
  });

  const projectsQuery = useProjectChoices();

  const decideMutation = useMutation<
    Awaited<ReturnType<typeof decideCollectionProjectSafely>>,
    unknown,
    {
      collectionId: string;
      projectId: string;
      action: 'include' | 'exclude';
      requireSuggested?: boolean;
      requireSuggestionSnapshot?: boolean;
      expectedSuggestion?: ExpectedProjectSuggestion;
    },
    { capturedSession: AuthSessionSnapshot }
  >({
    onMutate: () => ({ capturedSession: captureAuthSession() }),
    mutationFn: (params) => decideCollectionProjectSafely(api, params),
    onSuccess: (updated, vars, context) => {
      if (!isSameAuthSession(context?.capturedSession)) return;
      const capturedSession = context.capturedSession;
      setActionError(null);
      markSuggestionPromptHandled(vars.collectionId);
      queryClient.setQueryData(['collection', vars.collectionId], updated);
      const receipt = updated.undo_receipt;
      pushToast({
        message: vars.action === 'include' ? '已归入项目' : '已忽略建议关联',
        ...(receipt
          ? {
              actionLabel: '撤销',
              onAction: async () => {
                if (!isSameAuthSession(capturedSession)) return;
                try {
                  const restored = await undoCollectionProjectReceipt(api, updated.id, receipt);
                  if (!isSameAuthSession(capturedSession)) return;
                  queryClient.setQueryData(['collection', restored.id], restored);
                  void queryClient.invalidateQueries({ queryKey: ['collections'], refetchType: 'none' });
                  void queryClient.invalidateQueries({ queryKey: ['collections', 'unclassified'] });
                  void queryClient.invalidateQueries({ queryKey: ['projects'] });
                  void queryClient.invalidateQueries({ queryKey: ['project', vars.projectId] });
                  void queryClient.invalidateQueries({ queryKey: ['project-collections', vars.projectId] });
                  pushToast({ message: '已撤销归类操作' });
                } catch (undoErr) {
                  if (!isSameAuthSession(capturedSession)) return;
                  pushToast({ message: getFriendlyErrorMessage(undoErr), tone: 'error' });
                }
              },
            }
          : {}),
      });
      void queryClient.invalidateQueries({ queryKey: ['collections'], refetchType: 'none' });
      void queryClient.invalidateQueries({ queryKey: ['collections', 'unclassified'] });
      if (vars.action === 'include') {
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        void queryClient.invalidateQueries({ queryKey: ['project', vars.projectId] });
        void queryClient.invalidateQueries({ queryKey: ['project-collections', vars.projectId] });
      }
    },
    onError: (err, vars, context) => {
      if (!isSameAuthSession(context?.capturedSession)) return;
      if (err instanceof StaleSuggestionError) {
        markSuggestionPromptHandled(vars.collectionId);
        queryClient.setQueryData(['collection', vars.collectionId], err.freshCollection);
        void queryClient.invalidateQueries({ queryKey: ['collections', 'unclassified'] });
        setActionError(err.message);
        return;
      }
      if (isApiErrorCode(err, 'suggestion_conflict') || isApiErrorCode(err, 'decision_conflict')) {
        void queryClient.invalidateQueries({ queryKey: ['collections', 'unclassified'] });
      }
      setActionError(getFriendlyErrorMessage(err));
    },
  });

  const items = unclassifiedQuery.data?.pages.flatMap((p) => p.items) ?? [];
  // The suggestions view only earns a tab while there is something to confirm (or it is open).
  const showViewTabs = pendingSuggestionsCount > 0 || activeTab === 'suggested';
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  useFlipList(listRef, items.map((c) => c.id).join('|'));
  useSegmentIndicator(tabsRef, `${activeTab}:${showViewTabs}`);
  const projects = projectsQuery.data?.pages.flatMap(page => page.items) ?? [];
  const activeQuickProjects = projects.filter((p) => p.state === 'active').slice(0, 6);

  const renderQuickClassify = (col: CollectionSummary) => {
    const suggested = col.projects.filter((p) => p.decision === 'suggested');
    const chosenId = selectedProjectByCol[col.id] ?? '';

    if (suggested.length === 0 && projects.length === 0) return null;

    return (
      <div className="sp-classify-tray">
        {suggested.map((sug) => (
          <div key={sug.project_id} className="sp-suggestion-card sp-suggestion-card--highlighted">
            <div className="sp-suggestion-head">
              <div className="sp-row">
                <span className="sp-pill sp-pill--spark">AI 建议</span>
                <strong className="sp-suggestion-name sp-break-anywhere">
                  建议归入：{sug.name}
                </strong>
              </div>
              <div className="sp-row">
                <button
                  type="button"
                  className="sp-btn sp-btn--sm sp-btn--primary"
                  disabled={decideMutation.isPending}
                  onClick={() =>
                    decideMutation.mutate({
                      collectionId: col.id,
                      projectId: sug.project_id,
                      action: 'include',
                      requireSuggested: true,
                      requireSuggestionSnapshot: true,
                      expectedSuggestion: toExpectedSuggestion(sug),
                    })
                  }
                >
                  <Check size={13} strokeWidth={2} aria-hidden="true" />
                  <span>加入项目</span>
                </button>
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  disabled={decideMutation.isPending}
                  onClick={() =>
                    decideMutation.mutate({
                      collectionId: col.id,
                      projectId: sug.project_id,
                      action: 'exclude',
                      requireSuggested: true,
                      requireSuggestionSnapshot: true,
                      expectedSuggestion: toExpectedSuggestion(sug),
                    })
                  }
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                  <span>忽略</span>
                </button>
              </div>
            </div>
            <ProjectSuggestionEvidence association={sug} />
          </div>
        ))}

        {activeQuickProjects.length > 0 && (
          <div className="sp-classify-quick" role="group" aria-label={`快速将「${col.display_title}」归入进行中项目`}>
            <span className="sp-classify-quick-label">一点即归入</span>
            <div className="sp-classify-quick-tapes">
              {activeQuickProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`sp-tape sp-classify-tape ${projectToneClass(p.id)}`}
                  aria-label={`归入项目 ${p.name}`}
                  disabled={decideMutation.isPending}
                  onClick={() =>
                    decideMutation.mutate({
                      collectionId: col.id,
                      projectId: p.id,
                      action: 'include',
                    })
                  }
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {projects.length > 0 && (
          <div className="sp-classify-row">
            <select
              aria-label={`为「${col.display_title}」选择项目`}
              className="sp-select sp-select--compact"
              value={chosenId}
              onChange={(e) =>
                setSelectedProjectByCol((prev) => ({ ...prev, [col.id]: e.target.value }))
              }
            >
              <option value="">选择要关联的项目…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--primary"
              disabled={!chosenId || decideMutation.isPending}
              onClick={() =>
                decideMutation.mutate({
                  collectionId: col.id,
                  projectId: chosenId,
                  action: 'include',
                })
              }
            >
              确认关联
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="待归类"
        actions={
          <div className="sp-row">
            {items.length > 0 && (
              <Link to="/unclassified/triage" className="sp-btn sp-btn--sm sp-btn--primary">
                <Sparkles size={15} strokeWidth={2} aria-hidden="true" />
                <span>开始整理</span>
              </Link>
            )}
            <Link to="/projects" className="sp-btn--quiet">
              <FolderPlus size={16} strokeWidth={2} aria-hidden="true" />
              <span>管理项目</span>
            </Link>
          </div>
        }
      />

      {showViewTabs && (
      <div className="sp-filter-tabs" aria-label="待归类视图筛选" ref={tabsRef}>
        <button
          type="button"
          className={`sp-filter-tab ${activeTab === 'all' ? 'active' : ''}`}
          aria-pressed={activeTab === 'all'}
          onClick={() => setSearchParams({}, { replace: true })}
        >
          全部待归类
        </button>
        <button
          type="button"
          className={`sp-filter-tab ${activeTab === 'suggested' ? 'active' : ''}`}
          aria-pressed={activeTab === 'suggested'}
          onClick={() => setSearchParams({ tab: 'suggested' }, { replace: true })}
        >
          <span>待确认 AI 建议</span>
          {pendingSuggestionsCount > 0 && (
            <span key={pendingSuggestionsCount} className="sp-filter-count sp-tick">
              {pendingSuggestionsCount}
            </span>
          )}
        </button>
      </div>
      )}

      <MoreProjectChoices query={projectsQuery} />
      {projects.length === 0 && projectsQuery.isSuccess && (
        <div className="sp-banner sp-banner--info sp-spaced">
          <span>
            还没有项目，尚未归类的资料会暂时保留在这里。随时可以去{' '}
            <Link to="/projects" className="sp-strong">
              新建项目
            </Link>
            。
          </span>
        </div>
      )}

      {actionError && (
        <div className="sp-banner sp-banner--error sp-spaced" role="alert">
          <span>{actionError}</span>
        </div>
      )}

      {unclassifiedQuery.isLoading && <LoadingState message="正在加载待归类资料…" />}
      {unclassifiedQuery.isError && (
        <ErrorBanner
          error={unclassifiedQuery.error}
          onRetry={() => void unclassifiedQuery.refetch()}
        />
      )}
      {!unclassifiedQuery.isLoading && !unclassifiedQuery.isError && items.length === 0 && (
        <EmptyState
          title={activeTab === 'suggested' ? '没有待确认的 AI 建议' : '没有待归类的收藏'}
          description={
            activeTab === 'suggested'
              ? '当 AI 整理生成新的项目关联建议时，会保留在这里等你确认。'
              : '所有有效收藏都已经关联到项目了。'
          }
          action={
            activeTab === 'suggested' ? (
              <button
                type="button"
                className="sp-btn sp-btn--primary"
                onClick={() => setSearchParams({}, { replace: true })}
              >
                查看全部待归类
              </button>
            ) : (
              <Link to="/inbox" className="sp-btn sp-btn--primary">
                返回收件箱
              </Link>
            )
          }
        />
      )}

      <div className="sp-note-list sp-note-list--loose" ref={listRef}>
        {items.map((col) => {
          const tray = renderQuickClassify(col);
          return (
            <div
              key={col.id}
              data-flip-key={col.id}
              className={tray ? 'sp-classify-group' : undefined}
            >
              <CollectionCard collection={col} flipKey={null} />
              {tray}
            </div>
          );
        })}
      </div>

      <LoadMore
        hasNextPage={unclassifiedQuery.hasNextPage}
        isFetching={unclassifiedQuery.isFetchingNextPage}
        isError={unclassifiedQuery.isFetchNextPageError}
        onLoad={() => void unclassifiedQuery.fetchNextPage()}
      />
    </div>
  );
}
