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
    // Recover undo_receipt from replay lets user undo successfully without duplicate count
    await screen.findByText('本轮已处理 1 条');
    await user.click(screen.getByRole('button', { name: '撤销上一步' }));
    await screen.findByText('不确定网络结果的卡片');
    await screen.findByText('本轮已处理 0 条');
  });

  it('preserves pendingRetry receipt recovery button across background auto-move without duplicate operation or count', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    await seedAdminProject(adapter, '后台重查项目', 'proj-bg-retry-1');
    const colA = await seedAdminCollection(adapter, {
      id: '31000000-0000-4000-8000-000000000001',
      text: '已后台落库但响应丢失的卡片 A',
    });
    const colB = await seedAdminCollection(adapter, {
      id: '31000000-0000-4000-8000-000000000002',
      text: '下一张正常卡片 B',
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    // Wait for front card (newest is B) & initial SSE ready + detail_version ready
    await screen.findByText('下一张正常卡片 B');
    const frontTape = within(
      screen.getByRole('group', { name: '候选项目纸胶带' }),
    ).getByRole('button', { name: /后台重查项目/ });
    await waitFor(() => expect(frontTape).toBeEnabled());
    // Let initial onReady compensation settle before mocking uncertain PATCH failure
    await new Promise((r) => setTimeout(r, 40));

    const origUpdate = adapter.updateProjectDecisions.bind(adapter);
    const updateSpy = vi
      .spyOn(adapter, 'updateProjectDecisions')
      .mockImplementationOnce(async (id, body, key) => {
        await origUpdate(id, body, key);
        throw new ApiError({ status: 0, code: 'network_error', message: '连接超时' });
      });

    // First uncertain PATCH leaves pendingRetry active & locks re-operation on current card (B)
    await user.click(frontTape);
    await screen.findByRole('button', { name: '重试提交' });
    expect(screen.getByText('下一张正常卡片 B')).toBeInTheDocument();
    expect(frontTape).toBeDisabled();
    expect(screen.getByRole('button', { name: '跳过' })).toBeDisabled();

    // Simulate background refetch discovering the same committed decision via SSE ready compensation
    adapter.emitMockOrganizationReady();

    // Auto-move shifts queue cleanly to 卡片 A, while pendingRetry & 「重试提交」 stay visible!
    await screen.findByText('已后台落库但响应丢失的卡片 A');
    const retryAfterMove = await screen.findByRole('button', { name: '重试提交' });
    expect(screen.getByText('本轮已处理 0 条')).toBeInTheDocument();

    // Clicking 重试提交 replays the exact frozen key/payload for B to recover undo_receipt cleanly and counts once
    await user.click(retryAfterMove);
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0][0]).toBe(colB.id);
    expect(updateSpy.mock.calls[1][0]).toBe(colB.id);
    expect(updateSpy.mock.calls[1][1]).toEqual(updateSpy.mock.calls[0][1]);
    expect(updateSpy.mock.calls[1][2]).toBe(updateSpy.mock.calls[0][2]);

    await screen.findByText('本轮已处理 1 条');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '重试提交' })).not.toBeInTheDocument(),
    );

    // Undo restores 卡片 B cleanly with count back to 0
    await user.click(screen.getByRole('button', { name: '撤销上一步' }));
    await screen.findByText('下一张正常卡片 B');
    await screen.findByText('本轮已处理 0 条');
    expect(colA.id).toBeTruthy();
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

  it('reaches paused projects via 选择项目 button and right swipe even when no active projects exist', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const pausedProj = await seedAdminProject(adapter, '暂停参考库', 'proj-paused-1');
    await adapter.updateProject(pausedProj.id, {
      base_version: pausedProj.version,
      state: 'paused',
    });
    await seedAdminCollection(adapter, {
      id: '60000000-0000-4000-8000-000000000001',
      text: '需放入暂停项目的资料 1',
    });
    await seedAdminCollection(adapter, {
      id: '60000000-0000-4000-8000-000000000002',
      text: '需放入暂停项目的资料 2',
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    // 1. Click "选择项目" button -> truly expands 更多项目 and focuses paused project tape
    await screen.findByText('需放入暂停项目的资料 2');
    expect(screen.queryByRole('button', { name: /暂停参考库/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '选择项目' }));

    const pausedBtn = await screen.findByRole('button', { name: /暂停参考库/ });
    await waitFor(() => expect(pausedBtn).toHaveFocus());
    await user.click(pausedBtn);

    // Collapse 更多项目 to test right swipe on the next card
    await screen.findByText('需放入暂停项目的资料 1');
    await user.click(screen.getByRole('button', { name: '收起更多项目' }));
    expect(screen.queryByRole('button', { name: /暂停参考库/ })).not.toBeInTheDocument();

    // 2. Right swipe on card -> truly expands 更多项目 and focuses paused project tape
    const card = screen.getByRole('article', { name: '当前待归类收藏' });
    const evDown = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 60, clientY: 100 });
    Object.assign(evDown, { pointerId: 11, pointerType: 'touch' });
    fireEvent(card, evDown);
    const evMove = new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 200, clientY: 102 });
    Object.assign(evMove, { pointerId: 11, pointerType: 'touch' });
    fireEvent(card, evMove);
    const evUp = new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 200, clientY: 102 });
    Object.assign(evUp, { pointerId: 11, pointerType: 'touch' });
    fireEvent(card, evUp);

    const pausedBtnAfterSwipe = await screen.findByRole('button', { name: /暂停参考库/ });
    await waitFor(() => expect(pausedBtnAfterSwipe).toHaveFocus());
    await user.click(pausedBtnAfterSwipe);
    await screen.findByRole('heading', { name: '本轮整理完成' });
  });

  it('freezes multi-select decision_version and suggestion versions, requires reselect when refreshed target changes, and enforces 50-item limit', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true });

    const projS = await seedAdminProject(adapter, '建议项目 S', 'proj-freeze-s');
    await seedAdminProject(adapter, '手动项目 M', 'proj-freeze-m');
    const col = await seedAdminCollection(adapter, {
      id: '61000000-0000-4000-8000-000000000001',
      text: '多选冻结测试卡片：建议项目 S',
    });

    await waitFor(async () => {
      const fresh = await adapter.getCollection(col.id);
      expect(fresh.organization.status).toBe('succeeded');
      expect(fresh.projects.some((p) => p.project_id === projS.id && p.decision === 'suggested')).toBe(true);
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    await screen.findByText('建议归入：建议项目 S');
    await user.click(screen.getByRole('button', { name: '多选项目' }));
    const tapes = screen.getByRole('group', { name: '候选项目纸胶带' });
    const tapeS = within(tapes).getByRole('button', { name: /建议项目 S/ });
    const tapeM = within(tapes).getByRole('button', { name: /手动项目 M/ });
    await waitFor(() => expect(tapeS).toBeEnabled());

    // Select S & M while seeing current decision_version & suggestion_run_id
    await user.click(tapeS);
    await user.click(tapeM);
    expect(screen.getByRole('button', { name: '确认归入（2）' })).toBeInTheDocument();

    // Another tab rejects S (bumping decision_version and changing S from suggested -> rejected), then SSE ready triggers refresh
    const latestBeforeEdit = await adapter.getCollection(col.id);
    await adapter.updateProjectDecisions(col.id, {
      base_decision_version: latestBeforeEdit.decision_version,
      operations: [{ id: projS.id, action: 'exclude' }],
    });
    adapter.emitMockOrganizationReady();

    // Must require re-selection instead of silently adopting the new decision_version
    await screen.findByText('当前收藏的推荐状态或版本已更新，请重新选择项目。');
    expect(screen.queryByRole('button', { name: /确认归入/ })).not.toBeInTheDocument();
    expect(tapeS).toHaveAttribute('aria-pressed', 'false');
    expect(tapeM).toHaveAttribute('aria-pressed', 'false');

    // Also verify max 50 multi-select limit: seed 51 total active projects
    const extraProjects: string[] = [];
    for (let i = 1; i <= 49; i += 1) {
      const p = await seedAdminProject(adapter, `批量项目 ${i}`, `proj-cap-${i}`);
      extraProjects.push(p.id);
    }
    expect(extraProjects).toHaveLength(49);
    // Refresh projects query & expand 更多项目 to expose all 51 projects
    adapter.emitMockOrganizationReady();
    await user.click(await screen.findByRole('button', { name: '更多项目' }));

    const allTapeBtns = await waitFor(() => {
      const btns = within(screen.getByRole('group', { name: '候选项目纸胶带' })).getAllByRole('button');
      expect(btns.length).toBe(51);
      return btns;
    });

    for (let i = 0; i < 50; i += 1) {
      fireEvent.click(allTapeBtns[i]);
    }
    expect(screen.getByRole('button', { name: '确认归入（50）' })).toBeInTheDocument();

    fireEvent.click(allTapeBtns[50]);
    await screen.findByText('单次多选最多选择 50 个项目，请取消部分后再选。');
    expect(allTapeBtns[50]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '确认归入（50）' })).toBeInTheDocument();
  });

  it('fetches page 2 via unseen count when skipping all 30 items of page 1, keeps #31 before skipped tail, and never shows completed while cursor/failure remains', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await seedAdminProject(adapter, '分页测试项目', 'proj-31-1');

    const now = new Date().toISOString();
    const page1Items = Array.from({ length: 30 }, (_, idx) => ({
      id: `80000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
      display_title: `第${idx + 1}条`,
      excerpt: `三十一条队列条目 ${idx + 1}`,
      content_types: ['text' as const],
      projects: [],
      tags: [],
      organization_status: 'skipped' as const,
      created_at: now,
      updated_at: now,
      resource_version: 1,
    }));
    const item31 = {
      id: '80000000-0000-4000-8000-000000000031',
      display_title: '第31条',
      excerpt: '压轴第 31 条未见卡片',
      content_types: ['text' as const],
      projects: [],
      tags: [],
      organization_status: 'skipped' as const,
      created_at: now,
      updated_at: now,
      resource_version: 1,
    };

    let page2Attempt = 0;
    const origList = adapter.listCollections.bind(adapter);
    vi.spyOn(adapter, 'listCollections').mockImplementation(async (query, signal) => {
      if (query?.scope !== 'unclassified') return origList(query, signal);
      if (!query.cursor) {
        return { items: page1Items, next_cursor: 'cursor-31' };
      }
      page2Attempt += 1;
      if (page2Attempt === 1) {
        throw new ApiError({ status: 503, code: 'service_unavailable', message: '第 2 页加载失败' });
      }
      return { items: [item31] };
    });

    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id) => {
      const match = [...page1Items, item31].find((item) => item.id === id) ?? page1Items[0];
      return {
        id: match.id,
        document: makeTextDoc(match.excerpt),
        intent: '',
        display_title: match.display_title,
        content_types: ['text'],
        content_version: 1,
        resource_version: 1,
        decision_version: 1,
        attachments: [],
        projects: [],
        tags: [],
        organization: { content_version: 1, status: 'skipped', stages: [], updated_at: now },
        ai_excluded: false,
        created_at: now,
        updated_at: now,
      };
    });

    const user = userEvent.setup();
    renderWithAdapter(['/unclassified/triage'], adapter);

    await screen.findByText('三十一条队列条目 1');

    // Skip first 25 -> unseen drops to 5 -> auto-prefetch runs and fails once (shows retry banner)
    for (let i = 0; i < 25; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    }
    expect(await screen.findByRole('button', { name: '继续加载更多' })).toBeInTheDocument();

    // Skip remaining 5 items -> all 30 loaded cards are skipped, but cursor still failed:
    // MUST NOT show "本轮整理完成" or "结束本轮整理" or hide "继续加载更多"!
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByRole('button', { name: '跳过' }));
    }
    expect(screen.queryByRole('heading', { name: '本轮整理完成' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '结束本轮整理' })).not.toBeInTheDocument();
    const retryMoreBtn = screen.getByRole('button', { name: '继续加载更多' });

    // Retry loading page 2 -> item #31 is queued right next after current skipped card 1
    await user.click(retryMoreBtn);
    await waitFor(() => expect(page2Attempt).toBe(2));

    // One skip moves card 1 back to tail and immediately reveals unseen card #31!
    await user.click(screen.getByRole('button', { name: '跳过' }));
    await screen.findByText('压轴第 31 条未见卡片');
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
