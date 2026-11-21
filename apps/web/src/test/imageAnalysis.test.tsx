import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createRealApiClient } from '../api/client';
import { EMPTY_DOCUMENT } from '../lib/document';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

beforeAll(() => {
  if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () =>
      ({
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () {},
      }) as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  }
  if (typeof document !== 'undefined' && !document.elementFromPoint) {
    document.elementFromPoint = () => null;
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderWithAdapter(
  initialEntries: string[] = ['/inbox'],
  adapter: TestAdapter = createTestAdapter(),
) {
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

async function loginAsAdmin(
  user: ReturnType<typeof userEvent.setup>,
  initialEntries: string[] = ['/login'],
  adapter = createTestAdapter(),
) {
  const rendered = renderWithAdapter(initialEntries, adapter);
  await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
  await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
  return rendered;
}

async function createImageAttachmentCollection(
  adapter: TestAdapter,
  opts: { filename?: string; text?: string; aiExcluded?: boolean } = {},
) {
  const filename = opts.filename ?? 'whiteboard.png';
  const upload = await adapter.createUpload(
    {
      filename,
      mime_type: 'image/png',
      size_bytes: 128,
    },
    `up-${Math.random()}`,
  );
  await adapter.uploadFileBytes(upload, new File(['png-bytes'], filename, { type: 'image/png' }));
  await adapter.completeUpload(upload.id);
  return adapter.createCollection(
    {
      id: crypto.randomUUID(),
      document: opts.text
        ? {
            schema_version: 1,
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: opts.text }] }],
            },
          }
        : EMPTY_DOCUMENT,
      intent: '',
      upload_ids: [upload.id],
      project_ids: [],
      tag_ids: [],
      ai_excluded: opts.aiExcluded,
    },
    `col-${Math.random()}`,
  );
}

describe('T05 image analysis consent, detail view and search snippets', () => {
  it('calls GET/PUT /me/image-analysis with CSRF token on realApiClient', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = createRealApiClient();
    client.setCsrfToken('csrf-img-token');

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          enabled: false,
          available: true,
          required_consent_version: 'deepseek-images-v1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const initial = await client.getImageAnalysisPreferences();
    expect(initial).toEqual({
      enabled: false,
      available: true,
      required_consent_version: 'deepseek-images-v1',
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          enabled: true,
          available: true,
          required_consent_version: 'deepseek-images-v1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const updated = await client.setImageAnalysisPreferences({
      enabled: true,
      consent_version: 'deepseek-images-v1',
    });
    expect(updated.enabled).toBe(true);

    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('/api/v1/me/image-analysis');
    expect(putInit.method).toBe('PUT');
    expect(putInit.headers).toMatchObject({
      'X-CSRF-Token': 'csrf-img-token',
    });
    expect(JSON.parse(String(putInit.body))).toEqual({
      enabled: true,
      consent_version: 'deepseek-images-v1',
    });
  });

  it('keeps text AI consent separate from image consent and requires explicit DeepSeek confirmation', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await loginAsAdmin(user, ['/login'], adapter);
    await adapter.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-v1' });

    cleanup();
    renderWithAdapter(['/settings'], adapter);
    const imageCard = await screen.findByRole('region', { name: '图片理解（DeepSeek）' });
    await screen.findByRole('button', { name: '开启图片理解' });
    expect(imageCard).toHaveTextContent('未开启');
    expect(imageCard).toHaveTextContent('不会自动视为同意图片理解');

    await user.click(screen.getByRole('button', { name: '开启图片理解' }));
    const dialog = await screen.findByRole('dialog', { name: '开启图片理解（DeepSeek）' });
    expect(dialog).toHaveTextContent('DeepSeek');
    expect(dialog).toHaveTextContent('无需你填写 API Key');

    await user.click(screen.getByRole('button', { name: '我已了解并开启' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(
      await screen.findByRole('button', { name: '关闭图片理解' }),
    ).toBeInTheDocument();
    expect(await adapter.getImageAnalysisPreferences()).toMatchObject({
      enabled: true,
      required_consent_version: 'deepseek-images-v1',
    });

    await user.click(screen.getByRole('button', { name: '关闭图片理解' }));
    expect(await screen.findByRole('button', { name: '开启图片理解' })).toBeInTheDocument();
    expect(await adapter.getImageAnalysisPreferences()).toMatchObject({ enabled: false });
  });

  it('lets the user revoke consent while the service is paused', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await loginAsAdmin(user, ['/login'], adapter);
    cleanup();
    const paused = { enabled: true, available: false, required_consent_version: 'deepseek-images-v1' };
    vi.spyOn(adapter, 'getImageAnalysisPreferences').mockResolvedValue(paused);
    const write = vi.spyOn(adapter, 'setImageAnalysisPreferences').mockResolvedValue({ ...paused, enabled: false });
    renderWithAdapter(['/settings'], adapter);
    await user.click(await screen.findByRole('button', { name: '关闭图片理解' }));
    expect(write).toHaveBeenCalledExactlyOnceWith({ enabled: false });
    await waitFor(() => expect(screen.queryByRole('button', { name: '关闭图片理解' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '开启图片理解' })).not.toBeInTheDocument();
  });

  it('requires a matching disclosure before offering image consent', async () => {
    const adapter = createTestAdapter();
    await loginAsAdmin(userEvent.setup(), ['/login'], adapter);
    cleanup();
    vi.spyOn(adapter, 'getImageAnalysisPreferences').mockResolvedValue({
      enabled: false, available: true, required_consent_version: 'deepseek-images-v2',
    });
    const write = vi.spyOn(adapter, 'setImageAnalysisPreferences');
    renderWithAdapter(['/settings'], adapter);
    expect(await screen.findByText(/图片授权说明已更新/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开启图片理解' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it('renders per-attachment OCR text, visual description, truncation warning, and never polls periodically', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const getExtractionsSpy = vi.spyOn(adapter, 'getExtractions');

    await loginAsAdmin(user, ['/login'], adapter);
    await adapter.setImageAnalysisPreferences({
      enabled: true,
      consent_version: 'deepseek-images-v1',
    });

    adapter.setMockImageAnalysisBehavior({
      status: 'partial',
      text: '发票编号 INV-9527',
      imageDescription: '白色桌面上的产品手绘图',
      truncated: true,
    });
    const col = await createImageAttachmentCollection(adapter, { filename: 'sketch.png' });
    const attId = col.attachments[0].id;

    // Navigate directly to collection detail through fresh router for deterministic route
    cleanup();
    renderWithAdapter([`/collections/${col.id}`], adapter);

    expect(await screen.findByText('发票编号 INV-9527')).toBeInTheDocument();
    expect(screen.getByText('图中文字')).toBeInTheDocument();
    expect(screen.getByText('AI 画面描述')).toBeInTheDocument();
    expect(screen.getByText('白色桌面上的产品手绘图')).toBeInTheDocument();
    expect(screen.getByText('输出已截断，结果可能不完整')).toBeInTheDocument();

    // Update attachment state to queued and verify no periodic polling happens
    adapter.setMockCollectionExtractions(col.id, [
      {
        id: crypto.randomUUID(),
        source_kind: 'image',
        source_id: attId,
        content_version: col.content_version,
        status: 'queued',
        updated_at: new Date().toISOString(),
      },
    ]);

    const refreshButtons = screen.getAllByRole('button', { name: '刷新状态' });
    await user.click(refreshButtons[refreshButtons.length - 1]);
    expect(await screen.findByText('正在分析图片')).toBeInTheDocument();

    const callsAfterManualRefresh = getExtractionsSpy.mock.calls.length;
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    vi.useRealTimers();
    expect(getExtractionsSpy.mock.calls.length).toBe(callsAfterManualRefresh);
  });

  it('keeps original images viewable when consent is withdrawn, item is ai_excluded, or daily quota is blocked', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await loginAsAdmin(user, ['/login'], adapter);
    await adapter.setImageAnalysisPreferences({
      enabled: true,
      consent_version: 'deepseek-images-v1',
    });

    adapter.setMockImageAnalysisBehavior({ quotaExceeded: true });
    const blockedCol = await createImageAttachmentCollection(adapter, { filename: 'quota-img.png' });

    await adapter.setImageAnalysisPreferences({ enabled: false });
    const excludedCol = await createImageAttachmentCollection(adapter, {
      filename: 'private-img.png',
      aiExcluded: true,
    });

    // Check blocked collection still renders original image zoom trigger & quota pause message
    cleanup();
    renderWithAdapter([`/collections/${blockedCol.id}`], adapter);
    expect(await screen.findByText('今日 AI 额度已暂停')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /放大查看图片 quota-img\.png/i }),
    ).toBeInTheDocument();

    // Check excluded collection without consent still renders original image zoom trigger
    cleanup();
    renderWithAdapter([`/collections/${excludedCol.id}`], adapter);
    expect(
      await screen.findByText(/已设为不参与 AI 整理与图片理解；原图已完整保存/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /放大查看图片 private-img\.png/i }),
    ).toBeInTheDocument();
  });

  it('displays distinct image_text and image_description labels in search result snippets', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await loginAsAdmin(user, ['/login'], adapter);
    await adapter.setImageAnalysisPreferences({
      enabled: true,
      consent_version: 'deepseek-images-v1',
    });

    adapter.setMockImageAnalysisBehavior({
      status: 'succeeded',
      text: '关键印章 SparkVisionToken',
      imageDescription: '包含 SparkVisionToken 架构流程图的白板照片',
    });
    await createImageAttachmentCollection(adapter, { filename: 'arch.png' });

    await user.click(screen.getByRole('link', { name: '全部收藏' }));
    const searchInput = await screen.findByRole('searchbox');
    await user.type(searchInput, 'SparkVisionToken');

    await waitFor(
      () => {
        expect(screen.getByText('图中文字')).toBeInTheDocument();
        expect(screen.getByText('AI 画面描述')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('exposes per-item AI exclusion in composer when only image analysis is enabled and handles available=false', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await loginAsAdmin(user, ['/login'], adapter);
    await adapter.setImageAnalysisPreferences({
      enabled: true,
      consent_version: 'deepseek-images-v1',
    });
    cleanup();
    renderWithAdapter(['/inbox'], adapter);

    await user.click(await screen.findByRole('button', { name: '更多' }));
    expect(await screen.findByRole('menuitemcheckbox', { name: '本条不参与 AI 整理' })).toBeInTheDocument();

    adapter.setMockImageAnalysisBehavior({ available: false });
    cleanup();
    renderWithAdapter(['/settings'], adapter);
    expect(await screen.findByText(/当前账号暂未开放图片理解/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开启图片理解' })).not.toBeInTheDocument();
  });
});
