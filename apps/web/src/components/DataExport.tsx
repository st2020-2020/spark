import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { ApiError, isApiErrorCode } from '../api/errors';
import { requestMobileExportData, supportsMobileFiles } from '../lib/mobileBridge';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import type { ExportFormat } from '../api/types';
import { ErrorBanner } from './StateBlocks';

type DownloadFile = { href: string; name: string };

export function DataExport() {
  const api = useApi();
  const { user } = useAuth();
  const [format, setFormat] = useState<ExportFormat>('markdown');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [saved, setSaved] = useState('');
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
    setSaved('');
  }

  async function download() {
    if (api.isTestAdapter || request.current || retryAt !== null) return;
    const controller = new AbortController();
    request.current = controller;
    clearDownload();
    setError(null);
    setPending(true);
    try {
      if (supportsMobileFiles()) {
        if (!user) throw new Error('请重新登录 Spark 后再导出。');
        const receipt = await requestMobileExportData(format, user.id, controller.signal);
        if (!controller.signal.aborted) {
          setSaved(receipt.destination === 'documents' ? '已保存到所选位置。' : '已保存到系统下载目录。');
        }
        return;
      }
      const { blob, filename: name } = await api.exportMyData(format, controller.signal);
      if (controller.signal.aborted) return;
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
      if (controller.signal.aborted || isApiErrorCode(cause, 'cancelled')) return;
      if (cause instanceof ApiError) {
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
          <button type="button" className="sp-btn" disabled={api.isTestAdapter || pending || retryAt !== null}
            onClick={() => void download()}>
            <Download size={16} aria-hidden="true" />{pending ? '正在准备下载…' : '下载 ZIP'}
          </button>
        </div>
        {api.isTestAdapter && <p className="sp-help">连接真实服务后可导出账号数据。</p>}
        {retryAt !== null && <p className="sp-help" role="status">
          可在 {new Date(retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 再次导出。
        </p>}
        {saved && <p className="sp-help" role="status">{saved}</p>}
        {file && <p className="sp-help" role="status">文件已准备好。<a href={file.href} download={file.name}>再次下载此文件</a></p>}
        {error && <ErrorBanner error={error} />}
      </div>
    </section>
  );
}
