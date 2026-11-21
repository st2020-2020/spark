import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import type { Organization } from '../api/types';
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
    await screen.findByText('AI 已整理完成并生成项目建议，等待你的确认');
    const toastActionBtn = await screen.findByRole('button', { name: '查看并确认' });
    expect(openedSpy).not.toHaveBeenCalled();

    // Click toast CTA to jump straight to collection detail
    await user.click(toastActionBtn);
    expect(openedSpy).toHaveBeenCalledTimes(1);
    await screen.findByText('已整理');
    expect(getOrgSpy).not.toHaveBeenCalled();
    expect(getCollectionSpy).toHaveBeenCalledTimes(2);

    // Generated title, summary, AI suggestion & evidence quote are displayed
    await screen.findByText('AI 建议标题');
    await screen.findByText('AI 摘要');
    await screen.findByText('AI 建议');
    const evidenceList = await screen.findByRole('list', { name: '推荐依据摘录' });
    expect(within(evidenceList).getByText('用途说明')).toBeInTheDocument();
    expect(
      within(evidenceList).getByText(/前端交互升级需要参考这个卡片对齐细节/),
    ).toBeInTheDocument();

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

    // Trigger restartOrganization and poll to suggestion, then click 忽略 -> 恢复自动判断
    await user.click(screen.getByRole('button', { name: '重新整理' }));
    await waitFor(
      () => {
        expect(screen.getByText('已整理')).toBeInTheDocument();
      },
      { timeout: 7000 },
    );

    const detailCard = screen.getByRole('article');
    await within(detailCard).findByText(proj.name);
    await user.click(within(detailCard).getByRole('button', { name: '忽略' }));
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
        expect(screen.getByText('已整理')).toBeInTheDocument();
      },
      { timeout: 7000 },
    );
    await screen.findByText(/暂无匹配的项目建议/);
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

    // User can still toggle per-item exclusion cleanly without credentials
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
      screen.queryByText('AI 已整理完成并生成项目建议，等待你的确认'),
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
    await screen.findByText('AI 已整理完成并生成项目建议，等待你的确认');
    expect(screen.getAllByText('AI 已整理完成并生成项目建议，等待你的确认')).toHaveLength(1);

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
    await screen.findByText('AI 已整理完成并生成项目建议，等待你的确认');

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
    await screen.findByText('AI 已整理完成并生成项目建议，等待你的确认');
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
});
