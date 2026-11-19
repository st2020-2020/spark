import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { SparkDocument } from '../api/types';
import { ApiError } from '../api/errors';
import { AppProviders, AppRoutes } from '../App';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

function makeTextDoc(text: string): SparkDocument {
  return {
    schema_version: 1,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
  };
}

function renderWithAdapter(
  initialEntries: string[] = ['/unclassified/triage'],
  adapter: TestAdapter = createTestAdapter(),
  strictMode = false,
) {
  const tree = (
    <MemoryRouter initialEntries={initialEntries}>
      <AppProviders api={adapter}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>
  );
  return {
    adapter,
    ...render(strictMode ? <StrictMode>{tree}</StrictMode> : tree),
  };
}

async function seedAdminProject(adapter: TestAdapter, name: string, key: string) {
  return adapter.createProject({ name, description: '', focus_points: [] }, key);
}

async function seedAdminCollection(
  adapter: TestAdapter,
  opts: { id: string; text: string; intent?: string; projectIds?: string[] },
) {
  return adapter.createCollection(
    {
      id: opts.id,
      document: makeTextDoc(opts.text),
      intent: opts.intent ?? '',
      upload_ids: [],
      project_ids: opts.projectIds ?? [],
      tag_ids: [],
    },
    `seed-${opts.id}`,
  );
}

describe('Triage mode (/unclassified/triage)', () => {
  it('shows entry points in UnclassifiedPage and InboxPage without extra unclassified count requests', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const proj = await seedAdminProject(adapter, '归类目标', 'proj-entry-1');
    const colUnclassified = await seedAdminCollection(adapter, {
      id: '10000000-0000-4000-8000-000000000001',
      text: '待归类的收件箱笔记',
    });

    const listSpy = vi.spyOn(adapter, 'listCollections');
    const user = userEvent.setup();
    renderWithAdapter(['/inbox'], adapter);

    await screen.findByText('待归类的收件箱笔记');
    expect(await screen.findByRole('link', { name: /有待归类的收藏，开始整理/ })).toBeInTheDocument();
    expect(listSpy.mock.calls.some(([q]) => q?.scope === 'unclassified')).toBe(false);

    // Clicking Inbox triage hint navigates to /unclassified/triage
    await user.click(screen.getByRole('link', { name: /有待归类的收藏，开始整理/ }));
    await screen.findByRole('heading', { name: '快速整理' });
    await screen.findByText('待归类的收件箱笔记');

    // Classify the only unclassified note, then verify Inbox hides hint cleanly
    await user.click(await screen.findByRole('button', { name: /归类目标/ }));
    await screen.findByRole('heading', { name: '本轮整理完成' });
    await user.click(screen.getByRole('link', { name: '返回收件箱' }));
    await screen.findByText('待归类的收件箱笔记');
    expect(screen.queryByRole('link', { name: /有待归类的收藏，开始整理/ })).not.toBeInTheDocument();

    // UnclassifiedPage still provides header "开始整理" primary link
    await user.click(within(screen.getByRole('complementary', { name: '主导航' })).getByRole('link', { name: '待归类' }));
    expect(await screen.findByRole('link', { name: '开始整理' })).toHaveAttribute(
      'href',
      '/unclassified/triage',
    );
    expect(proj.id).toBeTruthy();
    expect(colUnclassified.id).toBeTruthy();
  });

  it('orders suggested projects first, supports single-tap, multi-select operations, single last undo, and completion view', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true });

    const pAlpha = await seedAdminProject(adapter, '常规项目 A', 'proj-triage-a');
    const pSuggested = await seedAdminProject(adapter, '研究清单', 'proj-triage-s');
    await seedAdminProject(adapter, '常规项目 B', 'proj-triage-b');

    const c1 = await seedAdminCollection(adapter, {
      id: '20000000-0000-4000-8000-000000000001',
      text: '需要放入研究清单的重要线索',
      intent: '调研阶段使用',
    });
    const c2 = await seedAdminCollection(adapter, {
      id: '20000000-0000-4000-8000-000000000002',
      text: '多项目共用规范文档',
    });

    // Wait for mock org to attach suggested association on c1 & c2
    await waitFor(async () => {
      const latest1 = await adapter.getCollection(c1.id);
      const latest2 = await adapter.getCollection(c2.id);
      expect(latest1.organization.status).toBe('succeeded');
      expect(latest2.organization.status).toBe('succeeded');
    });

    const patchSpy = vi.spyOn(adapter, 'updateProjectDecisions');
    const undoSpy = vi.spyOn(adapter, 'undoProjectDecisions');
    const user = userEvent.setup();

    renderWithAdapter(['/unclassified/triage'], adapter, true);

    await screen.findByText('本轮已处理 0 条');
    await waitFor(() => {
      expect(screen.getByRole('article', { name: '当前待归类收藏' })).toHaveTextContent(
        /多项目共用规范文档|需要放入研究清单的重要线索/,
      );
    });

    // Ensure c1 appears by skipping once if c2 is on front
    const frontCard = screen.getByRole('article', { name: '当前待归类收藏' });
    if (within(frontCard).queryAllByText('多项目共用规范文档').length > 0) {
      await user.click(screen.getByRole('button', { name: '跳过' }));
      await waitFor(() =>
        expect(
          within(screen.getByRole('article', { name: '当前待归类收藏' })).queryAllByText(
            '需要放入研究清单的重要线索',
          ).length,
        ).toBeGreaterThan(0),
      );
    }

    // Verify AI suggestion evidence and that 研究清单 (suggested) appears FIRST in candidate tapes
    await screen.findByText(/建议归入：研究清单/);
    await screen.findByText(/推荐理由：/);
    const tapesGroup = screen.getByRole('group', { name: '候选项目纸胶带' });
    const tapeButtons = within(tapesGroup).getAllByRole('button');
    expect(tapeButtons[0]).toHaveTextContent('研究清单');
    expect(tapeButtons[0]).toHaveTextContent('建议');

    // Multi-select two projects and submit once via operations array
    await user.click(screen.getByRole('button', { name: '多选项目' }));
    await user.click(within(tapesGroup).getByRole('button', { name: /常规项目 A/ }));
    await user.click(within(tapesGroup).getByRole('button', { name: /研究清单/ }));
    await user.click(screen.getByRole('button', { name: '确认归入（2）' }));

    await screen.findByText('本轮已处理 1 条');
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy.mock.calls[0][1].operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pAlpha.id, action: 'include' }),
        expect.objectContaining({
          id: pSuggested.id,
          action: 'include',
          expected_suggestion: expect.objectContaining({ project_version: pSuggested.version }),
        }),
      ]),
    );
    expect(patchSpy.mock.calls[0][2]).toBeTruthy();

    // Advance to next card (c2) and single-tap commit
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: '当前待归类收藏' })).queryAllByText(
          '多项目共用规范文档',
        ).length,
      ).toBeGreaterThan(0),
    );
    await user.click(screen.getByRole('button', { name: '多选项目' })); // toggle off -> single-tap mode
    await user.click(
      within(screen.getByRole('group', { name: '候选项目纸胶带' })).getByRole('button', {
        name: /常规项目 B/,
      }),
    );

    await screen.findByRole('heading', { name: '本轮整理完成' });
    await screen.findByText('本轮已处理 2 条');

    // Single last undo only: undoing restores ONLY c2 (not c1), then undo button disables
    const undoBtn = screen.getByRole('button', { name: '撤销上一步' });
    expect(undoBtn).toBeEnabled();
    await user.click(undoBtn);

    expect(undoSpy).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: '当前待归类收藏' })).queryAllByText(
          '多项目共用规范文档',
        ).length,
      ).toBeGreaterThan(0),
    );
    await screen.findByText('本轮已处理 1 条');
    expect(screen.getByRole('button', { name: '撤销上一步' })).toBeDisabled();

    // Finish by clicking 常规项目 B again
    await user.click(
      within(screen.getByRole('group', { name: '候选项目纸胶带' })).getByRole('button', {
        name: /常规项目 B/,
      }),
    );
    await screen.findByRole('heading', { name: '本轮整理完成' });
    expect(screen.getByRole('link', { name: '返回收件箱' })).toBeInTheDocument();
  });

  it('restores original suggested decision and evidence on undo after confirming suggested project', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true });

    const proj = await seedAdminProject(adapter, 'AI 建议项目', 'proj-undo-sugg');
    const col = await seedAdminCollection(adapter, {
      id: '21000000-0000-4000-8000-000000000001',
      text: '这是与 AI 建议项目 高度匹配的摘录证据文本',
    });

    await waitFor(async () => {
      const fresh = await adapter.getCollection(col.id);
      expect(fresh.organization.status).toBe('succeeded');
      expect(fresh.projects.some((p) => p.decision === 'suggested')).toBe(true);
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    await screen.findByText('建议归入：AI 建议项目');
    await user.click(
      within(screen.getByRole('group', { name: '候选项目纸胶带' })).getByRole('button', {
        name: /AI 建议项目/,
      }),
    );
    await screen.findByRole('heading', { name: '本轮整理完成' });

    await user.click(screen.getByRole('button', { name: '撤销上一步' }));
    await screen.findByText('建议归入：AI 建议项目');
    expect(
      screen.getAllByText(/这是与 AI 建议项目 高度匹配的摘录证据文本/).length,
    ).toBeGreaterThanOrEqual(2);
    const afterUndo = await adapter.getCollection(col.id);
    expect(afterUndo.projects.find((p) => p.project_id === proj.id)?.decision).toBe('suggested');
  });

  it('waits for decision_version before commit, retries frozen payload with same Idempotency-Key without pre-GET on uncertain failure, and handles 409 conflicts', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    const proj = await seedAdminProject(adapter, '重试目标项目', 'proj-retry-1');
    await seedAdminCollection(adapter, {
      id: '30000000-0000-4000-8000-000000000001',
      text: '不确定网络结果的卡片',
    });
    const col2 = await seedAdminCollection(adapter, {
      id: '30000000-0000-4000-8000-000000000002',
      text: '已被其他设备先处理冲突的卡片',
    });

    // Gate col2 detail fetch first so we verify decision readiness blocks premature submit
    let releaseDetail!: () => void;
    const origGetCollection = adapter.getCollection.bind(adapter);
    const getCollectionSpy = vi
      .spyOn(adapter, 'getCollection')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseDetail = () => {
              void origGetCollection(col2.id).then(resolve);
            };
          }),
      );

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    // Wait for list to load col2 on front while detail is still pending
    await screen.findByText('已被其他设备先处理冲突的卡片');
    const tapeBeforeReady = within(
      screen.getByRole('group', { name: '候选项目纸胶带' }),
    ).getByRole('button', { name: /重试目标项目/ });
    expect(tapeBeforeReady).toBeDisabled();

    releaseDetail();
    await waitFor(() => expect(tapeBeforeReady).toBeEnabled());

    // Simulate external classification on col2 right before clicking -> 409 decision_conflict -> refresh & advance
    const latestCol2 = await origGetCollection(col2.id);
    await adapter.updateProjectDecisions(col2.id, {
      base_decision_version: latestCol2.decision_version,
      operations: [{ id: proj.id, action: 'include' }],
    });

    await user.click(tapeBeforeReady);
    await screen.findByText('这条建议已在其他地方处理');
    await screen.findByText('不确定网络结果的卡片');

    // Now simulate uncertain outcome: server commits on attempt 1, client throws network_error
    getCollectionSpy.mockClear();
    const origUpdate = adapter.updateProjectDecisions.bind(adapter);
    const updateSpy = vi
      .spyOn(adapter, 'updateProjectDecisions')
      .mockImplementationOnce(async (id, body, key) => {
        await origUpdate(id, body, key);
        throw new ApiError({
          status: 0,
          code: 'network_error',
          message: '连接中断',
        });
      });

    await user.click(
      within(screen.getByRole('group', { name: '候选项目纸胶带' })).getByRole('button', {
        name: /重试目标项目/,
      }),
    );

    const retryBtn = await screen.findByRole('button', { name: '重试提交' });
    const getCountBeforeRetry = getCollectionSpy.mock.calls.length;

    await user.click(retryBtn);

    // Must NOT pre-GET before retrying frozen payload, and must send exact same payload & Idempotency-Key
    expect(getCollectionSpy).toHaveBeenCalledTimes(getCountBeforeRetry);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[1][1]).toEqual(updateSpy.mock.calls[0][1]);
    expect(updateSpy.mock.calls[1][2]).toBe(updateSpy.mock.calls[0][2]);

    await screen.findByRole('heading', { name: '本轮整理完成' });
    // Recovered undo_receipt from replay lets user undo successfully
    await user.click(screen.getByRole('button', { name: '撤销上一步' }));
    await screen.findByText('不确定网络结果的卡片');
  });

  it('prevents infinite cursor prefetch loop on error and preserves queue under StrictMode', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await seedAdminProject(adapter, '翻页项目', 'proj-page-1');

    const c1 = await seedAdminCollection(adapter, {
      id: '40000000-0000-4000-8000-000000000001',
      text: '第一页卡片 A',
    });
    const c2 = await seedAdminCollection(adapter, {
      id: '40000000-0000-4000-8000-000000000002',
      text: '第二页卡片 B',
    });

    let page2Attempt = 0;
    const origList = adapter.listCollections.bind(adapter);
    const listSpy = vi.spyOn(adapter, 'listCollections').mockImplementation(async (query, signal) => {
      if (query?.scope !== 'unclassified') {
        return origList(query, signal);
      }
      if (!query.cursor) {
        return {
          items: [
            {
              id: c1.id,
              display_title: c1.display_title,
              excerpt: '第一页卡片 A',
              content_types: ['text'],
              projects: [],
              tags: [],
              organization_status: 'skipped',
              created_at: c1.created_at,
              updated_at: c1.updated_at,
              resource_version: c1.resource_version,
            },
          ],
          next_cursor: 'cursor-page-2',
        };
      }
      page2Attempt += 1;
      if (page2Attempt === 1) {
        throw new ApiError({ status: 503, code: 'service_unavailable', message: '续页暂时不可用' });
      }
      return {
        items: [
          {
            id: c2.id,
            display_title: c2.display_title,
            excerpt: '第二页卡片 B',
            content_types: ['text'],
            projects: [],
            tags: [],
            organization_status: 'skipped',
            created_at: c2.created_at,
            updated_at: c2.updated_at,
            resource_version: c2.resource_version,
          },
        ],
      };
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter, true);

    await screen.findByText('第一页卡片 A');
    const retryMoreBtn = await screen.findByRole('button', { name: '继续加载更多' });

    // Wait briefly to confirm it does NOT loop auto-fetching page 2 after failure
    await new Promise((r) => setTimeout(r, 80));
    expect(page2Attempt).toBe(1);
    const callsForUnclassified = listSpy.mock.calls.filter(([q]) => q?.scope === 'unclassified');
    expect(callsForUnclassified.length).toBeGreaterThanOrEqual(2);
    const attemptCountBeforeRetry = page2Attempt;

    // Manual retry succeeds and appends page 2 cleanly under StrictMode
    await user.click(retryMoreBtn);
    await waitFor(() => expect(page2Attempt).toBe(attemptCountBeforeRetry + 1));

    await user.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByText('第二页卡片 B');
  });

  it('supports keyboard shortcuts (1-9, Enter, S, Z, Esc) with IME/input guard and pointer swipes without committing on pointercancel', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const proj = await seedAdminProject(adapter, '键盘手势项目', 'proj-kbd-1');
    await seedAdminCollection(adapter, {
      id: '50000000-0000-4000-8000-000000000001',
      text: '手势卡片 一号',
    });
    await seedAdminCollection(adapter, {
      id: '50000000-0000-4000-8000-000000000002',
      text: '手势卡片 二号',
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    await screen.findByText('手势卡片 二号');
    const tapeBtn = within(
      screen.getByRole('group', { name: '候选项目纸胶带' }),
    ).getByRole('button', { name: /键盘手势项目/ });
    await waitFor(() => expect(tapeBtn).toBeEnabled());

    // IME composition must NOT trigger S/1/Z/Enter shortcuts
    fireEvent.keyDown(window, { key: 's', isComposing: true, keyCode: 229 });
    expect(screen.getByText('手势卡片 二号')).toBeInTheDocument();

    const dispatchPointer = (
      el: HTMLElement,
      type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
      init: { pointerId: number; clientX: number; clientY: number; pointerType: string },
    ) => {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: init.clientX,
        clientY: init.clientY,
      });
      Object.assign(ev, { pointerId: init.pointerId, pointerType: init.pointerType });
      fireEvent(el, ev);
    };

    // Swipe left with pointercancel must NOT commit skip!
    const card = screen.getByRole('article', { name: '当前待归类收藏' });
    dispatchPointer(card, 'pointerdown', { pointerId: 1, clientX: 200, clientY: 100, pointerType: 'touch' });
    dispatchPointer(card, 'pointermove', { pointerId: 1, clientX: 50, clientY: 102, pointerType: 'touch' });
    dispatchPointer(card, 'pointercancel', { pointerId: 1, clientX: 50, clientY: 102, pointerType: 'touch' });
    expect(screen.getByText('手势卡片 二号')).toBeInTheDocument();

    // Swipe left with pointerUp skips 二号 -> shows 一号
    dispatchPointer(card, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 100, pointerType: 'touch' });
    dispatchPointer(card, 'pointermove', { pointerId: 2, clientX: 80, clientY: 104, pointerType: 'touch' });
    dispatchPointer(card, 'pointerup', { pointerId: 2, clientX: 80, clientY: 104, pointerType: 'touch' });
    await screen.findByText('手势卡片 一号');

    // Keyboard Z restores skipped 二号 back to front; S skips again
    fireEvent.keyDown(window, { key: 'z' });
    await screen.findByText('手势卡片 二号');
    fireEvent.keyDown(window, { key: 's' });
    await screen.findByText('手势卡片 一号');

    // Swipe right focuses project picker tape
    const cardAfterSkip = screen.getByRole('article', { name: '当前待归类收藏' });
    dispatchPointer(cardAfterSkip, 'pointerdown', { pointerId: 3, clientX: 80, clientY: 100, pointerType: 'touch' });
    dispatchPointer(cardAfterSkip, 'pointermove', { pointerId: 3, clientX: 200, clientY: 102, pointerType: 'touch' });
    dispatchPointer(cardAfterSkip, 'pointerup', { pointerId: 3, clientX: 200, clientY: 102, pointerType: 'touch' });
    expect(tapeBtn).toHaveFocus();

    // Keyboard '1' selects project 1, 'Enter' commits it
    fireEvent.keyDown(window, { key: '1' });
    expect(tapeBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'Enter' });

    // Remaining card 二号 becomes active; "不属于任何项目" hides locally without backend PATCH
    await screen.findByText('手势卡片 二号');
    const col2BeforeIgnore = await adapter.getCollection('50000000-0000-4000-8000-000000000002');
    expect(col2BeforeIgnore.projects).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '不属于任何项目' }));
    await screen.findByRole('heading', { name: '本轮整理完成' });
    const col2AfterIgnore = await adapter.getCollection('50000000-0000-4000-8000-000000000002');
    expect(col2AfterIgnore.projects).toHaveLength(0);

    // Esc exits to UnclassifiedPage
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByRole('heading', { name: '待归类' });
    expect(proj.id).toBeTruthy();
  });

  it('reaches paused and paginated projects via 更多项目 without hiding them when active projects are scarce', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const pausedProj = await seedAdminProject(adapter, '暂停参考库', 'proj-paused-1');
    await adapter.updateProject(pausedProj.id, {
      base_version: pausedProj.version,
      state: 'paused',
    });
    await seedAdminCollection(adapter, {
      id: '60000000-0000-4000-8000-000000000001',
      text: '需放入暂停项目的资料',
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    await screen.findByText('需放入暂停项目的资料');
    const expandBtn = await screen.findByRole('button', { name: '更多项目' });
    await user.click(expandBtn);

    const pausedBtn = await screen.findByRole('button', { name: /暂停参考库/ });
    await user.click(pausedBtn);
    await screen.findByRole('heading', { name: '本轮整理完成' });
  });

  it('discards stale in-flight triage responses across unmount/account switch', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await seedAdminCollection(adapter, {
      id: '70000000-0000-4000-8000-000000000001',
      text: '账号 A 延迟响应卡片',
    });

    let resolveList!: (value: Awaited<ReturnType<TestAdapter['listCollections']>>) => void;
    const origList = adapter.listCollections.bind(adapter);
    let capturedUnclassifiedCall = false;
    const listMock = vi.spyOn(adapter, 'listCollections').mockImplementation((query, signal) => {
      if (query?.scope === 'unclassified' && !capturedUnclassifiedCall) {
        capturedUnclassifiedCall = true;
        return new Promise((resolve) => {
          void origList({ scope: 'unclassified', limit: 30 }).then((res) => {
            resolveList = () => resolve(res);
          });
        });
      }
      return origList(query, signal);
    });

    const { unmount } = renderWithAdapter(['/unclassified/triage'], adapter);
    await waitFor(() =>
      expect(listMock.mock.calls.some(([q]) => q?.scope === 'unclassified')).toBe(true),
    );

    // Unmount before delayed response settles
    unmount();
    await waitFor(() => expect(resolveList).toBeTypeOf('function'));
    resolveList(await origList({ scope: 'unclassified', limit: 30 }));

    // Fresh user mount sees empty state rather than stale account A data
    adapter.reset();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    renderWithAdapter(['/unclassified/triage'], adapter);
    await screen.findByRole('heading', { name: '本轮整理完成' });
    expect(screen.queryByText('账号 A 延迟响应卡片')).not.toBeInTheDocument();
  });
});
