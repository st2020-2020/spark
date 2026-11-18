import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { ApiError, getFriendlyErrorMessage } from '../api/errors';
import { Modal } from '../components/Modal';
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
  const { user, setUser, logout } = useAuth();
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

        <section className="sp-card" aria-label="活跃会话与自动整理">
          <h2 style={{ margin: '0 0 12px', fontSize: 15 }}>登录会话与 AI 整理</h2>

          {isSessionsUnavailable && isUsageUnavailable ? (
            <p className="sp-help" style={{ margin: 0 }}>
              多设备会话管理与 AI 自动整理额度暂未开放，将在后续里程碑接入。
            </p>
          ) : (
            <div className="sp-stack" style={{ gap: 14 }}>
              <div>
                <div className="sp-label" style={{ marginBottom: 6 }}>AI 自动整理</div>
                {isUsageUnavailable ? (
                  <p className="sp-help" style={{ margin: 0 }}>暂未开放</p>
                ) : (
                  <div className="sp-stack" style={{ gap: 8 }}>
                    <div className="sp-row-between">
                      <span className="sp-help">
                        {user?.ai_enabled ? '当前已启用' : '当前未启用'}
                      </span>
                      <button
                        type="button"
                        className={`sp-btn sp-btn--sm ${user?.ai_enabled ? '' : 'sp-btn--primary'}`}
                        disabled={prefsMutation.isPending}
                        onClick={() => {
                          if (!user?.ai_enabled) setAiConsentOpen(true);
                          else prefsMutation.mutate({ ai_enabled: false });
                        }}
                      >
                        {user?.ai_enabled ? '关闭 AI 整理' : '启用 AI 整理'}
                      </button>
                    </div>
                    {usageQuery.data && (
                      <div className="sp-help">
                        {usageQuery.data.budget_day} · 已结算{' '}
                        {formatUnitsToYuan(usageQuery.data.settled_units)} / 上限{' '}
                        {formatUnitsToYuan(usageQuery.data.limit_units)}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={{ borderTop: '1px solid var(--sp-border)', paddingTop: 12 }}>
                <div className="sp-label" style={{ marginBottom: 6 }}>活跃设备会话</div>
                {isSessionsUnavailable ? (
                  <p className="sp-help" style={{ margin: 0 }}>暂未开放</p>
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
              </div>
            </div>
          )}
        </section>
      </div>

      <Modal open={aiConsentOpen} title="开启 AI 自动整理" onClose={() => setAiConsentOpen(false)}>
        <div className="sp-stack" style={{ gap: 14 }}>
          <p style={{ margin: 0 }}>
            启用后，Spark 会在你保存新收藏时，将文字、网址与用途说明发送给服务端配置的模型服务以生成标题、摘要与项目关联建议。
          </p>
          <div className="sp-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="sp-btn" onClick={() => setAiConsentOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="sp-btn sp-btn--primary"
              disabled={prefsMutation.isPending}
              onClick={() => prefsMutation.mutate({ ai_enabled: true, consent_version: 'v1' })}
            >
              我已了解并开启
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
