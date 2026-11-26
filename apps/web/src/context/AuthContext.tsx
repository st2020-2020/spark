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
import { showAccountAppearance, type PaletteId, type ThemePref } from '../lib/appearance';
import { advanceAuthSession } from '../lib/authSession';
import { clearUserDrafts } from '../lib/drafts';
import { useApi } from './ApiContext';
import { useToast } from './ToastContext';

interface AuthState {
  user: User | null;
  csrfToken: string | null;
  expiresAt: string | null;
  aiTrialEligible: boolean;
  aiPlatformEnabled: boolean;
  purgeEnabled: boolean;
  urlExtractionEnabled: boolean;
  isLoading: boolean;
  sessionError: string | null;
}

interface AuthContextValue extends AuthState {
  refreshSession: () => Promise<SessionResult | null>;
  login: (body: LoginRequest) => Promise<SessionResult>;
  register: (body: RegisterRequest) => Promise<SessionResult>;
  logout: (options?: { clearDrafts?: boolean }) => Promise<void>;
  applyAiPreferences: (user: User) => void;
  saveAppearance: (patch: { palette?: PaletteId; theme?: ThemePref }) => Promise<void>;
  appearancePending: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { pushToast, clearAllToasts } = useToast();
  const activeToken = useRef<string | null>(null);
  const exitingToken = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    user: null,
    csrfToken: null,
    expiresAt: null,
    aiTrialEligible: true,
    aiPlatformEnabled: true,
    purgeEnabled: false,
    urlExtractionEnabled: false,
    isLoading: true,
    sessionError: null,
  });

  const [appearancePending, setAppearancePending] = useState(false);
  const appearanceRequest = useRef<symbol | null>(null);
  const appearanceUserId = state.user?.id;
  const palette = state.user?.palette ?? 'mint';
  const theme = state.user?.theme ?? 'system';
  useEffect(() => {
    showAccountAppearance(appearanceUserId ? { palette, theme } : null);
  }, [appearanceUserId, palette, theme]);

  const sessionGeneration = useRef(0);
  const currentUserIdRef = useRef<string | null>(null);

  const applySession = useCallback(
    (session: SessionResult) => {
      if (currentUserIdRef.current && currentUserIdRef.current !== session.user.id) {
        appearanceRequest.current = null;
        setAppearancePending(false);
        clearAllToasts();
        queryClient.clear();
      }
      if (currentUserIdRef.current !== session.user.id) {
        advanceAuthSession(session.user.id);
      }
      sessionGeneration.current += 1;
      currentUserIdRef.current = session.user.id;
      activeToken.current = session.csrf_token;
      api.setCsrfToken(session.csrf_token);
      setState({
        user: session.user,
        csrfToken: session.csrf_token,
        expiresAt: session.expires_at,
        aiTrialEligible: session.ai_trial_eligible ?? true,
        aiPlatformEnabled: session.ai_platform_enabled ?? true,
        purgeEnabled: session.purge_enabled === true,
        urlExtractionEnabled: session.url_extraction_enabled === true,
        isLoading: false,
        sessionError: null,
      });
    },
    [api, clearAllToasts, queryClient],
  );

  const clearSessionState = useCallback(
    (message: string | null = null) => {
      sessionGeneration.current += 1;
      currentUserIdRef.current = null;
      advanceAuthSession(null);
      clearAllToasts();
      activeToken.current = null;
      api.setCsrfToken(null);
      appearanceRequest.current = null;
      setAppearancePending(false);
      queryClient.clear();
      setState({
        user: null,
        csrfToken: null,
        expiresAt: null,
        aiTrialEligible: false,
        aiPlatformEnabled: false,
        purgeEnabled: false,
        urlExtractionEnabled: false,
        isLoading: false,
        sessionError: message,
      });
    },
    [api, clearAllToasts, queryClient],
  );

  useEffect(() => {
    return () => {
      advanceAuthSession(null);
      showAccountAppearance(null);
    };
  }, []);

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
      clearAllToasts();
      queryClient.clear();
      advanceAuthSession(session.user.id);
      applySession(session);
      return session;
    },
    [api, applySession, clearAllToasts, queryClient],
  );

  const register = useCallback(
    async (body: RegisterRequest) => {
      const session = await api.register(body);
      clearAllToasts();
      queryClient.clear();
      advanceAuthSession(session.user.id);
      applySession(session);
      return session;
    },
    [api, applySession, clearAllToasts, queryClient],
  );

  const logout = useCallback(
    async (options?: { clearDrafts?: boolean }) => {
      const token = activeToken.current;
      const userId = currentUserIdRef.current;
      if (!token || !userId || exitingToken.current === token) return;
      exitingToken.current = token;
      try {
        await api.logout();
        if (activeToken.current !== token) return;
        if (options?.clearDrafts !== false) clearUserDrafts(userId);
        clearSessionState(null);
      } catch {
        if (activeToken.current !== token) return;
        try {
          const session = await api.currentSession();
          if (activeToken.current !== token) return;
          applySession(session);
          if (session.user.id !== userId) return;
          pushToast({ message: '尚未退出登录，草稿已保留，请重试退出。', tone: 'error' });
        } catch (error) {
          if (activeToken.current !== token) return;
          if (isApiErrorCode(error, 'session_expired') || isApiErrorCode(error, 'authentication_failed')) {
            clearSessionState(null);
          } else {
            pushToast({ message: '无法确认退出结果，草稿已保留。请在网络恢复后重试退出。', tone: 'error' });
          }
        }
      } finally {
        if (exitingToken.current === token) exitingToken.current = null;
      }
    },
    [api, applySession, clearSessionState, pushToast],
  );

  const applyAiPreferences = useCallback((user: User) => {
    setState((prev) => prev.user?.id === user.id ? { ...prev, user: {
      ...prev.user, ai_enabled: user.ai_enabled, ai_policy_version: user.ai_policy_version,
      ai_consent_version: user.ai_consent_version,
    } } : prev);
  }, []);

  const saveAppearance = async (patch: { palette?: PaletteId; theme?: ThemePref }) => {
    if (appearanceRequest.current) throw new Error('外观设置正在保存。');
    const request = Symbol();
    appearanceRequest.current = request;
    setAppearancePending(true);
    try {
      const updated = await api.updatePreferences(patch);
      if (appearanceRequest.current !== request || updated.id !== currentUserIdRef.current) return;
      if ((patch.palette && patch.palette !== updated.palette) || (patch.theme && patch.theme !== updated.theme)) {
        throw new Error('服务器未保存外观设置。');
      }
      sessionGeneration.current += 1;
      setState(prev => prev.user?.id === updated.id ? { ...prev, user: {
        ...prev.user, palette: updated.palette, theme: updated.theme,
      } } : prev);
    } finally {
      if (appearanceRequest.current === request) {
        appearanceRequest.current = null;
        setAppearancePending(false);
      }
    }
  };

  return (
    <AuthContext.Provider
      value={{
        ...state,
        refreshSession,
        login,
        register,
        logout,
        applyAiPreferences, saveAppearance, appearancePending,
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
