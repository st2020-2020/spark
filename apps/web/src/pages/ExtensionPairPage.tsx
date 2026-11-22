import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Chrome, ShieldCheck } from 'lucide-react';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { AuthLayout } from '../components/AuthLayout';
import { LoadingState } from '../components/StateBlocks';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import {
  clearPendingExtensionPair,
  extensionDeviceDisplayName,
  formatPairCode,
  loadPendingExtensionPair,
  parseExtensionPairFragment,
  savePendingExtensionPair,
  stripLocationHash,
  type PendingExtensionPair,
} from '../lib/extensionPair';

export function ExtensionPairPage() {
  const api = useApi();
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  const [pair, setPair] = useState<PendingExtensionPair | null>(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : '';
    const parsed = parseExtensionPairFragment(rawHash);
    if (parsed) {
      savePendingExtensionPair(parsed);
      return parsed;
    }
    if (rawHash) {
      clearPendingExtensionPair();
      return null;
    }
    return loadPendingExtensionPair();
  });
  const [fragmentInvalid] = useState(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : '';
    return Boolean(rawHash) && !parseExtensionPairFragment(rawHash);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<{
    accountEmail: string;
    deviceName: string;
    code: string;
  } | null>(null);

  useEffect(() => {
    stripLocationHash();
  }, []);

  if (isLoading) {
    return (
      <AuthLayout title="连接浏览器扩展" subtitle="正在核对当前登录会话…" footer={null}>
        <LoadingState message="正在检查登录状态…" />
      </AuthLayout>
    );
  }

  if (fragmentInvalid || (!pair && !approved)) {
    return (
      <AuthLayout title="扩展配对请求无效" subtitle="未能读取有效的配对信息" footer={null}>
        <div className="sp-stack sp-stack--loose">
          <div className="sp-banner sp-banner--warning" role="alert">
            <span>
              请从 Chrome 或 Edge 浏览器右上角的 Spark 扩展弹窗重新点击「打开 Spark 授权页」。
            </span>
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

  if (!user && pair) {
    const code = formatPairCode(pair.challenge);
    return (
      <AuthLayout
        title="连接浏览器扩展"
        subtitle={`正在等待授权 ${extensionDeviceDisplayName(pair.browser)}`}
        footer={
          <span>
            授权后可随时在 <Link to="/login" state={{ from: '/extension/pair' }}>登录</Link> 后的设置中撤销
          </span>
        }
      >
        <div className="sp-stack sp-stack--loose">
          <div className="sp-ext-pair-summary">
            <span className="sp-help">当前配对码（大小写敏感）</span>
            <div className="sp-ext-pair-code">{code.grouped}</div>
          </div>
          <p className="sp-help">
            请先登录你要绑定的 Spark 账号，登录成功后将回到此页核对账号并完成授权。
          </p>
          <div className="sp-row">
            <Link
              to="/login"
              state={{ from: '/extension/pair' }}
              className="sp-btn sp-btn--primary"
            >
              登录 Spark 并继续授权
            </Link>
            <Link
              to="/register"
              state={{ from: '/extension/pair' }}
              className="sp-btn"
            >
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
        title="已批准扩展连接"
        subtitle="请回到浏览器扩展完成连接"
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
              <strong>已允许 {approved.deviceName} 连接至 {approved.accountEmail}</strong>
            </span>
          </div>
          <div className="sp-ext-pair-summary">
            <span className="sp-help">配对码（5 分钟内有效）</span>
            <div className="sp-ext-pair-code">{approved.code}</div>
          </div>
          <p className="sp-help">
            接下来请点击浏览器工具栏上的 Spark 扩展图标，在扩展弹窗中点击「我已确认，完成连接」。你可以随时在设置中撤销此设备。
          </p>
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
  const activePair = pair!;
  const pairCode = formatPairCode(activePair.challenge);
  const deviceName = extensionDeviceDisplayName(activePair.browser);

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      await api.approveExtensionGrant({
        challenge: activePair.challenge,
        browser: activePair.browser,
        expected_account_id: activeUser.id,
      });
      clearPendingExtensionPair();
      setPair(null);
      setApproved({
        accountEmail: activeUser.email,
        deviceName,
        code: pairCode.grouped,
      });
    } catch (err) {
      if (
        isApiErrorCode(err, 'extension_account_changed') ||
        isApiErrorCode(err, 'extension_grant_conflict') ||
        isApiErrorCode(err, 'validation_failed')
      ) {
        clearPendingExtensionPair();
      }
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    clearPendingExtensionPair();
    navigate('/inbox', { replace: true });
  }

  return (
    <AuthLayout
      title="确认绑定浏览器扩展"
      subtitle="核对账号、设备与固定权限后授权"
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
              <Chrome size={15} strokeWidth={2} aria-hidden="true" />
              <strong>{deviceName}</strong>
            </span>
          </div>
        </div>

        <div className="sp-ext-pair-summary">
          <span className="sp-help">请核对与扩展弹窗一致的配对码（大小写敏感）</span>
          <div className="sp-ext-pair-code">{pairCode.grouped}</div>
        </div>

        <div className="sp-ext-perm-box" aria-label="扩展操作权限说明">
          <div className="sp-row">
            <ShieldCheck size={16} strokeWidth={2} aria-hidden="true" />
            <strong className="sp-label">本次授予的最小权限</strong>
          </div>
          <ul className="sp-ext-perm-list">
            <li>读取本人进行中的项目列表（仅项目 ID 与名称）</li>
            <li>保存网页标题、HTTP(S) 网址、纯文本选区与用途说明到你的空间</li>
            <li>不读取现有收藏、回收站、导出或管理员能力，可随时在设置中单独撤销</li>
          </ul>
        </div>

        <div className="sp-ext-pair-actions">
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            disabled={submitting}
            onClick={() => void handleConfirm()}
          >
            {submitting ? '正在确认…' : '确认授权绑定'}
          </button>
          <button type="button" className="sp-btn" disabled={submitting} onClick={handleCancel}>
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
