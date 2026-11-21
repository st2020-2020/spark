import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Modal } from './Modal';

export const SPARK_AI_CONSENT_VERSION = 'spark-ai-tags-v1';

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
  const { applyAiPreferences } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const enableMutation = useMutation({
    mutationFn: () =>
      api.updatePreferences({
        ai_enabled: true,
        consent_version: SPARK_AI_CONSENT_VERSION,
      }),
    onSuccess: (updatedUser) => {
      applyAiPreferences(updatedUser);
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['me', 'usage'] });
      pushToast({ message: '已开启 AI 自动整理' });
      onEnabled?.();
    },
    onError: (err) => {
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
  });

  return (
    <Modal open={open} title="开启平台 AI 自动整理" onClose={onClose}>
      <div className="sp-stack sp-stack--loose">
        <p className="sp-consent-intro">
          开启后，你在保存新收藏时将自动进入后台整理队列，无需自行配置模型或密钥。请确认以下处理范围：
        </p>
        <ul className="sp-consent-list">
          <li>
            <strong>发送资料范围：</strong>
            发送本条正文和用途说明，以及用于匹配的项目资料。正文或用途中出现已有标签名称时，也会发送相应标签的名称和标识。已排除的收藏不会发送。
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
            取消
          </button>
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            disabled={enableMutation.isPending}
            onClick={() => enableMutation.mutate()}
          >
            {enableMutation.isPending ? '保存中…' : '我已了解并开启'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
