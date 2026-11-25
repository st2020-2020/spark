import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes, createAppQueryClient } from '../App';
import { ApiProvider } from '../context/ApiContext';
import { AuthProvider } from '../context/AuthContext';
import { Modal } from '../components/Modal';
import { PurgeConfirmModal } from '../components/PurgeConfirmModal';
import { ToastProvider } from '../context/ToastContext';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

async function admin() {
  const api = createTestAdapter();
  await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
  return api;
}

function mount(api: TestAdapter, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders api={api}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

function paste(target: Element, text: string) {
  fireEvent.paste(target, {
    clipboardData: {
      types: ['text/plain'],
      getData: (format: string) => (format === 'text/plain' ? text : ''),
    },
  });
}

describe('v0.9.0 UX polish and motion behaviors', () => {
  // jsdom lacks caret geometry used by ProseMirror DOM updates/pastes.
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

  it('shows inferred URL pill with edit/dismiss, hides char counter below 300 chars, collapses inline composer on Escape, and suppresses active AI status bar', async () => {
    const api = await admin();
    await api.updatePreferences({ ai_enabled: true });
    const user = userEvent.setup();
    mount(api, '/inbox');

    const composer = await screen.findByRole('region', { name: '快速收集' });
    const textbox = within(composer).getByRole('textbox', { name: '收藏正文编辑器' });

    // AI active status bar stays quiet while enabled & not excluded
    expect(screen.queryByRole('status', { name: 'AI 自动整理状态' })).not.toBeInTheDocument();

    // Activating inline composer expands it, and pressing Escape while empty collapses it
    fireEvent.focus(textbox);
    expect(composer).toHaveClass('sp-composer--active');
    fireEvent.keyDown(textbox, { key: 'Escape' });
    expect(composer).not.toHaveClass('sp-composer--active');

    // Pasting short text with URL keeps char counter hidden (< 300) and shows light inferred URL pill
    textbox.focus();
    paste(textbox, '看下 https://example.com/guide');
    expect(composer.querySelector('.sp-char-count')).toBeNull();
    const urlPill = await within(composer).findByRole('status', { name: '已从正文识别网址' });
    expect(urlPill).toHaveTextContent('识别到网址：example.com');

    // Editing inferred URL opens and prefills the original URL field
    await user.click(within(urlPill).getByRole('button', { name: '编辑' }));
    const urlInput = within(composer).getByLabelText('附加网址') as HTMLInputElement;
    expect(urlInput.value).toBe('https://example.com/guide');

    // Clearing manual URL restores inferred URL pill, and dismissing hides it
    await user.clear(urlInput);
    await user.click(within(urlInput.closest('.sp-field')!).getByRole('button', { name: '收起' }));
    const pillAgain = await within(composer).findByRole('status', { name: '已从正文识别网址' });
    await user.click(within(pillAgain).getByRole('button', { name: '收起网址识别提示' }));
    expect(within(composer).queryByRole('status', { name: '已从正文识别网址' })).not.toBeInTheDocument();

    // Reaching >= 300 chars reveals soft counter
    textbox.focus();
    paste(textbox, ' ' + '字'.repeat(290));
    await waitFor(() => {
      expect(composer.querySelector('.sp-char-count')).not.toBeNull();
    });
  });

  it('optimistically toggles read/unread dot immediately and rolls back on failure', async () => {
    const api = await admin();
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '乐观已读测试' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'opt-read',
    );

    let rejectWrite!: (err: Error) => void;
    vi.spyOn(api, 'setReadState').mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectWrite = reject;
        }),
    );

    const user = userEvent.setup();
    mount(api, '/inbox');

    await screen.findByText('乐观已读测试');
    const card = screen.getByText('乐观已读测试').closest('article')!;
    expect(within(card).getByRole('img', { name: '未读' })).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));

    // Unread dot disappears optimistically before network finishes
    await waitFor(() => {
      expect(within(card).queryByRole('img', { name: '未读' })).not.toBeInTheDocument();
    });

    // Rejecting rolls back unread dot
    rejectWrite(new Error('network boom'));
    expect(await within(card).findByRole('img', { name: '未读' })).toBeInTheDocument();
    expect(col.id).toBeTruthy();
  });

  it('toggles ActivityCalendar date filter off when clicking selected date and marks today', async () => {
    const api = await admin();
    const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
    const user = userEvent.setup();
    mount(api, `/inbox?date=${today}`);

    const calendar = await screen.findByRole('region', { name: '灵光日历' });
    const todayLink = await within(calendar).findByRole('link', { current: 'date' });
    expect(todayLink).toHaveAttribute('data-today', 'true');

    // Clicking selected date toggles off back to /inbox (no date badge)
    await user.click(todayLink);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /清除日期筛选/ })).not.toBeInTheDocument();
    });
  });

  it('supports one-click active project classify with undo toast and demotes empty triage CTA in UnclassifiedPage', async () => {
    const api = await admin();
    const project = await api.createProject(
      { name: '手帐纸贴', description: '', focus_points: [] },
      'p-tape',
    );
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '一点即归入测试笔记' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'quick-classify',
    );

    const user = userEvent.setup();
    mount(api, '/unclassified');

    await screen.findByText('一点即归入测试笔记');
    const triageLink = screen.getByRole('link', { name: '开始整理' });
    expect(triageLink).toHaveClass('sp-btn--primary');

    // One-click classify active project tape
    await user.click(screen.getByRole('button', { name: `归入项目 ${project.name}` }));
    expect(await screen.findByText('已归入项目')).toBeInTheDocument();

    // Empty unclassified list demotes primary 开始整理 button
    await waitFor(() => {
      expect(screen.getByRole('link', { name: '开始整理' })).not.toHaveClass('sp-btn--primary');
    });

    // Click undo in toast to restore collection to unclassified
    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(await screen.findByText('一点即归入测试笔记')).toBeInTheDocument();
    expect(col.id).toBeTruthy();
  });

  it('supports project search clear/Escape, Settings two-step session revoke cancel, and PurgeConfirmModal autofocus on Cancel', async () => {
    const api = await admin();
    const proj = await api.createProject(
      { name: '研究档案', description: '', focus_points: [] },
      'p-search',
    );
    const revokeSpy = vi.spyOn(api, 'revokeSession');
    vi.spyOn(api, 'listSessions').mockResolvedValue({
      items: [
        {
          id: 'sess-current',
          device_label: 'Chrome · macOS',
          kind: 'web',
          current: true,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
        },
        {
          id: 'sess-other',
          device_label: 'Spark macOS 桌面端',
          kind: 'desktop',
          current: false,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
        },
      ],
    });

    const user = userEvent.setup();
    mount(api, `/projects/${proj.id}`);

    const searchInput = await screen.findByRole('searchbox', { name: '在当前项目内搜索' });
    await user.type(searchInput, '关键词');
    const clearBtn = await screen.findByRole('button', { name: '清空项目内搜索' });
    await user.click(clearBtn);
    expect(searchInput).toHaveValue('');

    await user.click(searchInput);
    expect(searchInput).toHaveFocus();
    fireEvent.keyDown(searchInput, { key: 'Escape' });
    expect(searchInput).not.toHaveFocus();

    // Switch to Settings view cleanly
    mount(api, '/settings');

    const desktopLabel = await screen.findByText('Spark macOS 桌面端');
    const row = desktopLabel.closest<HTMLElement>('.sp-session-row')!;
    await user.click(within(row).getByRole('button', { name: '撤销' }));
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(within(row).getByRole('button', { name: '确认撤销' })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: '取消' }));
    expect(revokeSpy).not.toHaveBeenCalled();
    expect(within(row).getByRole('button', { name: '撤销' })).toBeInTheDocument();

    // Check PurgeConfirmModal defaults focus to Cancel
    render(
      <ToastProvider>
        <PurgeConfirmModal
          open
          targetSummary="高危测试条"
          isSubmitting={false}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  });

  it('shows gentle toast when hiding Resurface card and highlights/checkmarks in CommandPalette', async () => {
    const api = await admin();
    await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '旧日记碎片' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'resurface-note',
    );
    const { items } = await api.listCollections();
    const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
    vi.spyOn(api, 'getResurface').mockResolvedValue({
      date: today,
      items: [{ collection: items[0], reason: 'unclassified' }],
    });

    const user = userEvent.setup();
    mount(api, '/inbox');

    const section = within(await screen.findByRole('region', { name: '今日重现' }));
    await user.click(section.getByRole('button', { name: '今天不再显示' }));
    expect(await screen.findByText('今天先收起这条回看')).toBeInTheDocument();

    // Sidebar uses 快速跳转 and opens CommandPalette with active checkmark and query highlight
    const sidebar = within(screen.getByRole('complementary', { name: '主导航' }));
    await user.click(sidebar.getByRole('button', { name: '快速跳转' }));
    const combobox = await screen.findByRole('combobox', { name: '搜索收藏、项目或命令' });
    await user.type(combobox, '薄荷晨雾');
    const paletteOption = await screen.findByRole('option', { name: '配色 · 薄荷晨雾' });
    expect(paletteOption.querySelector('mark')).not.toBeNull();
    expect(paletteOption.querySelector('.sp-command-row-check')).not.toBeNull();
  });

  it('opens CommandPalette via Cmd/Ctrl+K from both composer editor and search input, while keeping single-key shortcuts suppressed inside inputs', async () => {
    const api = await admin();
    const user = userEvent.setup();
    mount(api, '/inbox');

    const textbox = await waitFor(() => {
      const live = screen.getByRole('textbox', { name: '收藏正文编辑器' });
      live.focus();
      expect(live).toHaveFocus();
      return live;
    });

    // Single-key N inside editor must not trigger quick capture sheet / interfere
    fireEvent.keyDown(textbox, { key: 'n' });
    expect(screen.queryByRole('dialog', { name: '快速收集' })).not.toBeInTheDocument();

    // Cmd+K inside [contenteditable="true"] editor opens CommandPalette
    fireEvent.keyDown(textbox, { key: 'k', metaKey: true });
    const command = screen.getByRole('combobox', { name: '搜索收藏、项目或命令' });
    expect(command).toHaveFocus();
    fireEvent.keyDown(command, { key: 'Escape' });
    expect(textbox).toHaveFocus();

    // Ctrl+K inside header <input> search box also opens CommandPalette
    const headerSearch = screen.getByRole('searchbox', { name: '搜索收藏' });
    await user.click(headerSearch);
    expect(headerSearch).toHaveFocus();
    fireEvent.keyDown(headerSearch, { key: 'k', ctrlKey: true });
    const commandFromSearch = screen.getByRole('combobox', { name: '搜索收藏、项目或命令' });
    expect(commandFromSearch).toHaveFocus();
    fireEvent.keyDown(commandFromSearch, { key: 'Escape' });
    expect(headerSearch).toHaveFocus();
  });

  it('uses server undo_receipt without reset fallback and omits undo when receipt is absent', async () => {
    const api = await admin();
    const proj = await api.createProject(
      { name: '回执验证项目', description: '', focus_points: [] },
      'p-receipt',
    );
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '回执精准撤销笔记' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'receipt-col',
    );

    const updateSpy = vi.spyOn(api, 'updateProjectDecisions');
    const undoSpy = vi.spyOn(api, 'undoProjectDecisions');
    const user = userEvent.setup();
    mount(api, '/unclassified');

    await screen.findByText('回执精准撤销笔记');
    await user.click(screen.getByRole('button', { name: `归入项目 ${proj.name}` }));
    expect(await screen.findByText('已归入项目')).toBeInTheDocument();

    // updateProjectDecisions must receive an idempotencyKey
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]?.[2]).toBeTruthy();

    // Click Toast undo and verify undoProjectDecisions is invoked and NEVER reset
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(undoSpy).toHaveBeenCalledTimes(1));
    const resetCalled = updateSpy.mock.calls.some(([, body]) =>
      body.operations.some((op) => op.action === 'reset'),
    );
    expect(resetCalled).toBe(false);
    expect(await screen.findByText('回执精准撤销笔记')).toBeInTheDocument();

    // If server returns no undo_receipt, Toast renders without undo button
    const rawDetail = await api.getCollection(col.id);
    updateSpy.mockResolvedValueOnce({ ...rawDetail, undo_receipt: undefined });
    await user.click(screen.getByRole('button', { name: `归入项目 ${proj.name}` }));
    expect(await screen.findByText('已归入项目')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
  });

  it('optimistically updates SearchHit ({ collection, snippets }) rows and only rolls back failed item without clobbering concurrent card state', async () => {
    const api = await admin();
    const colA = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '并发标记 卡片A' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'card-a',
    );
    const colB = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '并发标记 卡片B' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'card-b',
    );

    let rejectA!: (err: Error) => void;
    const realSetReadState = api.setReadState.bind(api);
    vi.spyOn(api, 'setReadState').mockImplementation((id, body) => {
      if (id === colA.id) {
        return new Promise((_, reject) => {
          rejectA = reject;
        });
      }
      return realSetReadState(id, body);
    });

    const user = userEvent.setup();
    mount(api, '/collections?q=' + encodeURIComponent('并发标记'));

    const [matchA] = await screen.findAllByText(/卡片A/);
    const [matchB] = await screen.findAllByText(/卡片B/);
    const cardA = matchA.closest('article')!;
    const cardB = matchB.closest('article')!;

    expect(within(cardA).getByRole('img', { name: '未读' })).toBeInTheDocument();
    expect(within(cardB).getByRole('img', { name: '未读' })).toBeInTheDocument();

    // Start slow read toggle on Card A (in-flight, optimistic read applied)
    await user.click(within(cardA).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));
    await waitFor(() => {
      expect(within(cardA).queryByRole('img', { name: '未读' })).not.toBeInTheDocument();
    });

    // Concurrently complete read toggle on Card B while Card A is still in-flight
    await user.click(within(cardB).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));
    await waitFor(() => {
      expect(within(cardB).queryByRole('img', { name: '未读' })).not.toBeInTheDocument();
    });

    // Fail Card A -> only Card A rolls back to unread; Card B stays read!
    rejectA(new Error('card A failed'));
    expect(await within(cardA).findByRole('img', { name: '未读' })).toBeInTheDocument();
    expect(within(cardB).queryByRole('img', { name: '未读' })).not.toBeInTheDocument();
    expect(colB.id).toBeTruthy();
  });

  it('guards Cmd/Ctrl+K when a mention listbox is open, executes Toast actions once, and resets sheet swipe state on cancel/resize', async () => {
    const api = await admin();
    await api.createTag({ name: '动效' }, 'tag-motion');
    const user = userEvent.setup();
    mount(api, '/inbox');

    const textbox = await waitFor(() => {
      const live = screen.getByRole('textbox', { name: '收藏正文编辑器' });
      live.focus();
      expect(live).toHaveFocus();
      return live;
    });

    // Open # mention listbox via paste and ensure Cmd+K does not interrupt it
    paste(textbox, '灵感 #');
    expect(await screen.findByRole('listbox', { name: '标签联想' })).toBeInTheDocument();
    fireEvent.keyDown(textbox, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog', { name: '命令面板' })).not.toBeInTheDocument();

    // Verify Toast action executes only once even on rapid double click
    const onAction = vi.fn();
    function ToastTrigger() {
      return (
        <PurgeConfirmModal
          open={false}
          isSubmitting={false}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      );
    }
    const toastSpyView = render(
      <ToastProvider>
        <ToastTrigger />
      </ToastProvider>,
    );
    toastSpyView.unmount();

    const { useToast } = await import('../context/ToastContext');
    function DoubleClickHarness() {
      const { pushToast } = useToast();
      return (
        <button
          type="button"
          onClick={() => pushToast({ message: '测试提示', actionLabel: '只执行一次', onAction })}
        >
          触发提示
        </button>
      );
    }
    render(
      <ToastProvider>
        <DoubleClickHarness />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: '触发提示' }));
    const actionBtn = await screen.findByRole('button', { name: '只执行一次' });
    fireEvent.click(actionBtn);
    fireEvent.click(actionBtn);
    expect(onAction).toHaveBeenCalledTimes(1);

    // Verify useSheetSwipeDismiss resets drag state on lostpointercapture & desktop resize
    const { useSheetSwipeDismiss } = await import('../lib/motion');
    const prevWidth = window.innerWidth;
    const prevPointerEvent = window.PointerEvent;
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    function SwipeHarness({ enabled }: { enabled: boolean }) {
      const { isDragging, swipeStyle, swipeHandlers } = useSheetSwipeDismiss({
        enabled,
        onDismiss: () => {},
      });
      return (
        <div
          data-testid="swipe-zone"
          data-dragging={isDragging ? 'true' : 'false'}
          style={swipeStyle}
          {...swipeHandlers}
        />
      );
    }
    const { rerender } = render(<SwipeHarness enabled />);
    const zone = screen.getByTestId('swipe-zone');
    fireEvent(zone, new TestPointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100, pointerId: 1 }));
    fireEvent(zone, new TestPointerEvent('pointermove', { bubbles: true, clientY: 150, pointerId: 1 }));
    expect(zone).toHaveAttribute('data-dragging', 'true');
    expect(zone.style.transform).toBe('translateY(50px)');
    fireEvent.lostPointerCapture(zone);
    expect(zone).toHaveAttribute('data-dragging', 'false');
    expect(zone.style.transform).toBe('');

    fireEvent(zone, new TestPointerEvent('pointerdown', { bubbles: true, button: 0, clientY: 100, pointerId: 2 }));
    fireEvent(zone, new TestPointerEvent('pointermove', { bubbles: true, clientY: 140, pointerId: 2 }));
    expect(zone.style.transform).toBe('translateY(40px)');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    fireEvent(window, new Event('resize'));
    expect(zone).toHaveAttribute('data-dragging', 'false');
    expect(zone.style.transform).toBe('');
    rerender(<SwipeHarness enabled={false} />);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: prevWidth });
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: prevPointerEvent,
    });
  });

  it('clears global Toasts on logout and drops late read/classify/undo responses without writing cleared cache', async () => {
    const api = await admin();
    const proj = await api.createProject(
      { name: '跨会话项目', description: '', focus_points: [] },
      'p-session-guard',
    );
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '登出守卫笔记' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'session-guard-col',
    );

    const queryClient = createAppQueryClient();
    const realSetReadState = api.setReadState.bind(api);
    let resolveLateRead!: (value: Awaited<ReturnType<typeof realSetReadState>>) => void;
    vi.spyOn(api, 'setReadState').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLateRead = resolve;
        }),
    );

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/unclassified']}>
        <QueryClientProvider client={queryClient}>
          <ApiProvider api={api}>
            <ToastProvider>
              <AuthProvider>
                <AppRoutes />
              </AuthProvider>
            </ToastProvider>
          </ApiProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // 1. Trigger classify to display an undo Toast, then verify logout immediately clears Toasts
    await screen.findByText('登出守卫笔记');
    await user.click(screen.getByRole('button', { name: `归入项目 ${proj.name}` }));
    expect(await screen.findByText('已归入项目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument();

    // 2. Also navigate to /inbox with a new unread item and start an in-flight read toggle before logging out
    const col2 = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '迟到响应测试' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'late-read-col',
    );
    const readSnapshot = await api.getCollection(col2.id);
    await user.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('link', {
        name: '收件箱',
      }),
    );
    await screen.findByText('迟到响应测试');
    const card2 = screen.getByText('迟到响应测试').closest('article')!;
    await user.click(within(card2).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));

    // Log out via sidebar account menu
    const sidebar = within(screen.getByRole('complementary', { name: '主导航' }));
    await user.click(sidebar.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '撤销' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText('已归入项目')).not.toBeInTheDocument();

    // Resolve late read after logout -> must NOT populate ['collection', col2.id]
    act(() => {
      resolveLateRead({
        ...readSnapshot,
        resource_version: readSnapshot.resource_version + 1,
        read_at: new Date().toISOString(),
      });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(queryClient.getQueryData(['collection', col2.id])).toBeUndefined();
    expect(col.id).toBeTruthy();
  });

  it('rejects AI suggestion confirmation when UI lacks run_id or project_version instead of blindly adopting v2', async () => {
    const api = await admin();
    const proj = await api.createProject(
      { name: '快照项目', description: '', focus_points: [] },
      'p-snap',
    );
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '缺快照建议笔记' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'no-snap-col',
    );

    // List returns suggestion WITHOUT suggestion_run_id / project_version,
    // while getCollection returns newer v2 run.
    const realList = api.listCollections.bind(api);
    const realGet = api.getCollection.bind(api);
    vi.spyOn(api, 'listCollections').mockImplementation(async (q, signal) => {
      const res = await realList(q, signal);
      return {
        ...res,
        items: res.items.map((item) =>
          item.id === col.id
            ? {
                ...item,
                projects: [
                  {
                    project_id: proj.id,
                    name: proj.name,
                    decision: 'suggested',
                    evidence: [],
                  },
                ],
              }
            : item,
        ),
      };
    });
    vi.spyOn(api, 'getCollection').mockImplementation(async (id) => {
      const detail = await realGet(id);
      if (id !== col.id) return detail;
      return {
        ...detail,
        projects: [
          {
            project_id: proj.id,
            name: proj.name,
            decision: 'suggested',
            suggestion_run_id: 'run-v2',
            project_version: 2,
            evidence: [],
          },
        ],
      };
    });
    const updateSpy = vi.spyOn(api, 'updateProjectDecisions');

    const user = userEvent.setup();
    mount(api, '/unclassified');

    await screen.findByText(`建议归入：${proj.name}`);
    await user.click(screen.getByRole('button', { name: '加入项目' }));

    expect(
      await screen.findByText(/当前建议缺少完整版本快照，已为你同步最新建议/),
    ).toBeInTheDocument();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('prevents stale setReadState response from overwriting newer resource_version detail cache and prevents concurrent cards from flashing unread', async () => {
    const api = await admin();
    const colA = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '并发防闪 卡片A' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'conc-a',
    );
    const colB = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '并发防闪 卡片B' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'conc-b',
    );

    const queryClient = createAppQueryClient();
    const realGet = api.getCollection.bind(api);
    const baseDetailA = await realGet(colA.id);
    // Seed newer v3 detail cache before delayed v2 read response returns
    queryClient.setQueryData(['collection', colA.id], {
      ...baseDetailA,
      resource_version: baseDetailA.resource_version + 3,
      display_title: '最新标题 v3',
    });

    const realSetRead = api.setReadState.bind(api);
    let resolveA!: (val: Awaited<ReturnType<typeof realSetRead>>) => void;
    let resolveB!: (val: Awaited<ReturnType<typeof realSetRead>>) => void;
    vi.spyOn(api, 'setReadState').mockImplementation((id) => {
      if (id === colA.id) {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });
    const listSpy = vi.spyOn(api, 'listCollections');

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <QueryClientProvider client={queryClient}>
          <ApiProvider api={api}>
            <ToastProvider>
              <AuthProvider>
                <AppRoutes />
              </AuthProvider>
            </ToastProvider>
          </ApiProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText('并发防闪 卡片A');
    const cardA = screen.getByText('并发防闪 卡片A').closest('article')!;
    const cardB = screen.getByText('并发防闪 卡片B').closest('article')!;

    await user.click(within(cardA).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));
    await user.click(within(cardB).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));

    const listCallsBeforeB = listSpy.mock.calls.length;

    // Resolve B while A is still in flight -> list MUST NOT invalidate yet so A stays optimistically read
    const updatedB = await realSetRead(colB.id, { read: true });
    act(() => {
      resolveB(updatedB);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(listSpy.mock.calls.length).toBe(listCallsBeforeB);
    expect(within(cardA).queryByRole('img', { name: '未读' })).not.toBeInTheDocument();

    // Now resolve A with an older resource_version (<= v1) -> newer v3 display_title stays intact and list refreshes now!
    act(() => {
      resolveA({
        ...baseDetailA,
        resource_version: baseDetailA.resource_version,
        display_title: '旧标题 v1',
        read_at: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(listSpy.mock.calls.length).toBeGreaterThan(listCallsBeforeB);
    });
    const cachedDetail = queryClient.getQueryData<typeof baseDetailA>(['collection', colA.id]);
    expect(cachedDetail?.display_title).toBe('最新标题 v3');
    expect(cachedDetail?.resource_version).toBe(baseDetailA.resource_version + 3);
  });

  it('reopens closing Modal cleanly (inert cleared before focus), marks exiting Resurface card inert, and transitions unread dot on the same DOM node', async () => {
    const prevGetAnimations = Element.prototype.getAnimations;
    Object.defineProperty(Element.prototype, 'getAnimations', {
      configurable: true,
      value: () => [],
    });

    try {
      // 1. Modal reopen during closing clears inert synchronously before autofocus
      function ModalReopenHarness() {
        const [open, setOpen] = useState(true);
        return (
          <>
            <button type="button" onClick={() => setOpen(false)}>
              关弹窗
            </button>
            <button type="button" onClick={() => setOpen(true)}>
              重开弹窗
            </button>
            <Modal open={open} title="重开焦点测试" onClose={() => setOpen(false)}>
              <button type="button" data-dialog-autofocus>
                焦点按钮
              </button>
            </Modal>
          </>
        );
      }
      const { useState } = await import('react');
      const user = userEvent.setup();
      const modalView = render(<ModalReopenHarness />);
      const dialog = screen.getByRole('dialog', { name: '重开焦点测试' });
      expect(dialog.inert).toBe(false);
      await user.click(screen.getByRole('button', { name: '关弹窗' }));
      expect(dialog.inert).toBe(true);
      await user.click(screen.getByRole('button', { name: '重开弹窗' }));
      expect(dialog.inert).toBe(false);
      expect(screen.getByRole('button', { name: '焦点按钮' })).toHaveFocus();
      modalView.unmount();

      // 2. Resurface exiting clone is inert AND CollectionCard unread dot transitions on the exact same DOM node
      const api = await admin();
      await api.createCollection(
        {
          id: crypto.randomUUID(),
          document: {
            schema_version: 1,
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '同节点红点与惰性重现' }] }],
            },
          },
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        'same-node-dot',
      );
      const { items } = await api.listCollections();
      const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
      vi.spyOn(api, 'getResurface').mockResolvedValue({
        date: today,
        items: [{ collection: items[0], reason: 'unclassified' }],
      });
      const hideSpy = vi.spyOn(api, 'hideResurfaceItem');

      mount(api, '/inbox');
      const section = within(await screen.findByRole('region', { name: '今日重现' }));
      const resurfaceBtn = section.getByRole('button', { name: '今天不再显示' });
      const resurfaceArticle = resurfaceBtn.closest('article')!;
      await user.click(resurfaceBtn);
      expect(resurfaceArticle).toHaveClass('is-hiding');
      expect(resurfaceArticle.inert).toBe(true);
      expect(hideSpy).toHaveBeenCalledTimes(1);

      const mainCard = screen.getAllByText('同节点红点与惰性重现')
        .map((el) => el.closest('article'))
        .find((el): el is HTMLElement => Boolean(el?.classList.contains('sp-note')))!;
      const dotBefore = within(mainCard).getByRole('img', { name: '未读' });

      await user.click(within(mainCard).getByRole('button', { name: '更多操作' }));
      await user.click(screen.getByRole('menuitem', { name: '标为已读' }));

      // Exact same DOM node remains connected with .is-read class immediately on transition
      expect(dotBefore.isConnected).toBe(true);
      expect(dotBefore).toHaveClass('sp-unread-dot', 'is-read');
      expect(within(mainCard).queryByRole('img', { name: '未读' })).not.toBeInTheDocument();

      await waitFor(
        () => {
          expect(dotBefore.isConnected).toBe(false);
        },
        { timeout: 1000 },
      );
    } finally {
      Object.defineProperty(Element.prototype, 'getAnimations', {
        configurable: true,
        value: prevGetAnimations,
      });
    }
  });

  it('syncs list row resource_version without accepting out-of-order v2 over v3, and preserves captured targetRead when reconnecting from offline', async () => {
    const api = await admin();
    const colA = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '版本同步 卡片A' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'sync-rv-a',
    );
    const colB = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '乱序保护 卡片B' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'sync-rv-b',
    );
    const colC = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '离线已读 卡片C' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'offline-read-c',
    );

    const queryClient = createAppQueryClient();
    const realGet = api.getCollection.bind(api);
    const realTrash = api.trashCollection.bind(api);
    const realSetRead = api.setReadState.bind(api);

    const detailA = await realGet(colA.id);
    const detailB = await realGet(colB.id);

    let resolveKeepInFlight!: () => void;
    const keepInFlightPromise = new Promise<void>((r) => {
      resolveKeepInFlight = r;
    });
    let resolveDelayedB!: (val: Awaited<ReturnType<typeof realSetRead>>) => void;

    const setReadSpy = vi.spyOn(api, 'setReadState').mockImplementation(async (id, body) => {
      if (id === colA.id) {
        return {
          ...detailA,
          resource_version: detailA.resource_version + 1,
          read_at: new Date().toISOString(),
        };
      }
      if (id === colB.id) {
        return new Promise((resolve) => {
          resolveDelayedB = resolve;
        });
      }
      if (id === colC.id) {
        await keepInFlightPromise;
        return realSetRead(id, body);
      }
      return realSetRead(id, body);
    });

    const trashSpy = vi.spyOn(api, 'trashCollection');

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <QueryClientProvider client={queryClient}>
          <ApiProvider api={api}>
            <ToastProvider>
              <AuthProvider>
                <AppRoutes />
              </AuthProvider>
            </ToastProvider>
          </ApiProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText('版本同步 卡片A');
    const cardA = screen.getByText('版本同步 卡片A').closest('article')!;
    const cardB = screen.getByText('乱序保护 卡片B').closest('article')!;
    const cardC = screen.getByText('离线已读 卡片C').closest('article')!;

    // 1. Mark B so it is in-flight, and mark A so A finishes while B is still in-flight (no list invalidation yet!)
    await user.click(within(cardB).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));
    await user.click(within(cardA).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));

    // A finished with updated resource_version = detailA.resource_version + 1;
    // trash A before B finishes must use the synced resource_version (+1), NOT stale version!
    await waitFor(() => {
      const listData = queryClient.getQueriesData<{
        pages: Array<{ items: Array<{ id: string; resource_version: number }> }>;
      }>({
        queryKey: ['collections'],
      });
      const rowA = listData
        .flatMap(([, d]) => (d && Array.isArray(d.pages) ? d.pages.flatMap((p) => p.items) : []))
        .find((i) => i.id === colA.id);
      expect(rowA?.resource_version).toBe(detailA.resource_version + 1);
    });
    // Also seed real server version on mock server for colA so trash passes with new resource_version
    await realSetRead(colA.id, { read: true });
    await user.click(within(cardA).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '移入回收站' }));
    expect(trashSpy).toHaveBeenCalledWith(colA.id, {
      base_resource_version: detailA.resource_version + 1,
    });
    void realTrash;

    // 2. While B's older response (v2 read) is still pending, simulate newer v3 unread in list cache,
    // then resolve B with stale v2 -> list row MUST reject v2 and stay unread at v3!
    queryClient.setQueriesData<{
      pages: Array<{ items: Array<{ id: string; resource_version: number; read_at?: string }> }>;
    }>({ queryKey: ['collections'] }, (old) => {
      if (!old || !Array.isArray(old.pages)) return old;
      return {
        ...old,
        pages: old.pages.map((p) => ({
          ...p,
          items: p.items.map((item) =>
            item.id === colB.id
              ? { ...item, resource_version: detailB.resource_version + 3, read_at: undefined }
              : item,
          ),
        })),
      };
    });
    act(() => {
      resolveDelayedB({
        ...detailB,
        resource_version: detailB.resource_version + 2,
        read_at: new Date().toISOString(),
      });
    });
    await waitFor(() => {
      expect(within(cardB).getByRole('img', { name: '未读' })).toBeInTheDocument();
    });

    // 3. Offline/paused mutation on C captures targetRead = true even though optimistic UI flips props to read before mutationFn runs
    const onLineSpy = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    await user.click(within(cardC).getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '标为已读' }));
    // Optimistically card C is already read; now reconnect online and resolve
    onLineSpy.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    resolveKeepInFlight();

    await waitFor(() => {
      expect(setReadSpy).toHaveBeenCalledWith(colC.id, { read: true });
    });
  });

  it('hides mobile tabbar across editable switches, restores it on button focus, and cancels pending focusout timer on unmount', async () => {
    const api = await admin();
    const { unmount } = mount(api, '/inbox');
    const composer = await screen.findByRole('region', { name: '快速收集' });
    const textbox = within(composer).getByRole('textbox', { name: '收藏正文编辑器' });
    const mobileTabbar = screen.getByRole('navigation', { name: '手机底部导航' });
    // Expand two real <input> fields (intent & URL) since jsdom leaves contentEditable flags unset.
    const user = userEvent.setup();
    fireEvent.focus(textbox);
    await user.click(within(composer).getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '补一句用途' }));
    await user.click(within(composer).getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '附加网址' }));
    const intentInput = within(composer).getByPlaceholderText('以后可能用在哪儿？');
    const urlInput = within(composer).getByLabelText('附加网址');
    const jumpButton = screen.getByRole('button', { name: '快速跳转' });
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');

    try {
      vi.useFakeTimers();

      // 1. Focusing an editable target hides the mobile tabbar, and switching to another input keeps it hidden.
      act(() => {
        intentInput.focus();
        fireEvent.focusIn(intentInput);
      });
      expect(mobileTabbar).toHaveClass('sp-tabbar--hidden');

      act(() => {
        fireEvent.focusOut(intentInput);
        urlInput.focus();
        fireEvent.focusIn(urlInput);
        vi.advanceTimersByTime(100);
      });
      expect(mobileTabbar).toHaveClass('sp-tabbar--hidden');

      // 2. Moving from an input to a non-editable button right after focusout restores the mobile tabbar.
      act(() => {
        fireEvent.focusOut(urlInput);
        jumpButton.focus();
        fireEvent.focusIn(jumpButton);
        vi.advanceTimersByTime(100);
      });
      expect(mobileTabbar).not.toHaveClass('sp-tabbar--hidden');

      // 3. Unmounting while a focusout timer is pending clears the timeout without accessing torn-down document.
      act(() => {
        intentInput.focus();
        fireEvent.focusIn(intentInput);
        fireEvent.focusOut(intentInput);
      });
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalled();

      // Simulate JSDOM tearing down `document` immediately after test cleanup.
      vi.stubGlobal('document', undefined);
      expect(() => {
        vi.advanceTimersByTime(100);
      }).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      clearTimeoutSpy.mockRestore();
    }
  });
});
