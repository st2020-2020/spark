import { ApiError } from '../api/errors';
import type { ExportFormat } from '../api/types';
import type { PaletteId } from './appearance';

type MobileNotification = 'syncAppearance' | 'openLocalDrafts' | 'authStateChanged' | 'cancelFileAction';
type MobileFileAction = 'saveImage' | 'shareImage' | 'exportData';
type FileReceipt = { filename: string; destination?: 'gallery' | 'downloads' | 'documents' };
type MobileHost = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { postMessage(message: string): void };

function hasUserAgentMarker(marker: string): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.split(/\s+/).includes(marker);
}

export function isMobileHost(): boolean {
  return hasUserAgentMarker('SparkMobile/1');
}

export function hasLocalDraftsEntry(): boolean {
  return isMobileHost() || hasUserAgentMarker('SparkAndroid/2');
}

function mobileHost(): Partial<MobileHost> | undefined {
  if (!isMobileHost() || typeof window === 'undefined') return;
  const host = (window as Window & { sparkMobileHost?: Partial<MobileHost> }).sparkMobileHost;
  if (typeof host?.postMessage === 'function') return host;
}

export function canOpenMobileDrafts(): boolean {
  return !!mobileHost();
}

function mobileFileHost(): MobileHost | undefined {
  const host = mobileHost();
  if (typeof host?.addEventListener === 'function' && typeof host.removeEventListener === 'function') {
    return host as MobileHost;
  }
}

export function supportsMobileFiles(): boolean {
  return !!mobileFileHost();
}

function notify(action: MobileNotification, payload: Record<string, unknown>): boolean {
  const host = mobileHost();
  if (!host?.postMessage) return false;
  try {
    host.postMessage(JSON.stringify({ version: 1, action, payload }));
    return true;
  } catch {
    return false;
  }
}

export function notifyMobileAppearance(palette: PaletteId, mode: 'light' | 'dark', bgHex: string): void {
  if (/^#[0-9a-f]{6}$/i.test(bgHex)) notify('syncAppearance', { palette, mode, bg_hex: bgHex });
}

export function notifyMobileAuthChanged(authenticated: boolean): void {
  notify('authStateChanged', { authenticated });
}

export function openMobileLocalDrafts(): boolean {
  return notify('openLocalDrafts', {});
}

const invalidReply = () => new Error('无法读取 Spark 客户端的操作结果，请重试。');
let nextRequest = 0;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function requestMobile(
  action: MobileFileAction,
  payload: Record<string, unknown> & { expected_user_id: string },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const host = mobileFileHost();
  if (!host) throw new Error('Spark 客户端的文件功能暂不可用。');
  const { postMessage, addEventListener, removeEventListener } = host;
  if (signal?.aborted) throw signal.reason;
  const requestId = `${Date.now()}-${++nextRequest}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => abandon(
      new Error('等待 Spark 客户端响应超时，请先检查文件是否已保存。'),
    ), timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      removeEventListener.call(host, 'message', onMessage);
    }

    function abandon(reason: unknown) {
      cleanup();
      try {
        postMessage.call(host, JSON.stringify({ version: 1, action: 'cancelFileAction', payload: { request_id: requestId } }));
      } catch {
        // The WebView may already have invalidated the document.
      }
      reject(reason);
    }

    function abort() {
      abandon(signal?.reason);
    }

    function onMessage(event: Event) {
      const text: unknown = (event as MessageEvent<unknown>).data;
      let envelope: Record<string, unknown> | undefined;
      try {
        if (typeof text !== 'string' || text.length > 8192) throw invalidReply();
        envelope = record(JSON.parse(text));
        if (!envelope || typeof envelope.request_id !== 'string') throw invalidReply();
      } catch {
        abandon(invalidReply());
        return;
      }
      if (envelope.request_id !== requestId) return;
      cleanup();
      if (envelope.version !== 1) {
        reject(invalidReply());
      } else if (envelope.ok === true) {
        resolve(envelope.data);
      } else if (envelope.ok === false) {
        const error = record(envelope.error);
        if (typeof error?.code !== 'string' || typeof error.message !== 'string') {
          reject(invalidReply());
          return;
        }
        reject(new ApiError({
          status: typeof error.status === 'number' ? error.status : 0,
          code: error.code,
          message: error.message,
          retryAfter: typeof error.retry_after === 'number' && Number.isSafeInteger(error.retry_after)
            && error.retry_after >= 0 ? String(error.retry_after) : null,
        }));
      } else {
        reject(invalidReply());
      }
    }

    try {
      addEventListener.call(host, 'message', onMessage);
      signal?.addEventListener('abort', abort, { once: true });
      postMessage.call(host, JSON.stringify({ version: 1, request_id: requestId, action, payload }));
    } catch {
      cleanup();
      reject(new Error('无法联系 Spark 客户端，请重试。'));
    }
  });
}

function fileReceipt(data: unknown): FileReceipt {
  const receipt = record(data);
  if (typeof receipt?.filename !== 'string' || receipt.filename.length === 0) throw invalidReply();
  const { destination } = receipt;
  return {
    filename: receipt.filename,
    destination: destination === 'gallery' || destination === 'downloads' || destination === 'documents'
      ? destination : undefined,
  };
}

const imageSaveTimeout = 120_000; // Android 7–9 may open a document picker before saving.

async function imagePayload(file: File): Promise<Record<string, unknown>> {
  if (file.type !== 'image/png') throw new Error('只能发送 PNG 图片。');
  if (file.size > 4 * 1024 * 1024) throw new Error('PNG 超过 4 MiB，请减少卡片中的图片后重试。');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reader.onabort = () => reject(new Error('无法读取待分享图片，请重试。'));
    reader.onload = () => {
      const prefix = 'data:image/png;base64,';
      if (typeof reader.result === 'string' && reader.result.startsWith(prefix)) {
        resolve(reader.result.slice(prefix.length));
      } else {
        reject(new Error('无法读取待分享图片，请重试。'));
      }
    };
    reader.readAsDataURL(file);
  });
  return { mime: file.type, filename: file.name, base64 };
}

export async function requestMobileSaveImage(file: File, userId: string, signal?: AbortSignal): Promise<FileReceipt> {
  if (signal?.aborted) throw signal.reason;
  return fileReceipt(await requestMobile('saveImage',
    { ...await imagePayload(file), expected_user_id: userId }, imageSaveTimeout, signal));
}

export async function requestMobileShareImage(file: File, userId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await requestMobile('shareImage', { ...await imagePayload(file), expected_user_id: userId }, 30_000, signal);
}

export async function requestMobileExportData(format: ExportFormat, userId: string, signal?: AbortSignal): Promise<FileReceipt> {
  // Native export allows a five-minute stream and may ask for a document destination.
  return fileReceipt(await requestMobile('exportData', { format, expected_user_id: userId }, 420_000, signal));
}
