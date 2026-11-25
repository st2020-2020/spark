import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { saveAcceptedPurges, loadAcceptedPurges } from '../lib/purge';
import { ApiError } from '../api/errors';
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
  it.each([false, undefined])('keeps only restore and prior receipts when purge_enabled is %s', async flag => {
    const api = createTestAdapter();
    const session = await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const col = await api.createCollection({ id: crypto.randomUUID(), document: makeTextDocument('草图'),
      intent: '', upload_ids: [], project_ids: [], tag_ids: [] }, 'trash-seed');
    await api.trashCollection(col.id, { base_resource_version: col.resource_version });
    vi.spyOn(api, 'currentSession').mockResolvedValue({ ...session, purge_enabled: flag });
    saveAcceptedPurges(session.user.id, [{ collectionId: crypto.randomUUID(), operationId: crypto.randomUUID(), status: 'queued' }]);
    const purge = vi.spyOn(api, 'purgeCollection');
    renderWithAdapter(['/trash'], api);
    await screen.findByText('草图');
    expect(screen.getByRole('region', { name: '已受理永久删除任务' })).toHaveTextContent('已受理');
    expect(screen.getByText(/当前环境未开启永久删除功能/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '永久删除' })).toBeNull();
    expect(screen.queryByRole('button', { name: '清空回收站' })).toBeNull();
    expect(screen.queryByRole('button', { name: /彻底清除所选/ })).toBeNull();
    expect(screen.queryByText(/预计到期|自动清理|剩余约/)).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: '查看详情' }));
    await screen.findByText('此收藏位于回收站');
    expect(screen.queryByRole('button', { name: '永久删除' })).toBeNull();
    expect(screen.queryByText(/到期时间|剩余约/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '恢复' }));
    await screen.findByRole('button', { name: '编辑' });
    expect(purge).not.toHaveBeenCalled();
  });

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
    expect(screen.getByText(/剩余约 30 天后自动清理/)).toBeInTheDocument();
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

  it('retains all unfinished purge records beyond 20 while capping completed history and flushing once', () => {
    const userId = 'u-bound-test';
    const mixed = [
      ...Array.from({ length: 25 }, (_, i) => ({
        collectionId: `pending-${i}`,
        operationId: `op-p-${i}`,
        status: (i % 2 === 0 ? 'queued' : 'running') as 'queued' | 'running',
      })),
      ...Array.from({ length: 28 }, (_, i) => ({
        collectionId: `done-${i}`,
        operationId: `op-d-${i}`,
        status: 'completed' as const,
      })),
    ];
    const saved = saveAcceptedPurges(userId, mixed);
    const reloaded = loadAcceptedPurges(userId);
    expect(saved).toHaveLength(45);
    expect(reloaded.filter((r) => r.status !== 'completed')).toHaveLength(25);
    expect(reloaded.filter((r) => r.status === 'completed')).toHaveLength(20);
  });

  it('supports multi-select batch purge with irreversible confirmation while keeping unselected items', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const ids: string[] = [];
    for (const text of ['批量条目一', '批量条目二', '保留条目三']) {
      const col = await adapter.createCollection(
        {
          id: crypto.randomUUID(),
          document: makeTextDocument(text),
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        `seed-${text}`,
      );
      await adapter.trashCollection(col.id, { base_resource_version: col.resource_version });
      ids.push(col.id);
    }

    adapter.setMockPurgeBehavior({ initialStatus: 'completed' });
    renderWithAdapter(['/trash'], adapter);
    await screen.findByText('保留条目三');

    await user.click(screen.getByRole('checkbox', { name: '选择「批量条目一」' }));
    await user.click(screen.getByRole('checkbox', { name: '选择「批量条目二」' }));
    expect(screen.getByText('已选 2 条')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '彻底清除所选 (2)' }));
    expect(await screen.findByRole('dialog', { name: '确认永久删除所选收藏' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认永久删除 (2 条)' }));

    await waitFor(() => {
      expect(screen.queryByText('批量条目一')).not.toBeInTheDocument();
      expect(screen.queryByText('批量条目二')).not.toBeInTheDocument();
    });
    expect(screen.getByText('保留条目三')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '批量永久删除进度与结果' })).toHaveTextContent(
      '本批共 2 条：已受理 2 条（笔记与附件均已永久删除）',
    );
    expect(ids).toHaveLength(3);
  });

  it('enumerates all pages across >30 items for purge-all, keeps all unfinished tracking in storage without per-item O(n^2) rewrites, and skips post-confirm new or restored items', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const session = await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    // Seed 35 trashed collections (> 1 loaded page of 30)
    const seeded: Array<{ id: string; version: number }> = [];
    for (let i = 0; i < 35; i += 1) {
      const col = await adapter.createCollection(
        {
          id: crypto.randomUUID(),
          document: makeTextDocument(`跨页待清条目-${String(i).padStart(2, '0')}`),
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        `seed-all-${i}`,
      );
      const trashed = await adapter.trashCollection(col.id, {
        base_resource_version: col.resource_version,
      });
      seeded.push({ id: trashed.id, version: trashed.resource_version });
    }
    // Keep 1 active item to trash AFTER confirmation opens
    const lateNote = await adapter.createCollection(
      {
        id: crypto.randomUUID(),
        document: makeTextDocument('确认后新移入的收藏'),
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'seed-late',
    );

    // Force enumeration pagination even under limit=100 by temporarily capping mock page slice via wrapper spy
    const rawList = adapter.listCollections.bind(adapter);
    const listSpy = vi.spyOn(adapter, 'listCollections').mockImplementation(async (query, signal) => {
      if (query?.scope === 'trash' && (query.limit ?? 30) > 20) {
        return rawList({ ...query, limit: 20 }, signal);
      }
      return rawList(query, signal);
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    let inFlight = 0;
    let maxInFlight = 0;
    const rawPurge = adapter.purgeCollection.bind(adapter);
    const purgeSpy = vi
      .spyOn(adapter, 'purgeCollection')
      .mockImplementation(async (id, body, idempotencyKey) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 5));
          return await rawPurge(id, body, idempotencyKey);
        } finally {
          inFlight -= 1;
        }
      });

    adapter.setMockPurgeBehavior({ initialStatus: 'queued' });
    renderWithAdapter(['/trash'], adapter);
    await screen.findByRole('button', { name: '清空回收站' });

    setItemSpy.mockClear();
    await user.click(screen.getByRole('button', { name: '清空回收站' }));
    const confirmDialog = await screen.findByRole('dialog', { name: '确认清空回收站' });
    expect(confirmDialog).toHaveTextContent('35 条');

    // Mutate state AFTER confirmation opens: trash 1 new item & restore 1 confirmed item externally
    await adapter.trashCollection(lateNote.id, { base_resource_version: lateNote.resource_version });
    await adapter.restoreCollection(seeded[0].id, { base_resource_version: seeded[0].version });

    await user.click(screen.getByRole('button', { name: '确认清空 (35 条)' }));

    await waitFor(() => {
      expect(screen.getByRole('region', { name: '批量永久删除进度与结果' })).toHaveTextContent(
        '本批共 35 条：已受理 34 条（0 条已清除，34 条等待或正在清理附件，暂未确认全部附件清完），版本冲突或已恢复 1 条（未删除）',
      );
    });

    // Bounded concurrency <= 3, confirmed snapshot NEVER expanded to lateNote, and O(1) batch sessionStorage flush
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(purgeSpy).toHaveBeenCalledTimes(35);
    expect(purgeSpy.mock.calls.some(([id]) => id === lateNote.id)).toBe(false);
    expect(setItemSpy).toHaveBeenCalledTimes(1);

    // All 34 unfinished queued items remain persisted in sessionStorage (item #21..#34 NOT truncated!)
    const storedPending = loadAcceptedPurges(session.user.id);
    expect(storedPending).toHaveLength(34);
    expect(await screen.findByText('确认后新移入的收藏')).toBeInTheDocument();
    expect(listSpy).toHaveBeenCalled();
  });

  it('aborts purge-all with zero partial deletions if enumerating full trash pages fails', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    for (let i = 0; i < 3; i += 1) {
      const col = await adapter.createCollection(
        {
          id: crypto.randomUUID(),
          document: makeTextDocument(`枚举失败保护-${i}`),
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        `enum-fail-${i}`,
      );
      await adapter.trashCollection(col.id, { base_resource_version: col.resource_version });
    }

    const purgeSpy = vi.spyOn(adapter, 'purgeCollection');
    renderWithAdapter(['/trash'], adapter);
    await screen.findByText('枚举失败保护-0');

    vi.spyOn(adapter, 'listCollections').mockRejectedValueOnce(
      new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: '列表查询暂时不可用',
      }),
    );

    await user.click(screen.getByRole('button', { name: '清空回收站' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '获取全部回收站列表失败，未执行任何删除：列表查询暂时不可用',
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(purgeSpy).not.toHaveBeenCalled();
    expect(screen.getByText('枚举失败保护-0')).toBeInTheDocument();
  });

  it('retries only failed batch items using the exact original Idempotency-Key', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const cols: string[] = [];
    for (const label of ['重试样本A', '重试样本B', '重试样本C']) {
      const col = await adapter.createCollection(
        {
          id: crypto.randomUUID(),
          document: makeTextDocument(label),
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        `retry-${label}`,
      );
      await adapter.trashCollection(col.id, { base_resource_version: col.resource_version });
      cols.push(col.id);
    }

    const rawPurge = adapter.purgeCollection.bind(adapter);
    let failSecondOnce = true;
    const purgeSpy = vi
      .spyOn(adapter, 'purgeCollection')
      .mockImplementation(async (id, body, idempotencyKey) => {
        if (id === cols[1] && failSecondOnce) {
          failSecondOnce = false;
          throw new ApiError({
            status: 503,
            code: 'service_unavailable',
            message: '网络波动，结果未知',
          });
        }
        return rawPurge(id, body, idempotencyKey);
      });

    renderWithAdapter(['/trash'], adapter);
    await screen.findByText('重试样本B');

    await user.click(screen.getByRole('button', { name: '清空回收站' }));
    await user.click(await screen.findByRole('button', { name: '确认清空 (3 条)' }));

    const retryBtn = await screen.findByRole('button', { name: '原键重试失败项 (1)' });
    expect(screen.getByRole('region', { name: '批量永久删除进度与结果' })).toHaveTextContent(
      '可重试失败 1 条（保留原幂等键）',
    );

    const firstKeyForB = purgeSpy.mock.calls.find(([id]) => id === cols[1])?.[2];
    expect(firstKeyForB).toBeTruthy();

    await user.click(retryBtn);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: '批量永久删除进度与结果' })).toHaveTextContent(
        '本批共 3 条：已受理 3 条',
      );
    });

    // Retried ONLY the failed item (total 4 calls: 3 initial + 1 retry) with identical Idempotency-Key
    expect(purgeSpy).toHaveBeenCalledTimes(4);
    expect(purgeSpy.mock.calls[3]?.[0]).toBe(cols[1]);
    expect(purgeSpy.mock.calls[3]?.[2]).toBe(firstKeyForB);
  });

  it('aborts in-flight batch purge immediately on account switch without cross-account leakage', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    for (let i = 0; i < 4; i += 1) {
      const col = await adapter.createCollection(
        {
          id: crypto.randomUUID(),
          document: makeTextDocument(`切号中止-${i}`),
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        `switch-abort-${i}`,
      );
      await adapter.trashCollection(col.id, { base_resource_version: col.resource_version });
    }
    await adapter.logout();

    // Register user B ahead of time
    const ver = await adapter.sendVerification({ email: 'user-b-trash@example.test', purpose: 'register' });
    const code = adapter.getLastVerificationCode('user-b-trash@example.test')!;
    await adapter.register({
      email: 'user-b-trash@example.test',
      password: 'Password1234!',
      challenge_id: ver.challenge_id,
      verification_code: code,
      invite_code: 'SPARK-TEST-0001',
    });
    await adapter.logout();

    await loginAsAdmin(user, adapter);
    await user.click(screen.getByRole('link', { name: '回收站' }));
    await screen.findByText('切号中止-0');

    let resolveFirstPurge!: (val: { operation_id: string; status: 'completed' }) => void;
    const firstPurgeBlocked = new Promise<{ operation_id: string; status: 'completed' }>((res) => {
      resolveFirstPurge = res;
    });
    const purgeSpy = vi
      .spyOn(adapter, 'purgeCollection')
      .mockImplementation(() => firstPurgeBlocked);

    await user.click(screen.getByRole('button', { name: '清空回收站' }));
    await user.click(await screen.findByRole('button', { name: '确认清空 (4 条)' }));

    await waitFor(() => {
      expect(purgeSpy).toHaveBeenCalled();
    });
    const callsAtSwitch = purgeSpy.mock.calls.length;

    // Logout & sign in as User B while User A's batch requests are still in-flight
    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await screen.findByLabelText('邮箱');

    resolveFirstPurge({ operation_id: 'op-late-a', status: 'completed' });
    await new Promise((r) => setTimeout(r, 20));

    // Must not dispatch any remaining items after session change
    expect(purgeSpy.mock.calls.length).toBe(callsAtSwitch);

    await user.type(screen.getByLabelText('邮箱'), 'user-b-trash@example.test');
    await user.type(screen.getByLabelText('密码'), 'Password1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByRole('heading', { name: '收件箱' });
    await user.click(screen.getByRole('link', { name: '回收站' }));
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '已受理永久删除任务' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '批量永久删除进度与结果' })).not.toBeInTheDocument();
  });
});
