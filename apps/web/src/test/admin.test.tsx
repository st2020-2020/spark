import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { ApiError } from '../api/errors';
import type { User } from '../api/types';
import { createTestAdapter } from '../test-adapter/mockServer';

function renderAdminApp(adapter = createTestAdapter(), initialPath = '/admin') {
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

function makeUser(idx: number, overrides: Partial<User> = {}): User {
  return {
    id: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
    email: `member${idx}@spark.local`,
    role: 'user',
    status: 'active',
    ai_enabled: idx % 2 === 0,
    ai_policy_version: 1,
    ...overrides,
  };
}

describe('AdminPage T11 read-only users & independent module degradation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('denies non-admin user access and never queries admin endpoints', async () => {
    const adapter = createTestAdapter();
    const verif = await adapter.sendVerification({ email: 'member@spark.local', purpose: 'register' });
    await adapter.register({
      email: 'member@spark.local',
      password: 'Password123456!',
      challenge_id: verif.challenge_id,
      verification_code: adapter.getLastVerificationCode('member@spark.local')!,
      invite_code: 'SPARK-TEST-0001',
    });

    const listUsersSpy = vi.spyOn(adapter, 'listUsers');
    const getBudgetsSpy = vi.spyOn(adapter, 'getBudgets');
    const listBatchesSpy = vi.spyOn(adapter, 'listInviteBatches');

    renderAdminApp(adapter);
    await screen.findByText('无权访问管理后台');
    expect(listUsersSpy).not.toHaveBeenCalled();
    expect(getBudgetsSpy).not.toHaveBeenCalled();
    expect(listBatchesSpy).not.toHaveBeenCalled();
  });

  it('renders read-only user list with cursor pagination, deduplication, and zero account write buttons', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    const page1User1 = makeUser(1, { email: 'alpha@spark.local', role: 'admin', status: 'active' });
    const page1User2 = makeUser(2, { email: 'beta@spark.local', status: 'disabled', ai_enabled: true });
    const page2User3 = makeUser(3, { email: 'gamma@spark.local', status: 'active', ai_enabled: false });

    const setStatusSpy = vi.spyOn(adapter, 'setUserStatus');
    const listUsersSpy = vi
      .spyOn(adapter, 'listUsers')
      .mockResolvedValueOnce({
        items: [page1User1, page1User2],
        next_cursor: 'cursor-page-2',
      })
      .mockResolvedValueOnce({
        // Overlap page1User2 to verify dedupe across cursor pages
        items: [page1User2, page2User3],
        next_cursor: undefined,
      });

    renderAdminApp(adapter);

    const userSection = await screen.findByRole('region', { name: '用户管理' });
    await within(userSection).findByText('alpha@spark.local');
    expect(within(userSection).getByText('beta@spark.local')).toBeInTheDocument();
    expect(within(userSection).getByText('可查看账号角色、登录状态与 AI 整理设置')).toBeInTheDocument();

    // Unimplemented account write buttons must be removed
    expect(screen.queryByRole('button', { name: /禁用账号|恢复账号/ })).not.toBeInTheDocument();

    // Load page 2 via cursor pagination
    const loadMoreBtn = within(userSection).getByRole('button', { name: '加载更多' });
    await user.click(loadMoreBtn);

    await within(userSection).findByText('gamma@spark.local');
    expect(listUsersSpy).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 50 });
    expect(listUsersSpy).toHaveBeenNthCalledWith(2, { cursor: 'cursor-page-2', limit: 50 });
    expect(within(userSection).getAllByText('beta@spark.local')).toHaveLength(1);
    expect(within(userSection).queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it('shows empty user list state cleanly without blocking budgets or invites', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    vi.spyOn(adapter, 'listUsers').mockResolvedValueOnce({ items: [] });

    renderAdminApp(adapter);

    const userSection = await screen.findByRole('region', { name: '用户管理' });
    await within(userSection).findByText('暂无用户');
    await screen.findByLabelText(/平台日预算/);
    await screen.findByText('测试适配器初始批次');
  });

  it('degrades only user list on legacy 404 while keeping budgets and invite codes fully usable', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    vi.spyOn(adapter, 'listUsers').mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'not_found', message: 'not implemented' }),
    );
    const setBudgetsSpy = vi.spyOn(adapter, 'setBudgets');

    renderAdminApp(adapter);

    const userSection = await screen.findByRole('region', { name: '用户管理' });
    await within(userSection).findByText('用户列表暂未开放');
    expect(screen.queryByText('暂未开放，将在对应里程碑接入。')).not.toBeInTheDocument();

    // Invite batches & codes still work independently
    const inviteSection = screen.getByRole('region', { name: '邀请码批次列表' });
    await within(inviteSection).findByText('测试适配器初始批次');
    await user.click(within(inviteSection).getByRole('button', { name: '查看邀请码' }));
    await within(inviteSection).findByText('测试适配器初始批次 · 邀请码状态');

    // Budgets still load and save independently
    const budgetPlatform = await screen.findByLabelText(/平台日预算/);
    await user.clear(budgetPlatform);
    await user.type(budgetPlatform, '60000000');
    await user.click(screen.getByRole('button', { name: '保存预算' }));
    await screen.findByText(/预算配置已更新/);
    expect(setBudgetsSpy).toHaveBeenCalledTimes(1);
  });

  it('handles 403, 5xx retry, pagination failure, and independent budget 404 accurately', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    // 1. 403 forbidden shows permission message (not 404 fallback, no retry loop) & budgets still work
    vi.spyOn(adapter, 'listUsers').mockRejectedValueOnce(
      new ApiError({
        status: 403,
        code: 'forbidden',
        message: '需要 active 管理员账号',
        requestId: 'req-403',
      }),
    );

    const { unmount } = renderAdminApp(adapter);
    const userSection403 = await screen.findByRole('region', { name: '用户管理' });
    await within(userSection403).findByText('需要 active 管理员账号');
    expect(within(userSection403).queryByText('用户列表暂未开放')).not.toBeInTheDocument();
    expect(within(userSection403).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    await screen.findByLabelText(/平台日预算/);
    unmount();

    // 2. 5xx error supports retry -> succeeds -> page 2 failure keeps page 1 intact -> retry page 2 succeeds
    // Note: App QueryClient retries non-401/403/404 errors once (failureCount < 1) before entering error state.
    vi.restoreAllMocks();
    const err503 = new ApiError({
      status: 503,
      code: 'service_unavailable',
      message: '数据库暂时不可用',
      requestId: 'req-503-1',
    });
    const err500 = new ApiError({
      status: 500,
      code: 'internal_error',
      message: '下一页加载失败',
      requestId: 'req-500-2',
    });
    const listUsersSpy = vi
      .spyOn(adapter, 'listUsers')
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503)
      .mockResolvedValueOnce({
        items: [makeUser(10, { email: 'page1@spark.local' })],
        next_cursor: 'p2',
      })
      .mockRejectedValueOnce(err500)
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce({
        items: [makeUser(11, { email: 'page2@spark.local' })],
      });

    vi.spyOn(adapter, 'getBudgets').mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'not_found', message: 'not open' }),
    );

    renderAdminApp(adapter);
    const userSection = await screen.findByRole('region', { name: '用户管理' });
    await within(userSection).findByText('数据库暂时不可用', undefined, { timeout: 3500 });
    // Budget 404 only degrades budget block while user section stays active
    await screen.findByText('额度配置暂未开放');

    await user.click(within(userSection).getByRole('button', { name: '重试' }));
    await within(userSection).findByText('page1@spark.local');

    await user.click(within(userSection).getByRole('button', { name: '加载更多' }));
    await within(userSection).findByText('下一页加载失败', undefined, { timeout: 3500 });
    // Page 1 item remains visible when page 2 fails
    expect(within(userSection).getByText('page1@spark.local')).toBeInTheDocument();

    await user.click(within(userSection).getByRole('button', { name: '重试' }));
    await within(userSection).findByText('page2@spark.local');
    await waitFor(() => {
      expect(listUsersSpy).toHaveBeenCalledTimes(6);
    });
  }, 15000);
});

it('shows effective redemption states and updates them after the administrator disables a batch', async () => {
  const user = userEvent.setup();
  const api = createTestAdapter();
  await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
  const batch = (await api.listInviteBatches()).items[0];
  const base = { batch_id: batch.id, max_uses: 1, used_count: 0, disabled: false };
  vi.spyOn(api, 'listInviteCodes').mockResolvedValue({ items: [
    { ...base, id: 'used-code', used_count: 1 },
    { ...base, id: 'expired-code', expires_at: '2000-01-01T00:00:00Z' },
    { ...base, id: 'unused-code' },
  ] });
  renderAdminApp(api);
  const section = within(await screen.findByRole('region', { name: '邀请码批次列表' }));
  await user.click(await section.findByRole('button', { name: '查看邀请码' }));
  for (const state of ['已过期', '已兑换']) {
    const row = (await section.findByRole('cell', { name: state })).closest('tr')!;
    expect(within(row).getByRole('button', { name: '禁用' })).toBeDisabled();
  }
  await section.findByText('可用');
  await user.click(section.getByRole('button', { name: '禁用批次' }));
  expect(await section.findByText('批次已禁用')).toBeVisible();
  expect(section.queryByText('可用')).toBeNull();
});

it('keeps CSV after an expired preview and obtains a fresh preview for the unchanged file', async () => {
  const user = userEvent.setup();
  const api = createTestAdapter();
  await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
  const preview = vi.spyOn(api, 'previewInviteImport');
  const commit = vi.spyOn(api, 'commitInviteImport').mockRejectedValueOnce(
    new ApiError({ status: 410, code: 'import_expired', message: '预览过期，请重新校验。' }),
  );
  renderAdminApp(api);
  const csv = 'code,expires_at,max_uses\nFIRST-INVITE-01,,1';
  await user.type(await screen.findByLabelText('批次名称'), '邀请内测');
  await user.upload(screen.getByLabelText('选择 CSV 文件'), new File([csv], 'beta.csv', { type: 'text/csv' }));
  await waitFor(() => expect(screen.getByLabelText('CSV 内容')).toHaveValue(csv));
  const validate = screen.getByRole('button', { name: '预览校验' });
  const confirm = screen.getByRole('button', { name: '确认导入' });
  await user.click(validate);
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await screen.findByText('预览过期，请重新校验。');
  expect(confirm).toBeDisabled();
  expect(screen.getByLabelText('CSV 内容')).toHaveValue(csv);
  await user.click(validate);
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await screen.findByText('邀请内测');
  expect(preview.mock.calls[0][1]).not.toBe(preview.mock.calls[1][1]);
  expect(commit.mock.calls[0][0]).not.toBe(commit.mock.calls[1][0]);
});
