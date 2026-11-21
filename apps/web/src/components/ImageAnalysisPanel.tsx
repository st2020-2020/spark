import { ImageRetryAction, type ImageRetryKind } from './ImageRetryAction';
import { IMAGE_ANALYSIS_CONSENT_VERSION } from './ImageAnalysisConsentModal';
import { Link } from 'react-router-dom';
import { Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react';
import type { Attachment, Extraction, ImageAnalysisPreferences } from '../api/types';

function hasUsableImageResult(ext: Extraction) {
  return ext.status === 'succeeded' || ext.status === 'partial';
}

function hasImageContent(ext: Extraction) {
  return Boolean(ext.text?.trim() || ext.image_description?.trim());
}

function isTruncatedResult(ext: Extraction) {
  return (ext.status === 'failed' && ext.error_code === 'image_output_truncated_empty') ||
    (hasUsableImageResult(ext) &&
      (ext.truncated || ext.error_code === 'image_output_truncated'));
}

function imageRetryKind(ext: Extraction): ImageRetryKind | undefined {
  if (ext.image_retry_available !== true || hasImageContent(ext)) return;
  if (ext.status === 'failed' && ext.error_code === 'invalid_model_output') return 'legacy-format';
  if (ext.status === 'blocked' && ext.error_code === 'quota_exceeded') return 'quota';
  if (isTruncatedResult(ext)) return 'truncated';
}

function imageFailureNote(code?: string): string {
  switch (code) {
    case 'invalid_model_output': return '无法解析上次的识别结果，原图仍可查看。';
    case 'image_provider_empty_output': return '图片识别服务返回了空内容。';
    case 'image_provider_content_filtered': return '图片识别服务进行了内容过滤，本次没有可展示的结果。';
    case 'image_provider_interrupted': return '图片识别服务的生成中断，本次未取得完整结果。';
    case 'image_response_read_failed': return '读取图片识别服务的响应时出错。';
    case 'image_response_invalid': return '图片识别服务的响应格式无法解析。';
    case 'image_provider_content_invalid': return '服务返回的识别内容格式有误，无法提取文字或画面描述。';
    case 'image_provider_choice_invalid': return '图片识别服务返回的结果结构无法使用。';
    case 'image_provider_finish_invalid': return '图片识别服务返回的结束状态无法确认。';
    case 'usage_uncertain': return '本次识别用量待核对，原图仍可查看。';
    case 'image_unavailable': return '识别服务未能取得可处理的图片。';
    case 'provider_unavailable': return '本次未能连接到图片识别服务或接收其响应。';
    case 'provider_request_failed': return '图片识别服务未成功处理这次请求。';
    case 'image_token_limit': return '本次识别超出平台的用量限制。';
    default: return '本次没有可展示的识别结果，原图仍可查看。';
  }
}

function resolveImageStatusDisplay(ext: Extraction): {
  label: string;
  pillClass: string;
  note?: string;
} {
  if (isTruncatedResult(ext)) {
    const hasContent = hasImageContent(ext);
    return {
      label: hasContent ? '识别摘录（已截断）' : '输出已截断',
      pillClass: 'sp-pill sp-pill--warning',
      note: [!hasContent && '本次没有可展示的识别摘录，原图仍可查看。',
        ext.error_code === 'usage_uncertain' && '本次用量待核对。'].filter(Boolean).join(''),
    };
  }
  switch (ext.status) {
    case 'queued':
    case 'running':
      return {
        label: '正在分析图片',
        pillClass: 'sp-pill',
        note: '系统正在识别图中文字与画面内容，可在此查看最新状态。',
      };
    case 'succeeded':
      return {
        label: hasImageContent(ext) ? '已识别' : '识别完成',
        note: hasImageContent(ext) ? undefined : '未提取到文字或画面描述，原图仍可查看。',
        pillClass: 'sp-pill sp-pill--green',
      };
    case 'partial':
      return {
        label: hasImageContent(ext) ? '部分识别' : '暂无识别摘录',
        note: ext.error_code === 'usage_uncertain' ? '本次用量待核对。' : undefined,
        pillClass: 'sp-pill sp-pill--warning',
      };
    case 'blocked':
      return {
        label: ext.error_code === 'quota_exceeded' ? '今日 AI 额度已暂停' : '暂未执行',
        pillClass: 'sp-pill sp-pill--warning',
        note: ext.error_code === 'quota_exceeded' ? '今日 AI 额度不足或未分配，原图仍可查看。' : '图片识别暂时受阻，原图仍可查看。',
      };
    case 'skipped':
      return {
        label: '已跳过图片理解',
        pillClass: 'sp-pill',
        note: ext.error_code === 'integration_not_configured' ? '平台尚未启用图片理解，原图仍可查看。'
          : '本次未执行图片识别，原图仍可查看。',
      };
    case 'failed':
      return {
        label: '识别失败',
        pillClass: 'sp-pill sp-pill--danger',
        note: imageFailureNote(ext.error_code),
      };
  }
}

export function formatExtractionSummaryText(ext: Extraction): string {
  if (ext.source_kind === 'url') {
    return ext.text || ext.status;
  }
  const display = resolveImageStatusDisplay(ext);
  if (!hasUsableImageResult(ext) || !hasImageContent(ext)) {
    return [display.label, display.note].filter(Boolean).join(' · ');
  }
  const parts: string[] = [];
  if (ext.text?.trim()) parts.push(`图中文字：${ext.text.trim()}`);
  if (ext.image_description?.trim()) parts.push(`AI 画面描述：${ext.image_description.trim()}`);
  if (isTruncatedResult(ext)) parts.push('摘录已截断');
  return parts.join(' ｜ ');
}

export function ImageAnalysisPanel({
  collectionId,
  attachments,
  extractions,
  isInTrash,
  aiExcluded,
  imagePreferences,
  isLoading,
  isFetching,
  isError,
  onRefreshStatus,
}: {
  collectionId: string;
  attachments: Attachment[];
  extractions: Extraction[];
  isInTrash: boolean;
  aiExcluded: boolean;
  imagePreferences?: ImageAnalysisPreferences;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefreshStatus: () => void;
}) {
  if (isInTrash || attachments.length === 0) {
    return null;
  }

  const sortedAttachments = [...attachments].sort((a, b) => a.position - b.position);
  const bySourceId = new Map<string, Extraction>();
  for (const ext of extractions) {
    if (ext.source_kind === 'image' && !bySourceId.has(ext.source_id)) {
      bySourceId.set(ext.source_id, ext);
    }
  }

  const matched = sortedAttachments
    .map((attachment, index) => ({
      attachment,
      index,
      extraction: bySourceId.get(attachment.id) ?? null,
    }))
    .filter(
      (
        entry,
      ): entry is { attachment: Attachment; index: number; extraction: Extraction } =>
        entry.extraction !== null,
    );

  const hasResults = matched.length > 0;
  const showEmptyDisabledHint =
    !isLoading &&
    !isError &&
    !hasResults &&
    (aiExcluded || (imagePreferences?.available && !imagePreferences.enabled));


  return (
    <div className="sp-image-analysis-panel" aria-label="图片理解结果">
      <div className="sp-image-analysis-head">
        <span className="sp-image-analysis-title">
          <ImageIcon size={14} strokeWidth={2} aria-hidden="true" />
          <span>图片理解</span>
        </span>
        {!isLoading && (
          <button
            type="button"
            className="sp-btn sp-btn--sm sp-btn--ghost"
            disabled={isFetching}
            onClick={onRefreshStatus}
          >
            <RefreshCw
              size={13}
              strokeWidth={2}
              className={isFetching ? 'sp-spin' : undefined}
              aria-hidden="true"
            />
            <span>{isFetching ? '刷新中…' : '刷新状态'}</span>
          </button>
        )}
      </div>

      {isLoading && <p className="sp-help sp-image-analysis-note">正在加载图片理解状态…</p>}

      {isError && (
        <div className="sp-banner sp-banner--warning" role="status">
          <span>暂未能获取图片理解结果，原图仍可正常浏览。</span>
        </div>
      )}

      {showEmptyDisabledHint && (
        <p className="sp-help sp-image-analysis-note">
          {aiExcluded ? (
            '已设为不参与 AI 整理与图片理解；原图已完整保存，可随时点击大图查看。'
          ) : (
            <>
              未开启图片理解（DeepSeek），原图仍已完整保存。
              <Link to="/settings" className="sp-strong">
                前往设置
              </Link>
            </>
          )}
        </p>
      )}

      {!isLoading && !isError && !hasResults && !showEmptyDisabledHint && (
        <p className="sp-help sp-image-analysis-note">{imagePreferences && !imagePreferences.available
          ? '当前账号暂未开放图片理解，原图仍可查看。' : '这条收藏暂无图片识别结果。'}</p>
      )}

      {hasResults && (
        <div className="sp-image-analysis-list">
          {matched.map(({ attachment, index, extraction }) => {
            const statusDisplay = resolveImageStatusDisplay(extraction);
            const usable = hasUsableImageResult(extraction);
            const ocrText = usable && extraction.text?.trim();
            const visualDesc = usable && extraction.image_description?.trim();
            const retryKind = imageRetryKind(extraction);
            const mayOfferRetry = !isError && !aiExcluded && imagePreferences?.available === true;
            const isPending = extraction.status === 'queued' || extraction.status === 'running';

            return (
              <div
                key={attachment.id}
                className="sp-org-summary-card sp-image-analysis-item"
                data-attachment-id={attachment.id}
              >
                <div className="sp-row-between sp-wrap-gap">
                  <span className="sp-help sp-strong">
                    {sortedAttachments.length > 1
                      ? `第 ${index + 1} 张 · ${attachment.filename}`
                      : attachment.filename}
                  </span>
                  <div className="sp-row">
                    <span className={statusDisplay.pillClass}>
                      {isPending && (
                        <Loader2 size={12} strokeWidth={2} className="sp-spin" aria-hidden="true" />
                      )}
                      <span>{statusDisplay.label}</span>
                    </span>
                  </div>
                </div>

                {ocrText && (
                  <div>
                    <div className="sp-org-field-label">图中文字</div>
                    <p className="sp-org-field-value sp-break-anywhere sp-pre-wrap">{ocrText}</p>
                  </div>
                )}

                {visualDesc && (
                  <div>
                    <div className="sp-org-field-label">AI 画面描述</div>
                    <p className="sp-org-field-value sp-break-anywhere">{visualDesc}</p>
                  </div>
                )}

                {statusDisplay.note && (
                  <p className="sp-help sp-image-analysis-note">{statusDisplay.note}</p>
                )}

                {retryKind && mayOfferRetry && !imagePreferences.enabled && (
                  <Link className="sp-strong" to="/settings">前往设置开启图片理解</Link>
                )}
                {retryKind && mayOfferRetry && imagePreferences.enabled &&
                  imagePreferences.required_consent_version === IMAGE_ANALYSIS_CONSENT_VERSION && (
                    <ImageRetryAction key={extraction.id + ':' + extraction.updated_at} collectionId={collectionId}
                      attachment={attachment} extraction={extraction} kind={retryKind} />
                  )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
