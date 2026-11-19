import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
  Smartphone,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useOrganizationEvents } from '../context/OrganizationEventsContext';
import { handleMenuKeyDown } from '../lib/menuKeyboard';
import { projectToneClass } from '../lib/projectTone';
import { BrandLink, SparkGlyph } from './Brand';
import { QuickCaptureSheet } from './QuickCaptureSheet';

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

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
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [inputFocusedMobile, setInputFocusedMobile] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);

  const drawerPanelRef = useRef<HTMLDivElement | null>(null);
  const accountWrapRef = useRef<HTMLDivElement | null>(null);

  const activeProjectsQuery = useQuery({
    queryKey: ['projects', 'sidebar-active'],
    queryFn: () => api.listProjects({ state: 'active', limit: 5 }),
    staleTime: 30_000,
  });

  const activeItems = activeProjectsQuery.data?.items ?? [];
  const anyProjectsQuery = useQuery({
    queryKey: ['projects', 'sidebar-any'],
    queryFn: () => api.listProjects({ limit: 1 }),
    enabled: activeProjectsQuery.isSuccess && activeItems.length === 0,
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
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!drawerOpen) return;
    const prevActive = document.activeElement as HTMLElement | null;
    drawerPanelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setDrawerOpen(false);
      }
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
    const onFocusIn = (e: FocusEvent) => {
      if (isEditable(e.target)) setInputFocusedMobile(true);
    };
    const onFocusOut = () => {
      window.setTimeout(() => {
        if (!isEditable(document.activeElement)) {
          setInputFocusedMobile(false);
        }
      }, 60);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const primaryNav = [
    { to: '/inbox', label: '收件箱', icon: Inbox },
    { to: '/collections', label: '全部收藏', icon: Search },
    { to: '/unclassified', label: '待归类', icon: Layers },
  ];

  const sidebarProjects = activeItems.slice(0, 5);
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

  // "N" opens quick capture from anywhere, unless the person is typing or a dialog is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.isComposing || event.keyCode === 229) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      quickCaptureRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const renderPrimaryAndProjectsNav = () => (
    <>
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

      <div className="sp-sidebar-group-head">
        <span>项目</span>
        <Link
          to={hasTrulyZeroProjects ? '/projects?create=1' : '/projects'}
          aria-label="查看或新建项目"
          className="sp-icon-btn sp-icon-btn--sm"
        >
          <Plus size={15} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>

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
          <li>
            <NavLink
              to="/projects"
              end
              className={({ isActive }) =>
                `sp-nav-link sp-nav-link--muted ${isActive ? 'active' : ''}`
              }
            >
              <span>查看全部</span>
            </NavLink>
          </li>
        )}
      </ul>
    </>
  );

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
          <BrandLink className="sp-brand--sidebar" />

          <button type="button" className="sp-capture-btn" onClick={handleQuickCapture}>
            <PenLine size={16} strokeWidth={2} aria-hidden="true" />
            <span>记一条</span>
            <kbd className="sp-kbd-hint" aria-hidden="true">
              N
            </kbd>
          </button>

          {renderPrimaryAndProjectsNav()}

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
                  onClick={() => void logout()}
                >
                  <LogOut size={16} strokeWidth={2} aria-hidden="true" />
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="sp-main-column">{children}</main>
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

      <QuickCaptureSheet open={captureOpen} onClose={() => setCaptureOpen(false)} />

      {/* Tablet side drawer / phone bottom sheet — one panel, two presentations. */}
      {drawerOpen && (
        <div
          className="sp-drawer-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDrawerOpen(false);
          }}
        >
          <div
            ref={drawerPanelRef}
            className="sp-drawer-panel"
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
            tabIndex={-1}
          >
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

            {renderPrimaryAndProjectsNav()}

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
                onClick={() => void logout()}
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
