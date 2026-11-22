// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

it('空内联编辑器从用途输入按 Esc 收起，有原稿时保留编辑现场', async () => {
  render(<Book state={state} req={host() as Request} refresh={() => {}} />);
  fireEvent.click(
    await screen.findByRole('button', { name: '记下第一条灵感' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '用途' }));
  const purpose = screen.getByRole('textbox', { name: '用途' });
  fireEvent.keyDown(purpose, { key: 'Escape' });
  expect(screen.queryByRole('button', { name: /收下/ })).toBeNull();
  expect(document.activeElement).not.toBe(purpose);
  fireEvent.click(screen.getByRole('button', { name: /随手记 ⌃⌥␣/ }));
  const editor = screen.getByRole('textbox', { name: '记录灵感' });
  fireEvent.change(editor, { target: { value: '明日继续' } });
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(document.activeElement).toBe(editor);
  expect(screen.getByRole('button', { name: /收下/ })).toBeTruthy();
});

it('空发件箱可以从浮窗打开手帐', async () => {
  const req = host();
  render(<Capture state={state} req={req as Request} />);
  fireEvent.click(await screen.findByRole('button', { name: '打开手帐 ⌘O' }));
  expect(req).toHaveBeenCalledWith('window/main', 'POST');
  expect(screen.queryByText(/待同步/)).toBeNull();
});

it.each([
  [0, undefined],
  [2, 'unknown'],
  [0, '0001-01-01T00:00:00Z'],
] as const)(
  '断开设备时按 %i 条待处理记录说明后果，省略未知日期',
  async (count, expires_at) => {
    render(
      <Book
        state={{
          ...state,
          counts: { local_saved: count },
          session: { ...state.session, expires_at },
        }}
        req={host() as Request}
        refresh={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /设备与外观/ }));
    expect(screen.queryByText(/有效至/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '断开此设备' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain(
      count ? '2 条待处理记录' : '需要重新登录',
    );
    expect(dialog.textContent).not.toContain('0 条待处理记录');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
  },
);

it('手帐搜索按字面高亮，同时呈现已归类项目与本机待同步条目', async () => {
  const req = host();
  const searchHost: Request = (path, ...args) =>
    path.startsWith('search/local')
      ? Promise.resolve([
          {
            id: 'note',
            display_title: '[草图] 步道',
            snippet: '河岸',
            sync_state: 'synced',
            primary_type: 'image',
            projects: [
              { project_id: 'river', name: '河岸手册', decision: 'manual' },
            ],
          },
          {
            id: 'draft',
            display_title: '[草图] 入口',
            snippet: '现场记录',
            sync_state: 'local_saved',
            primary_type: 'text',
          },
        ] as never)
      : (req as Request)(path, ...args);
  render(<Book req={searchHost} state={state} refresh={() => {}} />);
  const input = screen.getByRole('textbox', { name: '搜索手帐' });
  fireEvent.change(input, { target: { value: '[草图]' } });
  expect(
    (await screen.findAllByText('[草图]', { selector: 'mark' })).length,
  ).toBe(2);
  expect(screen.getByRole('button', { name: /步道.*河岸手册/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /入口.*待同步/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole('heading', { name: '收件箱' })).toBeTruthy();
});

it('截屏权限提示随浮窗扩高，提示内可以打开系统设置，重试后移除旧提示', async () => {
  const req = host();
  render(<Capture state={state} req={req as Request} />);
  const camera = screen.getByRole('button', { name: '选区截屏' });
  fireEvent.click(camera);
  expect(req).toHaveBeenCalledWith('window/screenshot', 'POST');
  const panel = camera.closest('.panel')!;
  // jsdom has no layout. Model the taller content reported by WebKit after the event.
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 252 });
  fireEvent(window, new CustomEvent('spark-error', {
    detail: '需要开启系统“屏幕录制”权限才能使用选区截屏。',
  }));
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('屏幕录制');
  expect(req).toHaveBeenCalledWith('window/resize?height=252', 'POST');
  fireEvent.click(within(notice).getByRole('button', { name: '前往系统设置' }));
  expect(req).toHaveBeenCalledWith('window/settings', 'POST');
  fireEvent.click(camera);
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent(window, new CustomEvent('spark-error', { detail: '系统截屏未完成' }));
  expect((await screen.findByRole('status')).textContent).toBe('系统截屏未完成');
  expect(screen.queryByRole('button', { name: '前往系统设置' })).toBeNull();
});
