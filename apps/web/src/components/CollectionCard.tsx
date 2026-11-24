import { confirmLeavingImageDraft } from '../lib/drafts';
import { followUpCountLabel, toFollowUpSourceFromSummary } from '../lib/followUp';
import { CollectionLink, useRecordOpened } from './CollectionLink';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Image as ImageIcon,
  Link2,
  Mail,
  MailOpen,
  MoreHorizontal,
  PenLine,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { Attachment, Collection, CollectionSummary, SearchHit } from '../api/types';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useFollowUp } from '../context/FollowUpContext';
import { useToast } from '../context/ToastContext';
import { captureAuthSession, isSameAuthSession, type AuthSessionSnapshot } from '../lib/authSession';
import { canAnimateMotion } from '../lib/motion';
import {
  formatDateTime,
  formatRelativeTime,
  organizationStatusLabel,
  searchFieldLabel,
} from '../lib/format';
import { formatClock, isJustCreated } from '../lib/journal';
import { handleMenuKeyDown } from '../lib/menuKeyboard';
import { projectToneClass } from '../lib/projectTone';
import { AttachmentGallery } from './AttachmentGallery';
import { LinkPreviewCard } from './LinkPreviewCard';
import { HighlightText } from './StateBlocks';

const inFlightReadsBySession = new Map<number, number>();

function adjustInFlightReads(generation: number, delta: number): number {
  const next = Math.max(0, (inFlightReadsBySession.get(generation) ?? 0) + delta);
  if (next === 0) {
    inFlightReadsBySession.delete(generation);
  } else {
    inFlightReadsBySession.set(generation, next);
  }
  return next;
}

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
  attachments,
  snippets,
  searchQuery = '',
  timeStyle = 'relative',
}: {
  collection: CollectionSummary;
  attachments?: Attachment[];
  snippets?: SearchHit['snippets'];
  searchQuery?: string;
  /** "clock" inside day-grouped lists, where the day is already shown by the group stamp. */
  timeStyle?: 'relative' | 'clock';
}) {
  const api = useApi();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const recordOpened = useRecordOpened();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { openFollowUp } = useFollowUp();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const isUnread = !collection.read_at;
  const [prevUnread, setPrevUnread] = useState(isUnread);
  const [justRead, setJustRead] = useState(false);

  if (prevUnread !== isUnread) {
    setPrevUnread(isUnread);
    if (prevUnread && !isUnread && canAnimateMotion()) {
      setJustRead(true);
    } else if (isUnread) {
      setJustRead(false);
    }
  }

  useEffect(() => {
    if (!justRead) return;
    const timer = window.setTimeout(() => setJustRead(false), 160);
    return () => window.clearTimeout(timer);
  }, [justRead]);

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

  type ListRow = CollectionSummary | SearchHit;
  type InfiniteListCache = {
    pages: Array<{ items: ListRow[]; next_cursor?: string }>;
    pageParams: unknown[];
  };

  const patchTargetReadAt = (
    targetReadAt: string | undefined,
    options?: {
      expectedCurrentReadAt?: string | undefined;
      enforceMatch?: boolean;
      maxResourceVersion?: number;
    },
  ) => {
    const patchList = (old: InfiniteListCache | undefined) => {
      if (!old || !Array.isArray(old.pages)) return old;
      let touched = false;
      const pages = old.pages.map((page) => {
        if (!Array.isArray(page.items)) return page;
        let pageTouched = false;
        const items = page.items.map((row) => {
          const item = 'collection' in row ? row.collection : row;
          if (item.id !== collection.id) return row;
          if (
            options?.maxResourceVersion !== undefined &&
            item.resource_version > options.maxResourceVersion
          ) {
            return row;
          }
          if (options?.enforceMatch && item.read_at !== options.expectedCurrentReadAt) {
            return row;
          }
          pageTouched = true;
          const updatedItem: CollectionSummary = { ...item, read_at: targetReadAt };
          return 'collection' in row ? { ...row, collection: updatedItem } : updatedItem;
        });
        if (!pageTouched) return page;
        touched = true;
        return { ...page, items };
      });
      return touched ? { ...old, pages } : old;
    };

    queryClient.setQueriesData<InfiniteListCache>({ queryKey: ['collections'] }, patchList);
    queryClient.setQueriesData<InfiniteListCache>({ queryKey: ['project-collections'] }, patchList);
    queryClient.setQueriesData<InfiniteListCache>({ queryKey: ['collections-command'] }, patchList);
    queryClient.setQueryData<Collection>(['collection', collection.id], (old) => {
      if (!old) return old;
      if (
        options?.maxResourceVersion !== undefined &&
        old.resource_version > options.maxResourceVersion
      ) {
        return old;
      }
      if (options?.enforceMatch && old.read_at !== options.expectedCurrentReadAt) return old;
      return { ...old, read_at: targetReadAt };
    });
  };

  const toggleReadMutation = useMutation<
    Collection,
    unknown,
    void,
    {
      capturedSession: AuthSessionSnapshot;
      prevReadAt: string | undefined;
      optimisticReadAt: string | undefined;
    }
  >({
    mutationFn: () => api.setReadState(collection.id, { read: !collection.read_at }),
    onMutate: async () => {
      setMenuOpen(false);
      const capturedSession = captureAuthSession();
      adjustInFlightReads(capturedSession.generation, 1);

      await queryClient.cancelQueries({ queryKey: ['collections'] });
      await queryClient.cancelQueries({ queryKey: ['project-collections'] });
      await queryClient.cancelQueries({ queryKey: ['collections-command'] });
      await queryClient.cancelQueries({ queryKey: ['collection', collection.id] });

      const prevReadAt = collection.read_at;
      const optimisticReadAt = prevReadAt ? undefined : new Date().toISOString();
      if (isSameAuthSession(capturedSession)) {
        patchTargetReadAt(optimisticReadAt);
      }

      return { capturedSession, prevReadAt, optimisticReadAt };
    },
    onSuccess: (updated, _vars, context) => {
      if (!isSameAuthSession(context?.capturedSession)) return;
      patchTargetReadAt(updated.read_at, { maxResourceVersion: updated.resource_version });
      queryClient.setQueryData<Collection>(['collection', collection.id], (existing) => {
        if (!existing) return updated;
        if (existing.resource_version > updated.resource_version) {
          return existing;
        }
        return updated;
      });
    },
    onError: (err, _vars, context) => {
      if (!context || !isSameAuthSession(context.capturedSession)) return;
      patchTargetReadAt(context.prevReadAt, {
        expectedCurrentReadAt: context.optimisticReadAt,
        enforceMatch: true,
      });
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
    onSettled: (_data, err, _vars, context) => {
      if (!context) return;
      const remaining = adjustInFlightReads(context.capturedSession.generation, -1);
      if (!isSameAuthSession(context.capturedSession)) return;
      if (err) {
        void queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
      }
      if (remaining === 0) {
        void queryClient.invalidateQueries({ queryKey: ['collections'] });
        void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
      }
    },
  });

  const trashMutation = useMutation({
    mutationFn: () =>
      api.trashCollection(collection.id, { base_resource_version: collection.resource_version }),
    onSuccess: (trashed) => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      setMenuOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
      void queryClient.invalidateQueries({ queryKey: ['collection-thread'] });
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
          void queryClient.invalidateQueries({ queryKey: ['collection', collection.id] });
          void queryClient.invalidateQueries({ queryKey: ['collection-thread'] });
          void queryClient.invalidateQueries({ queryKey: ['projects'] });
          void queryClient.invalidateQueries({ queryKey: ['project'] });
          void queryClient.invalidateQueries({ queryKey: ['project-collections'] });
          void queryClient.invalidateQueries({ queryKey: ['tags'] });
          pushToast({ message: '已恢复收藏' });
        },
      });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

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
  const hasImage = collection.content_types.includes('image');
  const followUpCountText = followUpCountLabel(collection.follow_up_count);

  return (
    <article data-keyboard-card tabIndex={0} aria-label={collection.display_title}
      onKeyDown={e => {
        if (e.target !== e.currentTarget || e.nativeEvent.isComposing || e.keyCode === 229 ||
            e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.repeat) return;
        const key = e.key.toLowerCase();
        if (key === 'enter' || key === 'e') {
          e.preventDefault();
          if (!confirmLeavingImageDraft()) return;
          recordOpened(collection.id);
          navigate(`/collections/${collection.id}`, { state: { ...detailState, edit: key === 'e' } });
        } else if (key === 'f') {
          e.preventDefault();
          openFollowUp(toFollowUpSourceFromSummary(collection));
        } else if (key === 'r' && !toggleReadMutation.isPending) {
          e.preventDefault(); toggleReadMutation.mutate();
        }
      }} className={`sp-note ${isJustCreated(collection.created_at) ? 'sp-note--fresh' : ''}`}>
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
        {hasImage && (
          <span className="sp-note-kind" role="img" aria-label="含图片" title="含图片">
            <ImageIcon size={13} strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
        {(isUnread || justRead) && (
          <span
            className={`sp-unread-dot ${isUnread ? '' : 'is-read'}`}
            role={isUnread ? 'img' : undefined}
            aria-label={isUnread ? '未读' : undefined}
            title={isUnread ? '未读' : undefined}
            aria-hidden={isUnread ? undefined : 'true'}
          />
        )}

        {showOrgStatus &&
          (collection.organization_status === 'failed' ||
          collection.organization_status === 'blocked' ? (
            <CollectionLink
              id={collection.id}
              state={detailState}
              className={`sp-pill ${
                collection.organization_status === 'failed'
                  ? 'sp-pill--danger'
                  : 'sp-pill--warning'
              }`}
            >
              {organizationStatusLabel(collection.organization_status)}
            </CollectionLink>
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
                    openFollowUp(toFollowUpSourceFromSummary(collection));
                  }}
                >
                  <PenLine size={16} strokeWidth={2} aria-hidden="true" />
                  <span>续写</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sp-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    recordOpened(collection.id);
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
          <CollectionLink id={collection.id} state={detailState}>
            {searchQuery ? (
              <HighlightText text={collection.display_title} query={searchQuery} />
            ) : (
              collection.display_title
            )}
          </CollectionLink>
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
          {snippets.slice(0, 4).map((snip, idx) => (
            <div key={idx} className="sp-break-anywhere">
              <span className="sp-note-snippet-field">{searchFieldLabel(snip.field)}</span>
              <HighlightText text={snip.text} query={searchQuery} />
            </div>
          ))}
        </div>
      )}

      {collection.original_url && (
        <LinkPreviewCard
          originalUrl={collection.original_url}
          preview={collection.link_preview}
          variant="card"
        />
      )}

      {(() => {
        const effectiveAttachments: Attachment[] =
          attachments && attachments.length > 0
            ? attachments
            : collection.cover_attachment_id
              ? [
                  {
                    id: collection.cover_attachment_id,
                    filename: collection.display_title
                      ? `${collection.display_title} 封面`
                      : '图片附件',
                    mime_type: 'image/png',
                    size_bytes: 0,
                    position: 0,
                  },
                ]
              : [];
        if (effectiveAttachments.length === 0) return null;
        const hasMoreCoverImages = !attachments && (collection.attachment_count ?? 0) > 1;
        return (
          <div className="sp-note-cover">
            <AttachmentGallery
              attachments={effectiveAttachments}
              compact
              className="sp-note-gallery"
            />
            {hasMoreCoverImages && (
              <span className="sp-note-cover-count">共 {collection.attachment_count} 张</span>
            )}
          </div>
        );
      })()}

      <div className="sp-note-footer">
        {collection.tags.filter(t => t.decision !== 'rejected').map(t => <Link key={t.tag_id} className="sp-tag"
          to={`/collections?tag_id=${t.tag_id}`} state={{ tagName: t.path }}>#{t.path}</Link>)}
        {effectiveProjects.map((p) => (
          <Link
            key={p.project_id}
            to={`/projects/${p.project_id}`}
            className={`sp-tape ${projectToneClass(p.project_id)}`}
          >
            <span className="sp-truncate">{p.decision === 'auto' && '自动归入 · '}{p.name}</span>
          </Link>
        ))}

        {followUpCountText && (
          <CollectionLink
            id={collection.id}
            state={detailState}
            hash="#follow-up-thread"
            className="sp-pill sp-follow-up-pill"
          >
            {followUpCountText}
          </CollectionLink>
        )}

        <button
          type="button"
          className="sp-note-follow-up-btn"
          aria-label={`续写 ${collection.display_title}`}
          onClick={() => openFollowUp(toFollowUpSourceFromSummary(collection))}
        >
          <PenLine size={14} strokeWidth={2} aria-hidden="true" />
          <span>续写</span>
        </button>

        <CollectionLink
          id={collection.id}
          state={detailState}
          className="sp-note-open"
        >
          查看全文
          <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
        </CollectionLink>
      </div>
    </article>
  );
}
