import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { ApiError, getFriendlyErrorMessage } from '../api/errors';
import { AIConsentModal } from '../components/AIConsentModal';
import { PageHeader } from '../components/PageHeader';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatDateTime, formatDeviceLabel, formatUnitsToYuan } from '../lib/format';

type ThemePref = 'system' | 'light' | 'dark';

function readStoredTheme(): ThemePref {
  try {
    const val = window.localStorage.getItem('spark:theme');
    if (val === 'light' || val === 'dark') return val;
  } catch {
    // Ignore storage error
  }
  return 'system';
}

export function applyThemePreference(pref: ThemePref): void {
  if (pref === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', pref);
  }
  try {
    if (pref === 'system') window.localStorage.removeItem('spark:theme');
    else window.localStorage.setItem('spark:theme', pref);
  } catch {
    // Ignore storage error
  }
}

export function SettingsPage() {
  const api = useApi();
  const { user, setUser, logout, aiTrialEligible, aiPlatformEnabled } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [themePref, setThemePref] = useState<ThemePref>(() => readStoredTheme());
  const [aiConsentOpen, setAiConsentOpen] = useState(false);

  const usageQuery = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.getUsage(),
  });

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.listSessions(),
  });

  const prefsMutation = useMutation({
    mutationFn: (params: { ai_enabled: boolean; consent_version?: string }) =>
      api.updatePreferences(params),
    onSuccess: (updatedUser) => {
      setUser(updatedUser);
      setAiConsentOpen(false);
      pushToast({
        message: updatedUser.ai_enabled ? '已开启 AI 自动整理' : '已关闭 AI 自动整理',
      });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSuccess: () => {
      pushToast({ message: '已撤销该设备会话' });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err) => pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' }),
  });

  const isUsageUnavailable =
    usageQuery.isError &&
    usageQuery.error instanceof ApiError &&
    usageQuery.error.status === 404;

  const isSessionsUnavailable =
    sessionsQuery.isError &&
    sessionsQuery.error instanceof ApiError &&
    sessionsQuery.error.status === 404;

  return (
    <div>
      <PageHeader title="设置" showSearch={false} />

      <div className="sp-stack" style={{ gap: 14 }}>
        <section className="sp-card" aria-label="账号信息">
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>账号</h2>
          <div className="sp-row-between">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{user?.email}</div>
              <div className="sp-help">
                {user?.role === 'admin' ? '管理员' : '个人用户'}
              </div>
            </div>
            <button type="button" className="sp-btn" onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </section>

        <section className="sp-card" aria-label="界面外观">
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>外观主题</h2>
          <div className="sp-segmented" role="group" aria-label="选择外观主题">
            {([
              { id: 'system', label: '跟随系统', Icon: Monitor },
              { id: 'light', label: '浅色', Icon: Sun },
              { id: 'dark', label: '深色', Icon: Moon },
            ] as const).map(({ id: pref, label, Icon }) => (
              <button
                key={pref}
                type="button"
                className="sp-segmented-btn"
                aria-pressed={themePref === pref}
                onClick={() => {
                  setThemePref(pref);
                  applyThemePreference(pref);
                }}
              >
                <Icon size={14} strokeWidth={2} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="sp-card" aria-label="平台 AI 自动整理">
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>AI 自动整理</h2>
          <div className="sp-stack" style={{ gap: 10 }}>
            <div className="sp-row-between">
              <div className="sp-stack" style={{ gap: 4, minWidth: 0 }}>
                <div className="sp-row">
                  <span
                    className={`sp-pill ${user?.ai_enabled ? 'sp-pill--green' : ''}`}
                  >
                    {user?.ai_enabled
                      ? '已开启'
                      : !aiPlatformEnabled
                        ? '平台暂未启用'
                        : !aiTrialEligible
                          ? '试用暂未开放'
                          : '未开启'}
                  </span>
                  {user?.ai_enabled && (
                    <span className="sp-help">授权版本 v{user.ai_policy_version}</span>
                  )}
                </div>
                <span className="sp-help">
                  {!aiPlatformEnabled
                    ? '当前平台尚未启用 AI 服务，收藏内容仍会正常保存。'
                    : !aiTrialEligible && !user?.ai_enabled
                      ? '当前账号暂不在本批 AI 试用范围内，收藏与手动整理均不受影响。'
                      : '由平台统一管理模型、密钥与费用，无需个人配置模型或 API Key；可随时关闭，或在单条收藏详情页排除。'}
                </span>
              </div>
              {(user?.ai_enabled || (aiPlatformEnabled && aiTrialEligible)) && (
                <button
                  type="button"
                  className={`sp-btn sp-btn--sm ${user?.ai_enabled ? '' : 'sp-btn--primary'}`}
                  style={{ flexShrink: 0 }}
                  disabled={prefsMutation.isPending}
                  onClick={() => {
                    if (!user?.ai_enabled) setAiConsentOpen(true);
                    else prefsMutation.mutate({ ai_enabled: false });
                  }}
                >
                  {user?.ai_enabled ? '关闭 AI 整理' : '开启 AI 整理'}
                </button>
              )}
            </div>

            {isUsageUnavailable ? (
              <div className="sp-help">当日 AI 额度统计暂未开放</div>
            ) : usageQuery.isError ? (
              <div className="sp-help">{getFriendlyErrorMessage(usageQuery.error)}</div>
            ) : usageQuery.data ? (
              <div className="sp-stack" style={{ gap: 6 }}>
                <div className="sp-help" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  当日额度（{usageQuery.data.budget_day} · 北京时间）：已结算{' '}
                  {formatUnitsToYuan(usageQuery.data.settled_units)} / 预留{' '}
                  {formatUnitsToYuan(usageQuery.data.reserved_units)} / 上限{' '}
                  {formatUnitsToYuan(usageQuery.data.limit_units)}
                  {usageQuery.data.limit_units === 0 ? '（当前额度为 0）' : ''}
                </div>
                {usageQuery.data.limit_units === 0 ? (
                  <div className="sp-banner sp-banner--info" role="status">
                    <span>当前账号当日额度为 0（有效初始值），管理员分配预算前暂不发起计费整理；收藏仍可正常保存。</span>
                  </div>
                ) : (
                  usageQuery.data.blocked && (
                    <div className="sp-banner sp-banner--warning" role="status">
                      <span>今日 AI 额度已用完，新收藏仍会正常保存；额度次日恢复后可在详情页重试整理。</span>
                    </div>
                  )
                )}
              </div>
            ) : null}
          </div>
        </section>

        <section className="sp-card" aria-label="活跃设备会话">
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>活跃设备会话</h2>
          {isSessionsUnavailable ? (
            <p className="sp-help" style={{ margin: 0 }}>
              多设备会话管理暂未开放，将在后续里程碑接入。
            </p>
          ) : (
            <div>
              {(sessionsQuery.data?.items ?? []).map((sess) => (
                <div key={sess.id} className="sp-session-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="sp-row">
                      <span style={{ fontWeight: 500 }} title={sess.device_label}>
                        {formatDeviceLabel(sess.device_label)}
                      </span>
                      {sess.current && <span className="sp-pill sp-pill--green">当前设备</span>}
                    </div>
                    <div className="sp-help" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      到期于 {formatDateTime(sess.expires_at)}
                    </div>
                  </div>
                  {!sess.current && (
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm sp-btn--danger"
                      style={{ flexShrink: 0 }}
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(sess.id)}
                    >
                      撤销
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <AIConsentModal open={aiConsentOpen} onClose={() => setAiConsentOpen(false)} />
    </div>
  );
}
