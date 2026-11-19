import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { ApiError, parseApiErrorResponse } from '../api/errors';
import { ErrorBanner } from './StateBlocks';

type Format = 'markdown' | 'json';
type DownloadFile = { href: string; name: string };

export function DataExport({ preview, onSessionExpired }: {
  preview: boolean;
  onSessionExpired: () => void;
}) {
  const [format, setFormat] = useState<Format>('markdown');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [file, setFile] = useState<DownloadFile | null>(null);
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  function clearDownload() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setFile(null);
  }

  async function download() {
    if (request.current || retryAt !== null || preview) return;
    const controller = new AbortController();
    request.current = controller;
    clearDownload();
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/v1/me/export?format=${format}`, {
        credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/zip' }, signal: controller.signal,
      });
      if (!response.ok) throw await parseApiErrorResponse(response);
      if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/zip') {
        throw new Error('导出服务返回了意外的文件格式，请稍后重试。');
      }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const name = response.headers.get('Content-Disposition')?.match(/filename="(spark-export-\d{8}\.zip)"/i)?.[1] ?? 'spark-export.zip';
      const href = URL.createObjectURL(blob);
      objectUrl.current = href;
      setFile({ href, name });
      const link = document.createElement('a');
      link.href = href;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError) {
        if (cause.status === 401) onSessionExpired();
        const seconds = Number(cause.retryAfter);
        if (cause.status === 429 && Number.isInteger(seconds) && seconds > 0 && seconds <= 600) {
          setRetryAt(Date.now() + seconds * 1000);
          return;
        }
      }
      setError(cause instanceof TypeError ? new Error('下载中断，请检查网络后重试。') :
        cause instanceof Error ? cause : new Error('下载失败，请重试。'));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <section className="sp-card" aria-labelledby="export-title">
      <h2 className="sp-card-title" id="export-title">导出我的数据</h2>
      <div className="sp-stack">
        <p className="sp-help">将你的项目和未删除的收藏下载为 ZIP 文件，每十分钟可导出一次。</p>
        <div className="sp-setting-row">
          <div className="sp-segmented" role="group" aria-label="导出格式">
            {(['markdown', 'json'] as const).map((value) => (
              <button type="button" className="sp-segmented-btn" key={value} aria-pressed={format === value}
                disabled={pending} onClick={() => {
                  if (format !== value) { clearDownload(); setError(null); setFormat(value); }
                }}>{value === 'markdown' ? 'Markdown' : 'JSON'}</button>
            ))}
          </div>
          <button type="button" className="sp-btn" disabled={pending || retryAt !== null || preview}
            onClick={() => void download()}>
            <Download size={16} aria-hidden="true" />{pending ? '正在准备下载…' : '下载 ZIP'}
          </button>
        </div>
        {preview && <p className="sp-help">请在已登录的正式账号中导出数据。</p>}
        {retryAt !== null && <p className="sp-help" role="status">
          可在 {new Date(retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 再次导出。
        </p>}
        {file && <p className="sp-help" role="status">文件已准备好。<a href={file.href} download={file.name}>再次下载此文件</a></p>}
        {error && <ErrorBanner error={error} />}
      </div>
    </section>
  );
}
