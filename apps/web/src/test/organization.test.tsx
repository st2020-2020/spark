import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Link } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { AppProviders, AppRoutes } from '../App';
import type { Collection, Organization } from '../api/types';
import { classifyOrganizationDisplay, evidenceSourceLabel } from '../lib/organization';
import { createTestAdapter } from '../test-adapter/mockServer';

function renderApp(initialEntries: string[] = ['/login'], adapter = createTestAdapter()) {
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

async function loginAsAdmin(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
  await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
}

describe('Platform AI organization & UI states', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enables AI prominently from Inbox, subscribes once via SSE with zero detail polling, prompts on has_suggestion=true, and confirms with evidence', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const subscribeSpy = vi.spyOn(adapter, 'subscribeOrganizationEvents');
    const openedSpy = vi.spyOn(adapter, 'recordCollectionOpened');
    renderApp(['/login'], adapter);
    expect(adapter.getOrganizationSubscriberCount()).toBe(0);
    await loginAsAdmin(user);

    // Single aggregated SSE stream opened once authenticated shell mounts
    expect(adapter.getOrganizationSubscriberCount()).toBe(1);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    // 1. Enable AI directly from the prominent Inbox composer entry -> opens consent modal -> switches to lightweight status
    const composerRegion = screen.getByRole('region', { name: 'AI 自动整理入口' });
    const composer = screen.getByRole('region', { name: '快速收集' });
    expect(composer).not.toHaveClass('sp-composer--active');
    await user.click(within(composerRegion).getByRole('button', { name: '开启 AI 整理' }));
    expect(composer).not.toHaveClass('sp-composer--active');
    await screen.findByRole('heading', { name: '开启平台 AI 自动整理' });
    await screen.findByText(/发送资料范围：/);
    await screen.findByText(/第三方服务范围：/);
    await screen.findByText(/历史收藏说明：/);
    await user.click(screen.getByRole('button', { name: '我已了解并开启' }));
    await screen.findByText('AI 自动整理已开启');
    expect(screen.queryByRole('region', { name: 'AI 自动整理入口' })).not.toBeInTheDocument();

    // 2. Create a project so AI matcher can suggest it with evidence
    const sidebar = within(screen.getByRole('complementary', { name: '主导航' }));
    await user.click(sidebar.getByRole('link', { name: '创建项目' }));
    await user.type(await screen.findByLabelText('项目名称（必填）'), '前端交互升级');
    await user.type(
      screen.getByLabelText('项目描述（可选，补充说明有助于自动关联）'),
      '表单与详情页排版体验',
    );
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await screen.findByRole('heading', { name: '前端交互升级' });
    // Navigating across routes keeps the single SSE connection alive without recreating it
    expect(adapter.getOrganizationSubscriberCount()).toBe(1);

    // 3. Save a collection with URL + intent in Inbox
    await user.click(sidebar.getByRole('link', { name: '收件箱' }));
    await user.click(await screen.findByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '附加网址' }));
    await user.type(screen.getByLabelText('附加网址'), 'https://example.com/ui-alignment');

    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '补一句用途' }));
    await user.type(
      screen.getByLabelText('用途说明'),
      '前端交互升级需要参考这个卡片对齐细节',
    );

    const getCollectionSpy = vi.spyOn(adapter, 'getCollection');
    const getOrgSpy = vi.spyOn(adapter, 'getOrganization');

    await user.click(screen.getByRole('button', { name: '保存收藏' }));
    await screen.findByText('example.com');

    // Actionable completion prompt arrives via SSE when has_suggestion === true
    await screen.findByText('有一条收藏的项目建议待确认');
    const toastActionBtn = await screen.findByRole('button', { name: '查看并确认' });
    expect(openedSpy).not.toHaveBeenCalled();

    // Click toast CTA to jump straight to collection detail
    await user.click(toastActionBtn);
    expect(openedSpy).toHaveBeenCalledTimes(1);
    await screen.findByText('仍待归类');
    expect(getOrgSpy).not.toHaveBeenCalled();
    expect(getCollectionSpy).toHaveBeenCalledTimes(2);

    // AI suggestion & evidence quote are displayed cleanly while technical summary sits inside collapsed disclosure
    await screen.findByText('AI 建议');
    const evidenceList = await screen.findByRole('list', { name: '推荐依据摘录' });
    expect(within(evidenceList).getByText('用途说明')).toBeInTheDocument();
    expect(
      within(evidenceList).getByText(/前端交互升级需要参考这个卡片对齐细节/),
    ).toBeInTheDocument();
    await user.click(screen.getByText('更多管理与整理详情'));
    await screen.findByText('AI 摘要');

    // 5. Verify sidebar badge + Unclassified page also displays AI suggestion + evidence before confirming
    await sidebar.findByRole('link', { name: '1 条待确认 AI 建议' });
    await user.click(sidebar.getByRole('link', { name: '待归类' }));
    await screen.findByText(/建议归入：前端交互升级/);
    const unclassifiedEvidence = await screen.findByRole('list', { name: '推荐依据摘录' });
    expect(
      within(unclassifiedEvidence).getByText(/前端交互升级需要参考这个卡片对齐细节/),
    ).toBeInTheDocument();

    // Confirm ("加入项目") moves it out of unclassified and clears pending count badge
    await user.click(screen.getByRole('button', { name: '加入项目' }));
    await screen.findByText('已归入项目');
    await screen.findByText('没有待归类的收藏');
    expect(sidebar.queryByRole('link', { name: /待确认 AI 建议/ })).not.toBeInTheDocument();
    // Navigating across Inbox -> Projects -> Inbox -> Detail -> Unclassified kept the exact same single SSE subscription
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
  }, 15000);

  it('supports per-item AI exclusion on create and detail, plus ignore/reset on detail', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    const proj = await adapter.createProject(
      { name: '研究备份', description: '隐私与归档', focus_points: [] },
      'proj-key-1111111111',
    );

    renderApp(['/inbox'], adapter);
    await user.click(await screen.findByRole('button', { name: '更多' }));
    const excludeMenuItem = await screen.findByRole('menuitemcheckbox', {
      name: '本条不参与 AI 整理',
    });
    await user.click(excludeMenuItem);
    await screen.findByText('不参与 AI 整理');

    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '附加网址' }));
    await user.type(screen.getByLabelText('附加网址'), 'https://example.com/private-note');
    await user.click(screen.getByRole('button', { name: '更多' }));
    await user.click(screen.getByRole('menuitem', { name: '补一句用途' }));
    await user.type(screen.getByLabelText('用途说明'), '研究备份的私密记录');
    await user.click(screen.getByRole('button', { name: '保存收藏' }));

    await waitFor(async () => {
      const cols = await adapter.listCollections({ scope: 'active' });
      expect(cols.items.length).toBe(1);
      expect(cols.items[0].organization_status).toBe('skipped');
    });

    // Open detail and verify excluded state + re-allow toggle
    await user.click(await screen.findByRole('link', { name: '查看全文' }));
    await screen.findByText('已排除 AI');
    expect(screen.queryByRole('button', { name: /重新整理|重试整理/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '允许 AI 整理' }));
    await screen.findByRole('button', { name: '重新整理' });

    // Trigger restartOrganization and poll to suggestion, then click 忽略 -> 恢复自动判断 (in collapsed management drawer)
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(
      () => {
        expect(screen.getByText('AI 建议')).toBeInTheDocument();
      },
      { timeout: 7000 },
    );

    const detailCard = screen.getByRole('article');
    await within(detailCard).findByText(proj.name);
    await user.click(within(detailCard).getByRole('button', { name: '忽略' }));
    await user.click(within(detailCard).getByText('更多管理与整理详情'));
    await within(detailCard).findByText('已忽略');
    await user.click(within(detailCard).getByRole('button', { name: '恢复自动判断' }));
    await waitFor(() => {
      expect(within(detailCard).queryByText('已忽略')).not.toBeInTheDocument();
    });
  }, 15000);

  it('retries failed organization idempotently without clearing original input and distinguishes unconfigured / quota / no-suggestion states', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    adapter.setMockOrganizationMode('fail_then_succeed');

    const col = await adapter.createCollection(
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '原文保留校验文本' }] }],
          },
        },
        intent: '保留原文并测试重试',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: false,
      },
      'create-col-key-1111111111',
    );

    renderApp([`/collections/${col.id}`], adapter);
    await screen.findByText('原文保留校验文本');

    // Wait for mock failure terminal state
    await waitFor(
      () => {
        expect(screen.getByText('整理失败')).toBeInTheDocument();
      },
      { timeout: 7000 },
    );
    expect(screen.getByText('原文保留校验文本')).toBeInTheDocument();

    // First click fails transiently -> second click MUST reuse the exact same Idempotency-Key
    const restartSpy = vi
      .spyOn(adapter, 'restartOrganization')
      .mockRejectedValueOnce(new Error('短暂网关超时'));

    await user.click(screen.getByRole('button', { name: '重试整理' }));
    await screen.findByText('短暂网关超时');
    expect(screen.getByText('原文保留校验文本')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试整理' }));
    expect(restartSpy).toHaveBeenCalledTimes(2);
    expect(restartSpy.mock.calls[0][1]).toBe(restartSpy.mock.calls[1][1]);

    await waitFor(
      () => {
        expect(screen.getByText('暂无匹配项目')).toBeInTheDocument();
      },
      { timeout: 7000 },
    );
    await screen.findByText(/没有足够线索自动匹配或新建项目/);
  }, 15000);

  it('verifies no-credential interaction works cleanly when backend returns integration_not_configured', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    adapter.setMockOrganizationMode('integration_not_configured');

    const col = await adapter.createCollection(
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '无模型凭证交互测试' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: false,
      },
      'create-col-key-2222222222',
    );

    renderApp([`/collections/${col.id}`], adapter);
    await screen.findByText('未配置模型服务');
    await screen.findByText(/尚未配置模型服务凭证/);

    // User can still toggle per-item exclusion cleanly inside collapsed management drawer
    await user.click(screen.getByText('更多管理与整理详情'));
    await user.click(screen.getByRole('button', { name: '不参与 AI 整理' }));
    await screen.findByText('已排除 AI');
    await user.click(screen.getByRole('button', { name: '允许 AI 整理' }));
    await screen.findByText('未配置模型服务');
  });

  it('never falls back to detail polling on SSE disconnect, deduplicates prompts, only prompts on has_suggestion=true, and syncs once on ready/resume', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    const col = await adapter.createCollection(
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SSE 去重与重连补偿校验' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'create-col-key-3333333333',
    );

    const getOrgSpy = vi.spyOn(adapter, 'getOrganization');
    const listCollectionsSpy = vi.spyOn(adapter, 'listCollections');
    const listProjectsSpy = vi.spyOn(adapter, 'listProjects');
    renderApp([`/collections/${col.id}`], adapter);
    await screen.findByText('SSE 去重与重连补偿校验');
    expect(adapter.getOrganizationSubscriberCount()).toBe(1);

    // Wait for initial SSE ready sync to settle, then attach getCollection spy
    await waitFor(() => {
      expect(getOrgSpy).not.toHaveBeenCalled();
    });
    const getCollectionSpy = vi.spyOn(adapter, 'getCollection');

    // Simulate transient SSE error and settle initial mock auto-run: MUST NOT fall back to polling
    act(() => {
      adapter.emitMockOrganizationError(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getOrgSpy).not.toHaveBeenCalled();

    const callsBeforeNoSuggestion = getCollectionSpy.mock.calls.length;
    const listColsBeforeEvent = listCollectionsSpy.mock.calls.length;
    const listProjsBeforeEvent = listProjectsSpy.mock.calls.length;
    // Terminal event with has_suggestion=false must refresh detail once, NOT reload lists/projects, and NOT prompt confirmation toast
    act(() => {
      adapter.emitMockOrganizationEvent({
        collection_id: col.id,
        status: 'succeeded',
        has_suggestion: false,
      });
    });
    await waitFor(() => {
      expect(getCollectionSpy.mock.calls.length).toBe(callsBeforeNoSuggestion + 1);
    });
    expect(listCollectionsSpy.mock.calls.length).toBe(listColsBeforeEvent);
    expect(listProjectsSpy.mock.calls.length).toBe(listProjsBeforeEvent);
    expect(
      screen.queryByText('有一条收藏的项目建议待确认'),
    ).not.toBeInTheDocument();

    // Terminal event with has_suggestion=true shows ONE deduplicated confirmation toast even if delivered twice
    act(() => {
      adapter.emitMockOrganizationEvent({
        collection_id: col.id,
        status: 'succeeded',
        has_suggestion: true,
      });
      adapter.emitMockOrganizationEvent({
        collection_id: col.id,
        status: 'succeeded',
        has_suggestion: true,
      });
    });
    await screen.findByText('有一条收藏的项目建议待确认');
    expect(screen.getAllByText('有一条收藏的项目建议待确认')).toHaveLength(1);

    // Burst of ready + online + visibilitychange within coalesce window triggers only ONE compensation sync
    await new Promise((resolve) => setTimeout(resolve, 220));
    const callsBeforeBurst = getCollectionSpy.mock.calls.length;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => {
      adapter.emitMockOrganizationReady();
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(getCollectionSpy.mock.calls.length).toBe(callsBeforeBurst + 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getCollectionSpy.mock.calls.length).toBe(callsBeforeBurst + 1);
    expect(getOrgSpy).not.toHaveBeenCalled();

    // After coalesce window, foreground visibility resume triggers a single on-demand compensation sync
    await new Promise((resolve) => setTimeout(resolve, 220));
    const callsBeforeVis = getCollectionSpy.mock.calls.length;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(getCollectionSpy.mock.calls.length).toBe(callsBeforeVis + 1);
    });
    expect(getOrgSpy).not.toHaveBeenCalled();
  }, 12000);

  it('refreshes a previously empty project when an image is automatically filed there', async () => {
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const project = await api.createProject({ name: '蓝图册', description: '', focus_points: [] }, 'project');
    const col = await api.createCollection({ id: crypto.randomUUID(), intent: '', manual_title: '观察图',
      document: { schema_version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '网格' }] }] } },
      upload_ids: [], project_ids: [], tag_ids: [] }, 'item');
    const row = (await api.listCollections()).items.find(item => item.id === col.id)!;
    renderApp(['/projects/' + project.id], api);
    await screen.findByText('该项目下暂无匹配的收藏');
    const projects = [{ project_id: project.id, name: project.name, decision: 'auto' as const }];
    vi.spyOn(api, 'getCollection').mockResolvedValue({ ...col, projects,
      organization: { ...col.organization, status: 'succeeded', image_archive_status: 'linked' } });
    const list = api.listCollections.bind(api);
    vi.spyOn(api, 'listCollections').mockImplementation((filters, signal) => filters?.project_id === project.id
      ? Promise.resolve({ items: [{ ...row, projects }] }) : list(filters, signal));
    act(() => api.emitMockOrganizationEvent({ collection_id: col.id, status: 'succeeded', has_suggestion: false }));
    const article = await screen.findByRole('article', { name: '观察图' });
    expect(within(article).getByRole('link', { name: '自动归入 · 蓝图册' })).toBeVisible();
    expect(screen.queryByText('有一条收藏的项目建议待确认')).toBeNull();
  });

  it('updates a project search hit from live events while preserving its snippet', async () => {
    const api = createTestAdapter();
    const ui = userEvent.setup();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const project = await api.createProject({ name: '项目资料', description: '', focus_points: [] }, 'project');
    const col = await api.createCollection({ id: crypto.randomUUID(), intent: '', manual_title: '原始标题',
      document: { schema_version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '样本' }] }] } },
      upload_ids: [], project_ids: [project.id], tag_ids: [] }, 'item');
    const summary = (await api.listCollections({ project_id: project.id })).items[0];
    const search = vi.spyOn(api, 'searchCollections').mockResolvedValue({ items: [
      { collection: summary, snippets: [{ field: 'text', text: '保留这段摘录' }] },
    ] });
    renderApp([`/projects/${project.id}`], api);
    await ui.type(await screen.findByLabelText('在当前项目内搜索'), '样本');
    await screen.findByText('保留这段摘录');
    const emit = (status: 'queued' | 'succeeded') => act(() => api.emitMockOrganizationEvent({
      collection_id: col.id, status, has_suggestion: false,
    }));
    emit('queued');
    await screen.findByText('整理排队中');
    vi.spyOn(api, 'getCollection').mockResolvedValue({ ...col, display_title: '整理后的标题',
      organization: { ...col.organization, status: 'succeeded' } });
    emit('succeeded');
    await screen.findByRole('article', { name: '整理后的标题' });
    expect(screen.queryByText('整理排队中')).toBeNull();
    expect(screen.getByText('保留这段摘录')).toBeVisible();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it.each(['confirm', 'ignore in another tab', 'ignore after reconnect'])('synchronizes a mounted empty suggestions tab through %s', async mode => {
    const ui = userEvent.setup();
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    const project = await api.createProject({ name: '白板计划', description: '', focus_points: [] }, 'project');
    renderApp(['/unclassified?tab=suggested'], api);
    await screen.findByText('没有待确认的 AI 建议');
    const list = vi.spyOn(api, 'listCollections');
    const col = await api.createCollection({ id: crypto.randomUUID(), intent: '白板计划',
      document: { schema_version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '会议手稿' }] }] } },
      upload_ids: [], project_ids: [], tag_ids: [] }, 'item');
    await screen.findByText('建议归入：白板计划');
    expect(screen.getByRole('button', { name: /待确认 AI 建议/ })).toHaveTextContent('1');
    expect(list.mock.calls.every(([query]) => query?.has_suggestion === true)).toBe(true);
    if (mode === 'confirm') {
      await ui.click(screen.getByRole('button', { name: '加入项目' }));
    } else {
      const fresh = await api.getCollection(col.id);
      await api.updateProjectDecisions(col.id, { base_decision_version: fresh.decision_version,
        operations: [{ id: project.id, action: 'exclude' }] });
      act(() => {
        if (mode === 'ignore after reconnect') api.emitMockOrganizationReady();
        else api.emitMockOrganizationEvent({ collection_id: col.id, status: 'succeeded', has_suggestion: false });
      });
    }
    await screen.findByText('没有待确认的 AI 建议');
    expect(screen.queryByText('建议归入：白板计划')).toBeNull();
    expect(screen.queryByRole('button', { name: '忽略' })).toBeNull();
    expect(screen.getByRole('button', { name: /待确认 AI 建议/ })).not.toHaveTextContent('1');
  });

  it('recovers pending suggestions cleanly after returning offline and respects trial eligibility', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    await adapter.createProject(
      { name: '离线回访验证项目', description: '离线归档与恢复', focus_points: [] },
      'proj-offline-1111111111',
    );
    await adapter.createCollection(
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '离线期间完成的 AI 建议待确认' }] },
            ],
          },
        },
        intent: '离线回访验证项目整理测试',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'create-col-offline-1111111111',
    );
    // Let background mock finish while no UI SSE subscriber was mounted
    await new Promise((resolve) => setTimeout(resolve, 200));

    // User returns and mounts Inbox
    renderApp(['/inbox'], adapter);
    const pendingBanner = await screen.findByTestId('pending-suggestions-banner');
    expect(pendingBanner).toHaveTextContent(/有\s*1\s*条 AI 项目建议待确认/);

    // Expand inline list in Inbox and verify item + suggested project + evidence appear
    await user.click(within(pendingBanner).getByRole('button', { name: '查看列表' }));
    await within(pendingBanner).findByText(/建议归入：离线回访验证项目/);

    // Jump to /unclassified?tab=suggested and confirm from persistent list
    await user.click(within(pendingBanner).getByRole('link', { name: '去确认' }));
    await screen.findByRole('button', { name: /待确认 AI 建议/ });
    await screen.findByText(/建议归入：离线回访验证项目/);
    await user.click(screen.getByRole('button', { name: '加入项目' }));
    await screen.findByText('没有待确认的 AI 建议');

    // Logout closes SSE cleanly
    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await screen.findByRole('heading', { name: '登录你的空间' });
    expect(adapter.getOrganizationSubscriberCount()).toBe(0);

    // Non-trial user must not see a failing AI enable CTA on Inbox
    cleanup();
    adapter.setMockTrialEligibility({ ai_trial_eligible: false, ai_platform_enabled: true });
    await adapter.updatePreferences({ ai_enabled: false }).catch(() => undefined);
    // Login again after disabling AI on ineligible account
    const adminUser = await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    if (adminUser.user.ai_enabled) {
      await adapter.updatePreferences({ ai_enabled: false });
    }
    await adapter.logout();

    renderApp(['/login'], adapter);
    await loginAsAdmin(user);
    expect(screen.queryByRole('region', { name: 'AI 自动整理入口' })).not.toBeInTheDocument();
  }, 15000);

  it('guards PendingSuggestionsBanner against overwriting newer decisions made in another tab and clears dedupe across accounts', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'v1' });
    const proj = await adapter.createProject(
      { name: '跨标签防覆盖项目', description: '冲突防护', focus_points: [] },
      'proj-stale-guard-1111111111',
    );
    const col = await adapter.createCollection(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '跨标签防覆盖项目测试文档' }] }],
          },
        },
        intent: '跨标签防覆盖项目测试',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'create-col-stale-1111111111',
    );
    await waitFor(async () => {
      expect((await adapter.getCollection(col.id)).has_suggestion).toBe(true);
    });

    renderApp(['/inbox'], adapter);
    const pendingBanner = await screen.findByTestId('pending-suggestions-banner');
    await user.click(within(pendingBanner).getByRole('button', { name: '查看列表' }));
    await within(pendingBanner).findByText(/建议归入：跨标签防覆盖项目/);

    // Simulate another tab rejecting the suggestion (bumping decision_version and resolving suggested -> rejected)
    const beforeTab2 = await adapter.getCollection(col.id);
    await adapter.updateProjectDecisions(col.id, {
      base_decision_version: beforeTab2.decision_version,
      operations: [{ id: proj.id, action: 'exclude' }],
    });

    const updateDecisionsSpy = vi.spyOn(adapter, 'updateProjectDecisions');
    await user.click(within(pendingBanner).getByRole('button', { name: '加入项目' }));

    await screen.findByText('该条建议已在其他页面处理完成，列表已为你同步最新状态。');
    expect(updateDecisionsSpy).not.toHaveBeenCalled();
    const latest = await adapter.getCollection(col.id);
    expect(latest.projects.find((p) => p.project_id === proj.id)?.decision).toBe('rejected');

    // Cross-account isolation: SSE dedupe history clears cleanly on logout / account switch
    act(() => {
      adapter.emitMockOrganizationEvent({
        collection_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        status: 'succeeded',
        has_suggestion: true,
      });
    });
    await screen.findByText('有一条收藏的项目建议待确认');

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await screen.findByRole('heading', { name: '登录你的空间' });

    expect(adapter.getOrganizationSubscriberCount()).toBe(0);

    // Register a second account and verify same collection_id event is NOT suppressed by Account A's dedupe history
    const verif = await adapter.sendVerification({ email: 'userb@spark.local', purpose: 'register' });
    const code = adapter.getLastVerificationCode('userb@spark.local')!;
    await adapter.register({
      email: 'userb@spark.local',
      password: 'PasswordB123456!',
      challenge_id: verif.challenge_id,
      verification_code: code,
      invite_code: 'SPARK-TEST-0002',
    });

    cleanup();
    renderApp(['/inbox'], adapter);
    await screen.findByRole('heading', { name: '收件箱' });
    // The inbox can render before the effect that subscribes this session runs.
    await waitFor(() => expect(adapter.getOrganizationSubscriberCount()).toBe(1));
    expect(screen.queryByText('跨标签防覆盖项目测试文档')).not.toBeInTheDocument();

    act(() => {
      adapter.emitMockOrganizationEvent({
        collection_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        status: 'succeeded',
        has_suggestion: true,
      });
    });
    await screen.findByText('有一条收藏的项目建议待确认');
  }, 15000);
});

describe('organization display helpers', () => {
  const baseOrg: Organization = {
    content_version: 1,
    status: 'skipped',
    stages: [],
    updated_at: '2026-11-18T00:00:00Z',
  };

  it('distinguishes disabled, excluded, unconfigured, quota_exceeded, no suggestion, and failure without raw upstream text', () => {
    expect(
      classifyOrganizationDisplay({
        organization: { ...baseOrg, error_code: 'ai_disabled' },
        aiEnabled: false,
        aiExcluded: false,
        projects: [],
      }).kind,
    ).toBe('disabled');

    expect(
      classifyOrganizationDisplay({
        organization: baseOrg,
        aiEnabled: true,
        aiExcluded: true,
        projects: [],
      }).kind,
    ).toBe('excluded');

    expect(
      classifyOrganizationDisplay({
        organization: { ...baseOrg, error_code: 'integration_not_configured' },
        aiEnabled: true,
        aiExcluded: false,
        projects: [],
      }).kind,
    ).toBe('unconfigured');

    expect(
      classifyOrganizationDisplay({
        organization: { ...baseOrg, status: 'blocked', error_code: 'quota_exceeded' },
        aiEnabled: true,
        aiExcluded: false,
        projects: [],
      }).kind,
    ).toBe('quota_exceeded');

    const noSug = classifyOrganizationDisplay({
      organization: { ...baseOrg, status: 'succeeded' },
      aiEnabled: true,
      aiExcluded: false,
      projects: [],
    });
    expect(noSug.kind).toBe('succeeded');
    expect(noSug.noProjectSuggestion).toBe(true);

    const failed = classifyOrganizationDisplay({
      organization: { ...baseOrg, status: 'failed', error_code: 'invalid_model_output' },
      aiEnabled: true,
      aiExcluded: false,
      projects: [],
    });
    expect(failed.kind).toBe('failed');
    expect(failed.triggerLabel).toBe('重试整理');
    expect(failed.description).toContain('未通过内容与引用校验');
    expect(failed.description).not.toMatch(/http|stack|openai|deepseek/i);

    for (const code of [
      'provider_unavailable',
      'provider_timeout',
      'provider_auth_failed',
      'provider_rate_limited',
      'usage_uncertain',
    ]) {
      const res = classifyOrganizationDisplay({
        organization: { ...baseOrg, status: 'failed', error_code: code },
        aiEnabled: true,
        aiExcluded: false,
        projects: [],
      });
      expect(res.kind).toBe('failed');
      expect(res.description).not.toMatch(/http|stack|openai|deepseek/i);
    }

    const timedOut = classifyOrganizationDisplay({ organization: { ...baseOrg, status: 'failed', error_code: 'image_material_timeout' },
      aiEnabled: true, aiExcluded: false, projects: [] });
    expect(timedOut.description).toContain('等待图片识别超时，本次整理未使用图片材料');
    expect(timedOut.canTrigger).toBe(true);
    expect(timedOut.noProjectSuggestion).toBe(false);

    const partialProjectChanged = classifyOrganizationDisplay({
      organization: {
        ...baseOrg,
        status: 'partial',
        error_code: 'project_changed',
        generated_title: '保留的建议标题',
        summary: '保留的摘要内容',
      },
      aiEnabled: true,
      aiExcluded: false,
      projects: [],
    });
    expect(partialProjectChanged.kind).toBe('partial');
    expect(partialProjectChanged.description).toBe('项目已更新，本次项目建议未应用，可重新整理');
    expect(partialProjectChanged.noProjectSuggestion).toBe(false);
    expect(partialProjectChanged.triggerLabel).toBe('重新整理');

    const noTopic = classifyOrganizationDisplay({
      organization: { ...baseOrg, status: 'partial', error_code: 'invalid_topic_candidate' },
      aiEnabled: true,
      aiExcluded: false,
      projects: [],
    });
    expect(noTopic.description).toContain('已保留整理结果');
    expect(noTopic.noProjectSuggestion).toBe(false);

    const partialUsageUncertain = classifyOrganizationDisplay({
      organization: {
        ...baseOrg,
        status: 'partial',
        error_code: 'usage_uncertain',
        generated_title: '有效的标题',
        summary: '有效的摘要',
      },
      aiEnabled: true,
      aiExcluded: false,
      projects: [
        {
          project_id: 'p1',
          name: '项目一',
          decision: 'suggested',
        },
      ],
    });
    expect(partialUsageUncertain.kind).toBe('partial');
    expect(partialUsageUncertain.canTrigger).toBe(false);
    expect(partialUsageUncertain.description).toContain('无需重复重整');

    for (const code of ['queue_expired', 'attempts_exhausted', 'provider_request_rejected']) {
      const res = classifyOrganizationDisplay({
        organization: { ...baseOrg, status: 'failed', error_code: code },
        aiEnabled: true,
        aiExcluded: false,
        projects: [],
      });
      expect(res.kind).toBe('failed');
      expect(res.description).not.toMatch(/http|stack|openai|deepseek/i);
    }

    expect(evidenceSourceLabel('original_text')).toBe('正文');
    expect(evidenceSourceLabel('intent')).toBe('用途说明');
  });

  it('converges detail default view to clear project outcomes, hides stage/duplicate title clutter behind disclosure, and removes 已整理/无项目 contradiction', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    const filedProj = await adapter.createProject(
      { name: '潮汐传感器研究', description: '传感器测试项目', focus_points: ['潮汐'] },
      'proj-converge-filed-1',
    );

    const noMatchCol = await adapter.createCollection(
      {
        id: 'dddddddd-dddd-4ddd-8ddd-111111111111',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '大模型最新开源动态汇总' }] }],
          },
        },
        intent: '',
        manual_title: '大模型开源进展追踪',
        original_url: 'https://example.org/llm-news',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: false,
      },
      'col-converge-nomatch-1',
    );
    const readNoMatch = await adapter.setReadState(noMatchCol.id, { read: true });
    const settledNoMatch = {
      ...readNoMatch,
      tags: [
        {
          tag_id: 'tag-llm',
          name: '大模型动态',
          path: '大模型动态',
          decision: 'auto' as const,
        },
      ],
      projects: [],
      has_suggestion: false,
      organization: {
        ...readNoMatch.organization,
        status: 'succeeded' as const,
        web_archive_status: 'no_match' as const,
        generated_title: '大模型开源进展追踪',
        summary: '汇总本周主流大模型动态。',
        stages: [
          { name: 'generate' as const, status: 'succeeded' as const, attempts: 1 },
          { name: 'match_projects' as const, status: 'succeeded' as const, attempts: 1 },
          { name: 'apply' as const, status: 'succeeded' as const, attempts: 1 },
        ],
      },
    };

    const filedCol = await adapter.createCollection(
      {
        id: 'dddddddd-dddd-4ddd-8ddd-222222222222',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '潮汐传感器标定记录' }] }],
          },
        },
        intent: '',
        manual_title: '潮汐传感器标定记录',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-converge-filed-2',
    );
    const readFiled = await adapter.setReadState(filedCol.id, { read: true });
    const settledFiled = {
      ...readFiled,
      ai_excluded: false,
      projects: [
        {
          project_id: filedProj.id,
          name: filedProj.name,
          decision: 'auto' as const,
          reason: '材料匹配潮汐传感器主题',
          evidence: [{ source_id: 'page_title', quote: '潮汐传感器' }],
        },
      ],
      organization: {
        ...readFiled.organization,
        status: 'succeeded' as const,
        web_archive_status: 'linked' as const,
        generated_title: '潮汐传感器标定记录',
        stages: [
          { name: 'generate' as const, status: 'succeeded' as const, attempts: 1 },
          { name: 'match_projects' as const, status: 'succeeded' as const, attempts: 1 },
          { name: 'apply' as const, status: 'succeeded' as const, attempts: 1 },
        ],
      },
    };

    const origGet = adapter.getCollection.bind(adapter);
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === settledNoMatch.id) return structuredClone(settledNoMatch);
      if (id === settledFiled.id) return structuredClone(settledFiled);
      return origGet(id, signal);
    });

    // 1. Settled no_match: MUST say 仍待归类 + reason, NEVER 已整理 / 暂未关联项目 / 决定版本 / visible stages / duplicate title
    const v1 = renderApp([`/collections/${settledNoMatch.id}`], adapter);
    const filingRegion1 = await screen.findByRole('region', { name: '归类结果' });
    expect(within(filingRegion1).getByText('仍待归类')).toBeInTheDocument();
    expect(within(filingRegion1).queryByText('已整理')).not.toBeInTheDocument();
    expect(within(filingRegion1).queryByText('暂未关联项目')).not.toBeInTheDocument();
    expect(within(filingRegion1).queryByText(/决定版本/)).not.toBeInTheDocument();
    expect(within(filingRegion1).queryByText('AI 建议标题')).not.toBeInTheDocument();
    expect(within(filingRegion1).queryByText(/项目匹配/)).not.toBeInTheDocument();
    // At most one primary CTA button outside collapsed disclosure
    expect(within(filingRegion1).getByRole('button', { name: '手动选择项目' })).toBeInTheDocument();
    expect(within(filingRegion1).queryByRole('button', { name: '不参与 AI 整理' })).not.toBeInTheDocument();

    // Expanding disclosure reveals management & technical details
    await user.click(within(filingRegion1).getByText('更多管理与整理详情'));
    expect(within(filingRegion1).getByRole('button', { name: '不参与 AI 整理' })).toBeVisible();
    expect(within(filingRegion1).getByText('项目匹配')).toBeVisible();
    v1.unmount();

    // 2. Filed (auto): MUST show 已归入 + clickable project link, ZERO action buttons outside collapsed disclosure
    renderApp([`/collections/${settledFiled.id}`], adapter);
    const filingRegion2 = await screen.findByRole('region', { name: '归类结果' });
    expect(within(filingRegion2).getByText('已归入')).toBeInTheDocument();
    expect(within(filingRegion2).getByRole('link', { name: filedProj.name })).toHaveAttribute(
      'href',
      `/projects/${filedProj.id}`,
    );
    expect(within(filingRegion2).queryByRole('button', { name: '确认' })).not.toBeInTheDocument();
    expect(within(filingRegion2).queryByRole('button', { name: '移除' })).not.toBeInTheDocument();
    expect(within(filingRegion2).queryByRole('button', { name: '重新整理' })).not.toBeInTheDocument();
    expect(within(filingRegion2).queryByRole('button', { name: '不参与 AI 整理' })).not.toBeInTheDocument();
    expect(within(filingRegion2).queryByText('AI 建议标题')).not.toBeInTheDocument();
    expect(within(filingRegion2).queryByText(/决定版本/)).not.toBeInTheDocument();
  });

  it('auto-applies settled project_backfill_available on detail open once (StrictMode-safe), updates project views, blocks ineligible triggers, and retries same key on failure', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    const created = await adapter.createCollection(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-111111111111',
        document: { schema_version: 1, content: { type: 'doc', content: [] } },
        intent: '',
        manual_title: '潮汐传感器部署参数',
        original_url: 'https://example.org/tide-sensor',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-backfill-seed-1',
    );
    const readCol = await adapter.setReadState(created.id, { read: true });
    let liveBackfill = true;
    const backfillState = {
      ...readCol,
      ai_excluded: false,
      decision_version: 2,
      tags: [{ tag_id: 'tag-tide', name: '潮汐传感器', path: '潮汐传感器', decision: 'auto' as const }],
      organization: {
        ...readCol.organization,
        run_id: 'eeeeeeee-1111-4111-8111-111111111111',
        status: 'succeeded' as const,
        web_archive_status: 'no_match' as const,
        project_backfill_available: true,
        stages: [
          { name: 'generate' as const, status: 'succeeded' as const, attempts: 1 },
          { name: 'match_projects' as const, status: 'succeeded' as const, attempts: 1 },
          { name: 'apply' as const, status: 'succeeded' as const, attempts: 1 },
        ],
      },
    };
    const appliedResult = {
      ...backfillState,
      decision_version: 3,
      projects: [
        {
          project_id: 'eeeeeeee-2222-4222-8222-222222222222',
          name: '潮汐传感器',
          decision: 'auto' as const,
          reason: '复用已有具体标签「潮汐传感器」安全补归类',
          evidence: [{ source_id: 'page_title', quote: '潮汐传感器部署参数' }],
        },
      ],
      organization: {
        ...backfillState.organization,
        web_archive_status: 'created' as const,
        project_backfill_available: undefined,
      },
    };

    const origGetCollection = adapter.getCollection.bind(adapter);
    const origListCollections = adapter.listCollections.bind(adapter);
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === backfillState.id) return structuredClone(liveBackfill ? backfillState : appliedResult);
      return origGetCollection(id, signal);
    });
    vi.spyOn(adapter, 'listCollections').mockImplementation(async (query, signal) => {
      const page = await origListCollections(query, signal);
      return {
        ...page,
        items: page.items.map((item) =>
          item.id === backfillState.id ? { ...item, organization_status: 'succeeded' } : item,
        ),
      };
    });

    const applySpy = vi.spyOn(adapter, 'applyWebArchiveProject');

    // 1. Old consent + Inbox list must NEVER auto-trigger apply
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-image-notes-v2' });
    const inboxView = renderApp(['/inbox'], adapter);
    await screen.findByText('潮汐传感器部署参数');
    expect(applySpy).not.toHaveBeenCalled();
    inboxView.unmount();

    const oldConsentDetail = renderApp([`/collections/${backfillState.id}`], adapter);
    await screen.findByRole('button', { name: '更新整理授权以归类网页' });
    expect(applySpy).not.toHaveBeenCalled();
    oldConsentDetail.unmount();

    // 2. Grant valid consent, simulate 1 transient network error then 200 success on manual same-key retry
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-extension-archive-v1' });
    let attempt = 0;
    applySpy.mockImplementation(async (_id, body, _key) => {
      attempt += 1;
      expect(body.base_decision_version).toBe(2);
      if (attempt === 1) {
        throw new Error('网络临时中断');
      }
      liveBackfill = false;
      return structuredClone(appliedResult);
    });

    const strictView = render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/collections/${backfillState.id}`]}>
          <AppProviders api={adapter}>
            <AppRoutes />
          </AppProviders>
        </MemoryRouter>
      </StrictMode>,
    );

    // Auto-fires ONCE despite StrictMode, fails cleanly -> shows 仍待归类 + single retry button
    await screen.findByRole('button', { name: '重试归类' });
    expect(applySpy).toHaveBeenCalledTimes(1);

    // Retry reuses the EXACT SAME Idempotency-Key and immediately resolves to 已归入 <潮汐传感器>
    await user.click(screen.getByRole('button', { name: '重试归类' }));
    expect(applySpy).toHaveBeenCalledTimes(2);
    expect(applySpy.mock.calls[0][2]).toBe(applySpy.mock.calls[1][2]);

    const filingRegion = await screen.findByRole('region', { name: '归类结果' });
    expect(within(filingRegion).getByText('已归入')).toBeInTheDocument();
    expect(within(filingRegion).getByRole('link', { name: '潮汐传感器' })).toHaveAttribute(
      'href',
      '/projects/eeeeeeee-2222-4222-8222-222222222222',
    );
    expect(within(filingRegion).queryByRole('button', { name: '重试归类' })).not.toBeInTheDocument();
    strictView.unmount();

    // 3. Reopening detail after applied does NOT trigger again, and 409 conflict on a distinct run stops auto-retrying
    const conflictState = {
      ...backfillState,
      id: 'eeeeeeee-eeee-4eee-8eee-333333333333',
      organization: {
        ...backfillState.organization,
        run_id: 'eeeeeeee-3333-4333-8333-333333333333',
      },
    };
    const conflictResolved = {
      ...appliedResult,
      id: conflictState.id,
      organization: {
        ...appliedResult.organization,
        run_id: conflictState.organization.run_id,
      },
    };
    let conflictPending = true;
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === backfillState.id) return structuredClone(appliedResult);
      if (id === conflictState.id) return structuredClone(conflictPending ? conflictState : conflictResolved);
      return origGetCollection(id, signal);
    });
    const conflictApply = vi.fn().mockImplementation(async () => {
      conflictPending = false;
      const { ApiError } = await import('../api/errors');
      throw new ApiError({ status: 409, code: 'decision_conflict', message: '版本冲突' });
    });
    applySpy.mockImplementation(conflictApply);
    const conflictView = renderApp([`/collections/${conflictState.id}`], adapter);
    const afterConflict = await screen.findByRole('region', { name: '归类结果' });
    await waitFor(() => {
      expect(within(afterConflict).getByText('已归入')).toBeInTheDocument();
    });
    expect(conflictApply).toHaveBeenCalledTimes(1);
    conflictView.unmount();

    // 4. Excluded, trashed, or never-run (skipped) must NEVER auto-trigger apply
    const excludedState = {
      ...backfillState,
      id: 'eeeeeeee-eeee-4eee-8eee-444444444444',
      ai_excluded: true,
      organization: { ...backfillState.organization, run_id: 'eeeeeeee-4444-4444-8444-444444444444' },
    };
    const trashedState = {
      ...backfillState,
      id: 'eeeeeeee-eeee-4eee-8eee-555555555555',
      deleted_at: new Date().toISOString(),
      organization: { ...backfillState.organization, run_id: 'eeeeeeee-5555-4555-8555-555555555555' },
    };
    const skippedState = {
      ...backfillState,
      id: 'eeeeeeee-eeee-4eee-8eee-666666666666',
      organization: {
        ...backfillState.organization,
        run_id: undefined,
        status: 'skipped' as const,
        web_archive_status: undefined,
      },
    };
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === excludedState.id) return structuredClone(excludedState);
      if (id === trashedState.id) return structuredClone(trashedState);
      if (id === skippedState.id) return structuredClone(skippedState);
      return origGetCollection(id, signal);
    });
    const guardApply = vi.fn();
    applySpy.mockImplementation(guardApply);
    for (const guardId of [excludedState.id, trashedState.id, skippedState.id]) {
      const v = renderApp([`/collections/${guardId}`], adapter);
      await screen.findByRole('region', { name: '归类结果' });
      v.unmount();
    }
    expect(guardApply).not.toHaveBeenCalled();

    // 5. Settled partial (no_match) with project_backfill_available=true auto-applies cleanly
    const partialCol = await adapter.createCollection(
      {
        id: 'eeeeeeee-eeee-4eee-8eee-777777777777',
        document: { schema_version: 1, content: { type: 'doc', content: [] } },
        intent: '',
        manual_title: '气象站校准指南',
        original_url: 'https://example.org/weather-partial',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-backfill-partial-1',
    );
    const partialRead = await adapter.setReadState(partialCol.id, { read: true });
    const partialState = {
      ...partialRead,
      ai_excluded: false,
      decision_version: 2,
      tags: [{ tag_id: 'tag-weather', name: '气象站', path: '气象站', decision: 'auto' as const }],
      organization: {
        ...partialRead.organization,
        run_id: 'eeeeeeee-7777-4777-8777-777777777777',
        status: 'partial' as const,
        web_archive_status: 'no_match' as const,
        project_backfill_available: true,
      },
    };
    const partialResolved = {
      ...partialState,
      decision_version: 3,
      projects: [
        {
          project_id: 'eeeeeeee-8888-4888-8888-888888888888',
          name: '气象站',
          decision: 'auto' as const,
          evidence: [{ source_id: 'page_title', quote: '气象站校准指南' }],
        },
      ],
      organization: {
        ...partialState.organization,
        status: 'succeeded' as const,
        web_archive_status: 'created' as const,
        project_backfill_available: undefined,
      },
    };

    // 6. Slow A apply fails AFTER navigating A -> B: B must stay completely clean (no bleed)
    const slowA = {
      ...backfillState,
      id: 'eeeeeeee-eeee-4eee-8eee-999999999999',
      manual_title: '慢请求收藏 A',
      organization: {
        ...backfillState.organization,
        run_id: 'eeeeeeee-9999-4999-8999-999999999999',
      },
    };
    const cleanB = {
      ...appliedResult,
      id: 'eeeeeeee-eeee-4eee-8eee-aaaaaaaaaaaa',
      manual_title: '普通已归入收藏 B',
      organization: {
        ...appliedResult.organization,
        run_id: 'eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    };

    let partialDone = false;
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === partialState.id) return structuredClone(partialDone ? partialResolved : partialState);
      if (id === slowA.id) return structuredClone(slowA);
      if (id === cleanB.id) return structuredClone(cleanB);
      return origGetCollection(id, signal);
    });
    let rejectSlowA!: (err: Error) => void;
    applySpy.mockImplementation(async (colId) => {
      if (colId === partialState.id) {
        partialDone = true;
        return structuredClone(partialResolved);
      }
      if (colId === slowA.id) {
        return new Promise((_, rej) => {
          rejectSlowA = rej;
        });
      }
      throw new Error(`Unexpected apply call for ${colId}`);
    });

    const partialView = renderApp([`/collections/${partialState.id}`], adapter);
    const partialRegion = await screen.findByRole('region', { name: '归类结果' });
    await waitFor(() => {
      expect(within(partialRegion).getByText('已归入')).toBeInTheDocument();
      expect(within(partialRegion).getByRole('link', { name: '气象站' })).toBeInTheDocument();
    });
    partialView.unmount();

    const navView = renderApp([`/collections/${slowA.id}`], adapter);
    await screen.findByRole('heading', { name: '慢请求收藏 A' });
    // Navigate A -> B while A apply is still in flight
    await user.click(screen.getByRole('link', { name: '返回' }));
    await screen.findByRole('heading', { name: '收件箱' });
    // Mount B directly within the same session
    navView.unmount();
    renderApp([`/collections/${cleanB.id}`], adapter);
    await screen.findByRole('heading', { name: '普通已归入收藏 B' });
    await act(async () => {
      rejectSlowA(new Error('收藏 A 后台超时'));
      await Promise.resolve();
    });
    const bRegion = await screen.findByRole('region', { name: '归类结果' });
    expect(within(bRegion).getByText('已归入')).toBeInTheDocument();
    expect(within(bRegion).queryByText(/收藏 A 后台超时/)).not.toBeInTheDocument();
    expect(within(bRegion).queryByRole('button', { name: '重试归类' })).not.toBeInTheDocument();
  });

  it('drops unmounted/signed-out late apply writes without repopulating cleared cache, and preserves newer resource/content versions at equal decision_version', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    const seed = await adapter.createCollection(
      {
        id: 'ffffffff-1111-4111-8111-111111111111',
        document: { schema_version: 1, content: { type: 'doc', content: [] } },
        intent: '',
        manual_title: '未完成已退出样本',
        original_url: 'https://example.org/late-unmount',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-late-unmount-1',
    );
    const readSeed = await adapter.setReadState(seed.id, { read: true });
    const pendingBackfill = {
      ...readSeed,
      ai_excluded: false,
      decision_version: 2,
      content_version: 1,
      resource_version: 2,
      tags: [{ tag_id: 'tag-late', name: '迟到回归', path: '迟到回归', decision: 'auto' as const }],
      organization: {
        ...readSeed.organization,
        run_id: 'ffffffff-2222-4222-8222-222222222222',
        status: 'succeeded' as const,
        web_archive_status: 'no_match' as const,
        project_backfill_available: true,
      },
    };
    const lateReceipt = {
      ...pendingBackfill,
      decision_version: 3,
      content_version: 1,
      resource_version: 3,
      projects: [
        {
          project_id: 'ffffffff-3333-4333-8333-333333333333',
          name: '迟到回归',
          decision: 'auto' as const,
        },
      ],
      organization: {
        ...pendingBackfill.organization,
        web_archive_status: 'created' as const,
        project_backfill_available: undefined,
      },
    };

    const origGet = adapter.getCollection.bind(adapter);
    const getCollectionSpy = vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === pendingBackfill.id) return structuredClone(pendingBackfill);
      return origGet(id, signal);
    });

    let resolveLate!: (col: typeof lateReceipt) => void;
    let rejectConflict!: (err: unknown) => void;
    const applySpy = vi.spyOn(adapter, 'applyWebArchiveProject').mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveLate = res;
        }),
    );

    const view1 = renderApp([`/collections/${pendingBackfill.id}`], adapter);
    await screen.findByRole('heading', { name: '未完成已退出样本' });
    expect(applySpy).toHaveBeenCalledTimes(1);

    // Sign out from AppShell (clears session & query cache) BEFORE the in-flight apply resolves
    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await screen.findByRole('heading', { name: '登录你的空间' });
    const sessionCallsBeforeResolve = vi.spyOn(adapter, 'currentSession');
    sessionCallsBeforeResolve.mockClear();
    getCollectionSpy.mockClear();
    const setQueryDataSpy = vi.spyOn(QueryClient.prototype, 'setQueryData');
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    await act(async () => {
      resolveLate(structuredClone(lateReceipt));
      await Promise.resolve();
    });
    expect(sessionCallsBeforeResolve).not.toHaveBeenCalled();
    expect(getCollectionSpy).not.toHaveBeenCalled();
    expect(setQueryDataSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    setQueryDataSpy.mockRestore();
    invalidateSpy.mockRestore();
    // Stale detail title must NOT reappear in UI after logout
    expect(screen.queryByRole('heading', { name: '未完成已退出样本' })).not.toBeInTheDocument();

    // Verify 403/409 after unmount also does not call refreshSession()
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });
    const seed2 = {
      ...pendingBackfill,
      id: 'ffffffff-4444-4444-8444-444444444444',
      organization: {
        ...pendingBackfill.organization,
        run_id: 'ffffffff-5555-4555-8555-555555555555',
      },
    };
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === seed2.id) return structuredClone(seed2);
      return origGet(id, signal);
    });
    applySpy.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          rejectConflict = rej;
        }),
    );
    view1.unmount();
    const view2 = renderApp([`/collections/${seed2.id}`], adapter);
    await screen.findByRole('heading', { name: '未完成已退出样本' });
    view2.unmount();
    const sessionCallsAfterUnmount = vi.spyOn(adapter, 'currentSession');
    sessionCallsAfterUnmount.mockClear();
    const invalidateAfterUnmountSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    await act(async () => {
      const { ApiError } = await import('../api/errors');
      rejectConflict(new ApiError({ status: 403, code: 'web_archive_consent_required', message: '需授权' }));
      await Promise.resolve();
    });
    expect(sessionCallsAfterUnmount).not.toHaveBeenCalled();
    expect(invalidateAfterUnmountSpy).not.toHaveBeenCalled();
    invalidateAfterUnmountSpy.mockRestore();

    // Case 2: Equal decision_version (3) but newer content_version (2) / resource_version (4) in cache -> late apply receipt (cv=1, rv=3) MUST NOT overwrite edited title/body
    const seed3 = {
      ...pendingBackfill,
      id: 'ffffffff-6666-4666-8666-666666666666',
      manual_title: '初始网页标题',
      organization: {
        ...pendingBackfill.organization,
        run_id: 'ffffffff-7777-4777-8777-777777777777',
      },
    };
    const editedNewer = {
      ...lateReceipt,
      id: seed3.id,
      manual_title: '刚编辑保存的新标题',
      display_title: '刚编辑保存的新标题',
      decision_version: 3,
      content_version: 2,
      resource_version: 4,
      organization: {
        ...lateReceipt.organization,
        run_id: seed3.organization.run_id,
      },
    };
    let resolveDelayedApply!: (col: typeof lateReceipt) => void;
    let useEdited = false;
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === seed3.id) return structuredClone(useEdited ? editedNewer : seed3);
      return origGet(id, signal);
    });
    vi.spyOn(adapter, 'updateCollection').mockImplementation(async () => {
      useEdited = true;
      return structuredClone(editedNewer);
    });
    applySpy.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveDelayedApply = res;
        }),
    );

    renderApp([`/collections/${seed3.id}`], adapter);
    await screen.findByRole('heading', { name: '初始网页标题' });

    // User concurrently edits and saves newer manual_title (cv=2, rv=4, dv=3) while apply is still in flight
    await user.click(screen.getByRole('button', { name: '编辑' }));
    const titleInput = screen.getByLabelText('可选标题（留空恢复默认）');
    await user.clear(titleInput);
    await user.type(titleInput, '刚编辑保存的新标题');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('heading', { name: '刚编辑保存的新标题' });

    // Now late apply receipt arrives with dv=3, cv=1, rv=3, manual_title='未完成已退出样本' -> MUST NOT overwrite '刚编辑保存的新标题'!
    await act(async () => {
      resolveDelayedApply(structuredClone({ ...lateReceipt, id: seed3.id }));
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: '刚编辑保存的新标题' })).toBeInTheDocument();
  });

  it('recovers eligible settled invalid_model_output / model_output_truncated once with explicit confirmation, resends same key on network error, blocks double-click, and supports blocked quota requeue', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    const targetProj = await adapter.createProject(
      { name: 'AI工程实践', description: '工程实践资料', focus_points: ['代理工作流'] },
      'proj-recover-target-1',
    );

    const created = await adapter.createCollection(
      {
        id: 'aaaaaaaa-1111-4111-8111-111111111111',
        document: {
          schema_version: 1,
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '代理工作流截断恢复实测' }] }],
          },
        },
        intent: '归入AI工程实践',
        manual_title: '代理工作流实践',
        original_url: 'https://example.org/agent-workflow',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-recover-setup-1',
    );
    const baseCol = await adapter.setReadState(created.id, { read: true });
    const legacyRunId = 'aaaaaaaa-2222-4222-8222-222222222222';
    const quotaBlockedRunId = 'aaaaaaaa-3333-4333-8333-333333333333';

    let serverState: Collection = {
      ...baseCol,
      ai_excluded: false,
      web_archive_available: true,
      organization: {
        ...baseCol.organization,
        run_id: legacyRunId,
        status: 'failed',
        error_code: 'invalid_model_output',
        web_archive_retry_available: false,
        web_archive_recovery_available: true,
      },
    };

    const origGet = adapter.getCollection.bind(adapter);
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === baseCol.id) return structuredClone(serverState);
      return origGet(id, signal);
    });
    const restartSpy = vi.spyOn(adapter, 'restartOrganization');
    const archiveSpy = vi.spyOn(adapter, 'archiveWebCollection');

    let resolveRecover!: (org: Organization) => void;
    const recoverSpy = vi.spyOn(adapter, 'recoverWebArchive');

    // 1. Settled legacy invalid_model_output with recovery available: single explicit CTA, zero drawer generic retry, no truncation claim on legacy error
    const view1 = renderApp([`/collections/${baseCol.id}`], adapter);
    const region1 = await screen.findByRole('region', { name: '归类结果' });
    expect(within(region1).getByText(/上次网页归类已产生计费记录并保留/)).toBeInTheDocument();
    expect(within(region1).queryByText(/截断/)).not.toBeInTheDocument();
    expect(within(region1).getByRole('button', { name: '重试网页归类' })).toBeInTheDocument();
    await user.click(within(region1).getByText('更多管理与整理详情'));
    expect(within(region1).queryByRole('button', { name: /重试整理|重新整理|按网页内容归类|确认重新归类/ })).not.toBeInTheDocument();
    expect(recoverSpy).not.toHaveBeenCalled();

    // Open explicit confirmation panel -> unknown network error -> resend with EXACT same Idempotency-Key
    await user.click(within(region1).getByRole('button', { name: '重试网页归类' }));
    const confirmRegion1 = within(region1).getByRole('region', { name: '确认重试网页归类' });
    expect(within(confirmRegion1).getByText(/发送时会再次使用 AI 额度/)).toBeInTheDocument();

    recoverSpy.mockRejectedValueOnce(new Error('网络断开'));
    await user.click(within(confirmRegion1).getByRole('button', { name: '确认重新归类' }));
    await within(region1).findByText(/尚未确认恢复提交结果/);

    // Next click simulates in-flight promise to also verify synchronous double-click guard
    recoverSpy.mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveRecover = res;
        }),
    );
    const confirmBtn = within(confirmRegion1).getByRole('button', { name: '确认重新归类' });
    await act(async () => {
      confirmBtn.click();
      confirmBtn.click();
    });
    expect(recoverSpy).toHaveBeenCalledTimes(2);
    expect(recoverSpy.mock.calls[0][1]).toEqual({
      run_id: legacyRunId,
      base_decision_version: baseCol.decision_version,
    });
    expect(recoverSpy.mock.calls[1][1]).toEqual(recoverSpy.mock.calls[0][1]);
    expect(recoverSpy.mock.calls[1][2]).toBe(recoverSpy.mock.calls[0][2]);

    // Worker enters blocked quota_exceeded with zero dispatch -> keeps web_archive_recovery_available=true with quotaBlockedRunId
    const queuedOrg: Organization = {
      ...serverState.organization,
      run_id: quotaBlockedRunId,
      status: 'queued',
      error_code: undefined,
      web_archive_recovery_available: undefined,
    };
    serverState = {
      ...serverState,
      organization: {
        ...queuedOrg,
        status: 'blocked',
        error_code: 'quota_exceeded',
        web_archive_recovery_available: true,
      },
    };
    await act(async () => {
      resolveRecover(queuedOrg);
      await Promise.resolve();
    });

    // Re-confirming blocked quota recovery MUST send current quotaBlockedRunId + NEW Idempotency-Key
    const requeueTrigger = await within(region1).findByRole('button', { name: '重试网页归类' });
    await user.click(requeueTrigger);
    const requeueConfirm = within(region1).getByRole('region', { name: '确认重试网页归类' });
    recoverSpy.mockImplementationOnce(async () => {
      const linkedOrg = {
        ...serverState.organization,
        run_id: quotaBlockedRunId,
        status: 'succeeded' as const,
        error_code: undefined,
        web_archive_status: 'linked' as const,
        web_archive_recovery_available: undefined,
      };
      serverState = {
        ...serverState,
        decision_version: serverState.decision_version + 1,
        projects: [
          {
            project_id: targetProj.id,
            name: targetProj.name,
            decision: 'auto',
            reason: '匹配 AI工程实践',
            evidence: [{ source_id: 'page_title', quote: '代理工作流实践' }],
          },
        ],
        organization: linkedOrg,
      };
      return { ...linkedOrg, status: 'queued' as const };
    });

    await user.click(within(requeueConfirm).getByRole('button', { name: '确认重新排队' }));
    expect(recoverSpy).toHaveBeenCalledTimes(3);
    expect(recoverSpy.mock.calls[2][1]).toEqual({
      run_id: quotaBlockedRunId,
      base_decision_version: baseCol.decision_version,
    });
    expect(recoverSpy.mock.calls[2][2]).not.toBe(recoverSpy.mock.calls[0][2]);

    expect((await within(region1).findAllByRole('link', { name: targetProj.name })).length).toBeGreaterThan(0);
    expect(within(region1).queryByRole('button', { name: /重新整理|重试整理|重试网页归类|确认重新归类|确认重新排队/ })).not.toBeInTheDocument();
    expect(restartSpy).not.toHaveBeenCalled();
    expect(archiveSpy).not.toHaveBeenCalled();
    view1.unmount();

    // 2. New model_output_truncated failure shows readable truncation copy and single explicit recovery action
    serverState = {
      ...baseCol,
      ai_excluded: false,
      web_archive_available: true,
      projects: [],
      organization: {
        ...baseCol.organization,
        run_id: 'aaaaaaaa-4444-4444-8444-444444444444',
        status: 'failed',
        error_code: 'model_output_truncated',
        web_archive_retry_available: false,
        web_archive_recovery_available: true,
      },
    };
    renderApp([`/collections/${baseCol.id}`], adapter);
    const region2 = await screen.findByRole('region', { name: '归类结果' });
    expect(within(region2).getByText('生成结果被截断')).toBeInTheDocument();
    expect(within(region2).getByText(/模型输出内容过长而被截断/)).toBeInTheDocument();
    expect(within(region2).getByRole('button', { name: '重试网页归类' })).toBeInTheDocument();
  });

  it('never renders fake retry or generic restart buttons for existing results, usage_uncertain, second failures, or ineligible states', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    const proj = await adapter.createProject(
      { name: '归档已定项目', description: '测试', focus_points: ['归档'] },
      'proj-no-fake-retry-1',
    );
    const created = await adapter.createCollection(
      {
        id: 'bbbbbbbb-1111-4111-8111-111111111111',
        document: { schema_version: 1, content: { type: 'doc', content: [] } },
        intent: '校验禁止假重试',
        manual_title: '禁假重试样本',
        original_url: 'https://example.org/no-fake-retry',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-no-fake-retry-1',
    );
    const baseCol = await adapter.setReadState(created.id, { read: true });
    let activeSnapshot = structuredClone(baseCol);
    const origGet = adapter.getCollection.bind(adapter);
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === baseCol.id) return structuredClone(activeSnapshot);
      return origGet(id, signal);
    });

    const cases = [
      {
        name: 'already has auto project result',
        patch: {
          ai_excluded: false,
          web_archive_available: true,
          projects: [{ project_id: proj.id, name: proj.name, decision: 'auto' as const }],
          organization: {
            ...baseCol.organization,
            run_id: 'bbbbbbbb-2222-4222-8222-222222222222',
            status: 'succeeded' as const,
            web_archive_status: 'linked' as const,
            web_archive_recovery_available: true,
          },
        },
      },
      {
        name: 'failed usage_uncertain',
        patch: {
          ai_excluded: false,
          web_archive_available: true,
          projects: [],
          organization: {
            ...baseCol.organization,
            run_id: 'bbbbbbbb-3333-4333-8333-333333333333',
            status: 'failed' as const,
            error_code: 'usage_uncertain',
            web_archive_retry_available: true,
            web_archive_recovery_available: true,
          },
        },
      },
      {
        name: 'second failure without recovery eligibility',
        patch: {
          ai_excluded: false,
          web_archive_available: true,
          projects: [],
          organization: {
            ...baseCol.organization,
            run_id: 'bbbbbbbb-4444-4444-8444-444444444444',
            status: 'failed' as const,
            error_code: 'model_output_truncated',
            web_archive_retry_available: false,
            web_archive_recovery_available: false,
          },
        },
      },
      {
        name: 'succeeded no_match without consent/recovery',
        patch: {
          ai_excluded: false,
          web_archive_available: true,
          projects: [],
          organization: {
            ...baseCol.organization,
            run_id: 'bbbbbbbb-5555-4555-8555-555555555555',
            status: 'succeeded' as const,
            error_code: undefined,
            web_archive_status: 'no_match' as const,
          },
        },
      },
      {
        name: 'ineligible trial account even if recovery flag present',
        trialIneligible: true,
        patch: {
          ai_excluded: false,
          web_archive_available: true,
          projects: [],
          organization: {
            ...baseCol.organization,
            run_id: 'bbbbbbbb-6666-4666-8666-666666666666',
            status: 'failed' as const,
            error_code: 'invalid_model_output',
            web_archive_retry_available: false,
            web_archive_recovery_available: true,
          },
        },
      },
    ];

    for (const c of cases) {
      adapter.setMockTrialEligibility({
        ai_platform_enabled: true,
        ai_trial_eligible: !c.trialIneligible,
      });
      activeSnapshot = { ...baseCol, ...c.patch };
      const view = renderApp([`/collections/${baseCol.id}`], adapter);
      const region = await screen.findByRole('region', { name: '归类结果' });
      await user.click(within(region).getByText('更多管理与整理详情'));
      expect(
        within(region).queryByRole('button', {
          name: /重新整理|重试整理|按网页内容归类|重试网页归类|确认重新归类|确认重新排队/,
        }),
        `unexpected retry trigger for case: ${c.name}`,
      ).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('retains idempotency key on 409 operation_in_progress, rotates after explicit 409 rejection, and isolates late recovery callbacks across navigation', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    const colA = await adapter.createCollection(
      {
        id: 'cccccccc-1111-4111-8111-111111111111',
        document: { schema_version: 1, content: { type: 'doc', content: [] } },
        intent: 'A恢复延迟',
        manual_title: '收藏A',
        original_url: 'https://example.org/col-a',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-recover-guard-a',
    );
    const colB = await adapter.createCollection(
      {
        id: 'cccccccc-2222-4222-8222-222222222222',
        document: { schema_version: 1, content: { type: 'doc', content: [] } },
        intent: 'B独立确认',
        manual_title: '收藏B',
        original_url: 'https://example.org/col-b',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
        ai_excluded: true,
      },
      'col-recover-guard-b',
    );
    const readA = await adapter.setReadState(colA.id, { read: true });
    const readB = await adapter.setReadState(colB.id, { read: true });

    const snapA: Collection = {
      ...readA,
      ai_excluded: false,
      web_archive_available: true,
      organization: {
        ...readA.organization,
        run_id: 'cccccccc-3333-4333-8333-333333333333',
        status: 'failed',
        error_code: 'invalid_model_output',
        web_archive_retry_available: false,
        web_archive_recovery_available: true,
      },
    };
    const snapB: Collection = {
      ...readB,
      ai_excluded: false,
      web_archive_available: true,
      organization: {
        ...readB.organization,
        run_id: 'cccccccc-4444-4444-8444-444444444444',
        status: 'failed',
        error_code: 'model_output_truncated',
        web_archive_retry_available: false,
        web_archive_recovery_available: true,
      },
    };

    const origGet = adapter.getCollection.bind(adapter);
    const getSpy = vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === colA.id) return structuredClone(snapA);
      if (id === colB.id) return structuredClone(snapB);
      return origGet(id, signal);
    });

    const { ApiError } = await import('../api/errors');
    let resolveLateA!: (org: Organization) => void;
    const recoverSpy = vi
      .spyOn(adapter, 'recoverWebArchive')
      .mockRejectedValueOnce(new ApiError({ status: 409, code: 'operation_in_progress', message: '请求仍在处理' }))
      .mockRejectedValueOnce(new ApiError({ status: 409, code: 'web_archive_recovery_unavailable', message: '恢复资格已消费' }))
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveLateA = res;
          }),
      );

    // Part 1: 409 operation_in_progress preserves key; explicit 409 rotates key
    const vNav = render(
      <MemoryRouter initialEntries={[`/collections/${colA.id}`]}>
        <AppProviders api={adapter}>
          <Link to={`/collections/${colB.id}`}>切换到B</Link>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: '重试网页归类' }));
    await user.click(screen.getByRole('button', { name: '确认重新归类' }));
    await screen.findByText(/沿用原请求标识/);

    // Next click after 409 operation_in_progress MUST reuse the exact same key; hits explicit 409 -> clears key
    await user.click(screen.getByRole('button', { name: '确认重新归类' }));
    expect(recoverSpy).toHaveBeenCalledTimes(2);
    expect(recoverSpy.mock.calls[1][2]).toBe(recoverSpy.mock.calls[0][2]);
    await screen.findByText('恢复资格已消费');

    // Opening & submitting again MUST generate a NEW key after explicit 409 rejection, then switch A -> B while inflight
    await user.click(await screen.findByRole('button', { name: '重试网页归类' }));
    await user.click(screen.getByRole('button', { name: '确认重新归类' }));
    expect(recoverSpy).toHaveBeenCalledTimes(3);
    expect(recoverSpy.mock.calls[2][2]).not.toBe(recoverSpy.mock.calls[1][2]);

    // Navigate in the same mounted CollectionDetailPage from A -> B and open B's confirmation panel before A's late 202 resolves
    getSpy.mockClear();
    await user.click(screen.getByRole('link', { name: '切换到B' }));
    await user.click(await screen.findByRole('button', { name: '重试网页归类' }));
    const confirmB = screen.getByRole('region', { name: '确认重试网页归类' });
    const getBCountBefore = getSpy.mock.calls.filter(([id]) => id === colB.id).length;

    await act(async () => {
      resolveLateA({ ...snapA.organization, status: 'queued' });
      await Promise.resolve();
    });

    // Late A response MUST NOT close B's confirmation, show A's toast on B, or refetch B
    expect(confirmB).toBeInTheDocument();
    expect(screen.queryByText('已提交网页恢复归类请求')).not.toBeInTheDocument();
    expect(getSpy.mock.calls.filter(([id]) => id === colB.id).length).toBe(getBCountBefore);
    vNav.unmount();
  });
});
