import { CollectionLink } from './CollectionLink';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react';
import type { ExpectedProjectSuggestion } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import {
  decideCollectionProjectSafely,
  StaleSuggestionError,
  toExpectedSuggestion,
  undoCollectionProjectReceipt,
} from '../lib/organization';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { useToast } from '../context/ToastContext';
import { ProjectSuggestionEvidence } from './ProjectSuggestionEvidence';

export function PendingSuggestionsBanner() {
  const api = useApi();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const {
    pendingSuggestionsCount,
    pendingSuggestions,
    markSuggestionPromptHandled,
  } = useOrganizationEvents();

  const [expanded, setExpanded] = useState(false);

  const decideMutation = useMutation({
    mutationFn: (params: {
      collectionId: string;
      projectId: string;
      action: 'include' | 'exclude';
      expectedSuggestion?: ExpectedProjectSuggestion;
      accountId?: string;
    }) =>
      decideCollectionProjectSafely(api, {
        ...params,
        requireSuggested: true,
      }),
    onSuccess: (updated, vars) => {
      markSuggestionPromptHandled(vars.collectionId);
      queryClient.setQueryData(['collection', vars.collectionId], updated);
      const receipt = updated.undo_receipt;
      pushToast({
        message: vars.action === 'include' ? '已确认归入项目' : '已忽略该条项目建议',
        ...(receipt
          ? {
              actionLabel: '撤销',
              onAction: async () => {
                if (vars.accountId && user?.id && user.id !== vars.accountId) return;
                try {
                  const restored = await undoCollectionProjectReceipt(api, updated.id, receipt);
                  queryClient.setQueryData(['collection', restored.id], restored);
                  void queryClient.invalidateQueries({ queryKey: ['collections'] });
                  void queryClient.invalidateQueries({ queryKey: ['projects'] });
                  void queryClient.invalidateQueries({ queryKey: ['project'] });
                  void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
                  pushToast({ message: '已撤销该项目建议操作' });
                } catch (undoErr) {
                  pushToast({ message: getFriendlyErrorMessage(undoErr), tone: 'error' });
                }
              },
            }
          : {}),
      });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err, vars) => {
      if (err instanceof StaleSuggestionError) {
        markSuggestionPromptHandled(vars.collectionId);
        queryClient.setQueryData(['collection', vars.collectionId], err.freshCollection);
        void queryClient.invalidateQueries({ queryKey: ['collections'] });
        pushToast({ message: err.message });
        return;
      }
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
  });

  if (pendingSuggestionsCount <= 0) {
    return null;
  }

  return (
    <section
      className="sp-pending-suggestions"
      aria-label="待确认的 AI 项目建议"
      data-testid="pending-suggestions-banner"
    >
      <div className="sp-pending-suggestions-head">
        <div className="sp-pending-suggestions-lead">
          <span className="sp-pending-suggestions-icon" aria-hidden="true">
            <Sparkles size={14} strokeWidth={2} />
          </span>
          <span className="sp-pending-suggestions-title">
            有 <strong>{pendingSuggestionsCount}</strong> 条 AI 项目建议待确认
          </span>
        </div>
        <div className="sp-pending-suggestions-actions">
          <button
            type="button"
            className="sp-btn sp-btn--sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                <ChevronUp size={14} strokeWidth={2} aria-hidden="true" />
                <span>收起</span>
              </>
            ) : (
              <>
                <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                <span>查看列表</span>
              </>
            )}
          </button>
          <Link to="/unclassified?tab=suggested" className="sp-btn sp-btn--sm sp-btn--primary">
            去确认
          </Link>
        </div>
      </div>

      {expanded && (
        <ul className="sp-pending-suggestions-list">
          {pendingSuggestions.map((col) => {
            const suggested = col.projects.filter((p) => p.decision === 'suggested');
            const firstSuggested = suggested[0];
            return (
              <li key={col.id} className="sp-pending-suggestion-item">
                <div className="sp-pending-suggestion-main">
                  <CollectionLink
                    id={col.id}
                    className="sp-pending-suggestion-title sp-break-anywhere"
                  >
                    {col.display_title && col.display_title !== '未命名收藏'
                      ? col.display_title
                      : col.excerpt}
                  </CollectionLink>
                  {firstSuggested && (
                    <div className="sp-row">
                      <span className="sp-pill sp-pill--spark">
                        建议归入：{firstSuggested.name}
                      </span>
                    </div>
                  )}
                  {firstSuggested && <ProjectSuggestionEvidence association={firstSuggested} />}
                </div>
                <div className="sp-pending-suggestion-actions">
                  {firstSuggested && (
                    <>
                      <button
                        type="button"
                        className="sp-btn sp-btn--sm sp-btn--primary"
                        disabled={decideMutation.isPending}
                        onClick={() =>
                          decideMutation.mutate({
                            collectionId: col.id,
                            projectId: firstSuggested.project_id,
                            action: 'include',
                            expectedSuggestion: toExpectedSuggestion(firstSuggested),
                            accountId: user?.id,
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
                            projectId: firstSuggested.project_id,
                            action: 'exclude',
                            expectedSuggestion: toExpectedSuggestion(firstSuggested),
                            accountId: user?.id,
                          })
                        }
                      >
                        <X size={13} strokeWidth={2} aria-hidden="true" />
                        <span>忽略</span>
                      </button>
                    </>
                  )}
                  <CollectionLink id={col.id} className="sp-btn sp-btn--sm sp-btn--quiet">
                    详情
                  </CollectionLink>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
