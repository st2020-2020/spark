import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createTestAdapter } from '../test-adapter/mockServer';
import { loadDraft, saveDraft } from '../lib/drafts';
import { EMPTY_DOCUMENT } from '../lib/document';

function renderWithAdapter(initialEntries: string[] = ['/login'], adapter = createTestAdapter()) {
  return {
    adapter,
    ...render(
      <MemoryRouter initialEntries={initialEntries}>
        <AppProviders api={adapter}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    ),
  };
}

function getSidebar() {
  return within(screen.getByRole('complementary', { name: '主导航' }));
}

async function loginAsAdmin(user: ReturnType<typeof userEvent.setup>, adapter = createTestAdapter()) {
  const rendered = renderWithAdapter(['/login'], adapter);
  await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
  await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
  return rendered;
}

describe('Spark Web key flows', () => {
  it.each([false, true])('reconciles an interrupted logout and preserves the draft (server signed out: %s)', async (signedOut) => {
    const user = userEvent.setup();
    const api = createTestAdapter();
    const session = await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    saveDraft(session.user.id, 'edit:sample', { document: EMPTY_DOCUMENT, intent: '保留本地资料' });
    const logout = api.logout.bind(api);
    vi.spyOn(api, 'logout').mockImplementationOnce(async () => {
      if (signedOut) await logout();
      throw new Error('连接中断');
    });
    renderWithAdapter(['/settings'], api);
    await user.click(await screen.findByRole('button', { name: '退出登录' }));
    if (signedOut) {
      await screen.findByRole('button', { name: '登录' });
    } else {
      await screen.findByText(/尚未退出登录/);
    }
    expect(loadDraft(session.user.id, 'edit:sample').data).toMatchObject({ intent: '保留本地资料' });
    if (!signedOut) {
      await user.click(screen.getByRole('button', { name: '退出登录' }));
      await screen.findByRole('button', { name: '登录' });
      expect(loadDraft(session.user.id, 'edit:sample').data).toBeNull();
    }
  });

  it('restores project search and type when returning from a collection', async () => {
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const project = await api.createProject({ name: '山地记录', description: '', focus_points: [] }, 'seed');
    await api.createCollection({ id: crypto.randomUUID(), original_url: 'https://example.com/AlpineRecall',
      document: EMPTY_DOCUMENT, intent: 'AlpineRecall', upload_ids: [], tag_ids: [], project_ids: [project.id] }, 'note');
    renderWithAdapter([`/projects/${project.id}`], api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('在当前项目内搜索'), 'AlpineRecall');
    await user.selectOptions(screen.getByRole('combobox', { name: '筛选类型' }), 'url');
    await user.click(await screen.findByRole('link', { name: '查看全文' }));
    await user.click(await screen.findByRole('link', { name: '返回' }));
    expect(await screen.findByLabelText('在当前项目内搜索')).toHaveValue('AlpineRecall');
    expect(screen.getByRole('combobox', { name: '筛选类型' })).toHaveValue('url');
    expect(await screen.findByRole('link', { name: '查看全文' })).toBeInTheDocument();
  });

  it.each([
    ['/inbox', '展开类型筛选', '内容类型'],
    ['/collections', '筛选', '按类型筛选'],
    ['/projects/:id', '', '筛选类型'],
  ])('filters image collections from %s', async (path, toggle, label) => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const project = path.includes(':id')
      ? await adapter.createProject({ name: '图片手记', description: '', focus_points: [] }, 'image-project')
      : undefined;
    const list = vi.spyOn(adapter, 'listCollections');
    const user = userEvent.setup();
    renderWithAdapter([project ? path.replace(':id', project.id) : path], adapter);
    if (toggle) await user.click(await screen.findByRole('button', { name: toggle }));
    const filter = await screen.findByRole('combobox', { name: label });
    await user.selectOptions(filter, within(filter).getByRole('option', { name: '图片' }));
    await waitFor(() => expect(list.mock.calls.some(([q]) =>
      q?.type === 'image' && q.project_id === project?.id,
    )).toBe(true));
  });

  it.each([
    ['Android WebView SparkAndroid/2', true],
    ['Android WebView SparkAndroid/20', false],
    ['Android Chrome Mobile', false],
  ])('exposes local drafts only to a compatible app (%s)', async (ua, supported) => {
    const agent = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
    try {
      const user = userEvent.setup();
      await loginAsAdmin(user);
      await user.click(screen.getByRole('button', { name: '更多导航' }));
      const drawer = within(screen.getByRole('dialog', { name: '导航菜单' }));
      const link = drawer.queryByRole('link', { name: '本机草稿' });
      if (supported) expect(link).toHaveAttribute('href', '/android/local-drafts');
      else expect(link).toBeNull();
      await user.click(drawer.getByRole('link', { name: '待归类' }));
      await screen.findByRole('heading', { name: '待归类' });
      expect(screen.getByRole('button', { name: '更多导航' })).toHaveAttribute('aria-current', 'location');
    } finally {
      agent.mockRestore();
    }
  });

  it('completes admin invite CSV preview/commit and registers a new user with 0-project empty state', async () => {
    const user = userEvent.setup();
    const { adapter } = await loginAsAdmin(user);

    await user.click(getSidebar().getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '管理后台' }));
    await screen.findByRole('heading', { name: '管理后台' });

    // Import invite batch CSV (error preview first, then valid CSV)
    await user.type(screen.getByLabelText('批次名称'), '内测二期');
    await user.type(screen.getByLabelText('CSV 内容'), 'BAD\nSPARK-NEW-0001,,1');
    await user.click(screen.getByRole('button', { name: '预览校验' }));
    await screen.findByText(/错误 1 条/);
    expect(screen.getByRole('button', { name: '确认导入' })).toBeDisabled();

    await user.clear(screen.getByLabelText('CSV 内容'));
    await user.type(screen.getByLabelText('CSV 内容'), 'code,expires_at,max_uses\nSPARK-NEW-0001,,1');
    await user.click(screen.getByRole('button', { name: '预览校验' }));
    await screen.findByText(/有效行 1 条，错误 0 条/);
    await user.click(screen.getByRole('button', { name: '确认导入' }));
    await screen.findByText('内测二期');

    // Logout via account menu and register with the newly imported invite code
    await user.click(getSidebar().getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await user.click(await screen.findByRole('link', { name: '使用邀请码注册' }));

    await user.type(screen.getByLabelText('邮箱'), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await screen.findByText(/测试适配器模拟验证码/);
    const code = adapter.getLastVerificationCode('alice@example.com')!;
    expect(code).toMatch(/^[0-9]{6}$/);

    await user.type(screen.getByLabelText('6 位邮箱验证码'), code);
    await user.type(screen.getByLabelText('邀请码'), 'SPARK-NEW-0001');
    await user.type(screen.getByLabelText('设置密码（12 至 128 位）'), 'AliceSecret1234!');
    await user.click(screen.getByRole('button', { name: '验证并注册' }));

    await screen.findByRole('heading', { name: '收件箱' });
    await screen.findByText('保存的内容会出现在这里。');
    expect(getSidebar().queryByRole('link', { name: '查看全部' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();
  });

  it('creates a project and saves a URL + intent collection from calm composer', async () => {
    const user = userEvent.setup();
    await loginAsAdmin(user);

    await user.click(getSidebar().getByRole('link', { name: '查看或新建项目' }));
    await user.click((await screen.findAllByRole('button', { name: '新建项目' }))[0]);
    await user.type(await screen.findByLabelText('项目名称（必填）'), 'Spark 产品开发');
    await user.type(screen.getByLabelText('项目描述（可选，补充说明有助于自动关联）'), '多端同步与搜索设计');
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await screen.findByRole('heading', { name: 'Spark 产品开发' });

    await user.click(getSidebar().getByRole('link', { name: '收件箱' }));
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '附加网址' }));
    await user.type(screen.getByLabelText('附加网址'), 'https://example.com/sync');

    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '补一句用途' }));
    await user.type(screen.getByLabelText('用途说明'), '离线冲突处理可以参考');

    await user.click(screen.getByRole('button', { name: '添加项目' }));
    await user.click(screen.getByRole('button', { name: 'Spark 产品开发' }));
    await user.click(screen.getByRole('button', { name: '保存收藏' }));

    await screen.findByText('example.com');
    await waitFor(() => {
      expect(screen.getByRole('region', { name: '快速收集' })).not.toHaveClass('sp-composer--active');
    });
  });

  it('preserves local draft on 409 content conflict and finds updated collection via search', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const created = await adapter.createCollection(
      {
        id: '11111111-1111-4111-8111-111111111111',
        original_url: 'https://example.com/sync',
        intent: '离线冲突处理可以参考',
        document: EMPTY_DOCUMENT,
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'flow-seed-collection-1',
    );
    await adapter.logout();

    const user = userEvent.setup();
    await loginAsAdmin(user, adapter);

    await screen.findByText('example.com');
    await user.click(screen.getByRole('link', { name: '查看全文' }));
    await screen.findByRole('button', { name: '编辑' });

    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.type(screen.getByLabelText('用途说明'), '补充本地草稿');

    adapter.simulateExternalCollectionEdit(created.id, '来自另一设备的更新段落');

    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByText(/检测到内容版本冲突/);
    expect((screen.getByLabelText('用途说明') as HTMLTextAreaElement).value).toContain('补充本地草稿');

    await user.click(screen.getByRole('button', { name: /基于服务器 v2 覆盖提交/ }));
    await screen.findByText(/补充本地草稿/);

    await user.click(getSidebar().getByRole('link', { name: '全部收藏' }));
    await user.type(screen.getByLabelText('搜索收藏'), '冲突处理');
    await waitFor(
      () => {
        expect(screen.getAllByText('冲突处理').length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
  });

  it('isolates drafts per user account and warns if localStorage fails', async () => {
    const adapter = createTestAdapter();
    saveDraft('other-user-id', 'inbox', {
      collectionId: '22222222-2222-4222-8222-222222222222',
      idempotencyKey: 'spk-other',
      document: EMPTY_DOCUMENT,
      intent: 'SECRET_OTHER_INTENT',
      originalUrl: 'https://secret.example.com',
      manualTitle: '',
      projectIds: [],
      tagIds: [],
      aiExcluded: false,
      updatedAt: new Date().toISOString(),
    });

    const user = userEvent.setup();
    renderWithAdapter(['/login'], adapter);
    await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
    await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await screen.findByRole('heading', { name: '收件箱' });
    expect(screen.queryByDisplayValue('https://secret.example.com')).not.toBeInTheDocument();

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '附加网址' }));
    await user.type(screen.getByLabelText('附加网址'), 'https://fail-storage.example.com');
    await screen.findByText(/本地草稿存储失败/);
    setItemSpy.mockRestore();
  });

  it('retains user input and reuses the same Idempotency-Key when createCollection fails', async () => {
    const adapter = createTestAdapter();
    const createSpy = vi
      .spyOn(adapter, 'createCollection')
      .mockRejectedValueOnce(new Error('模拟网络超时'));

    const user = userEvent.setup();
    renderWithAdapter(['/login'], adapter);
    await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
    await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));

    await screen.findByRole('heading', { name: '收件箱' });
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '附加网址' }));
    await user.type(screen.getByLabelText('附加网址'), 'https://retry.example.com');
    await user.click(screen.getByRole('button', { name: '保存收藏' }));

    await screen.findByText('模拟网络超时');
    expect((screen.getByLabelText('附加网址') as HTMLInputElement).value).toBe(
      'https://retry.example.com',
    );
    expect(screen.getByRole('region', { name: '快速收集' })).toHaveClass('sp-composer--active');

    await user.click(screen.getByRole('button', { name: '重试保存' }));
    await screen.findByText('retry.example.com');

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(createSpy.mock.calls[0][0].id).toBe(createSpy.mock.calls[1][0].id);
    expect(createSpy.mock.calls[0][1]).toBe(createSpy.mock.calls[1][1]);
  });

  it('does not submit on Cmd/Ctrl+Enter while IME composition is active and keeps Aa/activation state intact', async () => {
    const adapter = createTestAdapter();
    const createSpy = vi.spyOn(adapter, 'createCollection');
    const user = userEvent.setup();
    renderWithAdapter(['/login'], adapter);

    await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
    await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));

    // Resting state initially, activates on focus and stays active on empty blur
    const composer = await screen.findByRole('region', { name: '快速收集' });
    expect(composer).not.toHaveClass('sp-composer--active');
    expect(screen.queryByRole('group', { name: '文字格式选项' })).not.toBeInTheDocument();

    const textbox = await screen.findByRole('textbox', { name: '收藏正文编辑器' });
    fireEvent.focus(textbox);
    expect(composer).toHaveClass('sp-composer--active');

    fireEvent.blur(textbox);
    expect(composer).toHaveClass('sp-composer--active');

    // Open Aa floating popover, apply bold/highlight, and close with Escape
    const aaBtn = screen.getByRole('button', { name: '文字格式' });
    await user.click(aaBtn);
    expect(screen.getByRole('group', { name: '文字格式选项' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '加粗' }));
    await user.click(screen.getByRole('button', { name: '高亮' }));
    expect(screen.getByRole('button', { name: '加粗' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '高亮' })).toHaveAttribute('aria-pressed', 'true');

    screen.getByRole('button', { name: '加粗' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '文字格式选项' })).not.toBeInTheDocument();
    expect(aaBtn).toHaveFocus();

    // IME composition Cmd+Enter must not submit
    fireEvent.compositionStart(textbox);
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true, isComposing: true, keyCode: 229 });
    expect(createSpy).not.toHaveBeenCalled();
    fireEvent.compositionEnd(textbox);
  });

  it('supports quick header search with Cmd+K, Escape & IME guard', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.createCollection(
      {
        id: '33333333-3333-4333-8333-333333333333',
        original_url: 'https://note.example.com/1',
        intent: '',
        document: EMPTY_DOCUMENT,
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'flow-seed-search-1',
    );
    await adapter.logout();

    const user = userEvent.setup();
    await loginAsAdmin(user, adapter);
    await screen.findByText('note.example.com');

    // The command palette restores focus; ordinary search stays available.
    const unreadTab = screen.getByRole('button', { name: '未读' });
    unreadTab.focus();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const command = screen.getByRole('combobox', { name: '搜索收藏、项目或命令' });
    expect(command).toHaveFocus();
    fireEvent.keyDown(command, { key: 'Escape' });
    expect(unreadTab).toHaveFocus();

    // Quick search IME Enter does not jump; normal submit jumps to /collections?q=...
    const searchInput = screen.getByLabelText('搜索收藏');
    searchInput.focus();
    fireEvent.compositionStart(searchInput);
    fireEvent.keyDown(searchInput, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('heading', { name: '收件箱' })).toBeInTheDocument();
    fireEvent.compositionEnd(searchInput);

    await user.type(searchInput, 'note.example.com{Enter}');
    await screen.findByRole('heading', { name: '全部收藏' });
    await screen.findByText(/搜索「note\.example\.com」结果/);
  });

  it('lists unclassified notes and restores from trash undo', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.createCollection(
      {
        id: '44444444-4444-4444-8444-444444444444',
        original_url: 'https://note.example.com/1',
        intent: '',
        document: EMPTY_DOCUMENT,
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'flow-seed-trash-1',
    );
    await adapter.logout();

    const user = userEvent.setup();
    await loginAsAdmin(user, adapter);

    await user.click(getSidebar().getByRole('link', { name: '待归类' }));
    await screen.findByText('note.example.com');

    await user.click(screen.getByRole('link', { name: '查看全文' }));
    await user.click(await screen.findByRole('button', { name: '移入回收站' }));
    const undoBtn = await screen.findByRole('button', { name: '撤销' });
    await user.click(undoBtn);
    await screen.findByText('已恢复收藏');
  });
});
