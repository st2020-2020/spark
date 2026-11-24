import { afterEach, expect, it, vi } from 'vitest';
import { initAppearance } from '../lib/appearance';
import {
  canOpenMobileDrafts,
  hasLocalDraftsEntry,
  isMobileHost,
  openMobileLocalDrafts,
  requestMobileExportData,
  supportsMobileFiles,
} from '../lib/mobileBridge';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const userId = '00000000-0000-4000-8000-000000000001';

function installHost(ua = 'Android WebView SparkMobile/1') {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
  const host = Object.assign(new EventTarget(), { postMessage: vi.fn<(message: string) => void>() });
  vi.stubGlobal('sparkMobileHost', host);
  return host;
}

it.each([
  { ua: 'Android WebView SparkMobile/1', mobile: true, drafts: true },
  { ua: 'Android WebView SparkAndroid/2', mobile: false, drafts: true },
  { ua: 'Android Chrome Mobile', mobile: false, drafts: false },
  { ua: 'Android WebView SparkMobile/10 SparkAndroid/20', mobile: false, drafts: false },
])('checks the exact UA marker and sends appearance only to SparkMobile ($ua)', ({ ua, mobile, drafts }) => {
  const host = installHost(ua);
  const root = document.documentElement;
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  document.head.append(meta);
  root.style.setProperty('--sp-bg', '#171213');
  localStorage.setItem('spark:palette', 'sakura');
  localStorage.setItem('spark:theme', 'dark');
  try {
    expect(isMobileHost()).toBe(mobile);
    expect(hasLocalDraftsEntry()).toBe(drafts);
    expect(canOpenMobileDrafts()).toBe(mobile);
    expect(supportsMobileFiles()).toBe(mobile);
    initAppearance();
    expect(meta.content).toBe('#171213');
    if (mobile) {
      expect(JSON.parse(host.postMessage.mock.calls[0]![0])).toEqual({
        version: 1, action: 'syncAppearance', payload: { palette: 'sakura', mode: 'dark', bg_hex: '#171213' },
      });
    } else {
      expect(host.postMessage).not.toHaveBeenCalled();
    }
  } finally {
    root.style.removeProperty('--sp-bg');
    root.removeAttribute('data-palette');
    root.removeAttribute('data-mode');
    meta.remove();
  }
});

it('keeps the drafts link available when the native object is missing', async () => {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Android WebView SparkMobile/1');
  expect(hasLocalDraftsEntry()).toBe(true);
  expect(canOpenMobileDrafts()).toBe(false);
  expect(openMobileLocalDrafts()).toBe(false);
  expect(supportsMobileFiles()).toBe(false);
  await expect(requestMobileExportData('markdown', userId)).rejects.toThrow('文件功能暂不可用');
});

it('resolves a download using the matching receipt and removes its listener', async () => {
  const host = installHost();
  const remove = vi.spyOn(host, 'removeEventListener');
  const pending = requestMobileExportData('json', userId);
  const request = JSON.parse(host.postMessage.mock.calls[0]![0]);
  expect(request).toMatchObject({ version: 1, action: 'exportData', payload: { format: 'json', expected_user_id: userId } });
  const receipt = { version: 1, ok: true, data: { filename: 'spark-export.zip', destination: 'downloads' } };
  host.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...receipt, request_id: 'other' }) }));
  expect(remove).not.toHaveBeenCalled();
  host.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...receipt, request_id: request.request_id }) }));
  await expect(pending).resolves.toEqual(receipt.data);
  expect(remove).toHaveBeenCalledOnce();
  expect(host.postMessage).toHaveBeenCalledOnce();
});

it('rejects an invalid native reply and removes its listener', async () => {
  const host = installHost();
  const remove = vi.spyOn(host, 'removeEventListener');
  const pending = requestMobileExportData('markdown', userId);
  host.dispatchEvent(new MessageEvent('message', { data: '{' }));
  await expect(pending).rejects.toThrow('无法读取 Spark 客户端的操作结果');
  expect(remove).toHaveBeenCalledOnce();
});

it('cancels the matching native job and removes listeners on timeout or abort', async () => {
  vi.useFakeTimers();
  const host = installHost();
  const remove = vi.spyOn(host, 'removeEventListener');
  const timedOut = expect(requestMobileExportData('json', userId)).rejects.toThrow('响应超时');
  await vi.runAllTimersAsync();
  await timedOut;
  expect(remove).toHaveBeenCalledOnce();

  const controller = new AbortController();
  const cancelled = requestMobileExportData('markdown', userId, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  const [timedOutRequest, timeoutCancellation, abortedRequest, abortCancellation] =
    host.postMessage.mock.calls.map(([text]) => JSON.parse(text));
  expect(timeoutCancellation).toEqual({
    version: 1, action: 'cancelFileAction', payload: { request_id: timedOutRequest.request_id },
  });
  expect(abortCancellation).toEqual({
    version: 1, action: 'cancelFileAction', payload: { request_id: abortedRequest.request_id },
  });
  await expect(requestMobileExportData('json', userId, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(host.postMessage).toHaveBeenCalledTimes(4);
});
