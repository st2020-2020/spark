import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../api/errors';
import type { CollectionCreate, SparkDocument } from '../api/types';
import { AppProviders, AppRoutes } from '../App';
import { loadDraft } from '../lib/drafts';
import { followUpDraftScope, selectInitialFollowUpProjects } from '../lib/followUp';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

beforeAll(() => {
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
});

function makeDoc(text: string): SparkDocument {
  return {
    schema_version: 1,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: text ? [{ type: 'text', text }] : [],
        },
      ],
    },
  };
}

function pasteText(node: HTMLElement, text: string) {
  fireEvent.paste(node, {
    clipboardData: {
      files: [],
      items: [],
      types: ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

async function signUpUser(api: TestAdapter, email: string, inviteCode = 'SPARK-TEST-0002') {
  const challenge = await api.sendVerification({ email, purpose: 'register' });
  const code = api.getLastVerificationCode(email);
  if (!code) throw new Error(`missing verification code for ${email}`);
  return api.register({
    email,
    challenge_id: challenge.challenge_id,
    verification_code: code,
    password: 'Password123!',
    invite_code: inviteCode,
  });
}

function buildCreateInput(
  overrides: Partial<CollectionCreate> & Pick<CollectionCreate, 'id' | 'document'>,
): CollectionCreate {
  return {
    intent: '',
    project_ids: [],
    tag_ids: [],
    upload_ids: [],
    ...overrides,
  };
}

async function setupWithUser(
  initialPath: string,
  seed?: (api: TestAdapter) => Promise<void>,
): Promise<TestAdapter> {
  const api = createTestAdapter();
  await signUpUser(api, 'followup-author@example.test');
  if (seed) {
    await seed(api);
  }
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppProviders api={api}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe('v0.7 follow-up notes', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens follow-up from card & detail, preserves original note, updates thread count, and hides in trash', async () => {
    const ui = userEvent.setup();
    const sourceId = crypto.randomUUID();
    let projectId = '';

    const api = await setupWithUser('/inbox', async (a) => {
      const proj = await a.createProject({ name: '项目甲', description: '', focus_points: [] }, 'proj-a');
      projectId = proj.id;
      await a.createCollection(
        buildCreateInput({
          id: sourceId,
          document: makeDoc('原笔记第一段内容，保留不变'),
          manual_title: '来源笔记',
          project_ids: [proj.id],
        }),
        'seed-source',
      );
    });

    const cardFollowUpBtn = await screen.findByRole('button', { name: '续写 来源笔记' });
    await ui.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: '续写' })).toBeVisible();
    await ui.click(cardFollowUpBtn);

    const dialog = await screen.findByRole('dialog', { name: '续写笔记' });
    expect(within(dialog).getByText('续写自')).toBeVisible();
    expect(within(dialog).getByText('来源笔记')).toBeVisible();
    expect(within(dialog).getByText('原笔记第一段内容，保留不变')).toBeVisible();
    expect(within(dialog).getByText(/原笔记内容与归属保持不变/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '移除项目 项目甲' })).toBeVisible();

    const createSpy = vi.spyOn(api, 'createCollection');
    const editor = within(dialog).getByRole('textbox', { name: '收藏正文编辑器' });
    act(() => editor.focus());
    pasteText(editor, '这是第一条续写');

    await ui.click(within(dialog).getByRole('button', { name: '保存收藏' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '续写笔记' })).toBeNull();
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      source_collection_id: sourceId,
      project_ids: [projectId],
    });

    const originalAfter = await api.getCollection(sourceId);
    expect(originalAfter.content_version).toBe(1);
    expect(originalAfter.follow_up_count).toBe(1);
    expect(originalAfter.projects.map((p) => p.project_id)).toEqual([projectId]);

    await waitFor(() => {
      expect(screen.getAllByRole('link', { name: '同一线索还有 1 条' }).length).toBeGreaterThanOrEqual(1);
    });
    const threadLink = screen
      .getAllByRole('link', { name: '同一线索还有 1 条' })
      .find((el) => el.getAttribute('href') === `/collections/${sourceId}#follow-up-thread`);
    expect(threadLink).toBeDefined();
    await ui.click(threadLink!);

    const timeline = await screen.findByRole('region', { name: '续写线索' });
    expect(within(timeline).getByText('可查看 2 条')).toBeVisible();
    expect(within(timeline).getByText('当前')).toBeVisible();
    expect(within(timeline).getByRole('link', { name: '这是第一条续写' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: '续写' }).length).toBeGreaterThanOrEqual(1);

    const latestOriginal = await api.getCollection(sourceId);
    await api.trashCollection(sourceId, { base_resource_version: latestOriginal.resource_version });

    cleanup();
    render(
      <MemoryRouter initialEntries={['/trash']}>
        <AppProviders api={api}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByText('来源笔记');
    expect(screen.queryByRole('button', { name: /续写/ })).toBeNull();

    cleanup();
    render(
      <MemoryRouter initialEntries={[`/collections/${sourceId}`]}>
        <AppProviders api={api}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByText('此收藏位于回收站');
    expect(screen.queryByRole('button', { name: '续写' })).toBeNull();
    expect(screen.queryByRole('region', { name: '续写线索' })).toBeNull();
  });

  it('preselects attributed selectable projects only, allows clearing project_ids to [], and isolates drafts per source', async () => {
    const ui = userEvent.setup();
    const s1 = crypto.randomUUID();
    const s2 = crypto.randomUUID();

    const p1 = { project_id: 'p1', name: '人工项目', decision: 'manual' as const };
    const p2 = { project_id: 'p2', name: '确认项目', decision: 'confirmed' as const };
    const p3 = { project_id: 'p3', name: '自动项目', decision: 'auto' as const };
    const p4 = { project_id: 'p4', name: '推荐项目', decision: 'suggested' as const };
    const p5 = { project_id: 'p5', name: '已忽略项目', decision: 'rejected' as const };
    const pMissing = { project_id: 'p-missing', name: '已删除项目', decision: 'manual' as const };

    const selected = selectInitialFollowUpProjects(
      [p1, p2, p3, p4, p5, pMissing, p1],
      [
        { id: 'p1', name: '人工项目', description: '', focus_points: [], state: 'active', collection_count: 1, version: 1, created_at: '', updated_at: '' },
        { id: 'p2', name: '确认项目', description: '', focus_points: [], state: 'active', collection_count: 1, version: 1, created_at: '', updated_at: '' },
        { id: 'p3', name: '自动项目', description: '', focus_points: [], state: 'active', collection_count: 1, version: 1, created_at: '', updated_at: '' },
        { id: 'p4', name: '推荐项目', description: '', focus_points: [], state: 'active', collection_count: 1, version: 1, created_at: '', updated_at: '' },
      ],
    );
    expect(selected.projectIds).toEqual(['p1', 'p2', 'p3']);

    let userId = '';
    const api = await setupWithUser('/inbox', async (a) => {
      const sess = await a.currentSession();
      userId = sess.user.id;
      const projA = await a.createProject({ name: '项目A', description: '', focus_points: [] }, 'pa');
      const projB = await a.createProject({ name: '项目B', description: '', focus_points: [] }, 'pb');
      await a.createCollection(
        buildCreateInput({
          id: s1,
          document: makeDoc('来源一内容'),
          manual_title: '来源一',
          project_ids: [projA.id],
        }),
        's1',
      );
      await new Promise((r) => setTimeout(r, 2));
      await a.createCollection(
        buildCreateInput({
          id: s2,
          document: makeDoc('来源二内容'),
          manual_title: '来源二',
          project_ids: [projB.id],
        }),
        's2',
      );
    });

    const inboxEditor = await waitFor(() => {
      const node = screen.getByRole('textbox', { name: '收藏正文编辑器' });
      node.focus();
      expect(node).toHaveFocus();
      return node;
    });
    pasteText(inboxEditor, '收件箱未提交草稿');
    await waitFor(() => expect(inboxEditor).toHaveTextContent('收件箱未提交草稿'));

    await ui.click(await screen.findByRole('button', { name: '续写 来源一' }));
    let dialog = await screen.findByRole('dialog', { name: '续写笔记' });
    await ui.click(within(dialog).getByRole('button', { name: '清空项目' }));
    expect(within(dialog).queryByRole('button', { name: '移除项目 项目A' })).toBeNull();

    const s1Editor = within(dialog).getByRole('textbox', { name: '收藏正文编辑器' });
    act(() => s1Editor.focus());
    pasteText(s1Editor, '来源一本地草稿');

    await ui.click(within(dialog).getByRole('button', { name: '关闭弹窗' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '续写笔记' })).toBeNull());

    await ui.click(screen.getByRole('button', { name: '续写 来源二' }));
    dialog = await screen.findByRole('dialog', { name: '续写笔记' });
    expect(within(dialog).getByRole('textbox', { name: '收藏正文编辑器' })).not.toHaveTextContent(
      '来源一本地草稿',
    );
    expect(within(dialog).getByRole('button', { name: '移除项目 项目B' })).toBeVisible();
    await ui.click(within(dialog).getByRole('button', { name: '清空项目' }));

    const createSpy = vi.spyOn(api, 'createCollection');
    const s2Editor = within(dialog).getByRole('textbox', { name: '收藏正文编辑器' });
    act(() => s2Editor.focus());
    pasteText(s2Editor, '清空项目后独立保存');
    await ui.click(within(dialog).getByRole('button', { name: '保存收藏' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '续写笔记' })).toBeNull());
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
      source_collection_id: s2,
      project_ids: [],
    });
    const createdFollowUp = await createSpy.mock.results[0]?.value;
    expect(createdFollowUp.projects).toEqual([]);

    await ui.click(screen.getByRole('button', { name: '续写 来源一' }));
    dialog = await screen.findByRole('dialog', { name: '续写笔记' });
    expect(within(dialog).getByRole('textbox', { name: '收藏正文编辑器' })).toHaveTextContent(
      '来源一本地草稿',
    );
    expect(within(dialog).queryByRole('button', { name: '移除项目 项目A' })).toBeNull();

    await ui.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '续写笔记' })).toBeNull());

    expect(loadDraft(userId, followUpDraftScope(s1)).data).toBeNull();
    expect(screen.getByRole('textbox', { name: '收藏正文编辑器' })).toHaveTextContent(
      '收件箱未提交草稿',
    );
  });

  it('retains draft and reuses collectionId/idempotencyKey across failed save and reports 404 unavailable source', async () => {
    const ui = userEvent.setup();
    const s1 = crypto.randomUUID();

    const api = await setupWithUser(`/collections/${s1}`, async (a) => {
      await a.createCollection(
        buildCreateInput({
          id: s1,
          document: makeDoc('详情页来源正文'),
          manual_title: '详情来源',
        }),
        's1-detail',
      );
    });

    await ui.click(await screen.findByRole('button', { name: '续写' }));
    const dialog = await screen.findByRole('dialog', { name: '续写笔记' });
    const editor = within(dialog).getByRole('textbox', { name: '收藏正文编辑器' });
    act(() => editor.focus());
    pasteText(editor, '离线重试文本');

    const createSpy = vi
      .spyOn(api, 'createCollection')
      .mockRejectedValueOnce(new ApiError({ status: 503, code: 'network_error', message: '暂时离线' }));

    await ui.click(within(dialog).getByRole('button', { name: '保存收藏' }));
    await within(dialog).findByRole('alert');
    expect(within(dialog).getByRole('textbox', { name: '收藏正文编辑器' })).toHaveTextContent(
      '离线重试文本',
    );

    await ui.click(within(dialog).getByRole('button', { name: '保存收藏' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '续写笔记' })).toBeNull());

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[0]?.[0].id).toBe(createSpy.mock.calls[1]?.[0].id);
    expect(createSpy.mock.calls[0]?.[1]).toBe(createSpy.mock.calls[1]?.[1]);
    expect(createSpy.mock.calls[0]?.[0].source_collection_id).toBe(s1);

    const thread = await api.getCollectionThread(s1);
    expect(thread.items).toHaveLength(2);

    // Concurrent trash of source returns 404 friendly message and keeps input.
    const followUpButtons = await screen.findAllByRole('button', { name: '续写' });
    await ui.click(followUpButtons[0]!);
    const dialog2 = await screen.findByRole('dialog', { name: '续写笔记' });
    const latestS1 = await api.getCollection(s1);
    await api.trashCollection(s1, { base_resource_version: latestS1.resource_version });
    const editor2 = within(dialog2).getByRole('textbox', { name: '收藏正文编辑器' });
    act(() => editor2.focus());
    pasteText(editor2, '来源被删后的草稿');
    await ui.click(within(dialog2).getByRole('button', { name: '保存收藏' }));

    await within(dialog2).findByText(/来源收藏已不可用（可能已移入回收站或被删除）/);
    expect(within(dialog2).getByRole('textbox', { name: '收藏正文编辑器' })).toHaveTextContent(
      '来源被删后的草稿',
    );
  });

  it('paginates timeline with 加载更多, renders soft-deleted placeholder 有一条已删除, removes purged items, and isolates across users', async () => {
    const ui = userEvent.setup();
    const rootId = crypto.randomUUID();
    const trashedChildId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    let trashedVersion = 1;

    const api = await setupWithUser(`/collections/${targetId}`, async (a) => {
      await a.createCollection(
        buildCreateInput({
          id: rootId,
          document: makeDoc('线索根节点正文'),
          manual_title: '根节点',
        }),
        'root',
      );
      await new Promise((r) => setTimeout(r, 2));

      for (let i = 1; i <= 21; i += 1) {
        const cid = i === 2 ? trashedChildId : crypto.randomUUID();
        const created = await a.createCollection(
          buildCreateInput({
            id: cid,
            document: makeDoc(i === 2 ? '隐私已被删除的正文内容' : `第 ${i} 条分叉续写`),
            manual_title: i === 2 ? '秘密已删除标题' : `续写第 ${i} 条`,
            source_collection_id: rootId,
          }),
          `child-${i}`,
        );
        if (i === 2) {
          trashedVersion = created.resource_version;
        }
        await new Promise((r) => setTimeout(r, 2));
      }

      const trashed = await a.trashCollection(trashedChildId, {
        base_resource_version: trashedVersion,
      });
      trashedVersion = trashed.resource_version;

      await a.createCollection(
        buildCreateInput({
          id: targetId,
          document: makeDoc('最后一个查看节点'),
          manual_title: '最后节点',
          source_collection_id: rootId,
        }),
        'target',
      );
    });

    const timeline = await screen.findByRole('region', { name: '续写线索' });
    expect(within(timeline).getByText('可查看 22 条')).toBeVisible();
    expect(within(timeline).getByText('来源')).toBeVisible();
    expect(within(timeline).getByText('有一条已删除')).toBeVisible();
    expect(screen.queryByText('秘密已删除标题')).toBeNull();
    expect(screen.queryByText('隐私已被删除的正文内容')).toBeNull();

    const realGetThread = api.getCollectionThread.bind(api);
    const threadSpy = vi
      .spyOn(api, 'getCollectionThread')
      .mockRejectedValueOnce(new ApiError({ status: 503, code: 'network_error', message: '翻页网络波动' }))
      .mockImplementation((id, query, signal) => realGetThread(id, query, signal));

    const loadMoreBtn = within(timeline).getByRole('button', { name: '加载更多' });
    await ui.click(loadMoreBtn);

    const retryBtn = await within(timeline).findByRole('button', { name: '重试' });
    expect(within(timeline).getByRole('alert')).toBeVisible();
    expect(within(timeline).getByText('根节点')).toBeVisible();
    expect(within(timeline).getByText('有一条已删除')).toBeVisible();

    await ui.click(retryBtn);
    await within(timeline).findByText('当前');
    expect(within(timeline).getByText('最后节点')).toBeVisible();
    expect(threadSpy).toHaveBeenCalledTimes(2);

    await api.purgeCollection(
      trashedChildId,
      { base_resource_version: trashedVersion },
      'purge-c2',
    );

    cleanup();
    render(
      <MemoryRouter initialEntries={[`/collections/${targetId}`]}>
        <AppProviders api={api}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const timelineAfterPurge = await screen.findByRole('region', { name: '续写线索' });
    expect(within(timelineAfterPurge).queryByText('有一条已删除')).toBeNull();

    // Cross-user isolation: another user receives 404 for thread read and follow-up creation.
    await signUpUser(api, 'other-user@example.test', 'SPARK-TEST-0002');
    await expect(api.getCollectionThread(rootId)).rejects.toMatchObject({ status: 404 });
    await expect(
      api.createCollection(
        buildCreateInput({
          id: crypto.randomUUID(),
          document: makeDoc('越权续写内容'),
          manual_title: '越权续写',
          source_collection_id: rootId,
        }),
        'cross-user',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
