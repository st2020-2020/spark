import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../App';
import { createRealApiClient } from '../api/client';
import type { SessionResult } from '../api/types';
import { DataExport } from '../components/DataExport';

const userId = '00000000-0000-4000-8000-000000000001';

function signedInApi() {
  const api = createRealApiClient();
  vi.spyOn(api, 'currentSession').mockResolvedValue({
    user: { id: userId, palette: 'mint', theme: 'system' }, csrf_token: 'test-export',
  } as SessionResult);
  return api;
}

async function renderExport(api = signedInApi()) {
  const csrf = vi.spyOn(api, 'setCsrfToken');
  const rendered = render(<AppProviders api={api}><DataExport /></AppProviders>);
  await waitFor(() => expect(csrf).toHaveBeenCalledWith('test-export'));
  return rendered;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  'Android Chrome Mobile',
  'Android WebView SparkAndroid/2',
  'Android WebView SparkMobile/1',
])('downloads through the browser when native file handling is unavailable (%s)', async (ua) => {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
  const fetchFile = vi.fn().mockResolvedValue(new Response(new Blob(['synthetic']), {
    headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="spark-export-20261118.zip"' },
  }));
  vi.stubGlobal('fetch', fetchFile);
  const revoke = vi.fn();
  class TestURL extends URL {
    static createObjectURL = () => 'blob:synthetic-test';
    static revokeObjectURL = revoke;
  }
  vi.stubGlobal('URL', TestURL);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const { unmount } = await renderExport();
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  const link = await screen.findByRole('link', { name: '再次下载此文件' });
  expect(link).toHaveAttribute('download', 'spark-export-20261118.zip');
  expect(fetchFile).toHaveBeenCalledExactlyOnceWith('/api/v1/me/export?format=json', expect.objectContaining({
    method: 'GET', headers: { 'X-CSRF-Token': 'test-export' }, redirect: 'error',
  }));
  expect(click).toHaveBeenCalledOnce();
  unmount();
  expect(revoke).toHaveBeenCalledWith('blob:synthetic-test');
});

it('honors the server retry time for both export formats', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '17' } })));
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await renderExport();
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  const availableAt = new Date(now + 17000).toLocaleTimeString('zh-CN', { hour12: false });
  expect(await screen.findByRole('status')).toHaveTextContent(availableAt);
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  expect(screen.getByRole('button', { name: '下载 ZIP' })).toBeDisabled();
});

it('aborts a pending request on unmount and refreshes the session for an expired account', async () => {
  const expired = vi.fn();
  const fetchFile = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }))
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetchFile);
  const api = signedInApi();
  const { unmount } = await renderExport(api);
  api.setUnauthorizedHandler(expired);
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  await waitFor(() => expect(expired).toHaveBeenCalledOnce());
  api.setCsrfToken('renewed-test-session');
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  expect(screen.getByRole('button', { name: '正在准备下载…' })).toBeDisabled();
  const signal = fetchFile.mock.calls[1][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
});


function installExportHost(reply?: { ok: boolean; data?: object; error?: object }) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Android WebView SparkMobile/1');
  const host = Object.assign(new EventTarget(), {
    postMessage: vi.fn((text: string) => {
      const { action, request_id } = JSON.parse(text);
      if (action === 'exportData' && reply) {
        host.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ version: 1, request_id, ...reply }) }));
      }
    }),
  });
  vi.stubGlobal('sparkMobileHost', host);
  return host;
}

it('delegates ZIP export to SparkMobile and reports the saved file', async () => {
  const host = installExportHost({ ok: true, data: { filename: 'spark-export-20261122.zip', destination: 'downloads' } });
  const api = signedInApi();
  const exportInBrowser = vi.spyOn(api, 'exportMyData');
  await renderExport(api);
  host.postMessage.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  expect(await screen.findByRole('status')).toHaveTextContent('已保存到系统下载目录');
  expect(host.postMessage).toHaveBeenCalledOnce();
  expect(JSON.parse(host.postMessage.mock.calls[0]![0])).toMatchObject({
    version: 1, action: 'exportData', payload: { format: 'json', expected_user_id: userId },
  });
  expect(exportInBrowser).not.toHaveBeenCalled();
});

it('uses the native 429 retry time for both formats', async () => {
  const host = installExportHost({ ok: false, error: {
    code: 'rate_limited', message: '导出过于频繁，请稍后重试。', status: 429, retry_after: 23,
  } });
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await renderExport();
  host.postMessage.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  expect(await screen.findByRole('status')).toHaveTextContent(new Date(now + 23_000).toLocaleTimeString('zh-CN', { hour12: false }));
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  expect(screen.getByRole('button', { name: '下载 ZIP' })).toBeDisabled();
  expect(host.postMessage).toHaveBeenCalledOnce();
});

it('cancels the native export when leaving the settings page', async () => {
  const host = installExportHost();
  const { unmount } = await renderExport();
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  const sent = () => host.postMessage.mock.calls.map(([text]) => JSON.parse(text));
  const request = sent().find(message => message.action === 'exportData');
  expect(request.payload.expected_user_id).toBe(userId);
  unmount();
  expect(sent()).toContainEqual({
    version: 1, action: 'cancelFileAction', payload: { request_id: request.request_id },
  });
});
