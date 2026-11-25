import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import type { Collection } from '../api/types';
import { ShareCard } from '../components/ShareCard';
import * as shareCardLib from '../lib/shareCard';
import { loadSidebarPrefs, resolveSidebarProjects, saveSidebarPrefs } from '../lib/sidebarPrefs';
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

    // Core navigation order: 收件箱 -> 待归类 -> 全部收藏; 快速跳转 at top
    const topNavLinks = within(sidebar.getByRole('navigation', { name: '工作区页面' })).getAllByRole('link');
    expect(topNavLinks.map((el) => el.textContent?.trim())).toEqual(['收件箱', '待归类', '全部收藏']);
    expect(sidebar.getByRole('button', { name: '快速跳转' })).toBeInTheDocument();

    // ActivityCalendar is collapsed by default into a single-row toggle
    const calendarBtn = sidebar.getByRole('button', { name: /灵光日历/ });
    expect(calendarBtn).toHaveAttribute('aria-expanded', 'false');
    await ui.click(calendarBtn);
    expect(calendarBtn).toHaveAttribute('aria-expanded', 'true');
    expect(await within(sidebar.getByRole('region', { name: '灵光日历' })).findByText(/^本月 3 条$/)).toBeInTheDocument();

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

    await ui.click(sidebar.getByRole('button', { name: '查看全部标签' }));
    const paletteInput = await screen.findByRole('combobox', { name: '搜索收藏、项目或命令' });
    expect(paletteInput).toHaveValue('#');
    expect(await screen.findByRole('option', { name: '标签 · #标签T6' })).toBeInTheDocument();

    // Navigate to /inbox?date=today -> calendar auto-expands, highlights date, and clears filter in one click
    const today = new Intl.DateTimeFormat('sv-SE').format(new Date());
    cleanup();
    mount(api, `/inbox?date=${today}`);
    const dateSidebar = within(await screen.findByRole('complementary', { name: '主导航' }));
    const dateCal = dateSidebar.getByRole('region', { name: '灵光日历' });
    expect(dateSidebar.getByRole('button', { name: /灵光日历/ })).toHaveAttribute('aria-expanded', 'true');
    expect(await within(dateCal).findByRole('link', { current: 'date' })).toHaveAttribute('data-today', 'true');
    await ui.click(within(dateCal).getByRole('link', { name: '清除日历日期筛选' }));
    await waitFor(() => {
      expect(within(dateCal).queryByRole('link', { current: 'date' })).not.toBeInTheDocument();
    });

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
});
