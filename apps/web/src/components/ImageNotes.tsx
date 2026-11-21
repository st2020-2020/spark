import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Collection, ImageNote } from '../api/types';
import { getFriendlyErrorMessage, isApiErrorCode } from '../api/errors';
import { useApi } from '../context/ApiContext';
import { Modal } from './Modal';

export function ImageNotes({ collection }: { collection: Collection }) {
  const api = useApi();
  const client = useQueryClient();
  const [editing, setEditing] = useState<ImageNote | null>(null);
  const [text, setText] = useState('');
  const notes = collection.image_notes ?? [];
  const latest = notes.find(n => n.attachment_id === editing?.attachment_id);
  const conflict = editing && latest?.version !== editing.version;
  const save = useMutation({
    mutationFn: (note: ImageNote) => api.updateImageNote(note.attachment_id, { base_version: note.version, text }),
    onSuccess: updated => {
      client.setQueryData(['collection', collection.id], updated);
      setEditing(null);
      void client.invalidateQueries({ queryKey: ['collections'] });
      void client.invalidateQueries({ queryKey: ['project-collections'] });
      void client.invalidateQueries({ queryKey: ['collection-revisions', collection.id] });
    },
    onError: () => { void client.invalidateQueries({ queryKey: ['collection', collection.id], exact: true }); },
  });
  return <>
    {notes.map(note => {
      const attachment = collection.attachments.find(a => a.id === note.attachment_id);
      if (!attachment) return null;
      const label = collection.attachments.length === 1 ? '图片说明' : `第 ${attachment.position + 1} 张图片说明`;
      return <section key={note.attachment_id} className="sp-image-note" aria-label={label}>
        <div className="sp-row-between sp-wrap-gap">
          <span className="sp-org-field-label">{label} · {note.state === 'edited' ? '已编辑' : 'AI 整理'}</span>
          {!collection.deleted_at && <button type="button" className="sp-btn sp-btn--sm sp-btn--ghost"
            aria-label={`编辑${label}`} onClick={() => {
              save.reset(); setText(note.text); setEditing(note);
            }}>编辑说明</button>}
        </div>
        <p className="sp-org-field-value sp-break-anywhere sp-pre-wrap">{note.text}</p>
      </section>;
    })}
    <Modal open={Boolean(editing)} title="编辑图片说明" onClose={() => { if (!save.isPending) setEditing(null); }}>
      <form className="sp-stack" onSubmit={e => {
        e.preventDefault();
        if (editing && !conflict && !save.isPending && [...text].length <= 2000) save.mutate(editing);
      }}>
        <label className="sp-field">图片说明
          <textarea className="sp-input" rows={5} value={text} data-dialog-autofocus
            onChange={e => setText(e.target.value)} disabled={save.isPending} />
        </label>
        {[...text].length > 2000 && <p role="alert">图片说明最多 2000 字。</p>}
        {!text.trim() && <p className="sp-help">删除说明后，原图仍保留。</p>}
        {conflict && <div className="sp-stack sp-stack--tight" role="status">
          {latest ? <>
            <p>图片说明已更新。请对照最新内容后决定是否继续编辑。</p>
            <p className="sp-pre-wrap sp-break-anywhere">{latest.text}</p>
            <button type="button" className="sp-btn" onClick={() => { setEditing(latest); save.reset(); }}>保留输入，基于最新版编辑</button>
          </> : <p>这段说明已移除，你仍可复制上方的输入。</p>}
        </div>}
        {save.isError && !conflict && <p className="sp-error-text" role="alert">
          {isApiErrorCode(save.error, 'image_note_conflict') ? '这段说明已更新，请核对最新内容。' : getFriendlyErrorMessage(save.error)}
        </p>}
        <div className="sp-form-actions">
          <button type="button" className="sp-btn" disabled={save.isPending} onClick={() => setEditing(null)}>取消</button>
          <button type="submit" className="sp-btn sp-btn--primary" disabled={!!conflict || save.isPending || [...text].length > 2000}>
            {save.isPending ? '保存中…' : text.trim() ? '保存说明' : '删除说明'}
          </button>
        </div>
      </form>
    </Modal>
  </>;
}
