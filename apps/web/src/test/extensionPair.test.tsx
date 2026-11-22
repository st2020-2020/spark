import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createTestAdapter } from '../test-adapter/mockServer';
import {
  clearPendingExtensionPair,
  formatPairCode,
  parseExtensionPairFragment,
} from '../lib/extensionPair';

const SAMPLE_CHALLENGE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function renderApp(initialPath = '/extension/pair', adapter = createTestAdapter()) {
  return {
    adapter,
    ...render(
      <MemoryRouter initialEntries={[initialPath]}>
        <AppProviders api={adapter}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    ),
  };
}

describe('Extension pairing and Settings device management', () => {
  afterEach(() => {
    clearPendingExtensionPair();
    window.history.replaceState(null, '', '/');
  });

  it('parses fragment challenge, strips URL hash immediately, preserves across login, approves grant, and rejects stale/changed account', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    window.history.replaceState(
      null,
      '',
      `/extension/pair#challenge=${SAMPLE_CHALLENGE}&browser=chrome`,
    );

    renderApp('/extension/pair', adapter);

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });

    const expectedCode = formatPairCode(SAMPLE_CHALLENGE).grouped;
    expect(await screen.findByText(expectedCode)).toBeInTheDocument();
    expect(screen.getByText(/Spark 浏览器扩展 \(Chrome\)/)).toBeInTheDocument();

    // Unauthenticated user navigates to login with return target preserved
    await user.click(screen.getByRole('link', { name: '登录 Spark 并继续授权' }));
    await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
    await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));

    // Redirected back to /extension/pair with user email, device, code and minimal scope
    expect(await screen.findByRole('heading', { name: '确认绑定浏览器扩展' })).toBeInTheDocument();
    expect(screen.getByText('admin@spark.local')).toBeInTheDocument();
    expect(screen.getByText(expectedCode)).toBeInTheDocument();
    expect(screen.getByLabelText('扩展操作权限说明')).toHaveTextContent('仅项目 ID 与名称');

    const approveSpy = vi.spyOn(adapter, 'approveExtensionGrant');
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));

    expect(await screen.findByRole('heading', { name: '已批准扩展连接' })).toBeInTheDocument();
    expect(approveSpy).toHaveBeenCalledWith({
      challenge: SAMPLE_CHALLENGE,
      browser: 'chrome',
      expected_account_id: expect.any(String),
    });

    // Idempotent repeat within 5-minute window succeeds with same signed-in account
    await expect(
      adapter.approveExtensionGrant({
        challenge: SAMPLE_CHALLENGE,
        browser: 'chrome',
        expected_account_id: approveSpy.mock.calls[0]![0].expected_account_id,
      }),
    ).resolves.toBeUndefined();

    // Account mismatch returns 409 extension_account_changed
    await expect(
      adapter.approveExtensionGrant({
        challenge: SAMPLE_CHALLENGE,
        browser: 'chrome',
        expected_account_id: '00000000-0000-4000-8000-999999999999',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'extension_account_changed' });

    // Consume grant as extension token exchange and check Settings device list + single revocation
    const exchanged = await adapter.redeemExtensionGrantForTest(SAMPLE_CHALLENGE);
    expect(exchanged.account_label).toBe('admin@spark.local');
    expect(exchanged.token).toBeTruthy();

    await user.click(screen.getByRole('link', { name: '查看与管理已绑定设备' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();

    const extLabel = await screen.findByText('Spark 浏览器扩展 (Chrome)');
    const extRow = extLabel.closest<HTMLElement>('.sp-session-row');
    expect(extRow).not.toBeNull();
    expect(within(extRow!).getByText('浏览器扩展')).toBeInTheDocument();
    expect(within(extRow!).getByText(/到期于/)).toBeInTheDocument();

    await user.click(within(extRow!).getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(screen.queryByText('Spark 浏览器扩展 (Chrome)')).not.toBeInTheDocument();
    });
  });

  it('rejects missing or invalid pairing fragment cleanly', async () => {
    window.history.replaceState(null, '', '/extension/pair#challenge=too-short&browser=safari');
    renderApp('/extension/pair');

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(await screen.findByRole('heading', { name: '扩展配对请求无效' })).toBeInTheDocument();
    expect(parseExtensionPairFragment('#challenge=short&browser=chrome')).toBeNull();
    expect(parseExtensionPairFragment(`#challenge=${SAMPLE_CHALLENGE}&browser=edge`)).toEqual({
      challenge: SAMPLE_CHALLENGE,
      browser: 'edge',
    });
  });

  it('displays conflict error when submitting stale challenge after account mismatch', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    // Consume the challenge under another grant/consumption flow first
    await adapter.approveExtensionGrant({
      challenge: SAMPLE_CHALLENGE,
      browser: 'edge',
      expected_account_id: '00000000-0000-4000-8000-000000000001',
    });
    await adapter.redeemExtensionGrantForTest(SAMPLE_CHALLENGE);

    window.history.replaceState(
      null,
      '',
      `/extension/pair#challenge=${SAMPLE_CHALLENGE}&browser=edge`,
    );
    renderApp('/extension/pair', adapter);

    expect(await screen.findByRole('heading', { name: '确认绑定浏览器扩展' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/已失效或已被使用/);
  });
});
