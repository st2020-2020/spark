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
  expect(await screen.findByRole('heading', { name: '关联项目' })).toHaveFocus();
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
