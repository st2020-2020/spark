import { useRef } from 'react';
import { CornerDownRight } from 'lucide-react';
import { confirmLeavingImageDraft } from '../lib/drafts';
import type { FollowUpSource } from '../lib/followUp';
import { CollectionComposer } from './CollectionComposer';
import { Modal } from './Modal';

function shouldShowSourceExcerpt(source: FollowUpSource): boolean {
  const excerpt = source.excerpt?.trim();
  const title = source.displayTitle.trim();
  if (!excerpt) return false;
  if (excerpt === title || excerpt.startsWith(title)) return false;
  return true;
}

export function FollowUpCaptureSheet({
  source,
  onClose,
}: {
  source: FollowUpSource | null;
  onClose: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);

  const handleRequestClose = () => {
    if (contentRef.current && !confirmLeavingImageDraft(contentRef.current)) {
      return;
    }
    onClose();
  };

  return (
    <Modal open={Boolean(source)} title="续写笔记" onClose={handleRequestClose}>
      {source && (
        <div ref={contentRef} className="sp-stack">
          <div className="sp-follow-up-source" aria-label="续写来源笔记">
            <div className="sp-follow-up-source-head">
              <CornerDownRight size={14} strokeWidth={2} aria-hidden="true" />
              <span className="sp-follow-up-source-label">续写自</span>
              <strong className="sp-follow-up-source-title sp-break-anywhere">
                {source.displayTitle}
              </strong>
            </div>
            {shouldShowSourceExcerpt(source) && (
              <p className="sp-follow-up-source-excerpt sp-break-anywhere">{source.excerpt}</p>
            )}
            <p className="sp-help sp-follow-up-source-note">
              将新建一条关联到该线索的收藏，原笔记内容与归属保持不变。
            </p>
          </div>

          <CollectionComposer
            key={source.id}
            followUpSource={source}
            autoFocus
            showAiEntry={false}
            variant="sheet"
            onCreated={onClose}
            onCancel={onClose}
          />
        </div>
      )}
    </Modal>
  );
}
