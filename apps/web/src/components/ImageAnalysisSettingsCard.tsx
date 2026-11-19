import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFriendlyErrorMessage } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { useToast } from '../context/ToastContext';
import { IMAGE_ANALYSIS_CONSENT_VERSION, ImageAnalysisConsentModal } from './ImageAnalysisConsentModal';

export function ImageAnalysisSettingsCard() {
  const api = useApi();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [consentOpen, setConsentOpen] = useState(false);

  const prefsQuery = useQuery({
    queryKey: ['me', 'image-analysis'],
    queryFn: () => api.getImageAnalysisPreferences(),
  });

  const usageQuery = useQuery({
    queryKey: ['me', 'usage'],
    queryFn: () => api.getUsage(),
  });

  const disableMutation = useMutation({
    mutationFn: () => api.setImageAnalysisPreferences({ enabled: false }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['me', 'image-analysis'], updated);
      pushToast({ message: '已关闭图片理解（原图保存与浏览不受影响）' });
    },
    onError: (err) => {
      pushToast({ message: getFriendlyErrorMessage(err), tone: 'error' });
    },
  });

  const prefs = prefsQuery.data;
  const usage = usageQuery.data;
  const isAvailable = Boolean(prefs?.available);
  const isEnabled = Boolean(prefs?.enabled);
  const canEnable = isAvailable && !isEnabled && prefs?.required_consent_version === IMAGE_ANALYSIS_CONSENT_VERSION;
  const isQuotaPaused = Boolean(usage && (usage.blocked || usage.limit_units <= 0));

  return (
    <>
      <section className="sp-card" aria-label="图片理解（DeepSeek）">
        <h2 className="sp-card-title">图片理解（DeepSeek）</h2>
        <div className="sp-stack">
          <div className="sp-setting-row">
            <div className="sp-setting-row-main">
              <div className="sp-strong">识别图中文字与 AI 画面描述</div>
              <div className="sp-help">
                {prefsQuery.isLoading && '正在读取图片理解授权状态…'}
                {prefsQuery.isError && getFriendlyErrorMessage(prefsQuery.error)}
                {prefs && !isAvailable && (
                  '当前平台暂未启用图片理解服务，已保存图片仍会完整保存原图并支持查看。'
                )}
                {prefs && isAvailable && isEnabled && (
                  <>
                    已开启。新确认绑定的非排除图片将发送至第三方
                    DeepSeek 识别「图中文字」与「AI 画面描述」，无需自行填写 Key；可随时撤回授权。
                  </>
                )}
                {isAvailable && !isEnabled && !canEnable && (
                  '图片授权说明已更新，请刷新至最新版本后查看并开启。'
                )}
                {canEnable && (
                  '未开启（默认不向第三方 DeepSeek 发送图片；开启文字「AI 自动整理」不会自动视为同意图片理解；原图照常保存）'
                )}
              </div>
            </div>

            {(isEnabled || canEnable) && (
              <button
                type="button"
                className={isEnabled ? 'sp-btn sp-btn--danger' : 'sp-btn sp-btn--primary'}
                disabled={disableMutation.isPending}
                onClick={() => {
                  if (isEnabled) {
                    disableMutation.mutate();
                  } else {
                    setConsentOpen(true);
                  }
                }}
              >
                {disableMutation.isPending
                  ? '保存中…'
                  : isEnabled
                    ? '关闭图片理解'
                    : '开启图片理解'}
              </button>
            )}
          </div>

          {prefs && isAvailable && isEnabled && isQuotaPaused && (
            <div className="sp-banner sp-banner--warning" role="status">
              <span>今日 AI 额度不足或已暂停，新保存图片将跳过远程识别，原图仍完整保存并可浏览。</span>
            </div>
          )}
        </div>
      </section>

      {canEnable && (
        <ImageAnalysisConsentModal open={consentOpen} onClose={() => setConsentOpen(false)} />
      )}
    </>
  );
}
