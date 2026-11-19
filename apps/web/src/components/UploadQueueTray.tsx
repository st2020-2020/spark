import { ArrowLeft, ArrowRight, Image as ImageIcon, RefreshCw, X } from 'lucide-react';
import type { Attachment } from '../api/types';
import { formatBytes } from '../lib/format';
import { MAX_ATTACHMENTS_PER_COLLECTION, type PendingUploadItem } from '../lib/uploads';
import { AttachmentImage } from './AttachmentImage';

export function UploadQueueTray({
  pendingItems,
  keptAttachments = [],
  validationError,
  onDismissValidationError,
  onCancelPending,
  onRetryPending,
  onRemovePending,
  onMovePending,
  onRemoveKept,
  onMoveKept,
  disabled = false,
}: {
  pendingItems: PendingUploadItem[];
  keptAttachments?: Attachment[];
  validationError?: string | null;
  onDismissValidationError?: () => void;
  onCancelPending: (localId: string) => void;
  onRetryPending: (localId: string) => void;
  onRemovePending: (localId: string) => void;
  onMovePending: (localId: string, direction: -1 | 1) => void;
  onRemoveKept?: (attachmentId: string) => void;
  onMoveKept?: (attachmentId: string, direction: -1 | 1) => void;
  disabled?: boolean;
}) {
  const totalCount = keptAttachments.length + pendingItems.length;
  if (totalCount === 0 && !validationError) return null;

  return (
    <div className="sp-upload-tray" role="region" aria-label="图片附件列表">
      {validationError && (
        <div className="sp-banner sp-banner--error sp-upload-validation" role="alert">
          <span>{validationError}</span>
          {onDismissValidationError && (
            <button
              type="button"
              className="sp-btn sp-btn--sm sp-btn--quiet"
              onClick={onDismissValidationError}
              aria-label="关闭图片提示"
            >
              关闭
            </button>
          )}
        </div>
      )}

      {totalCount > 0 && (
        <>
          <div className="sp-upload-tray-head">
            <span className="sp-help">
              图片 {totalCount} / {MAX_ATTACHMENTS_PER_COLLECTION}
            </span>
          </div>

          <div className="sp-upload-list">
            {keptAttachments.map((att, idx) => (
              <div key={att.id} className="sp-upload-card">
                <div className="sp-upload-thumb-wrap">
                  <AttachmentImage attachment={att} variant="tray" />
                </div>

                <div className="sp-upload-info">
                  <span className="sp-upload-name sp-truncate" title={att.filename}>
                    {att.filename}
                  </span>
                  <span className="sp-help">已保存 · {formatBytes(att.size_bytes)}</span>
                </div>

                <div className="sp-upload-actions">
                  {onMoveKept && keptAttachments.length > 1 && (
                    <>
                      <button
                        type="button"
                        className="sp-icon-btn sp-upload-action-btn"
                        aria-label={`前移已有图片 ${att.filename}`}
                        disabled={disabled || idx === 0}
                        onClick={() => onMoveKept(att.id, -1)}
                      >
                        <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="sp-icon-btn sp-upload-action-btn"
                        aria-label={`后移已有图片 ${att.filename}`}
                        disabled={disabled || idx === keptAttachments.length - 1}
                        onClick={() => onMoveKept(att.id, 1)}
                      >
                        <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
                      </button>
                    </>
                  )}
                  {onRemoveKept && (
                    <button
                      type="button"
                      className="sp-icon-btn sp-upload-action-btn"
                      aria-label={`移除已有图片 ${att.filename}`}
                      disabled={disabled}
                      onClick={() => onRemoveKept(att.id)}
                    >
                      <X size={13} strokeWidth={2} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {pendingItems.map((item, idx) => {
              const isInFlight = item.status === 'uploading' || item.status === 'verifying';
              return (
                <div
                  key={item.localId}
                  className={`sp-upload-card ${
                    item.status === 'failed' ? 'sp-upload-card--failed' : ''
                  }`}
                >
                  <div className="sp-upload-thumb-wrap">
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        className="sp-attachment-img sp-attachment-img--tray"
                      />
                    ) : (
                      <div className="sp-upload-thumb-placeholder" aria-hidden="true">
                        <ImageIcon size={18} strokeWidth={1.8} />
                      </div>
                    )}
                  </div>

                  <div className="sp-upload-info">
                    <span className="sp-upload-name sp-truncate" title={item.file.name}>
                      {item.file.name}
                    </span>

                    {item.status === 'uploading' && (
                      <>
                        <span className="sp-help">上传中 {item.progress}%</span>
                        <progress
                          className="sp-upload-progress"
                          value={item.progress}
                          max={100}
                          aria-label={`${item.file.name} 上传进度`}
                        />
                      </>
                    )}

                    {item.status === 'verifying' && <span className="sp-help">校验中…</span>}

                    {item.status === 'ready' && (
                      <span className="sp-help">已就绪 · {formatBytes(item.file.size)}</span>
                    )}

                    {item.status === 'failed' && (
                      <span className="sp-error-text sp-upload-error" role="alert">
                        {item.error || '图片上传失败'}
                      </span>
                    )}
                  </div>

                  <div className="sp-upload-actions">
                    {pendingItems.length > 1 && (
                      <>
                        <button
                          type="button"
                          className="sp-icon-btn sp-upload-action-btn"
                          aria-label={`前移待保存图片 ${item.file.name}`}
                          disabled={disabled || idx === 0}
                          onClick={() => onMovePending(item.localId, -1)}
                        >
                          <ArrowLeft size={13} strokeWidth={2} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="sp-icon-btn sp-upload-action-btn"
                          aria-label={`后移待保存图片 ${item.file.name}`}
                          disabled={disabled || idx === pendingItems.length - 1}
                          onClick={() => onMovePending(item.localId, 1)}
                        >
                          <ArrowRight size={13} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </>
                    )}

                    {isInFlight ? (
                      <button
                        type="button"
                        className="sp-btn sp-btn--sm sp-btn--quiet"
                        aria-label={`取消上传 ${item.file.name}`}
                        disabled={disabled}
                        onClick={() => onCancelPending(item.localId)}
                      >
                        取消
                      </button>
                    ) : (
                      <>
                        {item.status === 'failed' && (
                          <button
                            type="button"
                            className="sp-btn sp-btn--sm"
                            aria-label={`重试上传 ${item.file.name}`}
                            disabled={disabled}
                            onClick={() => onRetryPending(item.localId)}
                          >
                            <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
                            <span>重试</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="sp-icon-btn sp-upload-action-btn"
                          aria-label={`移除图片 ${item.file.name}`}
                          disabled={disabled}
                          onClick={() => onRemovePending(item.localId)}
                        >
                          <X size={13} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
