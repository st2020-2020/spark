import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

export function PurgeConfirmModal({
  open,
  title = '确认永久删除收藏',
  warningMessage = '永久删除后，这条笔记和附件将无法恢复。',
  confirmLabel = '确认永久删除',
  submittingLabel = '提交中…',
  targetSummary,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title?: string;
  warningMessage?: string;
  confirmLabel?: string;
  submittingLabel?: string;
  targetSummary?: string;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={() => {
        if (!isSubmitting) onCancel();
      }}
    >
      <div className="sp-stack">
        <div className="sp-banner sp-banner--warning">
          <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
          <span>{warningMessage}</span>
        </div>

        {targetSummary && (
          <p className="sp-help sp-break-anywhere">待删除内容：{targetSummary}</p>
        )}

        <div className="sp-modal-actions">
          <button
            type="button"
            data-dialog-autofocus
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
            {isSubmitting ? submittingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
