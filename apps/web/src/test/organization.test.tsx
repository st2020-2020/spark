import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { ApiError } from '../api/errors';
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

  it('completes consent -> project creation -> save -> polling -> terminal refresh -> evidence & confirm/ignore', async () => {
    const user = userEvent.setup();
    const { adapter } = renderApp(['/login']);
    await loginAsAdmin(user);

    // 1. Open Settings and verify user does not configure models; /me/usage 404 does not block consent
    vi.spyOn(adapter, 'getUsage').mockRejectedValueOnce(
      new ApiError({ status: 404, code: 'not_found', message: 'not open' }),
    );
    const sidebar = within(screen.getByRole('complementary', { name: '主导航' }));
    await user.click(sidebar.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('menuitem', { name: '设置与会话' }));
    await screen.findByRole('heading', { name: '设置' });
    await screen.findByText(/无需个人配置模型或 API Key/);
    expect(screen.getByRole('button', { name: '开启 AI 整理' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '开启 AI 整理' }));
    await screen.findByRole('heading', { name: '开启平台 AI 自动整理' });
    await screen.findByText(/发送资料范围：/);
    await screen.findByText(/第三方服务范围：/);
    await screen.findByText(/历史收藏说明：/);
    await user.click(screen.getByRole('button', { name: '我已了解并开启' }));
    await screen.findByText(/授权版本 v\d+/);

    // 2. Create a project so AI matcher can suggest it with evidence
    await user.click(sidebar.getByRole('link', { name: '创建项目' }));
    await user.type(await screen.findByLabelText('项目名称（必填）'), '前端交互升级');
    await user.type(
      screen.getByLabelText('项目描述（可选，补充说明有助于自动关联）'),
      '表单与详情页排版体验',
    );
    await user.click(screen.getByRole('button', { name: '创建项目' }));
    await screen.findByRole('heading', { name: '前端交互升级' });

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

    // 4. Open detail and observe polling queued -> running -> succeeded + single collection refresh
    await user.click(screen.getByRole('link', { name: '查看全文' }));
    await screen.findByText('整理排队中');

    await waitFor(
      () => {
        expect(screen.getByText('已整理')).toBeInTheDocument();
      },
      { timeout: 7000 },
    );
    expect(getOrgSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Initial detail load + 1 terminal refresh = 2 calls (not repeated after terminal)
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

    // 5. Verify Unclassified page also displays AI suggestion + evidence before confirming
    await user.click(sidebar.getByRole('link', { name: '待归类' }));
    await screen.findByText(/建议归入：前端交互升级/);
    const unclassifiedEvidence = await screen.findByRole('list', { name: '推荐依据摘录' });
    expect(
      within(unclassifiedEvidence).getByText(/前端交互升级需要参考这个卡片对齐细节/),
    ).toBeInTheDocument();

    // Confirm ("加入项目") moves it out of unclassified
    await user.click(screen.getByRole('button', { name: '加入项目' }));
    await screen.findByText('已归入项目');
    await screen.findByText('没有待归类的收藏');
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

  it('pauses organization polling while document is hidden and resumes when visible', async () => {
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
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '可见性轮询控制' }] }],
          },
        },
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'create-col-key-3333333333',
    );

    let visState: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visState);

    const getOrgSpy = vi.spyOn(adapter, 'getOrganization');
    renderApp([`/collections/${col.id}`], adapter);
    await screen.findByText('可见性轮询控制');

    await new Promise((resolve) => setTimeout(resolve, 2300));
    expect(getOrgSpy).not.toHaveBeenCalled();

    visState = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(
      () => {
        expect(getOrgSpy).toHaveBeenCalled();
      },
      { timeout: 4000 },
    );
  }, 12000);
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
