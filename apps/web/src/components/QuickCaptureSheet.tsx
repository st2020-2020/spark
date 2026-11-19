import { CollectionComposer } from './CollectionComposer';
import { Modal } from './Modal';

/**
 * Capture from any page without leaving it. Shares the inbox draft scope, which is safe because
 * the shell only opens this sheet when the inbox (and its inline composer) is not mounted.
 */
export function QuickCaptureSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="记一条" onClose={onClose}>
      <CollectionComposer autoFocus showAiEntry={false} variant="sheet" onCreated={onClose} />
      <p className="sp-capture-hint">保存后会出现在收件箱，项目可以稍后再选。未保存的内容会自动留作草稿。</p>
    </Modal>
  );
}
