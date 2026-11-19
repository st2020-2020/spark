import { Link } from 'react-router-dom';
import { Image as ImageIcon, Loader2, RefreshCw } from 'lucide-react';
import type { Attachment, Extraction, ImageAnalysisPreferences } from '../api/types';

function resolveImageStatusDisplay(ext: Extraction): {
  label: string;
  pillClass: string;
  note?: string;
} {
  switch (ext.status) {
    case 'queued':
    case 'running':
      return {
        label: '正在分析图片',
        pillClass: 'sp-pill',
        note: '系统正在识别图中文字与画面内容，完成后点击「刷新状态」查看。',
      };
    case 'succeeded':
      return {
        label: '已识别',
        pillClass: 'sp-pill sp-pill--green',
      };
    case 'partial':
      return {
        label: '部分识别',
        pillClass: 'sp-pill sp-pill--warning',
      };
    case 'blocked':
      return {
        label: ext.error_code === 'quota_exceeded' ? '今日 AI 额度已暂停' : '暂未执行',
        pillClass: 'sp-pill sp-pill--warning',
        note: '今日 AI 额度不足或未分配，图片理解已暂停，原图已完整保存并可继续查看。',
      };
    case 'skipped':
      return {
        label: '已跳过图片理解',
        pillClass: 'sp-pill',
        note: '当前未开启图片理解、缺少 DeepSeek 图片授权或已排除 AI 处理，原图仍完整保存。',
      };
    case 'failed':
      return {
        label: '识别失败',
        pillClass: 'sp-pill sp-pill--danger',
        note: '本次图片理解未能成功返回，原图已完整保存并可正常查看。',
      };
  }
}

export function formatExtractionSummaryText(ext: Extraction): string {
  if (ext.source_kind === 'url') {
    return ext.text || ext.status;
  }
  const parts: string[] = [];
  if (ext.text?.trim()) parts.push(`图中文字：${ext.text.trim()}`);
  if (ext.image_description?.trim()) parts.push(`AI 画面描述：${ext.image_description.trim()}`);
  if (ext.truncated || ext.status === 'partial') parts.push('输出已截断，识别结果可能不完整');
  return parts.length > 0 ? parts.join(' ｜ ') : ext.status;
}

export function ImageAnalysisPanel({
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

  if (!isLoading && !isError && !hasResults && !showEmptyDisabledHint) {
    return null;
  }

  return (
    <div className="sp-image-analysis-panel" aria-label="图片理解结果">
      <div className="sp-image-analysis-head">
        <span className="sp-image-analysis-title">
          <ImageIcon size={14} strokeWidth={2} aria-hidden="true" />
          <span>图片理解</span>
        </span>
        {(hasResults || isError) && (
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

      {hasResults && (
        <div className="sp-image-analysis-list">
          {matched.map(({ attachment, index, extraction }) => {
            const statusDisplay = resolveImageStatusDisplay(extraction);
            const ocrText = extraction.text?.trim() ?? '';
            const visualDesc = extraction.image_description?.trim() ?? '';
            const isTruncated = Boolean(extraction.truncated || extraction.status === 'partial');
            const isPending = extraction.status === 'queued' || extraction.status === 'running';
            const isEmptySuccess =
              (extraction.status === 'succeeded' || extraction.status === 'partial') &&
              !ocrText &&
              !visualDesc;

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
                    {isTruncated && (
                      <span className="sp-pill sp-pill--warning">
                        输出已截断，结果可能不完整
                      </span>
                    )}
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

                {isEmptySuccess && (
                  <p className="sp-help sp-image-analysis-note">
                    图片中未识别出有效文字或画面描述，原图已完整保存。
                  </p>
                )}

                {statusDisplay.note && (
                  <p className="sp-help sp-image-analysis-note">{statusDisplay.note}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
