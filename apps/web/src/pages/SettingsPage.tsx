import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { ApiError, getFriendlyErrorMessage } from '../api/errors';
import {
  AIConsentModal,
  SPARK_AI_CONSENT_VERSION,
  allowsImageFiling,
  allowsWebArchive,
} from '../components/AIConsentModal';
import { ImageAnalysisSettingsCard } from '../components/ImageAnalysisSettingsCard';
import { ResurfaceSetting } from '../components/Resurface';
import { DataExport } from '../components/DataExport';
import { PageHeader } from '../components/PageHeader';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  PALETTES,
  type PaletteId,
  type ThemePref,
} from '../lib/appearance';
import { isExtensionDeviceLabel } from '../lib/extensionPair';
import { formatDateTime, formatDeviceLabel, formatUnitsToYuan } from '../lib/format';

export function SettingsPage() {
  const api = useApi();
  const { user, applyAiPreferences, logout, saveAppearance, appearancePending, aiTrialEligible, aiPlatformEnabled } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const themePref = user?.theme ?? 'system';
  const palette = user?.palette ?? 'mint';
  function chooseAppearance(patch: { palette?: PaletteId; theme?: ThemePref }) {
    void saveAppearance(patch).catch(error => pushToast({ message: getFriendlyErrorMessage(error), tone: 'error' }));
  }
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
      applyAiPreferences(updatedUser);
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

      <div className="sp-stack sp-stack--loose">
        <section className="sp-card" aria-label="账号信息">
          <h2 className="sp-card-title">账号</h2>
          <div className="sp-row-between">
            <div className="sp-setting-row-main">
              <span className="sp-strong sp-break-anywhere">{user?.email}</span>
              <span className="sp-help">{user?.role === 'admin' ? '管理员' : '个人用户'}</span>
            </div>
            <button type="button" className="sp-btn" onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </section>

        <section className="sp-card" aria-label="键盘快捷键">
          <h2 className="sp-card-title">键盘快捷键</h2>
          <p><kbd>J</kbd> / <kbd>K</kbd> 选择下一条或上一条收藏。纸条获得焦点后，<kbd>Enter</kbd> 打开，<kbd>E</kbd> 编辑，<kbd>R</kbd> 切换已读。</p>
          <p><kbd>N</kbd> 记一条，<kbd>⌘/Ctrl K</kbd> 打开命令面板。编辑正文时用 <kbd>#</kbd> 选标签，<kbd>@</kbd> 选项目。</p>
        </section>
        <ResurfaceSetting />

        <section className="sp-card" aria-label="界面外观">
          <h2 className="sp-card-title">主题配色</h2>
          <div className="sp-palette-grid" role="group" aria-label="选择主题配色">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                className="sp-palette-option"
                aria-pressed={palette === p.id}
                disabled={appearancePending}
                onClick={() => chooseAppearance({ palette: p.id })}
              >
                <span className="sp-palette-swatches" aria-hidden="true">
                  {p.swatches.map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </span>
                <span className="sp-palette-name">{p.label}</span>
                <span className="sp-palette-hint">{p.hint}</span>
              </button>
            ))}
          </div>

          <h3 className="sp-card-subtitle">明暗模式</h3>
          <div className="sp-segmented" role="group" aria-label="选择明暗模式">
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
                disabled={appearancePending}
                onClick={() => chooseAppearance({ theme: pref })}
              >
                <Icon size={15} strokeWidth={2} aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <ImageAnalysisSettingsCard />

        <section className="sp-card" aria-label="平台 AI 自动整理">
          <h2 className="sp-card-title">AI 自动整理</h2>
          <div className="sp-stack">
            <div className="sp-setting-row">
              <div className="sp-setting-row-main">
                <div className="sp-row">
                  <span className={`sp-pill ${user?.ai_enabled ? 'sp-pill--success' : ''}`}>
                    {user?.ai_enabled
                      ? '已开启'
                      : !aiPlatformEnabled
                        ? '平台暂未启用'
                        : !aiTrialEligible
                          ? '试用暂未开放'
                          : '未开启'}
                  </span>
                  {user?.ai_enabled && (
                    <span className="sp-help">
                      {allowsWebArchive(user.ai_consent_version)
                        ? '已授权网页收藏归类、图片自动归类和自动创建标签'
                        : user.ai_consent_version === 'spark-ai-image-notes-v2'
                          ? '已授权图片自动归类和自动创建标签。更新整理授权后可启用网页收藏归类。'
                          : allowsImageFiling(user.ai_consent_version)
                            ? '已授权图片自动归类。更新整理授权后可自动创建标签与网页收藏归类。'
                            : user.ai_consent_version === 'spark-ai-image-material-v1'
                              ? '已授权图片材料生成项目建议'
                              : '现有文字整理授权'}
                    </span>
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
              {user?.ai_enabled && aiPlatformEnabled && aiTrialEligible && (
                <button type="button" className="sp-btn sp-btn--sm" onClick={() => setAiConsentOpen(true)}>
                  {user.ai_consent_version === SPARK_AI_CONSENT_VERSION ? '查看整理授权' : '更新整理授权'}
                </button>
              )}
              {(user?.ai_enabled || (aiPlatformEnabled && aiTrialEligible)) && (
                <button
                  type="button"
                  className={`sp-btn sp-btn--sm ${user?.ai_enabled ? '' : 'sp-btn--primary'}`}
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
              <div className="sp-stack sp-stack--tight">
                <div className="sp-help sp-tabular">
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

        <DataExport key={user?.id} />

        <section className="sp-card" aria-label="活跃设备会话">
          <h2 className="sp-card-title">活跃设备会话</h2>
          <p className="sp-help">
            撤销浏览器扩展会话会立即使其凭据失效；重设密码会同时撤销所有网页与扩展设备。
          </p>
          {isSessionsUnavailable ? (
            <p className="sp-help">多设备会话管理暂未开放，将在后续里程碑接入。</p>
          ) : (
            <div>
              {(sessionsQuery.data?.items ?? []).map((sess) => {
                const isExtension = isExtensionDeviceLabel(sess.device_label);
                return (
                  <div key={sess.id} className="sp-session-row">
                    <div className="sp-setting-row-main">
                      <div className="sp-row">
                        <span className="sp-strong" title={sess.device_label}>
                          {formatDeviceLabel(sess.device_label)}
                        </span>
                        {isExtension && <span className="sp-pill">浏览器扩展</span>}
                        {sess.current && <span className="sp-pill sp-pill--green">当前设备</span>}
                      </div>
                      <div className="sp-help sp-tabular">
                        创建于 {formatDateTime(sess.created_at)} · 到期于 {formatDateTime(sess.expires_at)}
                      </div>
                    </div>
                    {!sess.current && (
                      <button
                        type="button"
                        className="sp-btn sp-btn--sm sp-btn--danger"
                        disabled={revokeMutation.isPending}
                        onClick={() => revokeMutation.mutate(sess.id)}
                      >
                        撤销
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <AIConsentModal open={aiConsentOpen} onClose={() => setAiConsentOpen(false)} />
    </div>
  );
}
