// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Book } from '../src/Book';
import { Login } from '../src/shared';
import { Capture } from '../src/Panel';
import type { Request, State } from '../src/bridge';

const state: State = {
  session: {
    connected: true,
    account_id: 'a',
    account_label: 'writer@example.test',
  },
  counts: {},
  origin: '',
  palette: 'mint',
  mode: 'system',
  capture_key: 'Control+Option+Space',
  screenshot_key: 'Option+Shift+4',
};
function host() {
  return vi.fn(
    async (
      path: string,
      _method?: string,
      _body?: unknown,
    ): Promise<unknown> => {
      if (path === 'capture') return { item: { id: 'local-note' } };
      if (path === 'projects' || path === 'tags')
        return [{ id: path, name: path === 'projects' ? '速写' : '纸张' }];
      if (path === 'clipboard') return { available: false };
      if (path.startsWith('collections/page')) return { items: [] };
      return [];
    },
  );
}
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(cleanup);

it('从手帐入口就地续写，切页保留草稿，组合输入不会提前保存', async () => {
  const req = host();
  render(<Book state={state} req={req as Request} refresh={() => {}} />);
  fireEvent.click(
    await screen.findByRole('button', { name: '记下第一条灵感' }),
  );
  const editor = screen.getByRole('textbox', { name: '记录灵感' });
  expect(document.activeElement).toBe(editor);
  fireEvent.change(editor, {
    target: { value: '线稿 https://example.test/ @速' },
  });
  fireEvent.click(await screen.findByRole('option', { name: '@ 速写' }));
  fireEvent.change(editor, {
    target: { value: '线稿 https://example.test/ #纸' },
  });
  fireEvent.click(await screen.findByRole('option', { name: '# 纸张' }));
  fireEvent.click(screen.getByRole('button', { name: '用途' }));
  fireEvent.change(screen.getByRole('textbox', { name: '用途' }), {
    target: { value: '画册参考' },
  });
  fireEvent.paste(editor, {
    clipboardData: {
      files: [new File(['sample'], '纸张.png', { type: 'image/png' })],
    },
  });
  await screen.findByRole('button', { name: '移除 纸张.png' });
  fireEvent.click(screen.getByRole('button', { name: '全部收藏' }));
  fireEvent.click(screen.getByRole('button', { name: /随手记 ⌃⌥␣/ }));
  expect(document.activeElement).toBe(editor);
  fireEvent.click(screen.getByRole('button', { name: '全部收藏' }));
  fireEvent(window, new Event('spark-compose'));
  expect(document.activeElement).toBe(editor);
  fireEvent.keyDown(editor, { key: 'Enter', metaKey: true, isComposing: true });
  expect(req.mock.calls.some(([p]) => p === 'capture')).toBe(false);
  fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
  await screen.findByRole('button', { name: /本机已收下 · 查看/ });
  expect(req).toHaveBeenCalledWith('capture', 'POST', {
    raw_text: '线稿 https://example.test/ ',
    original_url: 'https://example.test/',
    suppress_url: false,
    intent: '画册参考',
    project_ids: ['projects'],
    tag_ids: ['tags'],
    attachments: [{ filename: '纸张.png', data_b64: 'c2FtcGxl' }],
  });
  expect(
    req.mock.calls.some(([p]) => p.startsWith('window/') || p === 'clipboard'),
  ).toBe(false);
});

it('浮窗保存失败保留原稿，成功后才隐藏窗口', async () => {
  const req = host();
  render(<Capture state={state} req={req as Request} />);
  const editor = screen.getByRole('textbox', {
    name: '记录灵感',
  }) as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: '纸上灵感' } });
  req.mockRejectedValueOnce(new Error('本机保存失败'));
  fireEvent.click(screen.getByRole('button', { name: /收下/ }));
  await screen.findByText('本机保存失败');
  expect(editor.value).toBe('纸上灵感');
  expect(req).not.toHaveBeenCalledWith('window/hide', 'POST');
  fireEvent.keyDown(editor, { key: 'Enter', metaKey: true });
  await waitFor(() => expect(req).toHaveBeenCalledWith('window/hide', 'POST'));
});

it('快搜按字面高亮，显示已有项目，Esc 分层返回原稿', async () => {
  const req = host();
  const searchHost: Request = (path, ...args) =>
    path.startsWith('search/local')
      ? Promise.resolve([
          {
            id: 'note',
            display_title: '参考 [图]',
            snippet: '[图]',
            sync_state: 'synced',
            projects: [{ project_id: 'p', name: '画册', decision: 'manual' }],
          },
        ] as never)
      : (req as Request)(path, ...args);
  render(<Capture state={state} req={searchHost} />);
  const editor = screen.getByRole('textbox', { name: '记录灵感' });
  fireEvent.change(editor, { target: { value: '还没写完' } });
  fireEvent.click(screen.getByRole('button', { name: '快搜 ⌘K' }));
  const input = screen.getByRole('textbox', { name: '搜索收藏' });
  fireEvent.change(input, { target: { value: '[图]' } });
  expect(
    (await screen.findAllByText('[图]', { selector: 'mark' })).length,
  ).toBe(2);
  await screen.findByText('画册');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect((input as HTMLInputElement).value).toBe('');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(
    (screen.getByRole('textbox', { name: '记录灵感' }) as HTMLTextAreaElement)
      .value,
  ).toBe('还没写完');
});

it('登录字段无效时在原位提示，焦点落回需修改的字段', () => {
  render(
    <Login
      state={{ ...state, session: { connected: false } }}
      onSuccess={() => {}}
    />,
  );
  const email = screen.getByRole('textbox', { name: '邮箱' });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(document.activeElement).toBe(email);
  expect(screen.getByRole('status').textContent).toBe('请输入有效的邮箱地址。');
  fireEvent.change(email, { target: { value: 'demo@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(document.activeElement).toBe(screen.getByLabelText('密码'));
  expect(screen.getByRole('status').textContent).toBe('请输入密码。');
});
