import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DataExport } from '../components/DataExport';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('downloads the selected format once and releases the private URL when the account view closes', async () => {
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
  const { unmount } = render(<DataExport preview={false} onSessionExpired={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  const link = await screen.findByRole('link', { name: '再次下载此文件' });
  expect(link).toHaveAttribute('download', 'spark-export-20261118.zip');
  expect(fetchFile).toHaveBeenCalledExactlyOnceWith('/api/v1/me/export?format=json', expect.objectContaining({
    credentials: 'same-origin', cache: 'no-store',
  }));
  expect(click).toHaveBeenCalledOnce();
  unmount();
  expect(revoke).toHaveBeenCalledWith('blob:synthetic-test');
});

it('honors the server retry time for both export formats', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '17' } })));
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  render(<DataExport preview={false} onSessionExpired={vi.fn()} />);
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
  const { unmount } = render(<DataExport preview={false} onSessionExpired={expired} />);
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  await waitFor(() => expect(expired).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: '下载 ZIP' }));
  expect(screen.getByRole('button', { name: '正在准备下载…' })).toBeDisabled();
  const signal = fetchFile.mock.calls[1][1].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
});
