import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';

export function DeleteProjectConfirmModal({
  open,
  projectName,
  collectionCount,
  hasUnsavedDraft = false,
  hasPendingImageFiles = false,
  readyImageCount = 0,
  inboxHasDraft = false,
  isSubmitting,
  errorMessage,
  conflictVersion,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  projectName: string;
  collectionCount: number;
  hasUnsavedDraft?: boolean;
  hasPendingImageFiles?: boolean;
  readyImageCount?: number;
  inboxHasDraft?: boolean;
  isSubmitting: boolean;
  errorMessage: string | null;
  conflictVersion: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmInput, setConfirmInput] = useState('');
  const [discardPendingAck, setDiscardPendingAck] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmInput('');
      setDiscardPendingAck(false);
    }
  }, [open]);

  const confirmMatched = confirmInput.trim() === projectName.trim() && projectName.trim().length > 0;
  const needsExplicitDiscardAck = hasPendingImageFiles || (hasUnsavedDraft && inboxHasDraft);
  const discardSatisfied = !needsExplicitDiscardAck || discardPendingAck;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmMatched || !discardSatisfied || isSubmitting) return;
    onConfirm();
  };

  return (
    <Modal
      open={open}
      title="确认删除项目"
      onClose={() => {
        if (!isSubmitting) onCancel();
      }}
    >
      <form onSubmit={handleSubmit} className="sp-stack sp-stack--loose">
        <div className="sp-banner sp-banner--warning">
          <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            删除项目后无法恢复。项目下的笔记和图片都会保留，只解除与这个项目的关联。
          </span>
        </div>

        {collectionCount > 0 && (
          <p className="sp-help">
            当前关联 {collectionCount} 条笔记，解除关联后仍可在全部收藏或待归类中找到。
          </p>
        )}

        {needsExplicitDiscardAck && (
          <div className="sp-stack">
            <div className="sp-banner sp-banner--error" role="alert">
              <span>
                {hasPendingImageFiles
                  ? '当前有未完成上传的临时图片，删除后无法保留。建议先点「取消」返回编辑区完成保存或清空。'
                  : `当前页有未保存草稿${readyImageCount > 0 ? `（含 ${readyImageCount} 张已上传图片）` : ''}，且收件箱已有其他草稿，继续删除不会覆盖收件箱草稿并会放弃当前页草稿。建议先点「取消」返回保存或清空。`}
              </span>
            </div>
            <label className="sp-row">
              <input
                type="checkbox"
                checked={discardPendingAck}
                disabled={isSubmitting}
                onChange={(e) => setDiscardPendingAck(e.target.checked)}
              />
              <span>
                {hasPendingImageFiles
                  ? '放弃未完成上传的临时图片并继续删除'
                  : '放弃当前页未保存草稿并继续删除'}
              </span>
            </label>
          </div>
        )}

        {!needsExplicitDiscardAck && hasUnsavedDraft && (
          <div className="sp-banner sp-banner--info" role="status">
            <span>
              当前页有未保存草稿{readyImageCount > 0 ? `（含 ${readyImageCount} 张已上传图片）` : ''}。可先点「取消」返回保存或清空；继续删除会将其转存到收件箱草稿（收件箱当前为空）。
            </span>
          </div>
        )}

        {errorMessage && (
          <div className="sp-banner sp-banner--error" role="alert">
            <span>{errorMessage}</span>
          </div>
        )}

        {conflictVersion !== null && (
          <div className="sp-banner sp-banner--warning" role="status">
            <span>
              项目已更新至 v{conflictVersion}，请核对最新名称后再确认删除。
            </span>
          </div>
        )}

        <div className="sp-field">
          <label htmlFor="delete-project-confirm-name" className="sp-label sp-break-anywhere">
            请输入「{projectName}」确认删除
          </label>
          <input
            id="delete-project-confirm-name"
            data-dialog-autofocus
            type="text"
            className="sp-input"
            autoComplete="off"
            placeholder={projectName}
            disabled={isSubmitting}
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
          />
        </div>

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
            type="submit"
            className="sp-btn sp-btn--danger"
            disabled={!confirmMatched || !discardSatisfied || isSubmitting}
          >
            {isSubmitting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
