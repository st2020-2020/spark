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
  draftTransferred = false,
  isSubmitting,
  errorMessage,
  conflictVersion,
  onTransferDraftToInbox,
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
  draftTransferred?: boolean;
  isSubmitting: boolean;
  errorMessage: string | null;
  conflictVersion: number | null;
  onTransferDraftToInbox?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirmInput, setConfirmInput] = useState('');
  const [discardAck, setDiscardAck] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmInput('');
      setDiscardAck(false);
    }
  }, [open]);

  const confirmMatched = confirmInput.trim() === projectName.trim() && projectName.trim().length > 0;
  const hasBlockingDraft = hasPendingImageFiles || hasUnsavedDraft;
  const draftSatisfied = !hasBlockingDraft || discardAck;
  const canTransferToInbox = Boolean(
    hasUnsavedDraft && !hasPendingImageFiles && !inboxHasDraft && onTransferDraftToInbox,
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!confirmMatched || !draftSatisfied || isSubmitting) return;
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

        {draftTransferred && (
          <div className="sp-banner sp-banner--info" role="status">
            <span>未保存草稿已转存到收件箱，可继续确认删除或先取消。</span>
          </div>
        )}

        {hasBlockingDraft && (
          <div className="sp-stack">
            <div className="sp-banner sp-banner--error" role="alert">
              <span>
                {hasPendingImageFiles
                  ? '当前有未完成上传的临时图片，删除后无法保留。请先点「取消」返回编辑区保存或清空。'
                  : inboxHasDraft
                    ? `当前页有未保存草稿${readyImageCount > 0 ? `（含 ${readyImageCount} 张已上传图片）` : ''}，且收件箱已有其他草稿。请先点「取消」保存或清空。`
                    : `当前页有未保存草稿${readyImageCount > 0 ? `（含 ${readyImageCount} 张已上传图片）` : ''}。可先点「取消」保存，或先转存到收件箱后再删除。`}
              </span>
            </div>
            {canTransferToInbox && (
              <div>
                <button
                  type="button"
                  className="sp-btn sp-btn--sm"
                  disabled={isSubmitting}
                  onClick={onTransferDraftToInbox}
                >
                  先转存到收件箱
                </button>
              </div>
            )}
            <label className="sp-row">
              <input
                type="checkbox"
                checked={discardAck}
                disabled={isSubmitting}
                onChange={(e) => setDiscardAck(e.target.checked)}
              />
              <span>
                {hasPendingImageFiles
                  ? '放弃未完成上传的临时图片并继续删除'
                  : '放弃当前页未保存草稿并继续删除'}
              </span>
            </label>
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
            disabled={!confirmMatched || !draftSatisfied || isSubmitting}
          >
            {isSubmitting ? '删除中…' : '确认删除'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
