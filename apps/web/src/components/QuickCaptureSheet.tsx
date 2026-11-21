import { useRef } from 'react';
import { confirmLeavingImageDraft } from '../lib/drafts';
import { CollectionComposer } from './CollectionComposer';
import { Modal } from './Modal';

/**
 * Capture from any page without leaving it. Shares the inbox draft scope, which is safe because
 * the shell only opens this sheet when the inbox (and its inline composer) is not mounted.
 */
export function QuickCaptureSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Modal open={open} title="记一条" onClose={() => {
      if (content.current && confirmLeavingImageDraft(content.current)) onClose();
    }}>
      <div ref={content}><CollectionComposer autoFocus showAiEntry={false} variant="sheet" onCreated={onClose} /></div>
      <p className="sp-capture-hint">保存后会出现在收件箱，项目可以稍后再选。正文和已就绪的图片可从本账号草稿继续。</p>
    </Modal>
  );
}
