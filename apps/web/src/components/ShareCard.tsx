import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collection } from '../api/types';
import { useApi } from '../context/ApiContext';
import { decodeThumbnail, renderShareCard, shareText } from '../lib/shareCard';
import { MAX_ATTACHMENTS_PER_COLLECTION } from '../lib/uploads';
import { Modal } from './Modal';

export function ShareCard({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const api = useApi();
  const [source, setSource] = useState(false);
  const [projects, setProjects] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const attachments = useMemo(() => [...collection.attachments].sort((a, b) => a.position - b.position)
    .slice(0, MAX_ATTACHMENTS_PER_COLLECTION), [collection.attachments]);
  const selection = useMemo(() => ({
    text: shareText(collection, source, projects),
    images: attachments.filter(a => !excluded.includes(a.id)),
  }), [collection, attachments, excluded, source, projects]);
  const cachedImages = useRef(new Map<string, HTMLImageElement>());
  const [result, setResult] = useState<{ selection: typeof selection; url: string; file: File }>();
  const ready = result?.selection === selection ? result : undefined;

  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    async function generate() {
      setError('');
      setResult(undefined);
      const images = [];
      for (const { id } of selection.images) {
        let image = cachedImages.current.get(id);
        if (!image) {
          image = await decodeThumbnail(await api.getThumbnail(id, controller.signal));
          if (controller.signal.aborted) return;
          cachedImages.current.set(id, image);
        }
        images.push(image);
      }
      const blob = await renderShareCard(selection.text, images);
      if (controller.signal.aborted) return;
      const file = new File([blob], 'Spark-收藏.png', { type: 'image/png' });
      url = URL.createObjectURL(file);
      setResult({ selection, url, file });
    }
    void generate().catch(() => {
      if (!controller.signal.aborted) setError(selection.images.length
        ? '含图卡片生成失败。可重试、取消部分图片，或选择仅文字。' : '卡片生成失败，请重试。');
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [api, selection, attempt]);

  return <Modal open title="生成卡片" onClose={onClose}>
    <div className="sp-stack">
      {ready && <img className="sp-share-preview" alt="待导出的分享卡片" src={ready.url} />}
      {!ready && !error && <p role="status">正在生成预览…</p>}
      {attachments.length > 0 && <fieldset className="sp-share-images">
        <legend>卡片中的图片</legend>
        {attachments.map((a, index) => <label key={a.id}>
          <input type="checkbox" checked={!excluded.includes(a.id)} onChange={e => setExcluded(
            e.target.checked ? excluded.filter(id => id !== a.id) : [...excluded, a.id])} /> 第 {index + 1} 张
        </label>)}
      </fieldset>}
      {collection.original_url && <label><input type="checkbox" checked={source} onChange={e => setSource(e.target.checked)} /> 显示来源网址（省略查询参数）</label>}
      {collection.projects.some(p => ['manual','confirmed','auto'].includes(p.decision)) && <label><input type="checkbox" checked={projects} onChange={e => setProjects(e.target.checked)} /> 显示关联项目</label>}
      {error && <div role="alert" className="sp-stack sp-stack--tight">{error}
        {!ready && <div className="sp-row sp-wrap-gap">
          <button className="sp-btn" onClick={() => setAttempt(n => n + 1)}>重新生成</button>
          {selection.images.length > 0 && <button className="sp-btn" onClick={() => setExcluded(attachments.map(a => a.id))}>仅文字</button>}
        </div>}
      </div>}
      {ready && <div className="sp-row">
        <a className="sp-btn sp-btn--primary" href={ready.url} download={ready.file.name}>下载 PNG</a>
        {typeof navigator.share === 'function' && navigator.canShare?.({ files: [ready.file] }) && <button className="sp-btn" onClick={async () => {
          try { await navigator.share({ files: [ready.file] }); }
          catch (err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setError('系统分享失败，仍可下载 PNG。'); }
        }}>系统分享</button>}
      </div>}
    </div>
  </Modal>;
}
