import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { allowsWebArchive, SPARK_AI_CONSENT_VERSION } from '../components/AIConsentModal';
import { EMPTY_DOCUMENT } from '../lib/document';
import { evidenceSourceLabel } from '../lib/organization';
import { createTestAdapter } from '../test-adapter/mockServer';
import {
  clearPendingExtensionPair,
  formatPairCode,
  parseExtensionPairFragment,
} from '../lib/extensionPair';

const SAMPLE_CHALLENGE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function renderApp(initialPath = '/extension/pair', adapter = createTestAdapter()) {
  return {
    adapter,
    ...render(
      <MemoryRouter initialEntries={[initialPath]}>
        <AppProviders api={adapter}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    ),
  };
}

describe('Extension pairing and Settings device management', () => {
  afterEach(() => {
    clearPendingExtensionPair();
    window.history.replaceState(null, '', '/');
  });

  it('parses fragment challenge, strips URL hash immediately, preserves across login, approves grant, and rejects stale/changed account', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    window.history.replaceState(
      null,
      '',
      `/extension/pair#challenge=${SAMPLE_CHALLENGE}&browser=chrome`,
    );

    renderApp('/extension/pair', adapter);

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });

    const expectedCode = formatPairCode(SAMPLE_CHALLENGE).grouped;
    expect(await screen.findByText(expectedCode)).toBeInTheDocument();
    expect(screen.getByText(/Spark 浏览器扩展 \(Chrome\)/)).toBeInTheDocument();

    // Unauthenticated user navigates to login with return target preserved
    await user.click(screen.getByRole('link', { name: '登录 Spark 并继续授权' }));
    await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
    await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
    await user.click(screen.getByRole('button', { name: '登录' }));

    // Redirected back to /extension/pair with user email, device, code and minimal scope
    expect(await screen.findByRole('heading', { name: '确认绑定浏览器扩展' })).toBeInTheDocument();
    expect(screen.getByText('admin@spark.local')).toBeInTheDocument();
    expect(screen.getByText(expectedCode)).toBeInTheDocument();
    expect(screen.getByLabelText('扩展操作权限说明')).toHaveTextContent('仅项目 ID 与名称');

    const approveSpy = vi.spyOn(adapter, 'approveExtensionGrant');
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));

    expect(await screen.findByRole('heading', { name: '已批准扩展连接' })).toBeInTheDocument();
    expect(approveSpy).toHaveBeenCalledWith({
      challenge: SAMPLE_CHALLENGE,
      browser: 'chrome',
      expected_account_id: expect.any(String),
    });

    // Idempotent repeat within 5-minute window succeeds with same signed-in account
    await expect(
      adapter.approveExtensionGrant({
        challenge: SAMPLE_CHALLENGE,
        browser: 'chrome',
        expected_account_id: approveSpy.mock.calls[0]![0].expected_account_id,
      }),
    ).resolves.toBeUndefined();

    // Account mismatch returns 409 extension_account_changed
    await expect(
      adapter.approveExtensionGrant({
        challenge: SAMPLE_CHALLENGE,
        browser: 'chrome',
        expected_account_id: '00000000-0000-4000-8000-999999999999',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'extension_account_changed' });

    // Consume grant as extension token exchange and check Settings device list + single revocation
    const exchanged = await adapter.redeemExtensionGrantForTest(SAMPLE_CHALLENGE);
    expect(exchanged.account_label).toBe('admin@spark.local');
    expect(exchanged.token).toBeTruthy();

    await user.click(screen.getByRole('link', { name: '查看与管理已绑定设备' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();

    const extLabel = await screen.findByText('Spark 浏览器扩展 (Chrome)');
    const extRow = extLabel.closest<HTMLElement>('.sp-session-row');
    expect(extRow).not.toBeNull();
    expect(within(extRow!).getByText('浏览器扩展')).toBeInTheDocument();
    expect(within(extRow!).getByText(/到期于/)).toBeInTheDocument();

    await user.click(within(extRow!).getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(screen.queryByText('Spark 浏览器扩展 (Chrome)')).not.toBeInTheDocument();
    });
  });

  it('rejects missing or invalid pairing fragment cleanly', async () => {
    window.history.replaceState(null, '', '/extension/pair#challenge=too-short&browser=safari');
    renderApp('/extension/pair');

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(await screen.findByRole('heading', { name: '扩展配对请求无效' })).toBeInTheDocument();
    expect(parseExtensionPairFragment('#challenge=short&browser=chrome')).toBeNull();
    expect(parseExtensionPairFragment(`#challenge=${SAMPLE_CHALLENGE}&browser=edge`)).toEqual({
      challenge: SAMPLE_CHALLENGE,
      browser: 'edge',
    });
  });

  it('displays conflict error when submitting stale challenge after account mismatch', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });

    // Consume the challenge under another grant/consumption flow first
    await adapter.approveExtensionGrant({
      challenge: SAMPLE_CHALLENGE,
      browser: 'edge',
      expected_account_id: '00000000-0000-4000-8000-000000000001',
    });
    await adapter.redeemExtensionGrantForTest(SAMPLE_CHALLENGE);

    window.history.replaceState(
      null,
      '',
      `/extension/pair#challenge=${SAMPLE_CHALLENGE}&browser=edge`,
    );
    renderApp('/extension/pair', adapter);

    expect(await screen.findByRole('heading', { name: '确认绑定浏览器扩展' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认授权绑定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/已失效或已被使用/);
  });
});

describe('v0.7.2 Web archive consent, detail trigger and evidence labels', () => {
  it('requires spark-ai-extension-archive-v1 disclosure before manual web-archive filing and keeps old consents inactive for web archive', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-image-notes-v2' });

    expect(allowsWebArchive('spark-ai-image-notes-v2')).toBe(false);
    expect(allowsWebArchive(SPARK_AI_CONSENT_VERSION)).toBe(true);
    expect(evidenceSourceLabel('page_title')).toBe('网页标题');

    // Create a URL collection with a title & no capture_source (unknown legacy URL source)
    const created = await adapter.createCollection(
      {
        id: '00000000-0000-4000-8000-000000000772',
        document: EMPTY_DOCUMENT,
        intent: '查看离线网页归档指南',
        original_url: 'https://example.org/v072-archive',
        manual_title: '网页归档专题笔记',
        project_ids: [],
        tag_ids: [],
        upload_ids: [],
      },
      'idem-web-archive-setup-1',
    );
    expect(created.web_archive_available).toBe(true);
    expect(created.capture_source).toBeUndefined();

    renderApp(`/collections/${created.id}`, adapter);

    expect(await screen.findByRole('heading', { name: '网页归档专题笔记' })).toBeInTheDocument();
    // Unknown-source collection must never claim extension provenance
    expect(screen.queryByText(/来自浏览器扩展/)).not.toBeInTheDocument();

    // Open explicit confirmation panel before triggering POST /organization/web-archive
    await user.click(await screen.findByRole('button', { name: '按网页内容归类' }));
    const confirmRegion = screen.getByRole('region', { name: '确认网页内容归类材料' });
    expect(within(confirmRegion).getByText(/标题：网页归档专题笔记/)).toBeInTheDocument();
    expect(within(confirmRegion).getByText(/用途：查看离线网页归档指南/)).toBeInTheDocument();
    expect(within(confirmRegion).getByText(/网址与网页抓取正文不发送/)).toBeInTheDocument();

    // Old consent -> requires updating AI consent with web archive disclosure
    await user.click(within(confirmRegion).getByRole('button', { name: '确认整理授权并继续' }));
    const dialog = within(await screen.findByRole('dialog', { name: '更新文字整理授权' }));
    expect(
      dialog.getByText(/将已保存并确认的标题、纯文本选文和用途发送给第三方文字模型以匹配或创建主题项目/),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: '确认更新授权' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const archiveSpy = vi.spyOn(adapter, 'archiveWebCollection');
    await user.click(screen.getByRole('button', { name: '确认发送并归类' }));
    expect(archiveSpy).toHaveBeenCalledTimes(1);

    // Wait for mock organization SSE completion to link/create topic project & expose page_title evidence
    expect(await screen.findByText(/已新建主题项目并自动归入/)).toBeInTheDocument();
    expect(screen.getByText('网页标题')).toBeInTheDocument();
  });

  it('shows guidance to add title/intent for pure URL collections and honors web_archive_status=no_match without false filing', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    // Pure URL collection with empty title, text and intent
    const bare = await adapter.createCollection(
      {
        id: '00000000-0000-4000-8000-000000000773',
        document: EMPTY_DOCUMENT,
        intent: '',
        original_url: 'https://example.org/pure-url-only',
        project_ids: [],
        tag_ids: [],
        upload_ids: [],
      },
      'idem-web-archive-bare-1',
    );
    expect(bare.web_archive_available).toBe(false);

    const noMatchCol: typeof bare = {
      ...bare,
      id: '00000000-0000-4000-8000-000000000774',
      capture_source: 'extension',
      manual_title: '零碎链接标题',
      web_archive_available: true,
      organization: {
        ...bare.organization,
        status: 'succeeded',
        error_code: undefined,
        web_archive_status: 'no_match',
      },
    };
    const origGetCollection = adapter.getCollection.bind(adapter);
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id === noMatchCol.id) return structuredClone(noMatchCol);
      return origGetCollection(id, signal);
    });

    const view = renderApp(`/collections/${bare.id}`, adapter);
    expect(
      await screen.findByText(/当前网址收藏尚无可用于网页归类的标题、纯文本选文或用途/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按网页内容归类' })).not.toBeInTheDocument();
    view.unmount();

    renderApp(`/collections/${noMatchCol.id}`, adapter);
    expect(await screen.findByText(/来自浏览器扩展/)).toBeInTheDocument();
    expect(
      screen.getByText(/已完成网页收藏分析，证据不足以自动匹配或创建项目/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/已自动归入|已新建主题项目并自动归入/)).not.toBeInTheDocument();
  });

  it('gates failed/blocked web-archive retry strictly by web_archive_retry_available ledger flag', async () => {
    const adapter = createTestAdapter();
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await adapter.updatePreferences({
      ai_enabled: true,
      consent_version: 'spark-ai-extension-archive-v1',
    });

    const createdCol = await adapter.createCollection(
      {
        id: '00000000-0000-4000-8000-000000000776',
        document: EMPTY_DOCUMENT,
        intent: '重试标记对照',
        original_url: 'https://example.org/retry-guard',
        manual_title: '网页归档队列超时样本',
        ai_excluded: true,
        project_ids: [],
        tag_ids: [],
        upload_ids: [],
      },
      'idem-web-archive-retry-flag-1',
    );
    const baseCol = await adapter.setReadState(createdCol.id, { read: true });

    const origGet = adapter.getCollection.bind(adapter);
    let currentRetryAvailable = true;
    vi.spyOn(adapter, 'getCollection').mockImplementation(async (id, signal) => {
      if (id !== baseCol.id) return origGet(id, signal);
      return {
        ...baseCol,
        ai_excluded: false,
        web_archive_available: true,
        organization: {
          ...baseCol.organization,
          status: 'failed',
          error_code: 'queue_expired',
          web_archive_retry_available: currentRetryAvailable,
        },
      };
    });

    const firstView = renderApp(`/collections/${baseCol.id}`, adapter);
    expect(await screen.findByRole('button', { name: '重试网页归类' })).toBeInTheDocument();
    expect(
      screen.queryByText(/上次网页归类已产生计费记录，为防重复计费不再提供直接重试/),
    ).not.toBeInTheDocument();
    firstView.unmount();

    currentRetryAvailable = false;
    renderApp(`/collections/${baseCol.id}`, adapter);
    expect(
      await screen.findByText(/上次网页归类已产生计费记录，为防重复计费不再提供直接重试/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试网页归类' })).not.toBeInTheDocument();
  });

  it('hides web-archive triggers when platform AI is disabled', async () => {
    const adapter = createTestAdapter();
    adapter.setMockTrialEligibility({ ai_platform_enabled: false });
    await adapter.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const col = await adapter.createCollection(
      {
        id: '00000000-0000-4000-8000-000000000775',
        document: EMPTY_DOCUMENT,
        intent: '平台关闭状态下保存',
        original_url: 'https://example.org/platform-off',
        manual_title: '平台未启用示例',
        project_ids: [],
        tag_ids: [],
        upload_ids: [],
      },
      'idem-web-archive-off-1',
    );

    renderApp(`/collections/${col.id}`, adapter);
    expect(await screen.findByRole('heading', { name: '平台未启用示例' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '按网页内容归类' })).not.toBeInTheDocument();
  });
});
