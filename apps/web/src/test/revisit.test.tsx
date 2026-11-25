import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

async function admin() {
  const api = createTestAdapter();
  await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
  return api;
}

function mount(api: TestAdapter, path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AppProviders api={api}><AppRoutes /></AppProviders></MemoryRouter>);
}

it.each([true, false])('preserves an explicit unread choice when initially read=%s', async initiallyRead => {
  const api = await admin();
  const ui = userEvent.setup();
  const col = await api.createCollection({
    id: crypto.randomUUID(), document: { schema_version: 1, content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '留待再读' }] },
    ] } }, intent: '', upload_ids: [], project_ids: [], tag_ids: [],
  }, 'read-state');
  if (initiallyRead) await api.setReadState(col.id, { read: true });
  const write = api.setReadState.bind(api);
  const writes = vi.spyOn(api, 'setReadState');
  let release = () => {};
  if (!initiallyRead) {
    const delay = new Promise<void>(resolve => { release = resolve; });
    writes.mockImplementationOnce(async (id, body) => { await delay; return write(id, body); });
  }
  mount(api, initiallyRead ? '/collections' : '/collections?read=false');
  await ui.click(await screen.findByRole('link', { name: /查看详情：/ }));
  await ui.click(await screen.findByRole('button', { name: '标为未读' }));
  release();
  await waitFor(() => expect(writes.mock.calls.map(([, body]) => body.read)).toEqual(initiallyRead ? [false] : [true, false]));
  await screen.findByRole('button', { name: '标为已读' });
  await ui.click(screen.getByRole('link', { name: '返回' }));
  expect(await screen.findByRole('img', { name: '未读' })).toBeVisible();
  expect((await api.getCollection(col.id)).read_at).toBeFalsy();
});

it.each([false, true])('orders trash after the entry read, preserving external conflicts=%s', async external => {
  const api = await admin();
  const ui = userEvent.setup();
  const col = await api.createCollection({ id: crypto.randomUUID(), document: { schema_version: 1,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '合成资料' }] }] } },
    intent: '', upload_ids: [], project_ids: [], tag_ids: [] }, 'trash-race');
  const write = api.setReadState.bind(api);
  let release = () => {};
  const delay = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(api, 'setReadState').mockImplementationOnce(async (id, body) => {
    await delay;
    const updated = await write(id, body);
    if (external) await write(id, { read: false });
    return updated;
  });
  const trash = vi.spyOn(api, 'trashCollection');
  mount(api, `/collections/${col.id}`);
  await ui.click(await screen.findByRole('button', { name: '移入回收站' }));
  expect(trash).not.toHaveBeenCalled();
  release();
  await screen.findByText(external ? '收藏状态已变更，请刷新后重试' : '已移入回收站');
  expect(trash).toHaveBeenCalledTimes(1);
  expect(Boolean((await api.getCollection(col.id)).deleted_at)).toBe(!external);
});

it.each(['composer', 'filter', 'detail', 'unclassified'])('selects project 101 on demand in the %s', async entry => {
  const api = await admin();
  const ui = userEvent.setup();
  const project = await api.createProject({ name: '第 101 项', description: '', focus_points: [] }, 'last');
  for (let i = 0; i < 100; i++) {
    await api.createProject({ name: `项目 ${i}`, description: '', focus_points: [] }, `p-${i}`);
  }
  const col = await api.createCollection({ id: crypto.randomUUID(), document: { schema_version: 1,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '待关联资料' }] }] } },
    intent: '', upload_ids: [], project_ids: [], tag_ids: [] }, 'note');
  const list = vi.spyOn(api, 'listProjects');
  mount(api, entry === 'composer' ? '/inbox' : entry === 'filter' ? '/collections' :
    entry === 'detail' ? `/collections/${col.id}` : '/unclassified');
  if (entry === 'composer') await ui.click(await screen.findByRole('button', { name: '添加项目' }));
  if (entry === 'filter') await ui.click(await screen.findByRole('button', { name: '筛选' }));
  if (entry === 'detail') await ui.click(await screen.findByText('更多管理与整理详情'));
  const more = await screen.findByRole('button', { name: '加载更多项目' });
  expect(list.mock.calls.some(([q]) => q?.cursor)).toBe(false);
  await ui.click(more);
  if (entry === 'composer') {
    const choice = await screen.findByRole('button', { name: project.name });
    await ui.click(choice);
    expect(choice).toHaveAttribute('aria-pressed', 'true');
  } else {
    const opt = await screen.findByRole('option', { name: project.name });
    const select = opt.closest('select')!;
    await ui.selectOptions(select, opt);
    expect(select).toHaveValue(project.id);
    if (entry !== 'filter') {
      await ui.click(screen.getByRole('button', { name: entry === 'detail' ? '加入项目' : '确认关联' }));
      await waitFor(async () => expect((await api.getCollection(col.id)).projects.some(p => p.project_id === project.id)).toBe(true));
    }
  }
});

it('uses server day boundaries even on a 25-hour day and clears the filter', async () => {
  const api = await admin();
  const selected = { date: '2026-11-01', count: 0, created_from: '2026-11-01T04:00:00Z', created_to: '2026-11-02T05:00:00Z' };
  vi.spyOn(api, 'getActivity').mockImplementation(async q => ({ ...q, days: [selected] }));
  const list = vi.spyOn(api, 'listCollections');
  const user = userEvent.setup();
  mount(api, '/inbox?date=2026-11-01');
  await screen.findByText('这一天没有符合条件的收藏');
  const inboxCalls = () => list.mock.calls.map(([q]) => q).filter(q => q?.limit === 30);
  expect(inboxCalls()).toEqual([expect.objectContaining({ scope: 'active', created_from: selected.created_from, created_to: selected.created_to })]);
  await user.click(screen.getByRole('button', { name: /清除日期筛选/ }));
  await screen.findByText('保存的内容会出现在这里。');
  expect(inboxCalls().at(-1)?.created_from).toBeUndefined();
});

it('does not request an empty or unbounded interval for a skipped local date', async () => {
  const api = await admin();
  vi.spyOn(api, 'getActivity').mockImplementation(async q => ({ ...q, days: [
    { date: '2011-12-30', count: 0, created_from: '2011-12-30T10:00:00Z', created_to: '2011-12-30T10:00:00Z' },
  ] }));
  const list = vi.spyOn(api, 'listCollections');
  mount(api, '/inbox?date=2011-12-30');
  await screen.findByText('这一天没有符合条件的收藏');
  expect(list.mock.calls.some(([q]) => q?.limit === 30)).toBe(false);
});

it('only records explicit detail activation and lets the user hide a card', async () => {
  const api = await admin();
  const c = await api.createCollection({
    id: crypto.randomUUID(), document: { schema_version: 1, content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '种植计划' }] },
    ] } }, intent: '', upload_ids: [], project_ids: [], tag_ids: [],
  }, crypto.randomUUID());
  const { items } = await api.listCollections();
  const date = new Intl.DateTimeFormat('sv-SE').format(new Date());
  vi.spyOn(api, 'getResurface').mockResolvedValue({ date, items: [{ collection: items[0], reason: 'unclassified' }] });
  const opened = vi.spyOn(api, 'recordCollectionOpened');
  const hide = vi.spyOn(api, 'hideResurfaceItem');
  const user = userEvent.setup();
  mount(api, '/inbox');
  const section = within(await screen.findByRole('region', { name: '今日重现' }));
  expect(opened).not.toHaveBeenCalled();
  await user.click(section.getByRole('link', { name: '归类' }));
  expect(await screen.findByRole('heading', { name: '归类结果' })).toHaveFocus();
  expect(opened.mock.calls).toEqual([[c.id]]);
  await user.click(screen.getByRole('link', { name: '返回' }));
  await user.click(within(await screen.findByRole('region', { name: '今日重现' })).getByRole('button', { name: '今天不再显示' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '今日重现' })).toBeNull());
  expect(hide).toHaveBeenCalledWith(c.id, date, Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(opened).toHaveBeenCalledTimes(1);
});

it('persists the off preference and skips candidate requests on the next inbox visit', async () => {
  const api = await admin();
  const candidates = vi.spyOn(api, 'getResurface');
  const user = userEvent.setup();
  mount(api, '/settings');
  const toggle = await screen.findByRole('checkbox', { name: '在收件箱显示值得回看的收藏' });
  await waitFor(() => expect(toggle).toBeChecked());
  await user.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  await user.click(within(screen.getByRole('complementary', { name: '主导航' })).getByRole('link', { name: '收件箱' }));
  await screen.findByText('保存的内容会出现在这里。');
  expect(candidates).not.toHaveBeenCalled();
});
