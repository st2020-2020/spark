import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Attachment, Extraction, ExtractionList } from '../api/types';
import { ApiError } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { generateIdempotencyKey } from '../lib/idempotency';
import { Modal } from './Modal';

function retryError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'extraction_conflict':
      case 'image_retry_not_available': return '图片识别记录已更新，请刷新状态。';
      case 'image_consent_required': return '请先在设置中确认图片理解授权。';
      case 'image_analysis_unavailable':
      case 'integration_not_configured': return '图片理解暂未开放，原图仍可查看。';
      case 'ai_excluded': return '这条收藏已排除 AI 处理。';
      case 'quota_exceeded': return '今日图片识别额度不足，可在额度恢复后重试。';
      case 'not_found':
      case 'collection_in_trash': return '附件已移除或收藏已移入回收站，请刷新状态。';
      default:
        if (error.status >= 400 && error.status < 500) return error.message;
    }
  }
  return '尚未确认提交结果，可刷新状态后再试。';
}

export type ImageRetryKind = 'truncated' | 'quota' | 'legacy-format';

const confirmationNotes: Record<ImageRetryKind, string> = {
  truncated: '这次识别会使用平台图片理解额度。每张符合条件的图片可重新识别一次。',
  quota: '上次任务因额度不足在发送前暂停，未产生用量。确认后会将同一任务重新排队，发送时会使用平台图片理解额度。',
  'legacy-format': '上次识别的用量已结算。这条旧记录可按更新后的方式再识别一次，发送时会再次使用平台图片理解额度。',
};

export function ImageRetryAction({ collectionId, attachment, extraction, kind }: {
  collectionId: string;
  attachment: Attachment;
  extraction: Extraction;
  kind: ImageRetryKind;
}) {
  const api = useApi();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  // Retain the key only while the last submission's outcome is unknown.
  const submissionKey = useRef<string | null>(null);
  const submitting = useRef(false);
  const queryKey = ['collection-extractions', collectionId];

  const retry = useMutation({
    retry: false,
    networkMode: 'always',
    mutationFn: (key: string) => api.retryImageAnalysis(attachment.id, {
      base_extraction_id: extraction.id, consent_version: 'deepseek-image-retry-v1',
    }, key),
    onSuccess: async (accepted) => {
      submissionKey.current = null;
      await client.cancelQueries({ queryKey, exact: true });
      // A newer SSE snapshot can already contain the completed recovery.
      client.setQueryData<ExtractionList>(queryKey, old => old && ({
        ...old, items: old.items.map(item => item.id === extraction.id &&
          item.updated_at === extraction.updated_at && item.status === extraction.status ? accepted : item),
      }));
      await client.invalidateQueries({ queryKey, exact: true });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) submissionKey.current = null;
      if (error instanceof ApiError && [403, 404, 409, 422].includes(error.status)) {
        void client.invalidateQueries({ queryKey, exact: true });
        void client.invalidateQueries({ queryKey: ['collection', collectionId], exact: true });
        void client.invalidateQueries({ queryKey: ['me', 'image-analysis'], exact: true });
      }
    },
    onSettled: () => { submitting.current = false; },
  });

  function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setConfirming(false);
    submissionKey.current ??= generateIdempotencyKey();
    retry.mutate(submissionKey.current);
  }

  return (
    <div>
      <button type="button" className="sp-btn sp-btn--sm" disabled={retry.isPending}
        onClick={() => setConfirming(true)}>
        {retry.isPending ? '正在提交…' : kind === 'quota' ? '重新排队' : '重新识别这张图片'}
      </button>
      {retry.isError && <p className="sp-error-text" role="alert">{retryError(retry.error)}</p>}
      <Modal open={confirming} onClose={() => setConfirming(false)} title="重新识别这张图片">
        <div className="sp-stack">
          <p className="sp-break-anywhere">将把「{attachment.filename}」的视觉副本再次发送给 DeepSeek，识别图中文字和画面。</p>
          <p>{confirmationNotes[kind]}</p>
          <div className="sp-form-actions">
            <button type="button" className="sp-btn" data-dialog-autofocus onClick={() => setConfirming(false)}>取消</button>
            <button type="button" className="sp-btn sp-btn--primary" onClick={submit}>确认重新识别</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
