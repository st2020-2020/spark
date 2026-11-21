import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { Modal } from './Modal';

export const IMAGE_ANALYSIS_CONSENT_VERSION = 'deepseek-images-v1';

export function ImageAnalysisConsentModal({
  open,
  onClose,
  onEnabled,
}: {
  open: boolean;
  onClose: () => void;
  onEnabled?: () => void;
}) {
  const api = useApi();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const enableMutation = useMutation({
    mutationFn: () =>
      api.setImageAnalysisPreferences({
        enabled: true,
        consent_version: IMAGE_ANALYSIS_CONSENT_VERSION,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['me', 'image-analysis'], updated);
      void queryClient.invalidateQueries({ queryKey: ['me', 'usage'] });
      onClose();
      pushToast({ message: '已开启图片理解' });
      onEnabled?.();
    },
    onError: (err) => {
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
  });

  return (
    <Modal open={open} title="开启图片理解（DeepSeek）" onClose={onClose}>
      <div className="sp-stack sp-stack--loose">
        <p className="sp-consent-intro">
          开启后，你在保存或编辑绑定新图片时，未设置「不参与 AI 整理」的收藏图片将发送给第三方
          DeepSeek 服务进行理解，无需你填写 API Key 或选择模型。请确认以下说明：
        </p>
        <ul className="sp-consent-list">
          <li>
            <strong>发送给 DeepSeek 的数据范围：</strong>
            仅发送未排除单条的新确认图片，用于识别「图中文字」与生成「AI 画面描述」；不发送账号凭证或已设为不参与
            AI 整理的收藏。
          </li>
          <li>
            <strong>与文字 AI 授权互相独立：</strong>
            要将识别结果交给第三方文字模型生成项目建议，还需在「AI 自动整理」确认相应授权。你可随时单独关闭图片理解。
          </li>
          <li>
            <strong>原图保存不受影响：</strong>
            无论是否开启、随时撤回、单条排除或平台今日额度暂停，原图都会完整保存并可正常查看；开启前已保存的图片不会自动重跑。
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
