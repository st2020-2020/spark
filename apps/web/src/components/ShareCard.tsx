import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Share2 } from 'lucide-react';
import type { Collection } from '../api/types';
import { useApi } from '../context/ApiContext';
import {
  SHARE_CARD_TEMPLATES,
  decodeThumbnail,
  renderShareCard,
  selectDefaultShareTemplate,
  shareText,
  type ShareCardTemplate,
} from '../lib/shareCard';
import { MAX_ATTACHMENTS_PER_COLLECTION } from '../lib/uploads';
import { Modal } from './Modal';

export function ShareCard({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const api = useApi();
  const [source, setSource] = useState(false);
  const [projects, setProjects] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [manualTemplate, setManualTemplate] = useState<ShareCardTemplate | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const copyTimerRef = useRef<number | null>(null);

  const attachments = useMemo(
    () =>
      [...collection.attachments]
        .sort((a, b) => a.position - b.position)
        .slice(0, MAX_ATTACHMENTS_PER_COLLECTION),
    [collection.attachments],
  );
  const selection = useMemo(
    () => ({
      text: shareText(collection, source, projects),
      images: attachments.filter((a) => !excluded.includes(a.id)),
    }),
    [collection, attachments, excluded, source, projects],
  );

  const activeTemplate =
    manualTemplate ?? selectDefaultShareTemplate(selection.text.body, selection.images.length);

  const cachedImages = useRef(new Map<string, HTMLImageElement>());
  const [result, setResult] = useState<{
    selection: typeof selection;
    template: ShareCardTemplate;
    url: string;
    blob: Blob;
    file: File;
  }>();
  const ready =
    result && result.selection === selection && result.template === activeTemplate
      ? result
      : undefined;

  useEffect(() => {
    setCopyStatus('idle');
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
      const blob = await renderShareCard(selection.text, images, activeTemplate);
      if (controller.signal.aborted) return;
      const file = new File([blob], 'Spark-收藏.png', { type: 'image/png' });
      url = URL.createObjectURL(file);
      setResult({ selection, template: activeTemplate, url, blob, file });
    }
    void generate().catch(() => {
      if (!controller.signal.aborted) {
        setError(
          selection.images.length
            ? '含图卡片生成失败。可重试、取消部分图片，或选择仅文字。'
            : '卡片生成失败，请重试。',
        );
      }
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, selection, activeTemplate, attempt]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const canCopyImage =
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined';

  const handleCopyImage = async () => {
    if (!ready) return;
    if (!canCopyImage) {
      setCopyStatus('fallback');
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': ready.blob })]);
      setCopyStatus('copied');
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopyStatus('idle');
      }, 2200);
    } catch {
      setCopyStatus('fallback');
    }
  };

  const hasAttributedProjects = collection.projects.some((p) =>
    ['manual', 'confirmed', 'auto'].includes(p.decision),
  );

  return (
    <Modal open title="生成卡片" onClose={onClose}>
      <div className="sp-stack">
        {ready && <img className="sp-share-preview" alt="待导出的分享卡片" src={ready.url} />}
        {!ready && !error && (
          <div className="sp-share-preview-placeholder" role="status">
            <span>正在生成高清卡片预览…</span>
          </div>
        )}

        <div className="sp-share-swatches" role="radiogroup" aria-label="分享卡片模板">
          {SHARE_CARD_TEMPLATES.map((tpl) => {
            const selected = activeTemplate === tpl.id;
            return (
              <button
                key={tpl.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`sp-share-swatch-btn ${selected ? 'is-active' : ''}`}
                onClick={() => setManualTemplate(tpl.id)}
              >
                <span
                  className={`sp-share-swatch-dot sp-share-swatch-dot--${tpl.id}`}
                  aria-hidden="true"
                />
                <span>{tpl.label}</span>
              </button>
            );
          })}
        </div>

        {(attachments.length > 0 || collection.original_url || hasAttributedProjects) && (
          <div className="sp-share-controls">
            {attachments.length > 0 && (
              <fieldset className="sp-share-images">
                <legend>卡片中的图片</legend>
                <div className="sp-share-switch-row">
                  {attachments.map((a, index) => {
                    const checked = !excluded.includes(a.id);
                    return (
                      <label
                        key={a.id}
                        className={`sp-switch-pill ${checked ? 'is-checked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="sp-switch-input"
                          checked={checked}
                          onChange={(e) =>
                            setExcluded(
                              e.target.checked
                                ? excluded.filter((id) => id !== a.id)
                                : [...excluded, a.id],
                            )
                          }
                        />
                        <span className="sp-switch-track" aria-hidden="true">
                          <span className="sp-switch-thumb" />
                        </span>
                        <span>第 {index + 1} 张</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}

            {(collection.original_url || hasAttributedProjects) && (
              <div className="sp-share-switch-row">
                {collection.original_url && (
                  <label className={`sp-switch-pill ${source ? 'is-checked' : ''}`}>
                    <input
                      type="checkbox"
                      className="sp-switch-input"
                      checked={source}
                      onChange={(e) => setSource(e.target.checked)}
                    />
                    <span className="sp-switch-track" aria-hidden="true">
                      <span className="sp-switch-thumb" />
                    </span>
                    <span>显示来源网址（省略查询参数）</span>
                  </label>
                )}
                {hasAttributedProjects && (
                  <label className={`sp-switch-pill ${projects ? 'is-checked' : ''}`}>
                    <input
                      type="checkbox"
                      className="sp-switch-input"
                      checked={projects}
                      onChange={(e) => setProjects(e.target.checked)}
                    />
                    <span className="sp-switch-track" aria-hidden="true">
                      <span className="sp-switch-thumb" />
                    </span>
                    <span>显示关联项目</span>
                  </label>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="sp-stack sp-stack--tight">
            {error}
            {!ready && (
              <div className="sp-row sp-wrap-gap">
                <button type="button" className="sp-btn" onClick={() => setAttempt((n) => n + 1)}>
                  重新生成
                </button>
                {selection.images.length > 0 && (
                  <button
                    type="button"
                    className="sp-btn"
                    onClick={() => setExcluded(attachments.map((a) => a.id))}
                  >
                    仅文字
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {copyStatus === 'fallback' && (
          <p className="sp-help" role="status">
            当前浏览器暂不支持直接复制图片，请点击「下载 PNG」保存。
          </p>
        )}

        {ready && (
          <div className="sp-row sp-wrap-gap">
            <a className="sp-btn sp-btn--primary" href={ready.url} download={ready.file.name}>
              <Download size={15} strokeWidth={2} aria-hidden="true" />
              <span>下载 PNG</span>
            </a>
            {canCopyImage && (
              <button type="button" className="sp-btn" onClick={() => void handleCopyImage()}>
                {copyStatus === 'copied' ? (
                  <Check size={15} strokeWidth={2.2} aria-hidden="true" />
                ) : (
                  <Copy size={15} strokeWidth={2} aria-hidden="true" />
                )}
                <span>{copyStatus === 'copied' ? '已复制图片' : '复制图片'}</span>
              </button>
            )}
            {typeof navigator.share === 'function' &&
              navigator.canShare?.({ files: [ready.file] }) && (
                <button
                  type="button"
                  className="sp-btn"
                  onClick={async () => {
                    try {
                      await navigator.share({ files: [ready.file] });
                    } catch (err) {
                      if (!(err instanceof DOMException && err.name === 'AbortError')) {
                        setError('系统分享失败，仍可下载 PNG。');
                      }
                    }
                  }}
                >
                  <Share2 size={15} strokeWidth={2} aria-hidden="true" />
                  <span>系统分享</span>
                </button>
              )}
          </div>
        )}
      </div>
    </Modal>
  );
}
