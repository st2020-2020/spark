import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { ApiError } from '../api/errors';
import type { VerificationResult } from '../api/types';
import { createTestAdapter } from '../test-adapter/mockServer';

function open(path: string, adapter: ReturnType<typeof createTestAdapter>) {
  render(<MemoryRouter initialEntries={[path]}>
    <AppProviders api={adapter}><AppRoutes /></AppProviders>
  </MemoryRouter>);
}
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const grant = { challenge_id: 'new-challenge', expires_in: 600, resend_after: 60 };
afterEach(() => vi.restoreAllMocks());

it.each([
  ['/register', '6 位邮箱验证码', '验证并注册'],
  ['/reset-password', '6 位验证码', '确认重置密码'],
])('isolates pending and accepted challenges after changing the email on %s', async (path, label, submit) => {
  const api = createTestAdapter();
  let finish!: (value: VerificationResult) => void;
  let fail!: (cause: Error) => void;
  vi.spyOn(api, 'sendVerification')
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
    .mockResolvedValueOnce(grant);
  open(path, api);
  await screen.findByLabelText('邮箱');
  for (const email of ['a@example.test', 'b@example.test', 'a@example.test']) {
    change('邮箱', email);
    fireEvent.click(button('发送验证码'));
  }
  await screen.findByText(/请求已受理/);
  change(label, '001234');
  await act(async () => {
    finish({ challenge_id: 'old', expires_in: 0, resend_after: 0 });
    fail(new Error('旧请求错误'));
  });
  expect(screen.queryByText('旧请求错误')).toBeNull();
  expect(screen.getByLabelText(label)).toHaveValue('001234');
  expect(button(/秒后重发/)).toBeDisabled();
  change('邮箱', 'c@example.test');
  expect(screen.getByLabelText(label)).toHaveValue('');
  expect(button(submit)).toBeDisabled();
  expect(screen.queryByText(/请求已受理/)).toBeNull();
  expect(button('发送验证码')).toBeEnabled();
});

it('honors server cooldown and expiry, preserves invite and password, and submits only the newest challenge', async () => {
  const api = createTestAdapter();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const send = vi.spyOn(api, 'sendVerification')
    .mockRejectedValueOnce(new ApiError({ status: 429, code: 'rate_limited', message: '申请过于频繁', retryAfter: '5' }))
    .mockResolvedValueOnce({ ...grant, expires_in: 10, resend_after: 2 })
    .mockResolvedValueOnce({ ...grant, challenge_id: 'last' });
  const register = vi.spyOn(api, 'register').mockRejectedValue(new Error('邀请码不可用'));
  open('/register', api);
  await screen.findByLabelText('邮箱');
  change('邮箱', 'new@example.test');
  change('邀请码', 'TEST-INVITE-01');
  change('设置密码（12 至 128 位）', 'test-password-123');
  fireEvent.click(button('发送验证码'));
  await screen.findByText('申请过于频繁');
  expect(button('5 秒后重发')).toBeDisabled();
  clock.mockReturnValue(now + 5100);
  act(() => { window.dispatchEvent(new Event('focus')); });
  fireEvent.click(await screen.findByRole('button', { name: '发送验证码' }, { timeout: 2000 }));
  await screen.findByText(/请求已受理/);
  change('6 位邮箱验证码', '111111');
  clock.mockReturnValue(now + 16000);
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText(/验证码已过期/)).toBeInTheDocument();
  expect(button('验证并注册')).toBeDisabled();
  fireEvent.click(button('重新发送'));
  await waitFor(() => expect(screen.getByLabelText('6 位邮箱验证码')).toBeEnabled());
  expect(screen.getByLabelText('6 位邮箱验证码')).toHaveValue('');
  change('6 位邮箱验证码', '001234');
  fireEvent.click(button('验证并注册'));
  await screen.findByText('邀请码不可用');
  expect(send).toHaveBeenCalledTimes(3);
  expect(register).toHaveBeenCalledWith({
    email: 'new@example.test', challenge_id: 'last', verification_code: '001234',
    invite_code: 'TEST-INVITE-01', password: 'test-password-123',
  });
  expect(screen.getByLabelText('邀请码')).toHaveValue('TEST-INVITE-01');
});

it('keeps a failed reset editable and returns to login only after acceptance of the new password', async () => {
  const api = createTestAdapter();
  const reset = vi.spyOn(api, 'resetPassword').mockRejectedValueOnce(new Error('请检查验证码'));
  open('/reset-password', api);
  await screen.findByLabelText('邮箱');
  change('邮箱', 'admin@spark.local');
  fireEvent.click(button('发送验证码'));
  await screen.findByText(/如果该邮箱已注册/);
  change('6 位验证码', api.getLastVerificationCode('admin@spark.local')!);
  change('新密码（12 至 128 位）', 'changed-password-123');
  fireEvent.click(button('确认重置密码'));
  await screen.findByText('请检查验证码');
  expect(screen.getByLabelText('新密码（12 至 128 位）')).toHaveValue('changed-password-123');
  fireEvent.click(button('确认重置密码'));
  await screen.findByRole('heading', { name: '登录你的空间' });
  expect(reset).toHaveBeenCalledTimes(2);
  await expect(api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' })).rejects.toThrow();
  await expect(api.login({ email: 'admin@spark.local', password: 'changed-password-123' })).resolves.toBeDefined();
});
