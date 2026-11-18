import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Folder, MoreHorizontal } from 'lucide-react';
import type { CollectionSummary, SearchHit } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import {
  formatDateTime,
  formatRelativeTime,
  organizationStatusLabel,
  searchFieldLabel,
} from '../lib/format';
import { handleMenuKeyDown } from '../lib/menuKeyboard';
import { HighlightText } from './StateBlocks';

function shouldShowDistinctTitle(collection: CollectionSummary): boolean {
  const title = collection.display_title?.trim();
  const excerpt = collection.excerpt?.trim();
  if (!title || title === '未命名收藏') return false;
  if (!excerpt) return true;
  if (excerpt === title || excerpt.startsWith(title)) return false;
  return true;
}

export function CollectionCard({
  collection,
  snippets,
  searchQuery = '',
}: {
  collection: CollectionSummary;
  snippets?: SearchHit['snippets'];
  searchQuery?: string;
}) {
  const api = useApi();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const active = document.activeElement;
        setMenuOpen(false);
        if (menuWrapRef.current?.contains(active)) {
          moreBtnRef.current?.focus();
        }
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [menuOpen]);

  const toggleReadMutation = useMutation({
    mutationFn: () => api.setReadState(collection.id, { read: !collection.read_at }),
    onSuccess: () => {
      setMenuOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const trashMutation = useMutation({
    mutationFn: () =>
      api.trashCollection(collection.id, { base_resource_version: collection.resource_version }),
    onSuccess: (trashed) => {
      setMenuOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      pushToast({
        message: '已移入回收站',
        actionLabel: '撤销',
        onAction: async () => {
          await api.restoreCollection(collection.id, {
            base_resource_version: trashed.resource_version,
          });
          void queryClient.invalidateQueries({ queryKey: ['collections'] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          void queryClient.invalidateQueries({ queryKey: ['project'] });
          void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
          pushToast({ message: '已恢复收藏' });
        },
      });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const isUnread = !collection.read_at;
  const effectiveProjects = collection.projects.filter(
    (p) => p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto',
  );
  const showTitle = shouldShowDistinctTitle(collection);
  const showOrgStatus =
    collection.organization_status === 'queued' ||
    collection.organization_status === 'running' ||
    collection.organization_status === 'failed' ||
    collection.organization_status === 'blocked';

  const detailState = { from: `${location.pathname}${location.search}` };

  return (
    <article className="sp-note">
      <div className="sp-note-meta">
        <time dateTime={collection.created_at} title={formatDateTime(collection.created_at)}>
          {formatRelativeTime(collection.created_at)}
        </time>
        {isUnread && <span className="sp-unread-dot" role="img" aria-label="未读" title="未读" />}

        {showOrgStatus &&
          (collection.organization_status === 'failed' ||
          collection.organization_status === 'blocked' ? (
            <Link
              to={`/collections/${collection.id}`}
              state={detailState}
              className={`sp-pill ${
                collection.organization_status === 'failed'
                  ? 'sp-pill--danger'
                  : 'sp-pill--warning'
              }`}
              style={{ textDecoration: 'none' }}
            >
              {organizationStatusLabel(collection.organization_status)}
            </Link>
          ) : (
            <span className="sp-pill">
              {organizationStatusLabel(collection.organization_status)}
            </span>
          ))}

        <div
          className="sp-note-more-wrap"
          ref={menuWrapRef}
          onKeyDown={(e) => {
            if (menuOpen) handleMenuKeyDown(e);
          }}
        >
          <button
            ref={moreBtnRef}
            type="button"
            className="sp-note-more-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="更多操作"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
          </button>

          {menuOpen && (
            <div
              className="sp-popover sp-popover--right"
              role="menu"
              aria-label="收藏操作菜单"
            >
              <button
                type="button"
                role="menuitem"
                className="sp-menu-item"
                disabled={toggleReadMutation.isPending}
                onClick={() => toggleReadMutation.mutate()}
              >
                {collection.read_at ? '标为未读' : '标为已读'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="sp-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  navigate(`/collections/${collection.id}`, { state: { ...detailState, edit: true } });
                }}
              >
                编辑
              </button>
              <div className="sp-menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="sp-menu-item sp-menu-item--danger"
                disabled={trashMutation.isPending}
                onClick={() => trashMutation.mutate()}
              >
                移入回收站
              </button>
            </div>
          )}
        </div>
      </div>

      {showTitle && (
        <h3 className="sp-note-title">
          <Link
            to={`/collections/${collection.id}`}
            state={detailState}
            style={{ color: 'inherit' }}
          >
            {searchQuery ? (
              <HighlightText text={collection.display_title} query={searchQuery} />
            ) : (
              collection.display_title
            )}
          </Link>
        </h3>
      )}

      {collection.excerpt && (
        <p className="sp-note-body sp-note-body--clamped">
          {searchQuery ? (
            <HighlightText text={collection.excerpt} query={searchQuery} />
          ) : (
            collection.excerpt
          )}
        </p>
      )}

      {snippets && snippets.length > 0 && (
        <div
          className="sp-stack"
          style={{
            gap: 4,
            marginTop: 12,
            padding: '10px 12px',
            background: 'var(--sp-bg)',
            borderRadius: 'var(--sp-radius-control)',
          }}
        >
          {snippets.slice(0, 3).map((snip, idx) => (
            <div key={idx} className="sp-help sp-break-anywhere" style={{ color: 'var(--sp-fg)' }}>
              <strong style={{ marginRight: 6 }}>{searchFieldLabel(snip.field)}:</strong>
              <HighlightText text={snip.text} query={searchQuery} />
            </div>
          ))}
        </div>
      )}

      <div className="sp-note-footer">
        {effectiveProjects.map((p) => (
          <Link key={p.project_id} to={`/projects/${p.project_id}`} className="sp-project-link">
            <Folder size={15} strokeWidth={2} aria-hidden="true" />
            <span>{p.name}</span>
          </Link>
        ))}

        <Link
          to={`/collections/${collection.id}`}
          state={detailState}
          className="sp-note-open"
        >
          查看全文
        </Link>
      </div>
    </article>
  );
}
