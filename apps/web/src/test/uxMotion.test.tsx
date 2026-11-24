import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppProviders, AppRoutes } from '../App';
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
});
