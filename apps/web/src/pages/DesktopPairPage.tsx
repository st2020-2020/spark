import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Laptop } from 'lucide-react';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { DevicePairFlow, type DevicePairApprovedState } from '../components/DevicePairFlow';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import {
  clearPendingDesktopPair,
  DESKTOP_DEVICE_LABEL,
  formatPairCode,
  loadPendingDesktopPair,
  parseDesktopPairFragment,
  savePendingDesktopPair,
  stripLocationHash,
  type PendingDesktopPair,
} from '../lib/devicePair';

const DESKTOP_PERMISSIONS = [
  '快速保存文字、网址与图片收藏，并上传和查看关联图片附件',
  '读取本人项目、标签列表并按关键词搜索与查看收藏详情',
  '不含账号设置、AI 授权、设备配对、永久删除、数据导出或管理功能；授权自生效起 30 天到期（无静默续期），可随时在设置中单独撤销',
] as const;

export function DesktopPairPage() {
  const api = useApi();
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();

  const [pair, setPair] = useState<PendingDesktopPair | null>(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : '';
    const parsed = parseDesktopPairFragment(rawHash);
    if (parsed) {
      savePendingDesktopPair(parsed);
      return parsed;
    }
    if (rawHash) {
      clearPendingDesktopPair();
      return null;
    }
    return loadPendingDesktopPair();
  });
  const [fragmentInvalid] = useState(() => {
    const rawHash = typeof window !== 'undefined' ? window.location.hash : '';
    return Boolean(rawHash) && !parseDesktopPairFragment(rawHash);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<DevicePairApprovedState | null>(null);

  useEffect(() => {
    stripLocationHash();
  }, []);

  const pairCode = pair ? formatPairCode(pair.challenge) : null;

  async function handleConfirm() {
    if (!user || !pair || !pairCode) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.approveDesktopGrant({
        challenge: pair.challenge,
        expected_account_id: user.id,
      });
      clearPendingDesktopPair();
      setPair(null);
      setApproved({
        accountEmail: user.email,
        deviceName: DESKTOP_DEVICE_LABEL,
        code: pairCode.grouped,
      });
    } catch (err) {
      if (
        isApiErrorCode(err, 'desktop_account_changed') ||
        isApiErrorCode(err, 'desktop_grant_conflict') ||
        isApiErrorCode(err, 'validation_failed')
      ) {
        clearPendingDesktopPair();
      }
      setError(getFriendlyErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    clearPendingDesktopPair();
    navigate('/inbox', { replace: true });
  }

  return (
    <DevicePairFlow
      isLoading={isLoading}
      fragmentInvalid={fragmentInvalid}
      hasPair={Boolean(pair)}
      pairCode={pairCode}
      user={user}
      approved={approved}
      returnPath="/desktop/pair"
      deviceName={DESKTOP_DEVICE_LABEL}
      deviceIcon={<Laptop size={15} strokeWidth={2} aria-hidden="true" />}
      sessionExpiryText="30 天（到期后需重新授权）"
      permissionsAriaLabel="macOS 桌面端操作权限说明"
      permissionsTitle="本次授予的权限与有效期"
      permissions={DESKTOP_PERMISSIONS}
      copy={{
        loadingTitle: '连接 macOS 桌面端',
        invalidTitle: '桌面配对请求无效',
        invalidBannerText:
          '请从 Spark macOS 桌面应用重新发起登录连接，再在系统浏览器打开授权页。',
        unauthTitle: '连接 macOS 桌面端',
        unauthSubtitle: `正在等待授权 ${DESKTOP_DEVICE_LABEL}`,
        approvedTitle: '已批准 macOS 桌面端连接',
        approvedSubtitle: '请返回 Spark 桌面应用完成连接',
        approvedNextStepText:
          '请切回 Spark macOS 桌面应用等待自动完成连接；该设备会话有效期为 30 天（到期需重新配对），你可以随时在设置中单独撤销。',
        confirmTitle: '确认绑定 macOS 桌面端',
        confirmSubtitle: '核对账号、比对码、权限与 30 天有效期后授权',
        confirmCodePrompt: '请核对与桌面端一致的比对码（大小写敏感）',
      }}
      submitting={submitting}
      error={error}
      onConfirm={() => void handleConfirm()}
      onCancel={handleCancel}
    />
  );
}
