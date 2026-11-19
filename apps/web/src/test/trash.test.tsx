import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createRealApiClient } from '../api/client';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

beforeAll(() => {
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
  if (typeof document !== 'undefined' && !document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
});

beforeEach(() => {
  window.sessionStorage.clear();
});

function renderWithAdapter(
  initialEntries: string[] = ['/trash'],
  adapter: TestAdapter = createTestAdapter(),
) {
  return {
    adapter,
    ...render(
      <MemoryRouter initialEntries={initialEntries}>
        <AppProviders api={adapter}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    ),
  };
}

async function loginAsAdmin(
  user: ReturnType<typeof userEvent.setup>,
  adapter = createTestAdapter(),
  initialEntries: string[] = ['/login'],
) {
  const rendered = renderWithAdapter(initialEntries, adapter);
  await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
  await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
  return rendered;
}

function makeTextDocument(text: string) {
  return {
    schema_version: 1 as const,
    content: {
      type: 'doc' as const,
      content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
    },
  };
}

describe('T08 Trash & permanent purge UI', () => {
  it('supports expiry notice, mutual exclusion, confirmation modal, accepted status & manual refresh without polling', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const getPurgeSpy = vi.spyOn(adapter, 'getCollectionPurgeStatus');

    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const col = await adapter.createCollection(
      {
        id: '44444444-4444-4444-8444-444444444444',
        document: makeTextDocument('准备永久删除的测试收藏'),
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'k-trash-create-1',
    );
    await adapter.trashCollection(col.id, { base_resource_version: col.resource_version });
    await adapter.logout();

    adapter.setMockPurgeBehavior({ initialStatus: 'queued' });
    await loginAsAdmin(user, adapter);

    await user.click(screen.getByRole('link', { name: '回收站' }));
    await screen.findByRole('heading', { name: '回收站' });

    expect(await screen.findByText('准备永久删除的测试收藏')).toBeInTheDocument();
    expect(screen.getByText(/预计到期：/)).toBeInTheDocument();
    expect(screen.getByText(/剩余约 30 天/)).toBeInTheDocument();

    // Open confirmation modal -> background restore & purge buttons become disabled (mutual exclusion)
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    expect(await screen.findByRole('dialog', { name: '确认永久删除收藏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '恢复' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '永久删除' })).toBeDisabled();

    // Cancel keeps item in trash and re-enables both actions
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '恢复' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '永久删除' })).toBeEnabled();

    // Confirm purge -> 202 queued -> item removed immediately and accepted banner shown
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await user.click(await screen.findByRole('button', { name: '确认永久删除' }));

    expect(await screen.findByText('已受理，等待持久化回执')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('准备永久删除的测试收藏')).not.toBeInTheDocument();
    });

    // Zero periodic polling
    const callsBeforeWait = getPurgeSpy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(getPurgeSpy.mock.calls.length).toBe(callsBeforeWait);

    // On-demand status refresh: queued -> running -> completed
    adapter.setMockPurgeStatus(col.id, 'running');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByText('清理中（正在清理数据库或对象）')).toBeInTheDocument();

    adapter.setMockPurgeStatus(col.id, 'completed');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByText('永久删除已完成')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新状态' })).not.toBeInTheDocument();
  });

  it('keeps items operable after purge errors and refreshes stale resource_version on 409 conflict', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const purgeSpy = vi.spyOn(adapter, 'purgeCollection');

    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const colA = await adapter.createCollection(
      {
        id: '55555555-5555-4555-8555-555555555551',
        document: makeTextDocument('冲突后仍可永久删除的收藏'),
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'k-trash-err-a',
    );
    await adapter.trashCollection(colA.id, { base_resource_version: colA.resource_version });

    const colB = await adapter.createCollection(
      {
        id: '55555555-5555-4555-8555-555555555552',
        document: makeTextDocument('失败后仍可恢复的收藏'),
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'k-trash-err-b',
    );
    await adapter.trashCollection(colB.id, { base_resource_version: colB.resource_version });
    await adapter.logout();

    await loginAsAdmin(user, adapter);
    await user.click(screen.getByRole('link', { name: '回收站' }));
    await screen.findByText('冲突后仍可永久删除的收藏');

    // 1. 503 integration_not_configured leaves item in trash and still allows restore
    adapter.setMockPurgeBehavior({ unconfigured: true });
    const purgeButtons = screen.getAllByRole('button', { name: '永久删除' });
    await user.click(purgeButtons[0]);
    await user.click(await screen.findByRole('button', { name: '确认永久删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('永久删除暂未开启。');
    expect(screen.getByText('失败后仍可恢复的收藏')).toBeInTheDocument();

    const restoreButtons = screen.getAllByRole('button', { name: '恢复' });
    await user.click(restoreButtons[0]);
    await waitFor(() => {
      expect(screen.queryByText('失败后仍可恢复的收藏')).not.toBeInTheDocument();
    });

    // 2. 409 resource_conflict refreshes resource_version and lets retry succeed with a new Idempotency-Key
    adapter.setMockPurgeBehavior({ unconfigured: false, conflictOnce: true, initialStatus: 'completed' });
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await user.click(await screen.findByRole('button', { name: '确认永久删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('收藏版本已变更');
    expect(screen.getByText('冲突后仍可永久删除的收藏')).toBeInTheDocument();

    // Retry after conflict refresh
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '永久删除' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await user.click(await screen.findByRole('button', { name: '确认永久删除' }));

    expect(await screen.findByText('永久删除已完成')).toBeInTheDocument();
    expect(purgeSpy).toHaveBeenCalledTimes(3);
    expect(purgeSpy.mock.calls[2]?.[2]).not.toBe(purgeSpy.mock.calls[1]?.[2]);
  });

  it('shows exact expiry and permanent purge flow on detail page, including 404 purge status lookup for owner only', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();

    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const col = await adapter.createCollection(
      {
        id: '66666666-6666-4666-8666-666666666666',
        document: makeTextDocument('详情页回收站永久删除测试'),
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'k-detail-purge-1',
    );
    await adapter.trashCollection(col.id, { base_resource_version: col.resource_version });
    await adapter.logout();

    adapter.setMockPurgeBehavior({ initialStatus: 'running' });
    const firstRender = await loginAsAdmin(user, adapter);
    await user.click(screen.getByRole('link', { name: '回收站' }));
    await user.click(await screen.findByRole('link', { name: '查看详情' }));

    expect(await screen.findByText('此收藏位于回收站')).toBeInTheDocument();
    expect(screen.getByText(/到期时间/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '永久删除' }));
    await user.click(await screen.findByRole('button', { name: '确认永久删除' }));

    expect(await screen.findByText('清理中（正在清理数据库或对象）')).toBeInTheDocument();
    adapter.setMockPurgeStatus(col.id, 'completed');
    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByText('永久删除已完成')).toBeInTheDocument();
    firstRender.unmount();

    // Fresh route visit after purge: owner sees completed status via GET /purge instead of resurrection
    const ownerReload = renderWithAdapter([`/collections/${col.id}`], adapter);
    expect(await screen.findByText('永久删除已完成')).toBeInTheDocument();
    ownerReload.unmount();

    // Different account sees standard 404 (no cross-account status leak)
    await adapter.logout();
    const ver = await adapter.sendVerification({
      email: 'other-t08@example.test',
      purpose: 'register',
    });
    const code = adapter.getLastVerificationCode('other-t08@example.test')!;
    await adapter.register({
      email: 'other-t08@example.test',
      password: 'Password1234!',
      challenge_id: ver.challenge_id,
      verification_code: code,
      invite_code: 'SPARK-TEST-0001',
    });

    renderWithAdapter([`/collections/${col.id}`], adapter);
    expect(await screen.findByRole('alert')).toHaveTextContent('收藏不存在');
    expect(screen.queryByText('永久删除已完成')).not.toBeInTheDocument();
  });

  it('calls real GET and POST /collections/{id}/purge endpoints with expected headers and body', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: {
              id: 'u1',
              email: 'u1@example.com',
              role: 'user',
              status: 'active',
              ai_enabled: false,
              ai_policy_version: 1,
            },
            csrf_token: 'csrf-purge-1',
            expires_at: '2030-01-01T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      const api = createRealApiClient();
      await api.login({ email: 'u1@example.com', password: 'password123456' });

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ operation_id: 'op-123', status: 'queued' }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
      );
      const accepted = await api.purgeCollection('col-9', { base_resource_version: 4 }, 'idem-p-1');
      expect(accepted).toEqual({ operation_id: 'op-123', status: 'queued' });

      const [postUrl, postInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(postUrl).toBe('/api/v1/collections/col-9/purge');
      expect(postInit.method).toBe('POST');
      expect(postInit.body).toBe(JSON.stringify({ base_resource_version: 4 }));
      const postHeaders = new Headers(postInit.headers);
      expect(postHeaders.get('X-CSRF-Token')).toBe('csrf-purge-1');
      expect(postHeaders.get('Idempotency-Key')).toBe('idem-p-1');

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ operation_id: 'op-123', status: 'running' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      const status = await api.getCollectionPurgeStatus('col-9');
      expect(status).toEqual({ operation_id: 'op-123', status: 'running' });
      const [getUrl, getInit] = fetchMock.mock.calls[2] as [string, RequestInit];
      expect(getUrl).toBe('/api/v1/collections/col-9/purge');
      expect(getInit.method).toBe('GET');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
