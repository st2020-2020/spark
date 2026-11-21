import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../api/types';
import { AppProviders, AppRoutes } from '../App';
import { createTestAdapter } from '../test-adapter/mockServer';
import { shareText } from '../lib/shareCard';
import { ShareCard } from '../components/ShareCard';
import * as card from '../lib/shareCard';
import { EMPTY_DOCUMENT } from '../lib/document';
import { loadDraft, saveDraft, type CollectionDraft } from '../lib/drafts';

async function setup(path: string, prepare?: (api: ReturnType<typeof createTestAdapter>) => Promise<void>) {
  const api = createTestAdapter();
  await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
  await prepare?.(api);
  render(<MemoryRouter initialEntries={[path]}><AppProviders api={api}><AppRoutes /></AppProviders></MemoryRouter>);
  return api;
}

function paste(node: HTMLElement, text: string) {
  fireEvent.paste(node, { clipboardData: { files: [], items: [], types: ['text/plain'],
    getData: (format: string) => format === 'text/plain' ? text : '' } });
}

describe('capture and recall', () => {
  // jsdom has no caret geometry. ProseMirror asks for it when pasting into a focused editor.
  beforeAll(() => {
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(Range.prototype, 'getClientRects');
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });
  it('keeps a cancelled trigger, saves selected tags in the draft and retains them after save failure', async () => {
    const api = await setup('/inbox', async api => { await api.createTag({ name: '观察' }, 'seed-tag'); });
    const editor = await waitFor(() => {
      const live = screen.getByRole('textbox', { name: '收藏正文编辑器' });
      live.focus();
      expect(live).toHaveFocus();
      return live;
    });
    paste(editor, '记录 #观');
    expect(editor).toHaveTextContent('记录 #观');
    await screen.findByRole('option', { name: '#观察' });
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: '标签联想' })).toBeNull();
    expect(editor).toHaveTextContent('#观');
    paste(editor, '察');
    await screen.findByRole('option', { name: '#观察' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByRole('button', { name: '移除标签 观察' });
    expect(editor).not.toHaveTextContent('#观');
    const save = vi.spyOn(api, 'createCollection').mockRejectedValueOnce(new Error('暂时离线'));
    await userEvent.click(screen.getByRole('button', { name: '保存收藏' }));
    await screen.findByText('暂时离线');
    const session = await api.currentSession();
    const draft = loadDraft<CollectionDraft>(session.user.id, 'inbox').data!;
    expect(draft.tagIds).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '重试保存' }));
    await screen.findByRole('link', { name: '#观察' });
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  });

  it('leaves a dismissed trigger untouched when tag creation finishes later', async () => {
    const api = await setup('/inbox');
    const editor = await waitFor(() => {
      const node = screen.getByRole('textbox', { name: '收藏正文编辑器' });
      node.focus();
      expect(node).toHaveFocus();
      return node;
    });
    const create = api.createTag.bind(api);
    let release!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(api, 'createTag').mockImplementation(async (...args) => { await response; return create(...args); });
    paste(editor, '笔记 #新标签');
    await screen.findByRole('option', { name: '新建标签「新标签」' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(api.createTag).toHaveBeenCalledOnce();
    fireEvent.keyDown(editor, { key: 'Escape' });
    await act(async () => { release(); await response; });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存收藏' })).toBeEnabled());
    expect(editor).toHaveTextContent('笔记 #新标签');
    expect(screen.queryByRole('button', { name: '移除标签 新标签' })).toBeNull();
  });

  it('retries a failed detail association without writing the saved body again', async () => {
    const id = crypto.randomUUID();
    const api = await setup('/collections/' + id, async a => {
      await a.createCollection({ id, original_url: 'https://example.test/read', intent: '',
        document: EMPTY_DOCUMENT, project_ids: [], tag_ids: [], upload_ids: [] }, 'detail-seed');
      await a.createTag({ name: '校对' }, 'detail-tag');
    });
    await userEvent.click(await screen.findByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: '收藏正文编辑器' });
    act(() => editor.focus());
    paste(editor, '新段落 #校');
    await screen.findByRole('option', { name: '#校对' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByRole('button', { name: '移除待保存关联 校对' });
    const body = vi.spyOn(api, 'updateCollection');
    vi.spyOn(api, 'updateTagDecisions').mockRejectedValueOnce(new Error('暂时离线'));
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText(/部分关联尚未保存/);
    expect(editor).toHaveTextContent('新段落');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('link', { name: '#校对' });
    expect(body).toHaveBeenCalledOnce();
    expect((await api.getCollection(id)).tags).toHaveLength(1);
  });

  it('recovers a draft created before association display names were stored', async () => {
    await setup('/inbox', async api => {
      const session = await api.currentSession();
      const project = await api.createProject({ name: '旧草稿项目', description: '', focus_points: [] }, 'seed-project');
      saveDraft(session.user.id, 'inbox', { idempotencyKey: 'key', collectionId: crypto.randomUUID(), document: EMPTY_DOCUMENT,
        intent: '原用途', originalUrl: '', manualTitle: '', projectIds: [project.id], tagIds: [], aiExcluded: false });
    });
    expect(await screen.findByRole('button', { name: '移除项目 旧草稿项目' })).toBeVisible();
    expect(screen.getByDisplayValue('原用途')).toBeVisible();
  });

  it('uses only explicit source and project choices and never draws the private link target or purpose', () => {
    const c = {
      created_at: '2026-11-21T12:00:00Z', original_url: 'https://example.test/read?signature=private#reader',
      intent: '私人用途', display_title: '内部标题',
      projects: [{ name: '私人项目', decision: 'manual' }, { name: '已排除', decision: 'rejected' }],
      document: { schema_version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [
        { type: 'text', text: '旅行笔记 https://example.test/read?signature=private#reader',
          marks: [{ type: 'link', attrs: { href: 'https://private.example.test/temporary' } }] },
      ] }] } },
    } as Collection;
    expect(shareText(c, false, false)).toEqual({ body: '旅行笔记', date: expect.any(String), projects: '', source: '' });
    expect(shareText(c, true, true)).toEqual({ body: '旅行笔记', date: expect.any(String), projects: '私人项目', source: 'https://example.test/read' });
  });

  it('keeps the PNG available after system share cancellation', async () => {
    const renderCard = vi.spyOn(card, 'renderShareCard').mockResolvedValue(new Blob(['preview'], { type: 'image/png' }));
    const share = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'));
    const originalShare = Object.getOwnPropertyDescriptor(navigator, 'share');
    const originalCanShare = Object.getOwnPropertyDescriptor(navigator, 'canShare');
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    const url = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:local-card';
    URL.revokeObjectURL = vi.fn();
    try {
      const { unmount } = render(<ShareCard onClose={() => {}} collection={{
        document: { ...EMPTY_DOCUMENT, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '手稿' }] }] } },
        created_at: '2026-11-21', projects: [],
      } as unknown as Collection} />);
      await userEvent.click(await screen.findByRole('button', { name: '系统分享' }));
      expect(share).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByRole('link', { name: '下载 PNG' })).toHaveAttribute('href', screen.getByRole('img').getAttribute('src'));
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-card');
    } finally {
      renderCard.mockRestore(); URL.createObjectURL = url; URL.revokeObjectURL = revoke;
      if (originalShare) Object.defineProperty(navigator, 'share', originalShare); else Reflect.deleteProperty(navigator, 'share');
      if (originalCanShare) Object.defineProperty(navigator, 'canShare', originalCanShare); else Reflect.deleteProperty(navigator, 'canShare');
    }
  });

  it('keeps the saved appearance on write failure and the prior signed-out appearance after logout', async () => {
    localStorage.setItem('spark:palette', 'matcha');
    const api = await setup('/settings', async a => { await a.updatePreferences({ palette: 'sea', theme: 'dark' }); });
    const panel = within(await screen.findByRole('region', { name: '界面外观' }));
    expect(document.documentElement.dataset.palette).toBe('sea');
    vi.spyOn(api, 'updatePreferences').mockRejectedValueOnce(new Error('保存失败'));
    await userEvent.click(panel.getByRole('button', { name: /樱花雾粉/ }));
    await screen.findByText('保存失败');
    expect(document.documentElement.dataset.palette).toBe('sea');
    await userEvent.click(panel.getByRole('button', { name: /樱花雾粉/ }));
    await waitFor(() => expect(document.documentElement.dataset.palette).toBe('sakura'));
    await userEvent.click(within(screen.getByRole('region', { name: '账号信息' })).getByRole('button', { name: '退出登录' }));
    await screen.findByRole('button', { name: '登录' });
    expect(document.documentElement.dataset.palette).toBe('matcha');
  });
});
