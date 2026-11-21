import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Modal } from './Modal';

export const SPARK_AI_CONSENT_VERSION = 'spark-ai-image-material-v1';

export function AIConsentModal({
  open,
  onClose,
  onEnabled,
}: {
  open: boolean;
  onClose: () => void;
  onEnabled?: () => void;
}) {
  const api = useApi();
  const { user, applyAiPreferences } = useAuth();
  const alreadyEnabled = Boolean(user?.ai_enabled);
  const currentConsent = alreadyEnabled && user?.ai_consent_version === SPARK_AI_CONSENT_VERSION;
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const enableMutation = useMutation({
    mutationFn: async () => {
      const updated = await api.updatePreferences({ ai_enabled: true, consent_version: SPARK_AI_CONSENT_VERSION });
      if (!updated.ai_enabled || updated.ai_consent_version !== SPARK_AI_CONSENT_VERSION) {
        throw new Error('服务器尚未确认本次整理授权，请稍后重试。');
      }
      return updated;
    },
    onSuccess: (updatedUser) => {
      applyAiPreferences(updatedUser);
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['me', 'usage'] });
      pushToast({ message: alreadyEnabled ? '已更新文字整理授权' : '已开启 AI 自动整理' });
      onEnabled?.();
    },
    onError: (err) => {
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
  });

  return (
    <Modal open={open} title={currentConsent ? '当前文字整理授权' : alreadyEnabled ? '更新文字整理授权' : '开启平台 AI 自动整理'} onClose={onClose}>
      <div className="sp-stack sp-stack--loose">
        <p className="sp-consent-intro">
          新收藏可由平台文字模型整理。以下说明列出会发送的资料、用途和服务方。
        </p>
        <ul className="sp-consent-list">
          <li>
            <strong>发送资料范围：</strong>
            发送本条正文、用途说明和用于匹配的项目资料，以及匹配到的已有标签名称和标识。已排除的收藏不会发送。
          </li>
          <li>
            <strong>图片识别结果：</strong>
            同时开启图片理解时，第三方文字模型还可使用这条收藏已识别的图中文字和 AI 画面描述生成项目建议。文字模型不会收到原图。发送原图给 DeepSeek 识别需要单独开启图片理解。
          </li>
          <li>
            <strong>处理用途：</strong>
            生成标题、摘要和至多一条带依据的项目建议，项目由你确认。模型也可从匹配的已有标签中选择并自动打标，保留你的人工决定。
          </li>
          <li>
            <strong>第三方服务范围：</strong>
            由 Spark 平台统一采购并托管的第三方文本模型服务处理，普通用户无需申请 API Key 或切换模型。
          </li>
          <li>
            <strong>历史收藏说明：</strong>
            开启仅对后续新保存的收藏生效，不会自动重跑全部历史收藏；旧资料可在详情页按需点击「重新整理」。
          </li>
        </ul>
        <div className="sp-form-actions">
          <button type="button" className="sp-btn" onClick={onClose}>
            {currentConsent ? '关闭' : '取消'}
          </button>
          {!currentConsent && <button
            type="button"
            className="sp-btn sp-btn--primary"
            disabled={enableMutation.isPending}
            onClick={() => enableMutation.mutate()}
          >
            {enableMutation.isPending ? '保存中…' : alreadyEnabled ? '确认更新授权' : '我已了解并开启'}
          </button>}
        </div>
      </div>
    </Modal>
  );
}
