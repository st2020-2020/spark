import { confirmLeavingImageDraft } from '../lib/drafts';
import { isValidHttpUrl } from '../lib/document';
import { followUpCountLabel, toFollowUpSourceFromSummary } from '../lib/followUp';
import { CollectionLink, useRecordOpened } from './CollectionLink';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CornerDownRight,
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
      serverCollection?: Collection;
    },
  ) => {
    const mergeSummary = (item: CollectionSummary): CollectionSummary => {
      const updated = options?.serverCollection;
      if (!updated) {
        return { ...item, read_at: targetReadAt };
      }
      return {
        ...item,
        display_title: updated.display_title,
        content_types: updated.content_types,
        projects: updated.projects,
        tags: updated.tags,
        organization_status: updated.organization?.status ?? item.organization_status,
        read_at: updated.read_at,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
        resource_version: updated.resource_version,
        has_suggestion: updated.has_suggestion,
        original_url: updated.original_url,
        thread_id: updated.thread_id ?? item.thread_id,
        source_collection_id: updated.source_collection_id ?? item.source_collection_id,
        follow_up_count: updated.follow_up_count ?? item.follow_up_count,
      };
    };

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
          const updatedItem = mergeSummary(item);
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
      return options?.serverCollection ?? { ...old, read_at: targetReadAt };
    });
  };

  const toggleReadMutation = useMutation<
    Collection,
    unknown,
    boolean,
    {
      capturedSession: AuthSessionSnapshot;
      prevReadAt: string | undefined;
      optimisticReadAt: string | undefined;
      targetRead: boolean;
    }
  >({
    mutationFn: (targetRead) => api.setReadState(collection.id, { read: targetRead }),
    onMutate: async (targetRead) => {
      setMenuOpen(false);
      const capturedSession = captureAuthSession();
      adjustInFlightReads(capturedSession.generation, 1);

      await queryClient.cancelQueries({ queryKey: ['collections'] });
      await queryClient.cancelQueries({ queryKey: ['project-collections'] });
      await queryClient.cancelQueries({ queryKey: ['collections-command'] });
      await queryClient.cancelQueries({ queryKey: ['collection', collection.id] });

      const prevReadAt = collection.read_at;
      const optimisticReadAt = targetRead ? (prevReadAt ?? new Date().toISOString()) : undefined;
      if (isSameAuthSession(capturedSession)) {
        patchTargetReadAt(optimisticReadAt);
      }

      return { capturedSession, prevReadAt, optimisticReadAt, targetRead };
    },
    onSuccess: (updated, _targetRead, context) => {
      if (!isSameAuthSession(context?.capturedSession)) return;
      patchTargetReadAt(updated.read_at, {
        maxResourceVersion: updated.resource_version,
        serverCollection: updated,
      });
      queryClient.setQueryData<Collection>(['collection', collection.id], (existing) => {
        if (!existing) return updated;
        if (existing.resource_version > updated.resource_version) {
          return existing;
        }
        return updated;
      });
    },
    onError: (err, _targetRead, context) => {
      if (!context || !isSameAuthSession(context.capturedSession)) return;
      patchTargetReadAt(context.prevReadAt, {
        expectedCurrentReadAt: context.optimisticReadAt,
        enforceMatch: true,
      });
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
    onSettled: (_data, err, _targetRead, context) => {
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
  const visibleProjects = effectiveProjects.slice(0, 2);
  const hiddenProjects = effectiveProjects.slice(visibleProjects.length);
  const extraProjectsCount = hiddenProjects.length;
  const extraProjectsLabel =
    extraProjectsCount > 0
      ? `还有 ${extraProjectsCount} 个关联项目：${hiddenProjects.map((p) => p.name).join('、')}`
      : '';

  const effectiveTags = collection.tags.filter((t) => t.decision !== 'rejected');
  const visibleTags = effectiveTags.slice(0, 3);
  const hiddenTags = effectiveTags.slice(visibleTags.length);
  const extraTagsCount = hiddenTags.length;
  const extraTagsLabel =
    extraTagsCount > 0
      ? `还有 ${extraTagsCount} 个标签：${hiddenTags.map((t) => `#${t.path}`).join('、')}`
      : '';

  const showTitle = shouldShowDistinctTitle(collection);
  const showOrgStatus =
    collection.organization_status === 'queued' ||
    collection.organization_status === 'running' ||
    collection.organization_status === 'failed' ||
    collection.organization_status === 'blocked';

  const detailState = { from: `${location.pathname}${location.search}` };
  const hasUrl = collection.content_types.includes('url');
  const hasImage = collection.content_types.includes('image');
  const hasRenderedUrlBar = Boolean(collection.original_url && isValidHttpUrl(collection.original_url));
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
  const hasRenderedThumbnails = effectiveAttachments.length > 0;
  const followUpCountText = followUpCountLabel(collection.follow_up_count);

  const handleCardClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (window.getSelection()?.toString().trim()) return;
    const target = e.target;
    if (
      target instanceof HTMLElement &&
      target.closest(
        'a, button, input, textarea, select, [role="button"], [role="menuitem"], [role="menu"], [role="dialog"], .sp-popover, .sp-sheet-scrim, .sp-lightbox-backdrop',
      )
    ) {
      return;
    }
    if (!confirmLeavingImageDraft()) return;
    recordOpened(collection.id);
    navigate(`/collections/${collection.id}`, { state: detailState });
  };

  return (
    <article
      data-keyboard-card
      tabIndex={0}
      aria-label={collection.display_title}
      onClick={handleCardClick}
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
          e.preventDefault(); toggleReadMutation.mutate(Boolean(isUnread));
        }
      }}
      className={`sp-note ${isJustCreated(collection.created_at) ? 'sp-note--fresh' : ''}`}
    >
      <div className="sp-note-meta">
        <CollectionLink
          id={collection.id}
          state={detailState}
          className="sp-note-time-link"
          aria-label={`查看详情：${collection.display_title}`}
        >
          <time dateTime={collection.created_at} title={formatDateTime(collection.created_at)}>
            {timeStyle === 'clock'
              ? formatClock(collection.created_at)
              : formatRelativeTime(collection.created_at)}
          </time>
        </CollectionLink>
        {hasUrl && !hasRenderedUrlBar && (
          <span className="sp-note-kind" role="img" aria-label="含网址" title="含网址">
            <Link2 size={13} strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
        {hasImage && !hasRenderedThumbnails && (
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
                  onClick={() => toggleReadMutation.mutate(Boolean(isUnread))}
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

      {hasRenderedThumbnails && (
        <div className="sp-note-cover">
          <AttachmentGallery
            attachments={effectiveAttachments}
            compact
            className="sp-note-gallery"
          />
          {!attachments && (collection.attachment_count ?? 0) > 1 && (
            <span className="sp-note-cover-count">共 {collection.attachment_count} 张</span>
          )}
        </div>
      )}

      {(visibleProjects.length > 0 || visibleTags.length > 0 || followUpCountText || true) && (
        <div className="sp-note-footer">
          {(visibleProjects.length > 0 || visibleTags.length > 0) && (
            <div className="sp-note-footer-meta">
              {visibleProjects.map((p) => (
                <Link
                  key={p.project_id}
                  to={`/projects/${p.project_id}`}
                  className={`sp-project-chip ${projectToneClass(p.project_id)}`}
                  aria-label={p.decision === 'auto' ? `自动归入 · ${p.name}` : p.name}
                  title={p.decision === 'auto' ? `自动归入 · ${p.name}` : p.name}
                >
                  <span className="sp-project-chip-dot" aria-hidden="true" />
                  <span className="sp-truncate">{p.name}</span>
                  {p.decision === 'auto' && (
                    <span className="sp-project-chip-ai" aria-hidden="true">
                      ✦
                    </span>
                  )}
                </Link>
              ))}
              {extraProjectsCount > 0 && (
                <CollectionLink
                  id={collection.id}
                  state={detailState}
                  className="sp-footer-more"
                  aria-label={extraProjectsLabel}
                  title={extraProjectsLabel}
                >
                  +{extraProjectsCount}
                </CollectionLink>
              )}

              {visibleTags.map((t) => (
                <Link
                  key={t.tag_id}
                  className="sp-tag sp-tag--quiet"
                  to={`/collections?tag_id=${t.tag_id}`}
                  state={{ tagName: t.path }}
                >
                  #{t.path}
                </Link>
              ))}
              {extraTagsCount > 0 && (
                <CollectionLink
                  id={collection.id}
                  state={detailState}
                  className="sp-footer-more"
                  aria-label={extraTagsLabel}
                  title={extraTagsLabel}
                >
                  +{extraTagsCount}
                </CollectionLink>
              )}
            </div>
          )}

          <div className="sp-note-footer-actions">
            {followUpCountText && (
              <CollectionLink
                id={collection.id}
                state={detailState}
                hash="#follow-up-thread"
                className="sp-pill sp-follow-up-pill"
                aria-label={followUpCountText}
                title={followUpCountText}
              >
                <CornerDownRight size={12} strokeWidth={2} aria-hidden="true" />
                <span>{collection.follow_up_count} 条续写</span>
              </CollectionLink>
            )}

            <button
              type="button"
              className="sp-note-follow-up-btn"
              aria-label={`续写 ${collection.display_title}`}
              onClick={() => openFollowUp(toFollowUpSourceFromSummary(collection))}
            >
              <PenLine size={13} strokeWidth={2} aria-hidden="true" />
              <span>续写</span>
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
