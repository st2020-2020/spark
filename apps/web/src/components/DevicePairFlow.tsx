import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import type { User } from '../api/types';
import { AuthLayout } from './AuthLayout';
import { LoadingState } from './StateBlocks';

export interface DevicePairApprovedState {
  accountEmail: string;
  deviceName: string;
  code: string;
}

export interface DevicePairFlowCopy {
  loadingTitle: string;
  invalidTitle: string;
  invalidBannerText: string;
  unauthTitle: string;
  unauthSubtitle: string;
  approvedTitle: string;
  approvedSubtitle: string;
  approvedNextStepText: string;
  confirmTitle: string;
  confirmSubtitle: string;
  confirmCodePrompt: string;
}

export function DevicePairFlow({
  isLoading,
  fragmentInvalid,
  hasPair,
  pairCode,
  user,
  approved,
  returnPath,
  deviceName,
  deviceIcon,
  sessionExpiryText,
  permissionsAriaLabel,
  permissionsTitle,
  permissions,
  copy,
  submitting,
  error,
  onConfirm,
  onCancel,
}: {
  isLoading: boolean;
  fragmentInvalid: boolean;
  hasPair: boolean;
  pairCode: { raw: string; grouped: string } | null;
  user: User | null;
  approved: DevicePairApprovedState | null;
  returnPath: string;
  deviceName: string;
  deviceIcon: ReactNode;
  sessionExpiryText?: string;
  permissionsAriaLabel: string;
  permissionsTitle: string;
  permissions: readonly string[];
  copy: DevicePairFlowCopy;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (isLoading) {
    return (
      <AuthLayout title={copy.loadingTitle} subtitle="正在核对当前登录会话…" footer={null}>
        <LoadingState message="正在检查登录状态…" />
      </AuthLayout>
    );
  }

  if (fragmentInvalid || (!hasPair && !approved)) {
    return (
      <AuthLayout title={copy.invalidTitle} subtitle="未能读取有效的配对信息" footer={null}>
        <div className="sp-stack sp-stack--loose">
          <div className="sp-banner sp-banner--warning" role="alert">
            <span>{copy.invalidBannerText}</span>
          </div>
          <div className="sp-row">
            <Link to={user ? '/settings' : '/login'} className="sp-btn sp-btn--primary">
              {user ? '前往设备设置' : '前往登录'}
            </Link>
            {user && (
              <Link to="/inbox" className="sp-btn">
                返回收件箱
              </Link>
            )}
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (!user && hasPair && pairCode) {
    return (
      <AuthLayout
        title={copy.unauthTitle}
        subtitle={copy.unauthSubtitle}
        footer={
          <span>
            授权后可随时在{' '}
            <Link to="/login" state={{ from: returnPath }}>
              登录
            </Link>{' '}
            后的设置中撤销
          </span>
        }
      >
        <div className="sp-stack sp-stack--loose">
          <div className="sp-ext-pair-summary">
            <span className="sp-help">当前配对码（大小写敏感）</span>
            <div className="sp-ext-pair-code">{pairCode.grouped}</div>
          </div>
          <p className="sp-help">
            请先登录你要绑定的 Spark 账号，登录成功后将回到此页核对账号并完成授权。
          </p>
          <div className="sp-row">
            <Link
              to="/login"
              state={{ from: returnPath }}
              className="sp-btn sp-btn--primary"
            >
              登录 Spark 并继续授权
            </Link>
            <Link to="/register" state={{ from: returnPath }} className="sp-btn">
              使用邀请码注册
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  if (approved) {
    return (
      <AuthLayout
        title={copy.approvedTitle}
        subtitle={copy.approvedSubtitle}
        footer={
          <span>
            如需切换账号，可前往 <Link to="/settings">设备与会话管理</Link>
          </span>
        }
      >
        <div className="sp-stack sp-stack--loose">
          <div className="sp-banner sp-banner--success" role="status">
            <span className="sp-row">
              <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
              <strong>
                已允许 {approved.deviceName} 连接至 {approved.accountEmail}
              </strong>
            </span>
          </div>
          <div className="sp-ext-pair-summary">
            <span className="sp-help">配对码（5 分钟内有效）</span>
            <div className="sp-ext-pair-code">{approved.code}</div>
          </div>
          <p className="sp-help">{copy.approvedNextStepText}</p>
          <div className="sp-row">
            <Link to="/settings" className="sp-btn sp-btn--primary">
              查看与管理已绑定设备
            </Link>
            <Link to="/inbox" className="sp-btn">
              返回收件箱
            </Link>
          </div>
        </div>
      </AuthLayout>
    );
  }

  const activeUser = user!;
  const code = pairCode!;

  return (
    <AuthLayout
      title={copy.confirmTitle}
      subtitle={copy.confirmSubtitle}
      footer={
        <div className="sp-row-between">
          <Link to="/settings">查看活跃设备会话</Link>
          <Link to="/inbox">返回收件箱</Link>
        </div>
      }
    >
      <div className="sp-stack sp-stack--loose">
        {error && (
          <div className="sp-banner sp-banner--error" role="alert">
            <span>{error}</span>
          </div>
        )}

        <div className="sp-ext-pair-meta">
          <div className="sp-row-between">
            <span className="sp-help">当前登录账号</span>
            <strong className="sp-break-anywhere">{activeUser.email}</strong>
          </div>
          <div className="sp-row-between">
            <span className="sp-help">目标设备</span>
            <span className="sp-row">
              {deviceIcon}
              <strong>{deviceName}</strong>
            </span>
          </div>
          {sessionExpiryText && (
            <div className="sp-row-between">
              <span className="sp-help">会话有效期</span>
              <strong>{sessionExpiryText}</strong>
            </div>
          )}
        </div>

        <div className="sp-ext-pair-summary">
          <span className="sp-help">{copy.confirmCodePrompt}</span>
          <div className="sp-ext-pair-code">{code.grouped}</div>
        </div>

        <div className="sp-ext-perm-box" aria-label={permissionsAriaLabel}>
          <div className="sp-row">
            <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" />
            <strong className="sp-label">{permissionsTitle}</strong>
          </div>
          <ul className="sp-ext-perm-list">
            {permissions.map((perm) => (
              <li key={perm}>{perm}</li>
            ))}
          </ul>
        </div>

        <div className="sp-ext-pair-actions">
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? '正在确认…' : '确认授权绑定'}
          </button>
          <button type="button" className="sp-btn" disabled={submitting} onClick={onCancel}>
            取消
          </button>
        </div>

        <div className="sp-row-between">
          <Link to="/settings" className="sp-help">
            查看活跃设备会话
          </Link>
          <Link to="/inbox" className="sp-help">
            返回收件箱
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
}
