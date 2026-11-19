import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Link2, Mail, MailOpen, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
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
import { formatClock, isJustCreated } from '../lib/journal';
import { handleMenuKeyDown } from '../lib/menuKeyboard';
import { projectToneClass } from '../lib/projectTone';
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
  timeStyle = 'relative',
}: {
  collection: CollectionSummary;
  snippets?: SearchHit['snippets'];
  searchQuery?: string;
  /** "clock" inside day-grouped lists, where the day is already shown by the group stamp. */
  timeStyle?: 'relative' | 'clock';
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
  const hasUrl = collection.content_types.includes('url');

  return (
    <article className={`sp-note ${isJustCreated(collection.created_at) ? 'sp-note--fresh' : ''}`}>
      <div className="sp-note-meta">
        <time dateTime={collection.created_at} title={formatDateTime(collection.created_at)}>
          {timeStyle === 'clock'
            ? formatClock(collection.created_at)
            : formatRelativeTime(collection.created_at)}
        </time>
        {hasUrl && (
          <span className="sp-note-kind" role="img" aria-label="含网址" title="含网址">
            <Link2 size={13} strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
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
            <>
              {/* Phone-only scrim: absorbs the outside tap so it never activates the card below. */}
              <div className="sp-sheet-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />
              <div
                className="sp-popover sp-popover--right sp-popover--sheet"
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
                  {collection.read_at ? (
                    <Mail size={16} strokeWidth={2} aria-hidden="true" />
                  ) : (
                    <MailOpen size={16} strokeWidth={2} aria-hidden="true" />
                  )}
                  <span>{collection.read_at ? '标为未读' : '标为已读'}</span>
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
                  <Pencil size={16} strokeWidth={2} aria-hidden="true" />
                  <span>编辑</span>
                </button>
                <div className="sp-menu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="sp-menu-item sp-menu-item--danger"
                  disabled={trashMutation.isPending}
                  onClick={() => trashMutation.mutate()}
                >
                  <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                  <span>移入回收站</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {showTitle && (
        <h3 className="sp-note-title">
          <Link to={`/collections/${collection.id}`} state={detailState}>
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
        <div className="sp-note-snippets">
          {snippets.slice(0, 3).map((snip, idx) => (
            <div key={idx} className="sp-break-anywhere">
              <span className="sp-note-snippet-field">{searchFieldLabel(snip.field)}</span>
              <HighlightText text={snip.text} query={searchQuery} />
            </div>
          ))}
        </div>
      )}

      <div className="sp-note-footer">
        {effectiveProjects.map((p) => (
          <Link
            key={p.project_id}
            to={`/projects/${p.project_id}`}
            className={`sp-tape ${projectToneClass(p.project_id)}`}
          >
            <span className="sp-truncate">{p.name}</span>
          </Link>
        ))}

        <Link
          to={`/collections/${collection.id}`}
          state={detailState}
          className="sp-note-open"
        >
          查看全文
          <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}
