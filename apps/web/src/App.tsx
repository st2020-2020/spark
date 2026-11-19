import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SparkApi } from './api/client';
import { ApiError } from './api/errors';
import { AppShell } from './components/AppShell';
import { LoadingState } from './components/StateBlocks';
import { ApiProvider } from './context/ApiContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { OrganizationEventsProvider } from './context/OrganizationEventsContext';
import { ToastProvider } from './context/ToastContext';
import { AdminPage } from './pages/AdminPage';
import { CollectionDetailPage } from './pages/CollectionDetailPage';
import { CollectionsPage } from './pages/CollectionsPage';
import { InboxPage } from './pages/InboxPage';
import { LoginPage } from './pages/LoginPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { initAppearance } from './lib/appearance';
import { SettingsPage } from './pages/SettingsPage';
import { TrashPage } from './pages/TrashPage';
import { TriagePage } from './pages/TriagePage';
import { UnclassifiedPage } from './pages/UnclassifiedPage';

function AuthenticatedShell() {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return (
      <div className="sp-auth-page">
        <div className="sp-auth-loading">
          <LoadingState message="正在恢复登录会话…" />
        </div>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  const wide = location.pathname.startsWith('/admin');
  return (
    <OrganizationEventsProvider>
      <AppShell wide={wide}>
        <Outlet />
      </AppShell>
    </OrganizationEventsProvider>
  );
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="sp-auth-page">
        <div className="sp-auth-loading">
          <LoadingState message="正在检查登录状态…" />
        </div>
      </div>
    );
  }
  if (user) {
    return <Navigate to="/inbox" replace />;
  }
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnly>
            <RegisterPage />
          </PublicOnly>
        }
      />
      <Route
        path="/reset-password"
        element={
          <PublicOnly>
            <ResetPasswordPage />
          </PublicOnly>
        }
      />

      <Route element={<AuthenticatedShell />}>
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/collections" element={<CollectionsPage />} />
        <Route path="/unclassified" element={<UnclassifiedPage />} />
        <Route path="/unclassified/triage" element={<TriagePage />} />
        <Route path="/collections/:id" element={<CollectionDetailPage />} />
        <Route path="/trash" element={<TrashPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
      </Route>

      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
  );
}

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (
            error instanceof ApiError &&
            (error.status === 401 || error.status === 403 || error.status === 404)
          ) {
            return false;
          }
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function AppProviders({
  api,
  children,
}: {
  api?: SparkApi;
  children: ReactNode;
}) {
  const [queryClient] = useState(() => createAppQueryClient());
  useEffect(() => {
    initAppearance();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProviders>
        <AppRoutes />
      </AppProviders>
    </BrowserRouter>
  );
}
