import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import type { Collection } from '../api/types';
import { ShareCard } from '../components/ShareCard';
import * as shareCardLib from '../lib/shareCard';
import {
  loadSidebarPrefs,
  resolveSidebarProjects,
  saveSidebarPrefs,
  togglePinnedId,
} from '../lib/sidebarPrefs';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

beforeAll(() => {
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
  if (typeof document !== 'undefined' && !document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
});

async function admin() {
  const api = createTestAdapter();
  const session = await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
  return { api, user: session.user };
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

describe('v0.9.0 sidebar, card footer, share card & project status simplification', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders 3-zone sidebar, supports user-isolated project/tag pin customization, # tag jump, and collapsed calendar', async () => {
    const { api, user: currentUser } = await admin();
    const projects = [];
    for (let i = 1; i <= 7; i += 1) {
      projects.push(
        await api.createProject(
          { name: `项目Alpha-${i}`, description: '', focus_points: [] },
          `p-${i}`,
        ),
      );
    }
    const tags = [];
    for (let i = 1; i <= 6; i += 1) {
      tags.push(await api.createTag({ name: `标签T${i}` }, `t-${i}`));
    }
    // Give 标签T6 and 标签T5 the highest counts so auto top-5 picks them
    for (const tagIdx of [5, 5, 4]) {
      await api.createCollection(
        {
          id: crypto.randomUUID(),
          document: {
            schema_version: 1,
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '高频标签样本' }] }],
            },
          },
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [tags[tagIdx].id],
        },
        crypto.randomUUID(),
      );
    }

    // Corrupt localStorage JSON must not crash and must isolate per user
    localStorage.setItem(`spark:sidebar-prefs:v1:${currentUser.id}`, '{not-json');
    expect(loadSidebarPrefs(currentUser.id)).toEqual({ pinnedProjectIds: null, pinnedTagIds: null });
    saveSidebarPrefs('other-user-id', { pinnedProjectIds: [projects[0].id] });
    expect(loadSidebarPrefs(currentUser.id).pinnedProjectIds).toBeNull();

    // Pre-pin a nonexistent id alongside projects[6] -> deleted id ignored smoothly
    saveSidebarPrefs(currentUser.id, { pinnedProjectIds: ['missing-deleted-id', projects[6].id] });

    const ui = userEvent.setup();
    mount(api, '/inbox');

    const sidebar = within(await screen.findByRole('complementary', { name: '主导航' }));

    // Core navigation order: 收件箱 -> 待归类 -> 全部收藏; 搜索或跳转 at top
    const topNavLinks = within(sidebar.getByRole('navigation', { name: '工作区页面' })).getAllByRole('link');
    expect(topNavLinks.map((el) => el.textContent?.trim())).toEqual(['收件箱', '待归类', '全部收藏']);
    expect(sidebar.getByRole('button', { name: '搜索或跳转' })).toBeInTheDocument();

    // The calendar filters the inbox, so it lives in the inbox header rather than the sidebar
    expect(sidebar.queryByRole('region', { name: '灵光日历' })).not.toBeInTheDocument();
    const calendarBtn = screen.getByRole('button', { name: '灵光日历' });
    expect(calendarBtn).toHaveAttribute('aria-expanded', 'false');
    await ui.click(calendarBtn);
    expect(calendarBtn).toHaveAttribute('aria-expanded', 'true');
    expect(await within(screen.getByRole('region', { name: '灵光日历' })).findByText(/^本月 3 条$/)).toBeInTheDocument();
    await ui.click(calendarBtn);
    expect(screen.queryByRole('region', { name: '灵光日历' })).not.toBeInTheDocument();

    // Invalid id ignored; valid pinned project shown + 全部项目 entry shown since 7 > 1
    expect(await sidebar.findByRole('link', { name: '项目Alpha-7' })).toBeInTheDocument();
    expect(sidebar.getByRole('link', { name: '全部项目' })).toBeInTheDocument();

    // Open project customize popover, test keyboard ArrowDown/Enter/Escape focus return, search & reset
    const customizeProjBtn = sidebar.getByRole('button', { name: '自定义常用项目' });
    await ui.click(customizeProjBtn);
    const projDialog = within(await sidebar.findByRole('dialog', { name: '自定义常用项目' }));
    const projSearch = projDialog.getByRole('searchbox', { name: '搜索常用项目' });
    await ui.type(projSearch, 'Alpha-2');
    await ui.keyboard('{ArrowDown}{Enter}');
    expect(await sidebar.findByRole('link', { name: '项目Alpha-2' })).toBeInTheDocument();
    await ui.keyboard('{Escape}');
    expect(sidebar.queryByRole('dialog', { name: '自定义常用项目' })).not.toBeInTheDocument();
    expect(customizeProjBtn).toHaveFocus();

    await ui.click(customizeProjBtn);
    const projDialogReopen = within(await sidebar.findByRole('dialog', { name: '自定义常用项目' }));
    await ui.click(projDialogReopen.getByRole('button', { name: '恢复自动推荐' }));
    expect(loadSidebarPrefs(currentUser.id).pinnedProjectIds).toBeNull();

    // Compact tag pills (max 5 in auto mode) + tag customize popover + 全部 -> opens CommandPalette '#'
    const tagNav = within(sidebar.getByRole('navigation', { name: '按标签查看收藏' }));
    await waitFor(() => expect(tagNav.getAllByRole('link').length).toBeLessThanOrEqual(5));
    await ui.click(sidebar.getByRole('button', { name: '自定义置顶标签' }));
    const tagDialog = within(await sidebar.findByRole('dialog', { name: '自定义置顶标签' }));
    await ui.click(tagDialog.getByRole('button', { name: /#标签T1/ }));
    expect(await tagNav.findByRole('link', { name: '#标签T1' })).toBeInTheDocument();
    await ui.click(tagDialog.getByRole('button', { name: '恢复自动推荐' }));

    await ui.click(sidebar.getByRole('button', { name: /^查看(其余 \d+ 个|全部)标签$/ }));
    const paletteInput = await screen.findByRole('combobox', { name: '搜索收藏、项目或命令' });
    expect(paletteInput).toHaveValue('#');
    expect(await screen.findByRole('option', { name: '标签 · #标签T6' })).toBeInTheDocument();

    // Navigate to /inbox?date=today -> the calendar highlights the date, and clicking it again clears the filter
    const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
    cleanup();
    mount(api, `/inbox?date=${today}`);
    expect(await screen.findByRole('button', { name: /清除日期筛选/ })).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: '灵光日历' }));
    const dateCal = screen.getByRole('region', { name: '灵光日历' });
    const selectedDay = await within(dateCal).findByRole('link', { current: 'date' });
    expect(selectedDay).toHaveAttribute('data-today', 'true');
    await ui.click(selectedDay);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /清除日期筛选/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('region', { name: '灵光日历' })).not.toBeInTheDocument();

    // Verify resolveSidebarProjects ignores deleted ids and falls back to auto top-5 when all deleted
    const fallback = resolveSidebarProjects(projects, ['only-deleted'], 5);
    expect(fallback.isCustomized).toBe(false);
    expect(fallback.visible).toHaveLength(5);
  });

  it('declutters card header/footer, caps 2 projects + 3 tags with +N, strips query params, and navigates on card click', async () => {
    const { api } = await admin();
    const pIds: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const p = await api.createProject({ name: `归属项目${i}`, description: '', focus_points: [] }, `cp-${i}`);
      pIds.push(p.id);
    }
    const tIds: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const t = await api.createTag({ name: `标签C${i}` }, `ct-${i}`);
      tIds.push(t.id);
    }
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'thumb.png', { type: 'image/png' });
    const grant = await api.createUpload({ filename: 'thumb.png', mime_type: 'image/png', size_bytes: pngFile.size }, 'up-1');
    await api.uploadFileBytes(grant, pngFile);
    await api.completeUpload(grant.id);

    await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '无标题点击整卡打开正文' }] }],
          },
        },
        original_url: 'https://news.example.com/articles/42?utm_source=tracker#frag',
        intent: '',
        upload_ids: [grant.id],
        project_ids: pIds,
        tag_ids: tIds,
      },
      'card-test-1',
    );

    const ui = userEvent.setup();
    mount(api, '/collections');

    const card = await screen.findByRole('article', { name: '无标题点击整卡打开正文' });
    const inCard = within(card);

    // No redundant top kind icons when URL bar and thumbnail already exist
    expect(inCard.queryByRole('img', { name: '含网址' })).not.toBeInTheDocument();
    expect(inCard.queryByRole('img', { name: '含图片' })).not.toBeInTheDocument();

    // Clean short link without query params or hash
    const link = inCard.getByRole('link', { name: 'news.example.com/articles/42' });
    expect(link).toHaveAttribute('href', 'https://news.example.com/articles/42?utm_source=tracker#frag');

    // No repeated '查看全文' link
    expect(inCard.queryByRole('link', { name: /查看全文/ })).not.toBeInTheDocument();

    // Footer: 2 projects + '+2' (semantic aria-label naming hidden projects), and 3 tags + '+2'
    expect(inCard.getByRole('link', { name: '归属项目1' })).toBeInTheDocument();
    expect(inCard.getByRole('link', { name: '归属项目2' })).toBeInTheDocument();
    expect(inCard.queryByRole('link', { name: '归属项目3' })).not.toBeInTheDocument();
    expect(
      inCard.getByRole('link', { name: '还有 2 个关联项目：归属项目3、归属项目4' }),
    ).toHaveTextContent('+2');

    expect(inCard.getByRole('link', { name: '#标签C1' })).toBeInTheDocument();
    expect(inCard.getByRole('link', { name: '#标签C3' })).toBeInTheDocument();
    expect(inCard.queryByRole('link', { name: '#标签C4' })).not.toBeInTheDocument();
    expect(
      inCard.getByRole('link', { name: '还有 2 个标签：#标签C4、#标签C5' }),
    ).toHaveTextContent('+2');

    // Clicking non-interactive card body opens detail view
    await ui.click(inCard.getByText('无标题点击整卡打开正文'));
    expect(await screen.findByRole('heading', { name: '归类结果' })).toBeInTheDocument();
  });

  it('selects smart ShareCard default template, switches 4 templates, exports 1080px without 节选, and copies image to clipboard', async () => {
    expect(shareCardLib.selectDefaultShareTemplate('短句测试', 0)).toBe('quote');
    expect(shareCardLib.selectDefaultShareTemplate('长文。'.repeat(30), 0)).toBe('paper');
    expect(shareCardLib.selectDefaultShareTemplate('有图', 1)).toBe('gallery');

    // Verify canvas render dimensions & zero '节选' label
    const fillTextCalls: string[] = [];
    const createdCanvases: HTMLCanvasElement[] = [];
    const origCreateElement = document.createElement.bind(document);
    const fakeGradient = { addColorStop: vi.fn() };
    const fakeCtx = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineJoin: 'round',
      textAlign: 'left',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetY: 0,
      measureText: (s: string) => ({ width: [...s].length * 18 }),
      fillRect: vi.fn(),
      fillText: vi.fn((text: string) => {
        fillTextCalls.push(text);
      }),
      stroke: vi.fn(),
      fill: vi.fn(),
      clip: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      arc: vi.fn(),
      roundRect: vi.fn(),
      drawImage: vi.fn(),
      createRadialGradient: vi.fn(() => fakeGradient),
    } as unknown as CanvasRenderingContext2D;

    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName === 'canvas') {
        const c = el as HTMLCanvasElement;
        c.getContext = (() => fakeCtx) as unknown as typeof c.getContext;
        c.toBlob = ((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' }))) as typeof c.toBlob;
        createdCanvases.push(c);
      }
      return el;
    }) as typeof document.createElement);

    const api = createTestAdapter();
    const longCollection = {
      id: 'col-share-1',
      created_at: '2026-11-24T10:00:00Z',
      original_url: 'https://share.example.test/note?token=secret',
      intent: '内部保密意图',
      display_title: '内部标题',
      projects: [{ project_id: 'p1', name: '设计系统', decision: 'manual' }],
      tags: [],
      attachments: [],
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '这是一段需要优雅截断的思考。'.repeat(40) }] }],
        },
      },
    } as unknown as Collection;

    const urlCreateOrig = URL.createObjectURL;
    const urlRevokeOrig = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:share-preview';
    URL.revokeObjectURL = vi.fn();

    const ui = userEvent.setup();
    const clipWrite = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const origClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: clipWrite },
    });
    (globalThis as { ClipboardItem: unknown }).ClipboardItem = class MockClipboardItem {
      data: Record<string, Blob>;
      constructor(data: Record<string, Blob>) {
        this.data = data;
      }
    };

    try {
      render(<ShareCard collection={longCollection} onClose={() => {}} />);

      // Body > 60 chars, no images -> smart default is '手帐纸笺' ('paper')
      const paperRadio = await screen.findByRole('radio', { name: '手帐纸笺' });
      expect(paperRadio).toHaveAttribute('aria-checked', 'true');
      await screen.findByRole('img', { name: '待导出的分享卡片' });
      expect(createdCanvases.some((c) => c.width === 1080)).toBe(true);
      expect(fillTextCalls).not.toContain('节选');

      // Switch to 胶片暗房 -> 展览海报 -> 极简金句
      for (const label of ['胶片暗房', '展览海报', '极简金句']) {
        await ui.click(screen.getByRole('radio', { name: label }));
        expect(screen.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true');
        await screen.findByRole('img', { name: '待导出的分享卡片' });
      }

      // Clipboard copy succeeds then falls back gently on failure
      await ui.click(screen.getByRole('button', { name: '复制图片' }));
      expect(await screen.findByRole('button', { name: '已复制图片' })).toBeInTheDocument();
      expect(clipWrite).toHaveBeenCalledTimes(1);

      await ui.click(screen.getByRole('button', { name: '已复制图片' }));
      expect(await screen.findByText(/当前浏览器暂不支持直接复制图片/)).toBeInTheDocument();

      void api;
    } finally {
      URL.createObjectURL = urlCreateOrig;
      URL.revokeObjectURL = urlRevokeOrig;
      if (origClipboard) Object.defineProperty(navigator, 'clipboard', origClipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem = origClipboardItem;
    }
  });

  it('hides ProjectsPage filter tabs until archived projects exist, groups paused+completed under 已归档, and explains state rules in ProjectDetailPage', async () => {
    const { api } = await admin();
    const activeProj = await api.createProject({ name: '活跃研发', description: '', focus_points: [] }, 'sp-1');
    const ui = userEvent.setup();

    // Only active project -> no tablist filter rendered
    const first = render(
      <MemoryRouter initialEntries={['/projects']}>
        <AppProviders api={api}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: '活跃研发' });
    expect(screen.queryByRole('tablist', { name: '项目状态筛选' })).not.toBeInTheDocument();
    first.unmount();

    // Seed one paused and one completed project
    const pausedProj = await api.createProject({ name: '暂缓调研', description: '', focus_points: [] }, 'sp-2');
    await api.updateProject(pausedProj.id, { base_version: pausedProj.version, state: 'paused' });
    const doneProj = await api.createProject({ name: '结题归档', description: '', focus_points: [] }, 'sp-3');
    await api.updateProject(doneProj.id, { base_version: doneProj.version, state: 'completed' });

    mount(api, '/projects');
    const tablist = await screen.findByRole('tablist', { name: '项目状态筛选' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['进行中', '已归档']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: '活跃研发' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '暂缓调研' })).not.toBeInTheDocument();

    await ui.click(tabs[1]);
    expect(await screen.findByRole('heading', { name: '暂缓调研' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '结题归档' })).toBeInTheDocument();
    expect(screen.getByText('已暂停')).toBeInTheDocument();
    expect(screen.getByText('已结束')).toBeInTheDocument();

    // Navigate to active project detail edit modal -> plain-language state explanation present
    await ui.click(tabs[0]);
    await ui.click(await within(screen.getByRole('main')).findByRole('link', { name: /活跃研发/ }));
    await ui.click(await screen.findByRole('button', { name: '编辑项目' }));
    expect(
      await screen.findByText('进行中：参与自动归类并显示在快捷列表；暂停或结束后停止自动归类，历史收藏完整保留'),
    ).toBeInTheDocument();
    void activeProj;
  });

  it('strips sensitive query URLs completely from shareText, keeps archive tab on error, blocks card SVG button click-through, preserves Popover focus/IME & off-page pins, syncs calendar back navigation, and guards clipboard receipts', async () => {
    // 1. shareText strips full URLs including query tokens even with shared original_url prefix
    const leakyCollection = {
      id: 'c-leak',
      created_at: '2026-11-24T12:00:00Z',
      original_url: 'https://docs.example.test/item',
      intent: '内部',
      display_title: '标题',
      projects: [],
      tags: [],
      attachments: [],
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '参考链接 https://docs.example.test/item?token=topsecret#frag 后文' }],
            },
          ],
        },
      },
    } as unknown as Collection;
    const stripped = shareCardLib.shareText(leakyCollection, false, false);
    expect(stripped.body).toBe('参考链接 后文');
    expect(stripped.body).not.toContain('token');
    expect(stripped.body).not.toContain('topsecret');

    // 2. togglePinnedId preserves off-page pinned IDs rather than wiping unloaded pages
    expect(togglePinnedId(['off-page-id', 'page1-a'], 'page1-b')).toEqual([
      'off-page-id',
      'page1-a',
      'page1-b',
    ]);
    expect(togglePinnedId(['off-page-id', 'page1-a'], 'page1-a')).toEqual(['off-page-id']);

    // 3. ProjectsPage keeps 已归档 tab visible when paused/completed fails and lets user retry
    const { api } = await admin();
    await api.createProject({ name: '唯一活跃', description: '', focus_points: [] }, 'only-act');
    const origListProjects = api.listProjects.bind(api);
    let failArchived = true;
    vi.spyOn(api, 'listProjects').mockImplementation(async (query) => {
      if (failArchived && (query?.state === 'paused' || query?.state === 'completed')) {
        throw new Error('archive fetch failed');
      }
      return origListProjects(query);
    });

    const ui = userEvent.setup();
    mount(api, '/projects');
    const errTablist = await screen.findByRole('tablist', { name: '项目状态筛选' });
    const archivedTab = within(errTablist).getByRole('tab', { name: '已归档' });
    await ui.click(archivedTab);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    failArchived = false;
    await ui.click(screen.getByRole('button', { name: '重试' }));
    // Once both archive queries succeed with 0 items, tabs hide safely and active list displays
    expect(await screen.findByRole('heading', { name: '唯一活跃' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '项目状态筛选' })).not.toBeInTheDocument();
    cleanup();

    // 4. Clicking an SVG path inside CollectionCard's more button does not trigger card navigation
    await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '点击SVG不跳详情' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'svg-guard-seed',
    );
    mount(api, '/collections');
    const card = await screen.findByRole('article', { name: '点击SVG不跳详情' });
    const moreBtn = within(card).getByRole('button', { name: '更多操作' });
    const innerSvg = moreBtn.querySelector('svg')!;
    fireEvent.click(innerSvg);
    expect(screen.getByRole('menu', { name: '收藏操作菜单' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '归类结果' })).not.toBeInTheDocument();

    // 5. Popover IME Escape does not close dialog & consecutive button clicks keep focus (no search focus hijack)
    const sidebar = within(screen.getByRole('complementary', { name: '主导航' }));
    await ui.click(sidebar.getByRole('button', { name: '自定义常用项目' }));
    const pop = within(await sidebar.findByRole('dialog', { name: '自定义常用项目' }));
    await waitFor(() => expect(pop.getByRole('searchbox', { name: '搜索常用项目' })).toHaveFocus());
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(sidebar.getByRole('dialog', { name: '自定义常用项目' })).toBeInTheDocument();

    const firstProjBtn = pop.getByRole('button', { name: /唯一活跃/ });
    await ui.keyboard('{ArrowDown}');
    expect(firstProjBtn).toHaveFocus();
    await ui.keyboard('{Enter}');
    expect(firstProjBtn).toHaveAttribute('aria-pressed', 'true');
    expect(firstProjBtn).toHaveFocus();
    await ui.keyboard('{Enter}');
    expect(firstProjBtn).toHaveAttribute('aria-pressed', 'false');
    expect(firstProjBtn).toHaveFocus();
    cleanup();

    // 6. ActivityCalendar resets manual month browsing when the selected date changes -> browser back returns to date month
    let navFn: ReturnType<typeof useNavigate> | null = null;
    function NavProbe() {
      navFn = useNavigate();
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/inbox?date=2026-10-05']}>
        <AppProviders api={api}>
          <NavProbe />
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await ui.click(await screen.findByRole('button', { name: '灵光日历' }));
    const firstCal = screen.getByRole('region', { name: '灵光日历' });
    expect(within(firstCal).getByText('2026年10月')).toBeInTheDocument();
    await ui.click(within(firstCal).getByRole('button', { name: '上个月' }));
    expect(within(firstCal).getByText('2026年9月')).toBeInTheDocument();
    await ui.click(await within(firstCal).findByRole('link', { name: /^2026年9月10日/ }));
    act(() => {
      navFn!(-1);
    });
    await ui.click(await screen.findByRole('button', { name: '灵光日历' }));
    const cal = screen.getByRole('region', { name: '灵光日历' });
    expect(await within(cal).findByText('2026年10月')).toBeInTheDocument();
    expect(await within(cal).findByRole('link', { current: 'date' })).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/^2026年10月5日/),
    );
    cleanup();

    // 7. ShareCard radiogroup arrow keys + grapheme-safe early termination + all 4 quote images + stale clipboard guard
    const measureMock = vi.fn((s: string) => ({ width: [...s].length * 18 }));
    const drawImageCalls: number[] = [];
    const origCreateEl = document.createElement.bind(document);
    const fakeCtx2 = {
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineJoin: 'round',
      textAlign: 'left',
      shadowColor: '',
      shadowBlur: 0,
      shadowOffsetY: 0,
      measureText: measureMock,
      fillRect: vi.fn(),
      fillText: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      clip: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      arc: vi.fn(),
      roundRect: vi.fn(),
      drawImage: vi.fn(() => {
        drawImageCalls.push(1);
      }),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D;

    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreateEl(tag);
      if (tag === 'canvas') {
        const c = el as HTMLCanvasElement;
        c.getContext = (() => fakeCtx2) as unknown as typeof c.getContext;
        c.toBlob = ((cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' }))) as typeof c.toBlob;
      }
      return el;
    }) as typeof document.createElement);

    // Huge 15,000 char string must break early instead of measuring every character
    await shareCardLib.renderShareCard(
      { body: '字'.repeat(15_000), date: '2026年11月24日', source: '', projects: '' },
      [],
      'paper',
    );
    expect(measureMock.mock.calls.length).toBeLessThan(800);

    // Quote template draws all 4 provided images without silent truncation
    drawImageCalls.length = 0;
    const mockImg = { naturalWidth: 200, naturalHeight: 200 } as HTMLImageElement;
    await shareCardLib.renderShareCard(
      { body: '四图金句', date: '2026年11月24日', source: '', projects: '' },
      [mockImg, mockImg, mockImg, mockImg],
      'quote',
    );
    expect(drawImageCalls).toHaveLength(4);

    // ShareCard radiogroup ArrowRight + stale async clipboard copy receipt ignored after template switch
    let resolveCopy!: () => void;
    const delayedWrite = new Promise<void>((res) => {
      resolveCopy = res;
    });
    const origClip = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const origClipItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn(() => delayedWrite) },
    });
    (globalThis as { ClipboardItem: unknown }).ClipboardItem = class {
      constructor(public data: Record<string, Blob>) {}
    };
    const origCreateUrl = URL.createObjectURL;
    const origRevokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:stale-guard';
    URL.revokeObjectURL = vi.fn();

    try {
      render(<ShareCard collection={leakyCollection} onClose={() => {}} />);
      const quoteRadio = await screen.findByRole('radio', { name: '极简金句' });
      expect(quoteRadio).toHaveAttribute('aria-checked', 'true');
      expect(quoteRadio).toHaveAttribute('tabIndex', '0');

      const copyBtn = await screen.findByRole('button', { name: '复制图片' });
      await ui.click(copyBtn);

      // Switch template with ArrowRight from focused radio before copy resolves
      quoteRadio.focus();
      await ui.keyboard('{ArrowRight}');
      const paperRadio = screen.getByRole('radio', { name: '手帐纸笺' });
      expect(paperRadio).toHaveAttribute('aria-checked', 'true');
      expect(paperRadio).toHaveFocus();

      await screen.findByRole('img', { name: '待导出的分享卡片' });
      await act(async () => {
        resolveCopy();
        await delayedWrite;
      });
      // Stale copy receipt from 'quote' must NOT mark 'paper' as copied
      expect(screen.queryByRole('button', { name: '已复制图片' })).not.toBeInTheDocument();
    } finally {
      URL.createObjectURL = origCreateUrl;
      URL.revokeObjectURL = origRevokeUrl;
      if (origClip) Object.defineProperty(navigator, 'clipboard', origClip);
      else Reflect.deleteProperty(navigator, 'clipboard');
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem = origClipItem;
    }
  });

  it('strips URLs containing CJK punctuation and link marks completely from share card body', () => {
    const now = '2026-04-20T09:00:00Z';
    const docCollection = {
      id: 'col-cjk-doc',
      owner_user_id: 'u-1',
      kind: 'link',
      title: '文档标题',
      content_text:
        '参考 https://example.com/条目（一）?token=secret#frag，详情见官网 https://example.org/路径、说明?auth=abc 。',
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '开头保留 ' },
                {
                  type: 'text',
                  text: 'https://example.com/条目（一）?token=secret#frag',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com/条目（一）?token=secret#frag' } }],
                },
                { type: 'text', text: ' 结尾保留，裸链接 https://example.org/路径（二）?key=topsecret#part。' },
              ],
            },
          ],
        },
      },
      summary: '',
      original_url: 'https://example.com/条目（一）?token=secret#frag',
      source_host: 'example.com',
      projects: [],
      tags: [],
      attachments: [],
      created_at: now,
      updated_at: now,
      deleted_at: null,
      read_at: now,
      resource_version: 1,
    } as unknown as Collection;

    const extracted = shareCardLib.shareText(docCollection, false, false);
    expect(extracted.body).toContain('开头保留');
    expect(extracted.body).toContain('结尾保留');
    expect(extracted.body).not.toContain('token=secret');
    expect(extracted.body).not.toContain('key=topsecret');
    expect(extracted.body).not.toContain('#frag');
    expect(extracted.body).not.toContain('#part');
    expect(extracted.body).not.toContain('https://');
  });

  it('persists pinned 51st project metadata across search clear and remount, and guards drawer Escape during IME', async () => {
    const { api } = await admin();
    for (let i = 1; i <= 51; i += 1) {
      await api.createProject(
        { name: i === 1 ? '第51号星标项目' : `批量项目-${String(i).padStart(2, '0')}`, description: '', focus_points: [] },
        `proj-51-${i}`,
      );
    }

    const ui = userEvent.setup();
    const firstMount = mount(api, '/inbox');
    await screen.findByText('批量项目-51');
    expect(screen.queryByRole('link', { name: '第51号星标项目' })).not.toBeInTheDocument();

    await ui.click(screen.getByRole('button', { name: '自定义常用项目' }));
    const searchInput = await screen.findByPlaceholderText('搜索进行中项目…');
    await ui.type(searchInput, '第51号星标项目');
    const pinBtn = await screen.findByRole('button', { name: /第51号星标项目/ });
    await ui.click(pinBtn);

    // Close popover with Escape (clears search) -> pinned #51 must stay visible via cached meta
    await ui.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByPlaceholderText('搜索进行中项目…')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: '第51号星标项目' })).toBeInTheDocument();

    // Test drawer Escape IME guard while still mounted
    await ui.click(screen.getByRole('button', { name: '更多导航' }));
    expect(screen.getByRole('dialog', { name: '导航菜单' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('dialog', { name: '导航菜单' })).toBeInTheDocument();
    await ui.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导航菜单' })).not.toBeInTheDocument());

    firstMount.unmount();

    // Remount -> cached metadata keeps #51 pinned in sidebar on initial page-1 load
    mount(api, '/inbox');
    await screen.findByRole('link', { name: '第51号星标项目' });
  });

  it('positions quote template footer strictly below rendered images', async () => {
    const drawImageCalls: unknown[][] = [];
    const fillTextCalls: unknown[][] = [];
    const createdCanvases: HTMLCanvasElement[] = [];

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = origCreateElement(tagName, options);
      if (tagName.toLowerCase() === 'canvas') {
        const canvas = el as HTMLCanvasElement;
        createdCanvases.push(canvas);
        const mockCtx = {
          font: '',
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          lineJoin: 'round',
          textAlign: 'left',
          textBaseline: 'alphabetic',
          globalAlpha: 1,
          shadowColor: '',
          shadowBlur: 0,
          shadowOffsetX: 0,
          shadowOffsetY: 0,
          createLinearGradient: () => ({ addColorStop: () => undefined }),
          createRadialGradient: () => ({ addColorStop: () => undefined }),
          translate: () => undefined,
          scale: () => undefined,
          arc: () => undefined,
          bezierCurveTo: () => undefined,
          quadraticCurveTo: () => undefined,
          closePath: () => undefined,
          fillRect: () => undefined,
          strokeRect: () => undefined,
          fillText: (...args: unknown[]) => {
            fillTextCalls.push(args);
          },
          measureText: (txt: string) => ({ width: txt.length * 18 }),
          save: () => undefined,
          restore: () => undefined,
          beginPath: () => undefined,
          roundRect: () => undefined,
          clip: () => undefined,
          moveTo: () => undefined,
          lineTo: () => undefined,
          stroke: () => undefined,
          fill: () => undefined,
          drawImage: (...args: unknown[]) => {
            drawImageCalls.push(args);
          },
        } as unknown as CanvasRenderingContext2D;
        canvas.getContext = (() => mockCtx) as unknown as typeof canvas.getContext;
        canvas.toBlob = ((cb: BlobCallback) => {
          cb(new Blob(['png'], { type: 'image/png' }));
        }) as typeof canvas.toBlob;
      }
      return el;
    }) as typeof document.createElement);

    const mockImg = { width: 1200, height: 900 } as unknown as HTMLImageElement;
    const blob = await shareCardLib.renderShareCard(
      {
        body: '第一行灵感\n第二行记录\n第三行补充',
        date: '2026 年 4 月 20 日',
        source: '',
        projects: '测试项目',
      },
      [mockImg, mockImg, mockImg, mockImg],
      'quote',
    );

    expect(blob).toBeInstanceOf(Blob);
    expect(drawImageCalls).toHaveLength(4);
    const maxImageBottom = Math.max(
      ...drawImageCalls.map((args) => Number(args[6]) + Number(args[8])),
    );
    const footerDateCall = fillTextCalls.find((args) => args[0] === '2026 年 4 月 20 日');
    expect(footerDateCall).toBeDefined();
    const footerDateY = Number(footerDateCall?.[2]);
    expect(footerDateY).toBeGreaterThan(maxImageBottom);
    expect(createdCanvases[0]?.height).toBeGreaterThan(footerDateY);
  });

  it('does not show empty project creation prompt when paused projects query fails', async () => {
    const { api } = await admin();
    const origListProjects = api.listProjects.bind(api);
    vi.spyOn(api, 'listProjects').mockImplementation(async (params) => {
      if (params?.state === 'paused') {
        throw new Error('network paused failure');
      }
      return origListProjects(params);
    });

    mount(api, '/projects');
    expect(await screen.findByText('当前没有进行中的项目')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看已归档' })).toBeInTheDocument();
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument();
  });

  it('merges consecutive same-href link nodes, preserves readable link titles, and strips apostrophe URLs completely', () => {
    const now = '2026-04-20T09:00:00Z';
    const docCollection = {
      id: 'col-split-link-apostrophe',
      owner_user_id: 'u-1',
      kind: 'link',
      title: '拆段链接与单引号路径',
      content_text: '',
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '先看 ' },
                {
                  type: 'text',
                  text: 'https://example.com/',
                  marks: [
                    {
                      type: 'link',
                      attrs: { href: 'https://example.com/secret-path?token=split-secret#h' },
                    },
                  ],
                },
                {
                  type: 'text',
                  text: 'secret-path',
                  marks: [
                    { type: 'bold' },
                    {
                      type: 'link',
                      attrs: { href: 'https://example.com/secret-path?token=split-secret#h' },
                    },
                  ],
                },
                {
                  type: 'text',
                  text: '?token=split-secret#h',
                  marks: [
                    {
                      type: 'link',
                      attrs: { href: 'https://example.com/secret-path?token=split-secret#h' },
                    },
                  ],
                },
                { type: 'text', text: ' 也可读 ' },
                {
                  type: 'text',
                  text: '苹果',
                  marks: [
                    { type: 'bold' },
                    { type: 'link', attrs: { href: 'https://developer.apple.com/design/' } },
                  ],
                },
                {
                  type: 'text',
                  text: '设计指南',
                  marks: [{ type: 'link', attrs: { href: 'https://developer.apple.com/design/' } }],
                },
                {
                  type: 'text',
                  text: " ，裸链接 https://example.com/O'Brien?token=apo-secret#top。 ",
                },
              ],
            },
          ],
        },
      },
      summary: '',
      original_url: '',
      source_host: '',
      projects: [],
      tags: [],
      attachments: [],
      created_at: now,
      updated_at: now,
      deleted_at: null,
      read_at: now,
      resource_version: 1,
    } as unknown as Collection;

    const extracted = shareCardLib.shareText(docCollection, false, false);
    expect(extracted.body).toContain('先看');
    expect(extracted.body).toContain('也可读 苹果设计指南');
    expect(extracted.body).not.toContain('split-secret');
    expect(extracted.body).not.toContain('secret-path');
    expect(extracted.body).not.toContain('apo-secret');
    expect(extracted.body).not.toContain("O'Brien");
    expect(extracted.body).not.toContain('https://');

    // Mark-boundary invariance: prefix has link mark while trailing ?token=secret has no mark
    const partialLinkDoc = {
      ...docCollection,
      id: 'col-partial-link-mark',
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '灵感摘录 ' },
                {
                  type: 'text',
                  text: 'https://example.com/article',
                  marks: [{ type: 'link', attrs: { href: 'https://example.com/article' } }],
                },
                { type: 'text', text: '?token=secret#frag 后半句保留' },
              ],
            },
          ],
        },
      },
    } as unknown as Collection;

    const fullLinkDoc = {
      ...partialLinkDoc,
      id: 'col-full-link-mark',
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '灵感摘录 ' },
                {
                  type: 'text',
                  text: 'https://example.com/article?token=secret#frag',
                  marks: [
                    { type: 'link', attrs: { href: 'https://example.com/article?token=secret#frag' } },
                  ],
                },
                { type: 'text', text: ' 后半句保留' },
              ],
            },
          ],
        },
      },
    } as unknown as Collection;

    const plainTextDoc = {
      ...partialLinkDoc,
      id: 'col-plain-url',
      document: {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: '灵感摘录 https://example.com/article?token=secret#frag 后半句保留',
                },
              ],
            },
          ],
        },
      },
    } as unknown as Collection;

    const partialBody = shareCardLib.shareText(partialLinkDoc, false, false).body;
    const fullBody = shareCardLib.shareText(fullLinkDoc, false, false).body;
    const plainBody = shareCardLib.shareText(plainTextDoc, false, false).body;
    expect(partialBody).toBe('灵感摘录 后半句保留');
    expect(fullBody).toBe(partialBody);
    expect(plainBody).toBe(partialBody);
  });

  it('prunes archived pinned projects from localStorage once full active list loads without flashing on remount', async () => {
    const { api, user } = await admin();
    const keepProj = await api.createProject(
      { name: '保留项目', description: '', focus_points: [] },
      'prune-keep',
    );
    const archiveProj = await api.createProject(
      { name: '即将归档项目', description: '', focus_points: [] },
      'prune-arch',
    );
    saveSidebarPrefs(user.id, {
      pinnedProjectIds: [archiveProj.id, keepProj.id],
      pinnedProjectMeta: {
        [archiveProj.id]: archiveProj.name,
        [keepProj.id]: keepProj.name,
      },
    });

    await api.updateProject(archiveProj.id, {
      base_version: archiveProj.version,
      state: 'paused',
    });

    const firstMount = mount(api, '/inbox');
    await screen.findByRole('link', { name: '保留项目' });
    await waitFor(() => {
      const saved = loadSidebarPrefs(user.id);
      expect(saved.pinnedProjectIds).toEqual([keepProj.id]);
      expect(saved.pinnedProjectMeta).toEqual({ [keepProj.id]: '保留项目' });
    });
    expect(screen.queryByRole('link', { name: '即将归档项目' })).not.toBeInTheDocument();
    firstMount.unmount();

    // Even if page loading is pending on subsequent mount, cleared localStorage prevents brief flash
    const origListProjects = api.listProjects.bind(api);
    let resolveDelayed: ((v: Awaited<ReturnType<typeof origListProjects>>) => void) | undefined;
    vi.spyOn(api, 'listProjects').mockImplementation((params) => {
      if (params?.state === 'active') {
        return new Promise((res) => {
          resolveDelayed = res;
        });
      }
      return origListProjects(params);
    });

    mount(api, '/inbox');
    await waitFor(() => expect(resolveDelayed).toBeTypeOf('function'));
    expect(screen.queryByRole('link', { name: '即将归档项目' })).not.toBeInTheDocument();
    await act(async () => {
      resolveDelayed?.({ items: [keepProj], next_cursor: undefined });
    });
    expect(await screen.findByRole('link', { name: '保留项目' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '即将归档项目' })).not.toBeInTheDocument();
  });
});
