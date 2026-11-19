import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

export function PurgeConfirmModal({
  open,
  targetSummary,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  targetSummary?: string;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title="确认永久删除收藏"
      onClose={() => {
        if (!isSubmitting) onCancel();
      }}
    >
      <div className="sp-stack">
        <div className="sp-banner sp-banner--warning">
          <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            永久删除后，该收藏会立即从回收站与搜索中移除，关联的原文、附件与历史版本将不可恢复。
          </span>
        </div>

        {targetSummary && (
          <p className="sp-help sp-break-anywhere">待删除内容：{targetSummary}</p>
        )}

        <div className="sp-modal-actions">
          <button
            type="button"
            className="sp-btn"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="sp-btn sp-btn--danger"
            disabled={isSubmitting}
            onClick={onConfirm}
          >
            {isSubmitting ? '提交中…' : '确认永久删除'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
