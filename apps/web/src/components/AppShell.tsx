import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Folder,
  Inbox,
  Layers,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { handleMenuKeyDown } from '../lib/menuKeyboard';

export function AppShell({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: ReactNode;
}) {
  const api = useApi();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [inputFocusedMobile, setInputFocusedMobile] = useState(false);

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
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!drawerOpen) return;
    const prevActive = document.activeElement as HTMLElement | null;
    drawerPanelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
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

  const handleQuickCaptureJump = () => {
    navigate('/inbox?focus=composer');
  };

  const renderPrimaryAndProjectsNav = () => (
    <>
      <nav aria-label="工作区页面">
        <ul className="sp-nav-list">
          {primaryNav.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
                >
                  <Icon size={16} strokeWidth={2} aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sp-sidebar-group-head">
        <span>项目</span>
        <Link
          to={hasTrulyZeroProjects ? '/projects?create=1' : '/projects'}
          aria-label="查看或新建项目"
          className="sp-btn--quiet sp-btn--icon"
          style={{ width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>

      <ul className="sp-nav-list">
        {sidebarProjects.map((proj) => (
          <li key={proj.id}>
            <NavLink
              to={`/projects/${proj.id}`}
              className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
              style={{ fontSize: 13 }}
            >
              <Folder size={16} strokeWidth={2} aria-hidden="true" />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {proj.name}
              </span>
            </NavLink>
          </li>
        ))}
        {hasTrulyZeroProjects ? (
          <li>
            <Link
              to="/projects?create=1"
              className="sp-nav-link sp-nav-link--muted"
              style={{ fontSize: 13 }}
            >
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
              style={{ fontSize: 13 }}
            >
              <span>查看全部</span>
            </NavLink>
          </li>
        )}
      </ul>
    </>
  );

  return (
    <div className="sp-app-root">
      {api.isTestAdapter && (
        <div className="sp-adapter-banner" role="status">
          <span>测试适配器模式（仅本地内存模拟，非真实后端；邮件 / 模型未连接真实服务）</span>
        </div>
      )}

      {/* Tablet top bar (768px - 1023px) */}
      <header className="sp-tablet-header">
        <div className="sp-row">
          <button
            type="button"
            className="sp-btn--quiet sp-btn--icon"
            aria-label="打开导航菜单"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={18} strokeWidth={1.7} />
          </button>
          <Link to="/inbox" className="sp-brand" style={{ padding: 0 }}>
            <span className="sp-brand-mark" aria-hidden="true">S</span>
            <span>Spark</span>
          </Link>
        </div>
        {!isInbox && (
          <button type="button" className="sp-btn--quiet" onClick={handleQuickCaptureJump}>
            记一条
          </button>
        )}
      </header>

      {/* Mobile top bar (< 768px) */}
      <header className="sp-mobile-header">
        <div className="sp-row">
          <button
            type="button"
            className="sp-btn--quiet sp-btn--icon"
            aria-label="打开导航菜单"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu size={18} strokeWidth={1.7} />
          </button>
          <Link to="/inbox" className="sp-brand" style={{ padding: 0, fontSize: 19 }}>
            <span className="sp-brand-mark" aria-hidden="true">S</span>
            <span>Spark</span>
          </Link>
        </div>
        {!isInbox && (
          <button type="button" className="sp-btn--quiet" onClick={handleQuickCaptureJump}>
            记一条
          </button>
        )}
      </header>

      <div className={`sp-workspace ${wide ? 'sp-workspace--wide' : ''}`}>
        <aside className="sp-sidebar" aria-label="主导航">
          <Link to="/inbox" className="sp-brand">
            <span className="sp-brand-mark" aria-hidden="true">S</span>
            <span>Spark</span>
          </Link>

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
              className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
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
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user?.email}
                </span>
                <span className="sp-help" style={{ fontSize: 11 }}>
                  {user?.role === 'admin' ? '管理员' : '个人空间'}
                </span>
              </span>
              <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
            </button>

            {accountMenuOpen && (
              <div
                className="sp-account-menu"
                role="menu"
                aria-label="账号与系统菜单"
              >
                <Link to="/settings" role="menuitem" className="sp-menu-item">
                  <Settings size={15} strokeWidth={2} aria-hidden="true" />
                  <span>设置与会话</span>
                </Link>
                {user?.role === 'admin' && (
                  <Link to="/admin" role="menuitem" className="sp-menu-item">
                    <ShieldCheck size={15} strokeWidth={2} aria-hidden="true" />
                    <span>管理后台</span>
                  </Link>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="sp-menu-item sp-menu-item--danger"
                  onClick={() => void logout()}
                >
                  <LogOut size={15} strokeWidth={2} aria-hidden="true" />
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        </aside>

        <main className="sp-main-column">{children}</main>
      </div>

      {/* Mobile bottom bar (< 768px): 收件箱 / 项目 / 搜索 / 更多 */}
      <nav
        className={`sp-mobile-bottom-nav ${inputFocusedMobile ? 'sp-mobile-bottom-nav--hidden' : ''}`}
        aria-label="手机底部导航"
      >
        <NavLink
          to="/inbox"
          className={({ isActive }) => `sp-mobile-nav-item ${isActive ? 'active' : ''}`}
        >
          <Inbox size={18} strokeWidth={2} aria-hidden="true" />
          <span>收件箱</span>
        </NavLink>
        <NavLink
          to="/projects"
          className={({ isActive }) => `sp-mobile-nav-item ${isActive ? 'active' : ''}`}
        >
          <Folder size={18} strokeWidth={2} aria-hidden="true" />
          <span>项目</span>
        </NavLink>
        <NavLink
          to="/collections"
          className={({ isActive }) => `sp-mobile-nav-item ${isActive ? 'active' : ''}`}
        >
          <Search size={18} strokeWidth={2} aria-hidden="true" />
          <span>搜索</span>
        </NavLink>
        <button
          type="button"
          className="sp-mobile-nav-item"
          aria-label="更多导航"
          onClick={() => setDrawerOpen(true)}
        >
          <MoreHorizontal size={18} strokeWidth={2} aria-hidden="true" />
          <span>更多</span>
        </button>
      </nav>

      {/* Tablet & Mobile Navigation Drawer */}
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
            <div className="sp-row-between" style={{ marginBottom: 14 }}>
              <Link to="/inbox" className="sp-brand" style={{ padding: '0 8px' }}>
                <span className="sp-brand-mark" aria-hidden="true">S</span>
                <span>Spark</span>
              </Link>
              <button
                type="button"
                className="sp-btn--quiet sp-btn--icon"
                aria-label="关闭导航菜单"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={18} strokeWidth={1.7} />
              </button>
            </div>

            {renderPrimaryAndProjectsNav()}

            <div className="sp-sidebar-footer" style={{ paddingTop: 24 }}>
              <NavLink
                to="/trash"
                className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
              >
                <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                <span>回收站</span>
              </NavLink>
              <NavLink
                to="/settings"
                className={({ isActive }) => `sp-nav-link ${isActive ? 'active' : ''}`}
              >
                <Settings size={16} strokeWidth={2} aria-hidden="true" />
                <span>设置与会话</span>
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
              <div
                className="sp-help sp-break-anywhere"
                style={{ padding: '10px 12px 6px', borderTop: '1px solid var(--sp-border)', marginTop: 6 }}
              >
                {user?.email}
              </div>
              <button
                type="button"
                className="sp-nav-link sp-menu-item--danger"
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
