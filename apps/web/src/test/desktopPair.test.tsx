import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import {
  clearPendingDesktopPair,
  formatPairCode,
  parseDesktopPairFragment,
  resolveSessionKind,
} from '../lib/devicePair';
import { createTestAdapter } from '../test-adapter/mockServer';

const DESKTOP_CHALLENGE = 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0F9e';
const EXT_CHALLENGE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function renderApp(initialPath = '/desktop/pair', adapter = createTestAdapter()) {
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

describe('Desktop pairing (/desktop/pair) and Settings macOS device management', () => {
  afterEach(() => {
    clearPendingDesktopPair();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('strips hash fragment, preserves across login, displays account/code/scope/30-day expiry, approves grant without holding bearer, and isolates/revokes macOS session in Settings', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    window.history.replaceState(null, '', `/desktop/pair#challenge=${DESKTOP_CHALLENGE}`);

    renderApp('/desktop/pair', adapter);

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });

    const expectedCode = formatPairCode(DESKTOP_CHALLENGE).grouped;
    expect(await screen.findByText(expectedCode)).toBeInTheDocument();
    expect(screen.getByText(/Spark macOS 桌面端/)).toBeInTheDocument();

    // Unauthenticated user navigates to login with /desktop/pair return target preserved
    await user.click(screen.getByRole('link', { name: '登录 Spark 并继续授权' }));
    await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
    await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));

    // Redirected back to /desktop/pair with clear account, device, code, scope, and 30-day expiry
    expect(await screen.findByRole('heading', { name: '确认绑定 macOS 桌面端' })).toBeInTheDocument();
    expect(screen.getByText('admin@spark.local')).toBeInTheDocument();
    expect(screen.getByText('Spark macOS 桌面端')).toBeInTheDocument();
    expect(screen.getByText('30 天（到期后需重新授权）')).toBeInTheDocument();
    expect(screen.getByText(expectedCode)).toBeInTheDocument();
    const permBox = screen.getByLabelText('macOS 桌面端操作权限说明');
    expect(permBox).toHaveTextContent('30 天到期');
    expect(permBox).toHaveTextContent('不含账号设置、AI 授权、设备配对');

    const approveSpy = vi.spyOn(adapter, 'approveDesktopGrant');
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));

    expect(await screen.findByRole('heading', { name: '已批准 macOS 桌面端连接' })).toBeInTheDocument();
    expect(approveSpy).toHaveBeenCalledWith({
      challenge: DESKTOP_CHALLENGE,
      expected_account_id: expect.any(String),
    });

    // Idempotent repeat within 5-minute window succeeds with same signed-in account
    await expect(
      adapter.approveDesktopGrant({
        challenge: DESKTOP_CHALLENGE,
        expected_account_id: approveSpy.mock.calls[0]![0].expected_account_id,
      }),
    ).resolves.toBeUndefined();

    // Account mismatch returns 409 desktop_account_changed
    await expect(
      adapter.approveDesktopGrant({
        challenge: DESKTOP_CHALLENGE,
        expected_account_id: '00000000-0000-4000-8000-999999999999',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'desktop_account_changed' });

    // Redeem desktop grant outside Web UI and verify Web never stores desktop bearer token
    const exchanged = await adapter.redeemDesktopGrantForTest(DESKTOP_CHALLENGE);
    expect(exchanged.account_label).toBe('admin@spark.local');
    expect(window.sessionStorage.getItem('spark:desktop-pair')).toBeNull();
    expect(JSON.stringify(window.sessionStorage)).not.toContain(exchanged.token);
    expect(JSON.stringify(window.localStorage)).not.toContain(exchanged.token);
    expect(document.body.textContent).not.toContain(exchanged.token);

    // Also add an extension session so Settings displays Web, Extension, and macOS Desktop distinctly
    await adapter.approveExtensionGrant({
      challenge: EXT_CHALLENGE,
      browser: 'chrome',
      expected_account_id: approveSpy.mock.calls[0]![0].expected_account_id,
    });
    await adapter.redeemExtensionGrantForTest(EXT_CHALLENGE);

    await user.click(screen.getByRole('link', { name: '查看与管理已绑定设备' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();

    const desktopLabel = await screen.findByText('Spark macOS 桌面端');
    const desktopRow = desktopLabel.closest<HTMLElement>('.sp-session-row');
    expect(desktopRow).not.toBeNull();
    expect(within(desktopRow!).getByText('macOS 桌面端')).toBeInTheDocument();
    expect(within(desktopRow!).getByText(/到期于/)).toBeInTheDocument();

    const extLabel = await screen.findByText('Spark 浏览器扩展 (Chrome)');
    const extRow = extLabel.closest<HTMLElement>('.sp-session-row');
    expect(extRow).not.toBeNull();
    expect(within(extRow!).getByText('浏览器扩展')).toBeInTheDocument();
    expect(screen.getByText('当前设备')).toBeInTheDocument();

    // Revoking macOS desktop session removes only the desktop device, preserving extension & web sessions
    await user.click(within(desktopRow!).getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(screen.queryByText('Spark macOS 桌面端')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Spark 浏览器扩展 (Chrome)')).toBeInTheDocument();
    expect(screen.getByText('当前设备')).toBeInTheDocument();
  });

  it('supports canceling authorization without calling POST /desktop/grants and clears stored challenge', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    const approveSpy = vi.spyOn(adapter, 'approveDesktopGrant');
    window.history.replaceState(null, '', `/desktop/pair#challenge=${DESKTOP_CHALLENGE}`);
    renderApp('/desktop/pair', adapter);

    expect(await screen.findByRole('heading', { name: '确认绑定 macOS 桌面端' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(await screen.findByRole('heading', { name: '收件箱' })).toBeInTheDocument();
    expect(approveSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('spark:desktop-pair')).toBeNull();
  });

  it('rejects missing/malformed fragments, stale/consumed challenges, and cross-type extension/desktop challenges', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    window.history.replaceState(null, '', '/desktop/pair#challenge=invalid-short');
    const badView = renderApp('/desktop/pair', adapter);

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(await screen.findByRole('heading', { name: '桌面配对请求无效' })).toBeInTheDocument();
    expect(parseDesktopPairFragment('#challenge=short')).toBeNull();
    expect(parseDesktopPairFragment(`#challenge=${DESKTOP_CHALLENGE}`)).toEqual({
      challenge: DESKTOP_CHALLENGE,
    });
    badView.unmount();

    // Pre-consume desktop challenge on another account, then submit in browser -> shows conflict alert
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.approveDesktopGrant({
      challenge: DESKTOP_CHALLENGE,
      expected_account_id: (await adapter.currentSession()).user.id,
    });
    await adapter.redeemDesktopGrantForTest(DESKTOP_CHALLENGE);

    window.history.replaceState(null, '', `/desktop/pair#challenge=${DESKTOP_CHALLENGE}`);
    renderApp('/desktop/pair', adapter);

    expect(await screen.findByRole('heading', { name: '确认绑定 macOS 桌面端' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/已失效、过期或已被使用/);
    expect(window.sessionStorage.getItem('spark:desktop-pair')).toBeNull();

    // Extension challenge cannot be approved as desktop grant and vice versa
    await adapter.approveExtensionGrant({
      challenge: EXT_CHALLENGE,
      browser: 'edge',
      expected_account_id: (await adapter.currentSession()).user.id,
    });
    await expect(
      adapter.approveDesktopGrant({
        challenge: EXT_CHALLENGE,
        expected_account_id: (await adapter.currentSession()).user.id,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'desktop_grant_conflict' });
  });

  it('shows account-changed error in UI when active session switches before confirm, and rejects expired 5-minute challenges', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    // Open /desktop/pair while browser renders admin@spark.local
    window.history.replaceState(null, '', `/desktop/pair#challenge=${DESKTOP_CHALLENGE}`);
    const v1 = renderApp('/desktop/pair', adapter);
    expect(await screen.findByRole('heading', { name: '确认绑定 macOS 桌面端' })).toBeInTheDocument();
    expect(screen.getByText('admin@spark.local')).toBeInTheDocument();

    // Another tab registers/switches active session to user B before user clicks 确认授权绑定
    const verif = await adapter.sendVerification({ email: 'switch-user@spark.local', purpose: 'register' });
    const code = adapter.getLastVerificationCode('switch-user@spark.local')!;
    await adapter.register({
      email: 'switch-user@spark.local',
      password: 'SwitchUser1234!',
      challenge_id: verif.challenge_id,
      verification_code: code,
      invite_code: 'SPARK-TEST-0002',
    });

    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/当前登录账号已变更/);
    expect(window.sessionStorage.getItem('spark:desktop-pair')).toBeNull();
    v1.unmount();

    // Pre-approve another challenge, advance clock past 5 minutes -> grant expired on both confirm & redeem
    const EXPIRED_CHALLENGE = 'M1n2O3p4Q5r6S7t8U9v0W1x2Y3z4A5b6C7d8E9f0G1h';
    const currentUserId = (await adapter.currentSession()).user.id;
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    await adapter.approveDesktopGrant({
      challenge: EXPIRED_CHALLENGE,
      expected_account_id: currentUserId,
    });

    nowSpy.mockReturnValue(baseNow + 5 * 60_000 + 1000);
    await expect(adapter.redeemDesktopGrantForTest(EXPIRED_CHALLENGE)).rejects.toMatchObject({
      status: 401,
      code: 'desktop_grant_invalid',
    });

    window.history.replaceState(null, '', `/desktop/pair#challenge=${EXPIRED_CHALLENGE}`);
    renderApp('/desktop/pair', adapter);
    expect(await screen.findByRole('heading', { name: '确认绑定 macOS 桌面端' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/已失效、过期或已被使用/);
    nowSpy.mockRestore();
  });

  it('renders macOS desktop pill in Settings for legacy session payloads using device_label fallback when kind is absent', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 30 * 86400_000).toISOString();
    vi.spyOn(adapter, 'listSessions').mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          device_label: 'Chrome · macOS',
          created_at: now,
          expires_at: exp,
          current: true,
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          device_label: 'Spark macOS 桌面端',
          created_at: now,
          expires_at: exp,
          current: false,
        },
      ],
    });

    expect(resolveSessionKind({ device_label: 'Spark macOS 桌面端' })).toBe('desktop');
    expect(resolveSessionKind({ kind: 'desktop', device_label: 'Custom' })).toBe('desktop');
    expect(resolveSessionKind({ kind: 'extension', device_label: 'Custom' })).toBe('extension');
    expect(resolveSessionKind({ device_label: 'Chrome · macOS' })).toBe('web');

    renderApp('/settings', adapter);
    const desktopText = await screen.findByText('Spark macOS 桌面端');
    const row = desktopText.closest<HTMLElement>('.sp-session-row');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('macOS 桌面端')).toBeInTheDocument();
    expect(within(row!).getByRole('button', { name: '撤销' })).toBeInTheDocument();
  });
});
