import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  Folder,
  Inbox,
  Layers,
  LogOut,
  Menu,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Smartphone,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { confirmLeavingImageDraft } from '../lib/drafts';
import { handleMenuKeyDown } from '../lib/menuKeyboard';
import {
  canAnimateMotion,
  prefersReducedMotion,
  SHEET_EXIT_MS,
  useSheetSwipeDismiss,
} from '../lib/motion';
import { projectToneClass } from '../lib/projectTone';
import { formatShortcut, isTouchDevice } from '../lib/shortcuts';
import {
  DEFAULT_SIDEBAR_ITEMS,
  loadSidebarPrefs,
  pruneSidebarPinnedIds,
  resolveSidebarProjects,
  saveSidebarPrefs,
  subscribeSidebarPrefs,
  togglePinnedWithMeta,
  type SidebarPrefs,
} from '../lib/sidebarPrefs';
import { BrandLink, SparkGlyph } from './Brand';
import { CommandPalette } from './CommandPalette';
import { SidebarCustomizePopover } from './SidebarCustomizePopover';
import { TagNavigation } from './Tags';
import { ActivityCalendar } from './ActivityCalendar';
import { QuickCaptureSheet } from './QuickCaptureSheet';

function formatBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

export function AppShell({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: ReactNode;
}) {
  const api = useApi();
  const { user, logout } = useAuth();
  const { pendingSuggestionsCount } = useOrganizationEvents();
  const navigate = useNavigate();
  const location = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRendered, setDrawerRendered] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [inputFocusedMobile, setInputFocusedMobile] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandInitialQuery, setCommandInitialQuery] = useState('');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [sidebarPrefs, setSidebarPrefs] = useState<SidebarPrefs>(() => loadSidebarPrefs(user?.id));
  const [projectCustomizeOpen, setProjectCustomizeOpen] = useState(false);
  const [projectPopoverSearch, setProjectPopoverSearch] = useState('');

  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const accountWrapRef = useRef<HTMLDivElement | null>(null);
  const drawerExitTimerRef = useRef<number | null>(null);
  const desktopProjectCustomizeBtnRef = useRef<HTMLButtonElement | null>(null);
  const drawerProjectCustomizeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setSidebarPrefs(loadSidebarPrefs(user?.id));
    setProjectCustomizeOpen(false);
    if (!user?.id) return;
    return subscribeSidebarPrefs((changedUserId, prefs) => {
      if (changedUserId === user.id) {
        setSidebarPrefs(prefs);
      }
    });
  }, [user?.id]);

  const updateSidebarPrefs = (patch: Partial<SidebarPrefs>) => {
    setSidebarPrefs(saveSidebarPrefs(user?.id, patch));
  };

  const openCommandPalette = (initial = '') => {
    setDrawerOpen(false);
    setProjectCustomizeOpen(false);
    setCommandInitialQuery(initial);
    setCommandOpen(true);
  };

  const {
    isDragging: drawerDragging,
    settledAfterDrag: drawerSettledAfterDrag,
    swipeStyle: drawerSwipeStyle,
    swipeHandlers: drawerSwipeHandlers,
  } = useSheetSwipeDismiss({
    enabled: drawerOpen && !drawerClosing,
    onDismiss: () => setDrawerOpen(false),
  });

  useLayoutEffect(() => {
    if (drawerPanelRef.current) {
      drawerPanelRef.current.inert = drawerClosing;
    }
  }, [drawerClosing]);

  useEffect(() => {
    if (drawerExitTimerRef.current !== null) {
      window.clearTimeout(drawerExitTimerRef.current);
      drawerExitTimerRef.current = null;
    }
    if (drawerOpen) {
      setDrawerRendered(true);
      setDrawerClosing(false);
      return;
    }
    if (!drawerRendered) return;
    if (!canAnimateMotion()) {
      setDrawerClosing(false);
      setDrawerRendered(false);
      return;
    }
    setDrawerClosing(true);
    drawerExitTimerRef.current = window.setTimeout(() => {
      drawerExitTimerRef.current = null;
      setDrawerClosing(false);
      setDrawerRendered(false);
    }, SHEET_EXIT_MS);
    return () => {
      if (drawerExitTimerRef.current !== null) {
        window.clearTimeout(drawerExitTimerRef.current);
        drawerExitTimerRef.current = null;
      }
    };
  }, [drawerOpen, drawerRendered]);

  const activeProjectsQuery = useInfiniteQuery({
    queryKey: ['projects', 'sidebar-active', user?.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listProjects({ state: 'active', cursor: pageParam, limit: 50 }),
    getNextPageParam: (page) => page.next_cursor,
    enabled: Boolean(user),
    staleTime: 30_000,
  });

  const remoteProjectTerm = projectPopoverSearch.trim();
  const activeProjectsSearchQuery = useQuery({
    queryKey: ['projects', 'sidebar-active-search', user?.id, remoteProjectTerm],
    queryFn: () => api.listProjects({ state: 'active', q: remoteProjectTerm, limit: 50 }),
    enabled: Boolean(user) && projectCustomizeOpen && Boolean(remoteProjectTerm) && Boolean(activeProjectsQuery.hasNextPage),
    staleTime: 15_000,
  });

  const activeItems = useMemo(() => {
    const pages = activeProjectsQuery.data?.pages.flatMap((p) => p.items) ?? [];
    const searched = activeProjectsSearchQuery.data?.items ?? [];
    if (searched.length === 0) return pages;
    const seen = new Set(pages.map((p) => p.id));
    return [...pages, ...searched.filter((p) => !seen.has(p.id))];
  }, [activeProjectsQuery.data, activeProjectsSearchQuery.data]);

  const anyProjectsQuery = useQuery({
    queryKey: ['projects', 'sidebar-any', user?.id],
    queryFn: () => api.listProjects({ limit: 1 }),
    enabled: Boolean(user) && activeProjectsQuery.isSuccess && activeItems.length === 0,
    staleTime: 30_000,
  });

  const hasTrulyZeroProjects =
    activeProjectsQuery.isSuccess &&
    activeItems.length === 0 &&
    anyProjectsQuery.isSuccess &&
    anyProjectsQuery.data.items.length === 0;

  useEffect(() => {
    setDrawerOpen(false);
    setAccountMenuOpen(false);
    setCaptureOpen(false);
    setProjectCustomizeOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!drawerOpen) return;
    const prevActive = document.activeElement as HTMLElement | null;
    if (drawerPanelRef.current) {
      drawerPanelRef.current.inert = false;
    }
    drawerPanelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('.sp-sidebar-customize-popover')) return;
      event.stopPropagation();
      setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      prevActive?.focus?.();
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (accountWrapRef.current && !accountWrapRef.current.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [accountMenuOpen]);

  // The mobile tab bar steps aside while typing so the soft keyboard never covers the save action.
  useEffect(() => {
    const isEditable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
      if (el.tagName === 'INPUT') {
        const type = (el as HTMLInputElement).type;
        return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
      }
      return el.isContentEditable;
    };
    let focusOutTimer: number | null = null;
    const clearFocusOutTimer = () => {
      if (focusOutTimer !== null) {
        window.clearTimeout(focusOutTimer);
        focusOutTimer = null;
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      clearFocusOutTimer();
      setInputFocusedMobile(isEditable(e.target));
    };
    const onFocusOut = () => {
      clearFocusOutTimer();
      focusOutTimer = window.setTimeout(() => {
        focusOutTimer = null;
        if (!isEditable(document.activeElement)) {
          setInputFocusedMobile(false);
        }
      }, 60);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      clearFocusOutTimer();
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const primaryNav = [
    { to: '/inbox', label: '收件箱', icon: Inbox },
    { to: '/unclassified', label: '待归类', icon: Layers },
    { to: '/collections', label: '全部收藏', icon: Search },
  ];

  const allActiveLoaded = activeProjectsQuery.isSuccess && !activeProjectsQuery.hasNextPage;

  useEffect(() => {
    if (!user?.id || !allActiveLoaded || !activeProjectsQuery.data) return;
    const loadedProjects = activeProjectsQuery.data.pages.flatMap((p) => p.items);
    const loadedIds = new Set(loadedProjects.map((p) => p.id));
    const loadedNames = new Map(loadedProjects.map((p) => [p.id, p.name]));
    const updated = pruneSidebarPinnedIds(user.id, 'project', loadedIds, loadedNames);
    if (updated) {
      setSidebarPrefs(updated);
    }
  }, [user?.id, allActiveLoaded, activeProjectsQuery.data]);

  const {
    visible: sidebarProjects,
    isCustomized: projectsCustomized,
    validPinnedIds: validPinnedProjectIds,
  } = useMemo(
    () =>
      resolveSidebarProjects(activeItems, sidebarPrefs.pinnedProjectIds, DEFAULT_SIDEBAR_ITEMS, {
        meta: sidebarPrefs.pinnedProjectMeta,
        allActiveLoaded,
      }),
    [activeItems, sidebarPrefs.pinnedProjectIds, sidebarPrefs.pinnedProjectMeta, allActiveLoaded],
  );
  const validPinnedProjectSet = useMemo(
    () => new Set(validPinnedProjectIds),
    [validPinnedProjectIds],
  );
  const projectMap = useMemo(() => new Map(activeItems.map((p) => [p.id, p])), [activeItems]);
  const popoverProjectItems = useMemo(() => {
    const base = activeItems.map((p) => ({
      id: p.id,
      label: p.name,
      count: p.collection_count,
      pinned: validPinnedProjectSet.has(p.id),
      accentClass: projectToneClass(p.id),
    }));
    const seen = new Set(activeItems.map((p) => p.id));
    for (const id of validPinnedProjectIds) {
      if (!seen.has(id) && sidebarPrefs.pinnedProjectMeta?.[id]) {
        base.push({
          id,
          label: sidebarPrefs.pinnedProjectMeta[id],
          count: 0,
          pinned: true,
          accentClass: projectToneClass(id),
        });
      }
    }
    return base;
  }, [activeItems, validPinnedProjectIds, validPinnedProjectSet, sidebarPrefs.pinnedProjectMeta]);
  const showAllProjectsLink =
    !hasTrulyZeroProjects &&
    (activeItems.length > sidebarProjects.length ||
      Boolean(activeProjectsQuery.hasNextPage) ||
      (activeProjectsQuery.isSuccess && activeItems.length === 0));

  const userInitial = (user?.email?.slice(0, 1) || 'S').toUpperCase();
  const isInbox = location.pathname === '/inbox';
  const androidWorkspace = navigator.userAgent.split(/\s+/).includes('SparkAndroid/2');
  const inMoreSection = !['inbox', 'projects', 'collections'].includes(location.pathname.split('/')[1]);
  const badgeText = formatBadgeCount(pendingSuggestionsCount);

  // On the inbox the composer is already on screen: focus it in place so the draft and scroll
  // position stay intact. Everywhere else, capture in a sheet without leaving the page.
  const handleQuickCapture = () => {
    if (isInbox) {
      const editable = document.querySelector<HTMLElement>('.sp-composer [contenteditable="true"]');
      if (editable) {
        editable.focus();
        editable.scrollIntoView({
          block: 'center',
          behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
        return;
      }
      navigate('/inbox?focus=composer');
      return;
    }
    setDrawerOpen(false);
    setCaptureOpen(true);
  };
  const quickCaptureRef = useRef(handleQuickCapture);
  quickCaptureRef.current = handleQuickCapture;

  // "N" opens quick capture from anywhere outside inputs; Cmd/Ctrl+K opens CommandPalette even while typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return;
      if (
        document.querySelector(
          '[aria-modal="true"], [role="menu"], [role="dialog"], [role="listbox"]',
        )
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (event.metaKey || event.ctrlKey) {
        if (key === 'k') {
          event.preventDefault();
          setCommandInitialQuery('');
          setCommandOpen(true);
        }
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]')
      ) {
        return;
      }
      if (key === 'n') { event.preventDefault(); quickCaptureRef.current(); }
      if (key === 'j' || key === 'k') {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('main [data-keyboard-card]'));
        if (!cards.length) return;
        const current = cards.findIndex(c => c.contains(document.activeElement));
        const next = current < 0 ? (key === 'j' ? 0 : cards.length - 1)
          : Math.max(0, Math.min(cards.length - 1, current + (key === 'j' ? 1 : -1)));
        event.preventDefault(); cards[next].focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const renderPrimaryNav = () => (
    <nav aria-label="工作区页面">
      <ul className="sp-nav-list">
        {primaryNav.map((item) => {
          const Icon = item.icon;
          const showSuggestionBadge =
            item.to === '/unclassified' && pendingSuggestionsCount > 0;
          return (
            <li key={item.to} className="sp-nav-item">
              <NavLink
                to={item.to}
                className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
              >
                <Icon size={17} strokeWidth={2} aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
              {showSuggestionBadge && (
                <Link
                  to="/unclassified?tab=suggested"
                  className="sp-nav-badge"
                  aria-label={`${pendingSuggestionsCount} 条待确认 AI 建议`}
                  title={`${pendingSuggestionsCount} 条待确认 AI 建议`}
                >
                  {badgeText}
                </Link>
              )}
            </li>
          );
        })}
        {androidWorkspace && (
          <li className="sp-nav-item">
            {/* A document navigation deliberately reaches the Android WebViewClient. */}
            <a href="/android/local-drafts" className="sp-nav-link" onClick={() => setDrawerOpen(false)}>
              <Smartphone size={17} strokeWidth={2} aria-hidden="true" />
              <span>本机草稿</span>
            </a>
          </li>
        )}
      </ul>
    </nav>
  );

  const renderSpaceSection = (compactMobile = false) => {
    const customizeAnchorRef = compactMobile
      ? drawerProjectCustomizeBtnRef
      : desktopProjectCustomizeBtnRef;
    const showPopoverHere = projectCustomizeOpen && compactMobile === drawerOpen;
    return (
      <div className="sp-sidebar-space">
        <div className="sp-sidebar-section">
          <div className="sp-sidebar-group-head">
            <Link to="/projects" className="sp-sidebar-group-label sp-sidebar-group-link">
              常用项目
            </Link>
            <div className="sp-sidebar-group-actions">
              {activeItems.length > 0 && (
                <button
                  ref={customizeAnchorRef}
                  type="button"
                  className="sp-icon-btn sp-icon-btn--sm"
                  aria-label="自定义常用项目"
                  aria-expanded={showPopoverHere}
                  title="自定义常用项目"
                  onClick={() => setProjectCustomizeOpen((v) => !v)}
                >
                  <SlidersHorizontal size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
              <Link
                to={hasTrulyZeroProjects ? '/projects?create=1' : '/projects'}
                aria-label="查看或新建项目"
                className="sp-icon-btn sp-icon-btn--sm"
              >
                <Plus size={15} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <SidebarCustomizePopover
            open={showPopoverHere}
            title="自定义常用项目"
            searchLabel="搜索常用项目"
            searchPlaceholder="搜索进行中项目…"
            emptyText="没有匹配的项目"
            items={popoverProjectItems}
            isCustomized={projectsCustomized}
            hasMore={Boolean(activeProjectsQuery.hasNextPage)}
            isLoadingMore={activeProjectsQuery.isFetchingNextPage}
            onLoadMore={() => void activeProjectsQuery.fetchNextPage()}
            onQueryChange={setProjectPopoverSearch}
            onTogglePin={(id) => {
              const name =
                projectMap.get(id)?.name ?? sidebarPrefs.pinnedProjectMeta?.[id] ?? '';
              const next = togglePinnedWithMeta(
                sidebarPrefs.pinnedProjectIds,
                sidebarPrefs.pinnedProjectMeta,
                id,
                name,
              );
              updateSidebarPrefs({
                pinnedProjectIds: next.ids,
                pinnedProjectMeta: next.meta,
              });
            }}
            onReset={() =>
              updateSidebarPrefs({ pinnedProjectIds: null, pinnedProjectMeta: {} })
            }
            onClose={() => setProjectCustomizeOpen(false)}
            anchorRef={customizeAnchorRef}
          />

          <ul className="sp-nav-list">
            {sidebarProjects.map((proj) => (
              <li key={proj.id}>
                <NavLink
                  to={`/projects/${proj.id}`}
                  className={({ isActive }) => `sp-nav-link sp-nav-link--project ${isActive ? 'active' : ''}`}
                >
                  <span className={`sp-project-dot ${projectToneClass(proj.id)}`} aria-hidden="true" />
                  <span className="sp-truncate">{proj.name}</span>
                </NavLink>
              </li>
            ))}
            {hasTrulyZeroProjects ? (
              <li>
                <Link to="/projects?create=1" className="sp-nav-link sp-nav-link--muted">
                  <span>创建项目</span>
                </Link>
              </li>
            ) : (
              showAllProjectsLink && (
                <li>
                  <NavLink
                    to="/projects"
                    end
                    className={({ isActive }) =>
                      `sp-nav-link sp-nav-link--muted sp-sidebar-all-link ${isActive ? 'active' : ''}`
                    }
                  >
                    <span>全部项目</span>
                  </NavLink>
                </li>
              )
            )}
          </ul>
        </div>

        <TagNavigation
          pinnedTagIds={sidebarPrefs.pinnedTagIds}
          pinnedTagMeta={sidebarPrefs.pinnedTagMeta}
          onUpdatePinnedTags={(nextIds, nextMeta) =>
            updateSidebarPrefs({ pinnedTagIds: nextIds, pinnedTagMeta: nextMeta })
          }
          onOpenAllTags={() => openCommandPalette('#')}
          onNavigate={compactMobile ? () => setDrawerOpen(false) : undefined}
        />

        <ActivityCalendar
          key={user?.id}
          onSelect={compactMobile ? () => setDrawerOpen(false) : undefined}
        />
      </div>
    );
  };

  return (
    <div className={`sp-app-root${androidWorkspace && !isInbox ? ' sp-app-root--android-subpage' : ''}`}>
      {api.isTestAdapter && (
        <div className="sp-adapter-banner" role="status">
          <span>测试适配器模式（仅本地内存模拟，非真实后端；邮件 / 模型未连接真实服务）</span>
        </div>
      )}

      {/* Top bar for tablet (menu + drawer) and phone (brand + status), hidden on desktop. */}
      <header className="sp-topbar">
        <div className="sp-topbar-inner">
          <div className="sp-topbar-start">
            <button
              type="button"
              className="sp-icon-btn sp-topbar-menu"
              aria-label="打开导航菜单"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu size={20} strokeWidth={2} />
            </button>
            <BrandLink />
          </div>
          <div className="sp-topbar-end">
            {pendingSuggestionsCount > 0 && (
              <Link
                to="/unclassified?tab=suggested"
                className="sp-topbar-chip"
                aria-label={`待确认建议 ${pendingSuggestionsCount} 条`}
              >
                <SparkGlyph size={12} />
                <span>{badgeText} 条待确认</span>
              </Link>
            )}
            {!isInbox && (
              <button
                type="button"
                className="sp-btn sp-btn--sm sp-topbar-capture"
                onClick={handleQuickCapture}
              >
                <PenLine size={15} strokeWidth={2} aria-hidden="true" />
                <span>记一条</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <div className={`sp-workspace ${wide ? 'sp-workspace--wide' : ''}`}>
        <aside className="sp-sidebar" aria-label="主导航">
          <div className="sp-sidebar-top">
            <BrandLink className="sp-brand--sidebar" />

            <div className="sp-sidebar-actions">
              <button type="button" className="sp-capture-btn" onClick={handleQuickCapture}>
                <PenLine size={16} strokeWidth={2} aria-hidden="true" />
                <span>记一条</span>
                <kbd className="sp-kbd-hint" aria-hidden="true">
                  N
                </kbd>
              </button>

              <button
                type="button"
                className="sp-jump-btn"
                aria-label="快速跳转"
                title={`快速跳转 (${formatShortcut('K')})`}
                onClick={() => openCommandPalette('')}
              >
                <Search size={15} strokeWidth={2} aria-hidden="true" />
                {!isTouchDevice() && (
                  <kbd className="sp-kbd-hint" aria-hidden="true">
                    {formatShortcut('K')}
                  </kbd>
                )}
              </button>
            </div>

            {renderPrimaryNav()}
          </div>

          {renderSpaceSection(false)}

          <div
            className="sp-sidebar-footer"
            ref={accountWrapRef}
            onKeyDown={(e) => {
              if (accountMenuOpen) handleMenuKeyDown(e);
            }}
          >
            <NavLink
              to="/trash"
              className={({ isActive }) => `sp-nav-link sp-nav-link--muted ${isActive ? 'active' : ''}`}
            >
              <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
              <span>回收站</span>
            </NavLink>

            <button
              type="button"
              className="sp-account-trigger"
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
              aria-label="账号菜单"
              onClick={() => setAccountMenuOpen((v) => !v)}
            >
              <span className="sp-avatar" aria-hidden="true">
                {userInitial}
              </span>
              <span className="sp-account-text">
                <span className="sp-account-email">{user?.email}</span>
                <span className="sp-account-role">
                  {user?.role === 'admin' ? '管理员' : '个人空间'}
                </span>
              </span>
              <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
            </button>

            {accountMenuOpen && (
              <div className="sp-account-menu" role="menu" aria-label="账号与系统菜单">
                <Link to="/settings" role="menuitem" className="sp-menu-item">
                  <Settings size={16} strokeWidth={2} aria-hidden="true" />
                  <span>设置与会话</span>
                </Link>
                {user?.role === 'admin' && (
                  <Link to="/admin" role="menuitem" className="sp-menu-item">
                    <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" />
                    <span>管理后台</span>
                  </Link>
                )}
                <div className="sp-menu-divider" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="sp-menu-item sp-menu-item--danger"
                  onClick={() => {
                    if (confirmLeavingImageDraft()) void logout();
                  }}
                >
                  <LogOut size={16} strokeWidth={2} aria-hidden="true" />
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        </aside>

        <main key={location.pathname} className="sp-main-column sp-page-stage">
          {children}
        </main>
      </div>

      {/* Phone tab bar: 收件箱 / 项目 / 记一条 / 搜索 / 更多 */}
      <nav
        className={`sp-tabbar ${inputFocusedMobile ? 'sp-tabbar--hidden' : ''}`}
        aria-label="手机底部导航"
      >
        <NavLink to="/inbox" className={({ isActive }) => `sp-tab ${isActive ? 'active' : ''}`}>
          <Inbox size={22} strokeWidth={1.9} aria-hidden="true" />
          <span>收件箱</span>
        </NavLink>
        <NavLink to="/projects" className={({ isActive }) => `sp-tab ${isActive ? 'active' : ''}`}>
          <Folder size={22} strokeWidth={1.9} aria-hidden="true" />
          <span>项目</span>
        </NavLink>
        <button type="button" className="sp-tab sp-tab--capture" aria-label="记一条" onClick={handleQuickCapture}>
          <span className="sp-tab-capture-disc" aria-hidden="true">
            <Plus size={24} strokeWidth={2.4} />
          </span>
        </button>
        <NavLink to="/collections" className={({ isActive }) => `sp-tab ${isActive ? 'active' : ''}`}>
          <Search size={22} strokeWidth={1.9} aria-hidden="true" />
          <span>搜索</span>
        </NavLink>
        <button
          type="button"
          className={`sp-tab ${drawerOpen || inMoreSection ? 'active' : ''}`}
          aria-label="更多导航"
          aria-current={inMoreSection ? 'location' : undefined}
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <span className="sp-tab-icon-wrap">
            <MoreHorizontal size={22} strokeWidth={1.9} aria-hidden="true" />
            {pendingSuggestionsCount > 0 && (
              <span className="sp-tab-badge" aria-hidden="true">
                {badgeText}
              </span>
            )}
          </span>
          <span>更多</span>
        </button>
      </nav>

      <CommandPalette
        open={commandOpen}
        initialQuery={commandInitialQuery}
        onClose={() => setCommandOpen(false)}
      />
      <QuickCaptureSheet open={captureOpen} onClose={() => setCaptureOpen(false)} />

      {/* Tablet side drawer / phone bottom sheet — one panel, two presentations. */}
      {(drawerOpen || drawerRendered) && (
        <div
          className={`sp-drawer-backdrop ${drawerClosing ? 'is-closing' : ''}`}
          role="presentation"
          onClick={(e) => {
            if (!drawerClosing && e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <div
            ref={drawerPanelRef}
            className={`sp-drawer-panel ${drawerClosing ? 'is-closing' : ''} ${
              drawerDragging ? 'is-dragging' : ''
            } ${drawerSettledAfterDrag ? 'is-swipe-settled' : ''}`}
            style={drawerSwipeStyle}
            role="dialog"
            aria-modal={!drawerClosing ? 'true' : undefined}
            aria-hidden={drawerClosing ? 'true' : undefined}
            aria-label="导航菜单"
            tabIndex={-1}
          >
            <div className="sp-sheet-swipe-zone" {...drawerSwipeHandlers}>
              <span className="sp-sheet-grabber" aria-hidden="true" />
              <div className="sp-drawer-head">
                <BrandLink />
                <button
                  type="button"
                  className="sp-icon-btn"
                  aria-label="关闭导航菜单"
                  onClick={() => setDrawerOpen(false)}
                >
                  <X size={20} strokeWidth={2} />
                </button>
              </div>
            </div>

            <Link to="/settings" className="sp-drawer-account">
              <span className="sp-avatar sp-avatar--lg" aria-hidden="true">
                {userInitial}
              </span>
              <span className="sp-account-text">
                <span className="sp-account-email">{user?.email}</span>
                <span className="sp-account-role">
                  {user?.role === 'admin' ? '管理员 · 设置与会话' : '设置与会话'}
                </span>
              </span>
              <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
            </Link>

            <button
              type="button"
              className="sp-nav-link sp-nav-link--command"
              aria-label="搜索与跳转"
              onClick={() => openCommandPalette('')}
            >
              <Search size={16} strokeWidth={2} aria-hidden="true" />
              <span>搜索与跳转</span>
            </button>

            {renderPrimaryNav()}
            {renderSpaceSection(true)}

            <div className="sp-drawer-footer">
              <NavLink
                to="/trash"
                className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
              >
                <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                <span>回收站</span>
              </NavLink>
              {user?.role === 'admin' && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
                >
                  <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" />
                  <span>管理后台</span>
                </NavLink>
              )}
              <button
                type="button"
                className="sp-nav-link sp-nav-link--danger"
                onClick={() => {
                  if (confirmLeavingImageDraft()) void logout();
                }}
              >
                <LogOut size={16} strokeWidth={2} aria-hidden="true" />
                <span>退出登录</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
