import { useEffect, useMemo, useState } from 'react';
import type { Collection } from '../api/types';
import { renderShareCard, shareText } from '../lib/shareCard';
import { Modal } from './Modal';

export function ShareCard({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const [source, setSource] = useState(false);
  const [projects, setProjects] = useState(false);
  const [error, setError] = useState('');
  const content = useMemo(() => shareText(collection, source, projects), [collection, source, projects]);
  const [result, setResult] = useState<{ content: typeof content; url: string; file: File }>();
  const [attempt, setAttempt] = useState(0);
  const ready = result?.content === content ? result : undefined;
  useEffect(() => {
    let live = true;
    let url = '';
    setError('');
    setResult(undefined);
    renderShareCard(content).then(blob => {
      if (!live) return;
      url = URL.createObjectURL(blob);
      setResult({ content, url, file: new File([blob], 'Spark-收藏.png', { type: 'image/png' }) });
    }).catch(() => { if (live) setError('图片生成失败，请重试。'); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [content, attempt]);
  return <Modal open title="生成卡片" onClose={onClose}>
    <div className="sp-stack">
      {ready && <img className="sp-share-preview" alt="待导出的分享卡片" src={ready.url} />}
      {!ready && !error && <p role="status">正在生成预览…</p>}
      {collection.original_url && <label><input type="checkbox" checked={source} onChange={e => setSource(e.target.checked)} /> 显示来源网址（省略查询参数）</label>}
      {collection.projects.some(p => ['manual','confirmed','auto'].includes(p.decision)) && <label><input type="checkbox" checked={projects} onChange={e => setProjects(e.target.checked)} /> 显示关联项目</label>}
      {error && <div role="alert">{error} <button className="sp-btn" onClick={() => setAttempt(n => n + 1)}>重新生成</button></div>}
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
