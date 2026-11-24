import { useEffect, useMemo, useRef, useState } from 'react';
import { isApiErrorCode } from '../api/errors';
import type { Collection } from '../api/types';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { requestMobileSaveImage, requestMobileShareImage, supportsMobileFiles } from '../lib/mobileBridge';
import { decodeThumbnail, renderShareCard, shareText } from '../lib/shareCard';
import { MAX_ATTACHMENTS_PER_COLLECTION } from '../lib/uploads';
import { Modal } from './Modal';

export function ShareCard({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const api = useApi();
  const { user } = useAuth();
  const [source, setSource] = useState(false);
  const [projects, setProjects] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState('');
  const nativeOperation = useRef<AbortController | null>(null);
  const nativeFiles = supportsMobileFiles();
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
      setSaved('');
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

  useEffect(() => () => nativeOperation.current?.abort(), []);

  async function useNativeFile(file: File, share: boolean) {
    if (nativeOperation.current) return;
    if (!user) {
      setError('请重新登录 Spark 后再操作。');
      return;
    }
    const controller = new AbortController();
    nativeOperation.current = controller;
    setPending(true);
    setError('');
    setSaved('');
    try {
      if (share) await requestMobileShareImage(file, user.id, controller.signal);
      else {
        const receipt = await requestMobileSaveImage(file, user.id, controller.signal);
        if (!controller.signal.aborted) {
          setSaved(receipt.destination === 'documents' ? '已保存到所选位置。' : '已保存到系统相册。');
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted && !isApiErrorCode(cause, 'cancelled')) {
        setError(cause instanceof Error ? cause.message : '文件操作失败，请重试。');
      }
    } finally {
      nativeOperation.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return <Modal open title="生成卡片" onClose={onClose}>
    <div className="sp-stack">
      {ready && <img className="sp-share-preview" alt="待导出的分享卡片" src={ready.url} />}
      {!ready && !error && <p role="status">正在生成预览…</p>}
      {attachments.length > 0 && <fieldset className="sp-share-images">
        <legend>卡片中的图片</legend>
        {attachments.map((a, index) => <label key={a.id}>
          <input type="checkbox" disabled={pending} checked={!excluded.includes(a.id)} onChange={e => setExcluded(
            e.target.checked ? excluded.filter(id => id !== a.id) : [...excluded, a.id])} /> 第 {index + 1} 张
        </label>)}
      </fieldset>}
      {collection.original_url && <label><input type="checkbox" disabled={pending} checked={source} onChange={e => setSource(e.target.checked)} /> 显示来源网址（省略查询参数）</label>}
      {collection.projects.some(p => ['manual','confirmed','auto'].includes(p.decision)) && <label><input type="checkbox" disabled={pending} checked={projects} onChange={e => setProjects(e.target.checked)} /> 显示关联项目</label>}
      {error && <div role="alert" className="sp-stack sp-stack--tight">{error}
        {!ready && <div className="sp-row sp-wrap-gap">
          <button className="sp-btn" onClick={() => setAttempt(n => n + 1)}>重新生成</button>
          {selection.images.length > 0 && <button className="sp-btn" onClick={() => setExcluded(attachments.map(a => a.id))}>仅文字</button>}
        </div>}
      </div>}
      {saved && <p className="sp-help" role="status">{saved}</p>}
      {ready && nativeFiles && <div className="sp-row">
        <button type="button" className="sp-btn sp-btn--primary" disabled={pending}
          onClick={() => void useNativeFile(ready.file, false)}>下载 PNG</button>
        <button type="button" className="sp-btn" disabled={pending}
          onClick={() => void useNativeFile(ready.file, true)}>系统分享</button>
      </div>}
      {ready && !nativeFiles && <div className="sp-row">
        <a className="sp-btn sp-btn--primary" href={ready.url} download={ready.file.name}>下载 PNG</a>
        {typeof navigator.share === 'function' && navigator.canShare?.({ files: [ready.file] }) && <button className="sp-btn" onClick={async () => {
          try { await navigator.share({ files: [ready.file] }); }
          catch (err) { if (!(err instanceof DOMException && err.name === 'AbortError')) setError('系统分享失败，仍可下载 PNG。'); }
        }}>系统分享</button>}
      </div>}
    </div>
  </Modal>;
}
