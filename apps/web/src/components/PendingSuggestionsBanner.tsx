import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react';
import { getFriendlyErrorMessage } from '../api/errors';
import { decideCollectionProjectSafely, StaleSuggestionError } from '../lib/organization';
import { useApi } from '../context/ApiContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { useToast } from '../context/ToastContext';
import { ProjectSuggestionEvidence } from './ProjectSuggestionEvidence';

export function PendingSuggestionsBanner() {
  const api = useApi();
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
    }) =>
      decideCollectionProjectSafely(api, {
        ...params,
        requireSuggested: true,
      }),
    onSuccess: (updated, vars) => {
      markSuggestionPromptHandled(vars.collectionId);
      queryClient.setQueryData(['collection', vars.collectionId], updated);
      pushToast({
        message: vars.action === 'include' ? '已确认归入项目' : '已忽略该条项目建议',
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
        <div className="sp-row" style={{ gap: 8, minWidth: 0 }}>
          <span className="sp-pending-suggestions-icon" aria-hidden="true">
            <Sparkles size={14} strokeWidth={2} />
          </span>
          <span className="sp-pending-suggestions-title">
            有 <strong>{pendingSuggestionsCount}</strong> 条 AI 项目建议待确认
          </span>
        </div>
        <div className="sp-row" style={{ gap: 6, flexShrink: 0 }}>
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
                  <Link
                    to={`/collections/${col.id}`}
                    className="sp-pending-suggestion-title sp-break-anywhere"
                  >
                    {col.display_title && col.display_title !== '未命名收藏'
                      ? col.display_title
                      : col.excerpt}
                  </Link>
                  {firstSuggested && (
                    <div className="sp-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <span className="sp-pill sp-pill--green">
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
                          })
                        }
                      >
                        <X size={13} strokeWidth={2} aria-hidden="true" />
                        <span>忽略</span>
                      </button>
                    </>
                  )}
                  <Link to={`/collections/${col.id}`} className="sp-btn sp-btn--sm sp-btn--quiet">
                    详情
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
