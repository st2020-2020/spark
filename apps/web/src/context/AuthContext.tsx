import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, RegisterRequest, SessionResult, User } from '../api/types';
import { isApiErrorCode } from '../api/errors';
import { clearUserDrafts } from '../lib/drafts';
import { useApi } from './ApiContext';

interface AuthState {
  user: User | null;
  csrfToken: string | null;
  expiresAt: string | null;
  aiTrialEligible: boolean;
  aiPlatformEnabled: boolean;
  isLoading: boolean;
  sessionError: string | null;
}

interface AuthContextValue extends AuthState {
  refreshSession: () => Promise<SessionResult | null>;
  login: (body: LoginRequest) => Promise<SessionResult>;
  register: (body: RegisterRequest) => Promise<SessionResult>;
  logout: (options?: { clearDrafts?: boolean }) => Promise<void>;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    user: null,
    csrfToken: null,
    expiresAt: null,
    aiTrialEligible: true,
    aiPlatformEnabled: true,
    isLoading: true,
    sessionError: null,
  });

  const sessionGeneration = useRef(0);
  const currentUserIdRef = useRef<string | null>(null);

  const applySession = useCallback(
    (session: SessionResult) => {
      if (currentUserIdRef.current && currentUserIdRef.current !== session.user.id) {
        queryClient.clear();
      }
      sessionGeneration.current += 1;
      currentUserIdRef.current = session.user.id;
      api.setCsrfToken(session.csrf_token);
      setState({
        user: session.user,
        csrfToken: session.csrf_token,
        expiresAt: session.expires_at,
        aiTrialEligible: session.ai_trial_eligible ?? true,
        aiPlatformEnabled: session.ai_platform_enabled ?? true,
        isLoading: false,
        sessionError: null,
      });
    },
    [api, queryClient],
  );

  const clearSessionState = useCallback(
    (message: string | null = null) => {
      sessionGeneration.current += 1;
      currentUserIdRef.current = null;
      api.setCsrfToken(null);
      queryClient.clear();
      setState({
        user: null,
        csrfToken: null,
        expiresAt: null,
        aiTrialEligible: false,
        aiPlatformEnabled: false,
        isLoading: false,
        sessionError: message,
      });
    },
    [api, queryClient],
  );

  useEffect(() => {
    api.setUnauthorizedHandler(() => {
      clearSessionState('登录会话已过期，请重新登录（未保存草稿已按账号保留）。');
    });
    return () => api.setUnauthorizedHandler(null);
  }, [api, clearSessionState]);

  const refreshSession = useCallback(async () => {
    const generation = sessionGeneration.current;
    try {
      const session = await api.currentSession();
      if (generation !== sessionGeneration.current) return null;
      applySession(session);
      return session;
    } catch (err) {
      if (generation !== sessionGeneration.current) return null;
      if (isApiErrorCode(err, 'session_expired') || isApiErrorCode(err, 'authentication_failed')) {
        clearSessionState(null);
        return null;
      }
      // Network or 503 error: keep unauthenticated loading finished and expose error
      setState((prev) => ({
        ...prev,
        isLoading: false,
        sessionError: err instanceof Error ? err.message : '无法获取会话状态',
      }));
      return null;
    }
  }, [api, applySession, clearSessionState]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const login = useCallback(
    async (body: LoginRequest) => {
      const session = await api.login(body);
      queryClient.clear();
      applySession(session);
      return session;
    },
    [api, applySession, queryClient],
  );

  const register = useCallback(
    async (body: RegisterRequest) => {
      const session = await api.register(body);
      queryClient.clear();
      applySession(session);
      return session;
    },
    [api, applySession, queryClient],
  );

  const logout = useCallback(
    async (options?: { clearDrafts?: boolean }) => {
      const prevUserId = state.user?.id;
      try {
        await api.logout();
      } finally {
        if (prevUserId && options?.clearDrafts !== false) {
          clearUserDrafts(prevUserId);
        }
        clearSessionState(null);
      }
    },
    [api, clearSessionState, state.user?.id],
  );

  const setUser = useCallback((user: User) => {
    setState((prev) => ({ ...prev, user }));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        refreshSession,
        login,
        register,
        logout,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
