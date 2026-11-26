import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Collection } from '../api/types';
import { ApiProvider } from '../context/ApiContext';
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

// jsdom has no View Transition API. Its DOM update callback runs asynchronously in browsers.
function deferThemeTransition() {
  const updates: (() => void)[] = [];
  const original = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: (update: () => void) => { updates.push(update); },
  });
  return {
    flush: () => updates.splice(0).forEach(update => update()),
    restore: () => {
      if (original) Object.defineProperty(document, 'startViewTransition', original);
      else Reflect.deleteProperty(document, 'startViewTransition');
    },
  };
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
    await within(screen.getByRole('main')).findByRole('link', { name: '#观察' });
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
    await within(screen.getByRole('main')).findByRole('link', { name: '#校对' });
    expect(body).toHaveBeenCalledOnce();
    expect((await api.getCollection(id)).tags).toHaveLength(1);
  });

  it('retains a full edit draft across a reload and compares a later remote version before any write', async () => {
    const ui = userEvent.setup();
    const id = crypto.randomUUID();
    const path = '/collections/' + id;
    const api = await setup(path, async a => {
      await a.createTag({ name: '留存' }, 'tag');
      await a.createCollection({ id, document: EMPTY_DOCUMENT, original_url: 'https://example.test/base',
        intent: '原用途', tag_ids: [], project_ids: [], upload_ids: [] }, 'seed');
    });
    await ui.click(await screen.findByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: '收藏正文编辑器' });
    const long = '一段草稿。'.repeat(600) + '最后一句';
    act(() => editor.focus());
    paste(editor, long + ' #留');
    await screen.findByRole('option', { name: '#留存' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByRole('button', { name: '移除待保存关联 留存' });
    fireEvent.change(screen.getByLabelText(/可选标题/), { target: { value: '本地标题' } });
    fireEvent.change(screen.getByLabelText('用途说明'), { target: { value: '本地用途' } });
    fireEvent.change(screen.getByLabelText(/来源网址/), { target: { value: 'https://example.test/local' } });
    cleanup();
    api.simulateExternalCollectionEdit(id, '另一台设备的正文');
    const write = vi.spyOn(api, 'updateCollection');
    render(<MemoryRouter initialEntries={[path]}><AppProviders api={api}><AppRoutes /></AppProviders></MemoryRouter>);
    await ui.click(await screen.findByRole('button', { name: '编辑' }));
    await screen.findByRole('heading', { name: /内容版本冲突.*v2/ });
    expect(screen.getByRole('textbox', { name: '收藏正文编辑器' })).toHaveTextContent(long);
    await ui.click(screen.getByRole('button', { name: '复制本地草稿' }));
    const copied = await navigator.clipboard.readText();
    for (const field of [long, '本地用途', '本地标题', 'https://example.test/local', '#留存']) expect(copied).toContain(field);
    await ui.click(screen.getByRole('button', { name: '保留草稿并退出编辑' }));
    expect(screen.getByText('另一台设备的正文')).toBeVisible();
    await ui.click(screen.getByRole('button', { name: '编辑' }));
    const overwrite = await screen.findByRole('button', { name: /基于服务器 v2 覆盖提交/ });
    expect(write).not.toHaveBeenCalled();
    api.simulateExternalCollectionEdit(id, '再次更新');
    await ui.click(overwrite);
    await screen.findByRole('button', { name: /基于服务器 v3 覆盖提交/ });
    expect(screen.getByDisplayValue('本地用途')).toBeVisible();
    await ui.click(screen.getByRole('button', { name: '放弃本地修改' }));
    expect(screen.getByRole('textbox', { name: '收藏正文编辑器' })).toHaveTextContent('再次更新');
    expect(write).toHaveBeenCalledTimes(1);
    expect((await api.getCollection(id)).content_version).toBe(3);
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

  it('requires all selected thumbnails before export and permits explicit text-only sharing', async () => {
    const api = createTestAdapter();
    const thumbnail = vi.spyOn(api, 'getThumbnail').mockResolvedValue(new Blob())
      .mockRejectedValueOnce(new Error('unavailable'));
    const image = new Image();
    const decode = vi.spyOn(card, 'decodeThumbnail').mockResolvedValue(image);
    const renderCard = vi.spyOn(card, 'renderShareCard').mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const url = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:card'; URL.revokeObjectURL = vi.fn();
    const c = { document: EMPTY_DOCUMENT, projects: [], created_at: '2026-11-21',
      image_notes: [{ attachment_id: 'a', text: '手动修改的图片笔记' }],
      attachments: [{ id: 'b', position: 1, filename: 'private-b' }, { id: 'a', position: 0, filename: 'private-a' }],
    } as unknown as Collection;
    try {
      render(<ApiProvider api={api}><ShareCard collection={c} onClose={() => {}} /></ApiProvider>);
      await screen.findByRole('alert');
      expect(screen.queryByRole('link', { name: '下载 PNG' })).toBeNull();
      expect(renderCard).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: '重新生成' }));
      await screen.findByRole('link', { name: '下载 PNG' });
      expect(thumbnail.mock.calls.map(args => args[0])).toEqual(['a', 'a', 'b']);
      expect(renderCard).toHaveBeenLastCalledWith(expect.objectContaining({ body: '手动修改的图片笔记' }), [image, image], 'gallery');
      await userEvent.click(screen.getByLabelText('第 2 张'));
      await waitFor(() => expect(renderCard).toHaveBeenLastCalledWith(expect.anything(), [image], 'gallery'));
      expect(thumbnail).toHaveBeenCalledTimes(3);
      expect(screen.queryByText(/private-/)).toBeNull();
      cleanup();
      thumbnail.mockRejectedValueOnce(new Error('offline'));
      render(<ApiProvider api={api}><ShareCard collection={c} onClose={() => {}} /></ApiProvider>);
      await userEvent.click(await screen.findByRole('button', { name: '仅文字' }));
      await screen.findByRole('link', { name: '下载 PNG' });
      expect(renderCard).toHaveBeenLastCalledWith(expect.objectContaining({ body: '手动修改的图片笔记' }), [], 'quote');
    } finally {
      cleanup();
      thumbnail.mockRestore(); decode.mockRestore(); renderCard.mockRestore();
      URL.createObjectURL = url; URL.revokeObjectURL = revoke;
    }
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
        created_at: '2026-11-21', projects: [], attachments: [],
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

  it('preserves account colors when returning to the tab refreshes the session', async () => {
    localStorage.setItem('spark:palette', 'sea');
    localStorage.setItem('spark:theme', 'light');
    const api = await setup('/settings', async a => {
      await a.updatePreferences({ palette: 'matcha', theme: 'dark' });
      const read = a.currentSession.bind(a);
      vi.spyOn(a, 'currentSession').mockImplementation(async () => structuredClone(await read()));
    });
    await screen.findByRole('region', { name: '界面外观' });
    const root = document.documentElement;
    expect(root.dataset.palette).toBe('matcha');
    const transition = deferThemeTransition();
    const visible = vi.spyOn(document, 'visibilityState', 'get');
    try {
      vi.mocked(api.currentSession).mockClear();
      visible.mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
      visible.mockReturnValue('visible');
      await act(async () => { fireEvent(document, new Event('visibilitychange')); });
      expect(api.currentSession).toHaveBeenCalled();
      transition.flush();
      expect(root.dataset.palette).toBe('matcha');
      expect(root.dataset.mode).toBe('dark');
    } finally {
      visible.mockRestore();
      transition.restore();
    }
  });

  it('keeps the last confirmed colors on the login page when a transition finishes after logout', async () => {
    localStorage.setItem('spark:palette', 'sea');
    await setup('/settings', async a => { await a.updatePreferences({ palette: 'sea' }); });
    const panel = within(await screen.findByRole('region', { name: '界面外观' }));
    const transition = deferThemeTransition();
    try {
      await userEvent.click(panel.getByRole('button', { name: /樱花雾粉/ }));
      await waitFor(() => expect(panel.getByRole('button', { name: /樱花雾粉/ })).toHaveAttribute('aria-pressed', 'true'));
      await userEvent.click(within(screen.getByRole('region', { name: '账号信息' })).getByRole('button', { name: '退出登录' }));
      await screen.findByRole('button', { name: '登录' });
      transition.flush();
      expect(document.documentElement.dataset.palette).toBe('sakura');
    } finally {
      transition.restore();
    }
  });

  it('updates an open public page after a browser appearance change without overriding a signed-in account', async () => {
    await setup('/settings', async a => { await a.updatePreferences({ palette: 'matcha', theme: 'dark' }); });
    const account = within(await screen.findByRole('region', { name: '账号信息' }));
    const fromOtherTab = (palette: string) => {
      localStorage.setItem('spark:appearance', JSON.stringify({ palette, theme: 'light' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'spark:appearance', storageArea: localStorage }));
    };
    fromOtherTab('sea');
    expect(document.documentElement.dataset.palette).toBe('matcha');
    await userEvent.click(account.getByRole('button', { name: '退出登录' }));
    await screen.findByRole('button', { name: '登录' });
    expect(document.documentElement.dataset.palette).toBe('sea');
    fromOtherTab('sakura');
    expect(document.documentElement.dataset.palette).toBe('sakura');
    expect(document.documentElement.dataset.mode).toBe('light');
  });

  it('keeps confirmed account colors after a failed save and uses the latest saved colors across public pages', async () => {
    localStorage.setItem('spark:palette', 'matcha');
    const api = await setup('/settings', async a => { await a.updatePreferences({ palette: 'sea', theme: 'dark' }); });
    const panel = within(await screen.findByRole('region', { name: '界面外观' }));
    // The account colors reach the document in an effect after the session renders, so on a
    // slow runner the panel can appear a beat before the stored browser palette is replaced.
    await waitFor(() => expect(document.documentElement.dataset.palette).toBe('sea'));
    vi.spyOn(api, 'updatePreferences').mockRejectedValueOnce(new Error('保存失败'));
    await userEvent.click(panel.getByRole('button', { name: /樱花雾粉/ }));
    await screen.findByText('保存失败');
    expect(document.documentElement.dataset.palette).toBe('sea');
    await userEvent.click(panel.getByRole('button', { name: /樱花雾粉/ }));
    await waitFor(() => expect(document.documentElement.dataset.palette).toBe('sakura'));
    await userEvent.click(within(screen.getByRole('region', { name: '账号信息' })).getByRole('button', { name: '退出登录' }));
    await screen.findByRole('button', { name: '登录' });
    expect(document.documentElement.dataset.palette).toBe('sakura');
    expect(document.documentElement.dataset.mode).toBe('dark');
    for (const path of ['/login', '/register', '/reset-password', '/desktop/pair', '/extension/pair']) {
      cleanup();
      render(<MemoryRouter initialEntries={[path]}><AppProviders api={api}><AppRoutes /></AppProviders></MemoryRouter>);
      await screen.findByRole('heading', { level: 1 });
      expect(document.documentElement.dataset.palette).toBe('sakura');
      expect(document.documentElement.dataset.mode).toBe('dark');
    }
  });
});
