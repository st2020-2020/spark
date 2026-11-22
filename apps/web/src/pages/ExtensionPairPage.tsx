import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Chrome } from 'lucide-react';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { DevicePairFlow, type DevicePairApprovedState } from '../components/DevicePairFlow';
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
} from '../lib/devicePair';

const EXTENSION_PERMISSIONS = [
  '读取本人进行中的项目列表（仅项目 ID 与名称）',
  '保存网页标题、HTTP(S) 网址、纯文本选区与用途说明到你的空间',
  '不读取现有收藏、回收站、导出或管理员能力，可随时在设置中单独撤销',
] as const;

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
  const [approved, setApproved] = useState<DevicePairApprovedState | null>(null);

  useEffect(() => {
    stripLocationHash();
  }, []);

  const deviceName = pair ? extensionDeviceDisplayName(pair.browser) : 'Spark 浏览器扩展';
  const pairCode = pair ? formatPairCode(pair.challenge) : null;

  async function handleConfirm() {
    if (!user || !pair || !pairCode) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.approveExtensionGrant({
        challenge: pair.challenge,
        browser: pair.browser,
        expected_account_id: user.id,
      });
      clearPendingExtensionPair();
      setPair(null);
      setApproved({
        accountEmail: user.email,
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
    <DevicePairFlow
      isLoading={isLoading}
      fragmentInvalid={fragmentInvalid}
      hasPair={Boolean(pair)}
      pairCode={pairCode}
      user={user}
      approved={approved}
      returnPath="/extension/pair"
      deviceName={deviceName}
      deviceIcon={<Chrome size={15} strokeWidth={2} aria-hidden="true" />}
      permissionsAriaLabel="扩展操作权限说明"
      permissionsTitle="本次授予的最小权限"
      permissions={EXTENSION_PERMISSIONS}
      copy={{
        loadingTitle: '连接浏览器扩展',
        invalidTitle: '扩展配对请求无效',
        invalidBannerText:
          '请从 Chrome 或 Edge 浏览器右上角的 Spark 扩展弹窗重新点击「打开 Spark 授权页」。',
        unauthTitle: '连接浏览器扩展',
        unauthSubtitle: `正在等待授权 ${deviceName}`,
        approvedTitle: '已批准扩展连接',
        approvedSubtitle: '请回到浏览器扩展完成连接',
        approvedNextStepText:
          '接下来请点击浏览器工具栏上的 Spark 扩展图标，在扩展弹窗中点击「我已确认，完成连接」。你可以随时在设置中撤销此设备。',
        confirmTitle: '确认绑定浏览器扩展',
        confirmSubtitle: '核对账号、设备与固定权限后授权',
        confirmCodePrompt: '请核对与扩展弹窗一致的配对码（大小写敏感）',
      }}
      submitting={submitting}
      error={error}
      onConfirm={() => void handleConfirm()}
      onCancel={handleCancel}
    />
  );
}
