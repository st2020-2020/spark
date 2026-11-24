// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Book } from '../src/Book';
import { Login, Preview } from '../src/shared';
import { Capture } from '../src/Panel';
import { Search } from '../src/Search';
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
  // jsdom does not implement native dialog focus or the Escape cancel event.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
    this.querySelector('button')?.focus();
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
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
  const panel = camera.closest('.panel-content')!;
  // jsdom has no layout. Model the taller content reported by WebKit after the event.
  Object.defineProperty(panel, 'offsetHeight', {
    configurable: true,
    value: 252,
  });
  Object.defineProperty(panel, 'scrollHeight', {
    configurable: true,
    value: 256,
  });
  fireEvent(
    window,
    new CustomEvent('spark-error', {
      detail: '需要开启系统“屏幕录制”权限才能使用选区截屏。',
    }),
  );
  const notice = await screen.findByRole('status');
  expect(notice.textContent).toContain('屏幕录制');
  expect(req).toHaveBeenCalledWith('window/resize?height=252', 'POST');
  fireEvent.click(within(notice).getByRole('button', { name: '前往系统设置' }));
  expect(req).toHaveBeenCalledWith('window/settings', 'POST');
  fireEvent.click(camera);
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent(
    window,
    new CustomEvent('spark-error', { detail: '系统截屏未完成' }),
  );
  expect((await screen.findByRole('status')).textContent).toBe(
    '系统截屏未完成',
  );
  expect(screen.queryByRole('button', { name: '前往系统设置' })).toBeNull();
});

it('手帐搜索分层退出，重选当前侧栏也能从搜索或详情返回', async () => {
  const req = host();
  const searchHost: Request = (path, ...args) => {
    if (path.startsWith('search/local'))
      return Promise.resolve([
        {
          id: 'one',
          display_title: '步道',
          snippet: '参考',
          sync_state: 'synced',
        },
      ] as never);
    if (path === 'collections/one')
      return Promise.resolve({
        collection: { display_title: '步道', plain_text: '河岸参考' },
      } as never);
    return (req as Request)(path, ...args);
  };
  render(<Book req={searchHost} state={state} refresh={() => {}} />);
  const input = screen.getByRole('textbox', {
    name: '搜索手帐',
  }) as HTMLInputElement;
  const inbox = screen.getByRole('button', { name: '收件箱' });
  input.focus();
  fireEvent.change(input, { target: { value: '河岸' } });
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
  expect(input.value).toBe('河岸');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input.value).toBe('');
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(document.activeElement).not.toBe(input);
  fireEvent.change(input, { target: { value: '参考' } });
  await screen.findByRole('heading', { name: '搜索结果' });
  fireEvent.click(inbox);
  expect(screen.getByRole('heading', { name: '收件箱' })).toBeTruthy();
  fireEvent.change(input, { target: { value: '参考' } });
  fireEvent.click(await screen.findByRole('button', { name: /步道/ }));
  await screen.findByRole('heading', { name: '步道' });
  fireEvent.click(inbox);
  expect(input.value).toBe('');
  expect(screen.getByRole('heading', { name: '收件箱' })).toBeTruthy();
});

it('详情分别复制链接与正文，仅在写入成功时短暂确认', async () => {
  const req = host();
  const detailHost: Request = (path, ...args) =>
    path === 'collections/one'
      ? Promise.resolve({
          collection: {
            display_title: '参考',
            original_url: 'https://example.test/',
            plain_text: '河岸参考',
          },
        } as never)
      : (req as Request)(path, ...args);
  render(<Preview req={detailHost} id="one" />);
  const body = await screen.findByRole('button', { name: '复制正文' });
  const link = screen.getByRole('button', { name: '复制链接' });
  req.mockRejectedValueOnce(new Error('无法复制'));
  fireEvent.click(link);
  await screen.findByText('无法复制');
  expect(screen.queryByText('已复制')).toBeNull();
  fireEvent.click(link);
  await screen.findByRole('button', { name: '已复制' });
  expect(req).toHaveBeenCalledWith(
    'clipboard/copy',
    'POST',
    { text: 'https://example.test/' },
    expect.any(AbortSignal),
  );
  fireEvent.click(body);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '已复制' })).toHaveLength(2),
  );
  expect(req).toHaveBeenCalledWith(
    'clipboard/copy',
    'POST',
    { text: '河岸参考' },
    expect.any(AbortSignal),
  );
  await screen.findByRole('button', { name: '复制正文' }, { timeout: 2400 });
});

it('两种确认操作均从取消开始，Esc 恢复入口焦点和原稿', async () => {
  const req = host();
  const item = {
    id: 'draft',
    raw_text: '画册参考',
    state: 'needs_review',
    project_ids: [],
    tag_ids: [],
  };
  const draftHost: Request = (path, ...args) => {
    if (path === 'outbox') return Promise.resolve([item] as never);
    if (path === 'collections/draft') return Promise.resolve({ item } as never);
    return (req as Request)(path, ...args);
  };
  render(<Book req={draftHost} state={state} refresh={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /画册参考/ }));
  for (const label of ['删除本地稿', '断开此设备']) {
    if (label === '断开此设备')
      fireEvent.click(screen.getByRole('button', { name: /设备与外观/ }));
    const trigger = await screen.findByRole('button', { name: label });
    fireEvent.click(trigger);
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(document.activeElement).toBe(cancel);
    fireEvent(
      screen.getByRole('alertdialog'),
      new Event('cancel', { cancelable: true }),
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  }
  expect(
    req.mock.calls.some(
      ([p, m]) => p === 'session/disconnect' || m === 'DELETE',
    ),
  ).toBe(false);
});

it('手动同步等待刷新完成，期间不能重复触发', async () => {
  let finish: (() => void) | undefined;
  const req = host();
  const syncHost: Request = (path, ...args) =>
    path === 'sync/now'
      ? new Promise((resolve) => {
          finish = () => resolve(undefined as never);
        })
      : (req as Request)(path, ...args);
  // An expired session skips the automatic refresh on mount.
  render(
    <Book
      state={{ ...state, session: { ...state.session, expired: true } }}
      req={syncHost}
      refresh={() => {}}
    />,
  );
  const sync = screen.getByRole('button', {
    name: '立即同步',
  }) as HTMLButtonElement;
  fireEvent.click(sync);
  expect(sync.disabled).toBe(true);
  expect(sync.getAttribute('aria-busy')).toBe('true');
  finish!();
  await waitFor(() => expect(sync.disabled).toBe(false));
});

it('会话失效后刷新手帐仍可打开缓存详情，连续状态通知只读取本机数据', async () => {
  const requests: string[] = [];
  const expired = {
    ...state,
    session: { ...state.session, connected: false, expired: true },
  };
  const req: Request = async (path) => {
    requests.push(path);
    if (path.startsWith('collections?'))
      return [{ id: 'one', display_title: '本机记录' }] as never;
    if (path === 'collections/one?local=1')
      return {
        collection: {
          id: 'one',
          display_title: '本机记录',
          plain_text: '本机正文',
        },
      } as never;
    return [] as never;
  };
  render(<Book state={expired} req={req} refresh={() => {}} />);
  await screen.findByRole('button', { name: '本机记录' });
  fireEvent(window, new Event('spark-state'));
  fireEvent(window, new Event('spark-state'));
  fireEvent.click(await screen.findByRole('button', { name: '本机记录' }));
  await screen.findByText('本机正文');
  expect(requests).toContain('collections/one?local=1');
  expect(
    requests.some(
      (p) =>
        p.startsWith('collections/page') ||
        p === 'sync/now' ||
        p === 'collections/one',
    ),
  ).toBe(false);
});

it('写正文消隐当前剪贴板建议，Tab 回到普通导航', async () => {
  const base = host();
  const req: Request = (path, ...args) =>
    path === 'clipboard'
      ? Promise.resolve({
          available: true,
          change_count: 17,
          text: '复制片段',
        } as never)
      : (base as Request)(path, ...args);
  render(<Capture state={state} req={req} />);
  await screen.findByText('复制片段');
  const input = screen.getByRole('textbox', {
    name: '记录灵感',
  }) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '新想法' } });
  expect(screen.queryByText('复制片段')).toBeNull();
  expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
  expect(input.value).toBe('新想法');
  expect(base).toHaveBeenCalledWith('clipboard/dismiss', 'POST', {
    change_count: 17,
  });
  fireEvent(window, new Event('spark-show'));
  await waitFor(() =>
    expect(base.mock.calls.filter(([path]) => path === 'projects').length).toBe(
      2,
    ),
  );
  expect(screen.queryByText('复制片段')).toBeNull();
});

it('浮窗保持打开时收到目录刷新结果即可选择项目', async () => {
  let projects: { id: string; name: string }[] = [];
  const base = host();
  const req: Request = (path, ...args) =>
    path === 'projects'
      ? Promise.resolve(projects as never)
      : (base as Request)(path, ...args);
  render(<Capture state={state} req={req} />);
  const input = screen.getByRole('textbox', { name: '记录灵感' });
  fireEvent.change(input, { target: { value: '灵感 @画' } });
  expect(screen.queryByRole('option')).toBeNull();
  projects = [{ id: 'p', name: '画册' }];
  fireEvent(window, new Event('spark-state'));
  fireEvent.click(await screen.findByRole('option', { name: '@ 画册' }));
  expect((input as HTMLTextAreaElement).value).toBe('灵感 ');
});

it('快搜失效时在防抖结束后仍只读本机结果和缓存预览', async () => {
  const paths: string[] = [];
  const req: Request = async (path) => {
    paths.push(path);
    if (path.startsWith('search/local'))
      return [
        {
          id: 'one',
          display_title: '步道',
          snippet: '河岸',
          sync_state: 'synced',
        },
      ] as never;
    if (path === 'collections/one?local=1')
      return {
        collection: { display_title: '步道', plain_text: '缓存预览' },
      } as never;
    return [] as never;
  };
  vi.useFakeTimers();
  try {
    render(<Search req={req} back={() => {}} localOnly />);
    const input = screen.getByRole('textbox', { name: '搜索收藏' });
    fireEvent.change(input, { target: { value: '河岸' } });
    await act(() => vi.advanceTimersByTimeAsync(250));
    fireEvent.click(screen.getByRole('button', { name: /步道/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('缓存预览')).toBeTruthy();
    expect(paths.some((path) => path.startsWith('search/remote'))).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
