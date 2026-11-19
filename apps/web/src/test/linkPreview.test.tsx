import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createRealApiClient } from '../api/client';
import { LinkPreviewCard } from '../components/LinkPreviewCard';
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

async function loginAsAdmin(user: ReturnType<typeof userEvent.setup>, adapter = createTestAdapter()) {
  const rendered = renderWithAdapter(['/login'], adapter);
  await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
  await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
  return rendered;
}

describe('LinkPreviewCard & T07 link preview flows', () => {
  it('renders queued, succeeded, silent fallback states and ignores unsafe URLs', () => {
    const { rerender } = render(
      <LinkPreviewCard
        originalUrl="https://docs.example.test/guide"
        preview={{ status: 'queued' }}
        variant="card"
      />,
    );
    expect(screen.getByText('正在获取网页信息')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://docs.example.test/guide' }),
    ).toHaveAttribute('target', '_blank');

    rerender(
      <LinkPreviewCard
        originalUrl="https://docs.example.test/guide"
        preview={{
          status: 'succeeded',
          site_name: 'Example Docs',
          source_title: '快速上手指南',
          summary: '两行内展示的网页摘要说明，帮助在卡片里快速回忆。',
        }}
        variant="card"
      />,
    );
    expect(screen.getByText('Example Docs')).toBeInTheDocument();
    const titleLink = screen.getByRole('link', { name: '快速上手指南' });
    expect(titleLink).toHaveAttribute('href', 'https://docs.example.test/guide');
    expect(titleLink).toHaveAttribute('target', '_blank');
    expect(screen.getByText('两行内展示的网页摘要说明，帮助在卡片里快速回忆。')).toBeInTheDocument();

    for (const status of ['failed', 'blocked', 'skipped', 'partial'] as const) {
      rerender(
        <LinkPreviewCard
          originalUrl="https://docs.example.test/guide"
          preview={{ status }}
          variant="card"
        />,
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText(/失败|不可用|被拦截|正在获取/)).not.toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'https://docs.example.test/guide' }),
      ).toBeInTheDocument();
    }

    rerender(<LinkPreviewCard originalUrl="javascript:alert(1)" variant="card" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows link preview states and cover attachment preview in collection list cards', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    await loginAsAdmin(user, adapter);

    const url = 'https://spark-notes.test/articles/1';
    const created = await adapter.createCollection(
      {
        id: '11111111-1111-4111-8111-111111111111',
        document: EMPTY_DOCUMENT,
        original_url: url,
        intent: '后续阅读参考',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'k-create-url-1',
    );

    // Prepare an attachment + cover collection
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cover.png', {
      type: 'image/png',
    });
    const grant = await adapter.createUpload(
      {
        filename: 'cover.png',
        mime_type: 'image/png',
        size_bytes: pngFile.size,
      },
      'k-upload-1',
    );
    await adapter.uploadFileBytes(grant, pngFile);
    await adapter.completeUpload(grant.id);

    const pngFile2 = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'second.png', {
      type: 'image/png',
    });
    const grant2 = await adapter.createUpload(
      {
        filename: 'second.png',
        mime_type: 'image/png',
        size_bytes: pngFile2.size,
      },
      'k-upload-2',
    );
    await adapter.uploadFileBytes(grant2, pngFile2);
    await adapter.completeUpload(grant2.id);

    await adapter.createCollection(
      {
        id: '22222222-2222-4222-8222-222222222222',
        document: EMPTY_DOCUMENT,
        intent: '带封面图片收藏',
        upload_ids: [grant.id, grant2.id],
        project_ids: [],
        tag_ids: [],
      },
      'k-create-img-1',
    );

    adapter.setMockCollectionExtractions(created.id, [
      {
        id: 'ext-succeeded-1',
        content_version: created.content_version,
        source_kind: 'url',
        source_id: url,
        status: 'succeeded',
        site_name: 'Spark Notes',
        source_title: '把碎片想法整理到项目里',
        summary: '列表卡片里的两行摘要预览文本。',
        updated_at: new Date().toISOString(),
      },
    ]);

    await user.click(screen.getByRole('link', { name: '全部收藏' }));
    await screen.findByRole('heading', { name: '全部收藏' });

    expect(await screen.findByText('Spark Notes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '把碎片想法整理到项目里' })).toHaveAttribute(
      'href',
      url,
    );
    expect(screen.getByText('列表卡片里的两行摘要预览文本。')).toBeInTheDocument();

    // Cover attachment + count badge rendered on list card without detail fetch
    expect(screen.getByText('共 2 张')).toBeInTheDocument();
    expect(await screen.findByLabelText('图片附件，共 1 张')).toBeInTheDocument();
  });

  it('matches detail extractions strictly by original_url & content_version and refreshes on demand without polling', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const getExtractionsSpy = vi.spyOn(adapter, 'getExtractions');
    const refreshUrlSpy = vi.spyOn(adapter, 'refreshUrlExtraction');

    await loginAsAdmin(user, adapter);

    const url = 'https://spark-notes.test/articles/detail-1';
    const created = await adapter.createCollection(
      {
        id: '33333333-3333-4333-8333-333333333333',
        document: EMPTY_DOCUMENT,
        original_url: url,
        intent: '技术笔记',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'k-detail-1',
    );

    // Seed stale content_version and wrong source_id extractions, plus current queued extraction
    adapter.setMockCollectionExtractions(created.id, [
      {
        id: 'ext-stale-version',
        content_version: created.content_version + 99,
        source_kind: 'url',
        source_id: url,
        status: 'succeeded',
        site_name: 'Stale Site',
        source_title: '过期版本标题不应出现',
        summary: '过期版本摘要',
        updated_at: new Date().toISOString(),
      },
      {
        id: 'ext-wrong-kind',
        content_version: created.content_version,
        source_kind: 'image',
        source_id: url,
        status: 'succeeded',
        source_title: '图片提取不应混入',
        updated_at: new Date().toISOString(),
      },
      {
        id: 'ext-current-queued',
        content_version: created.content_version,
        source_kind: 'url',
        source_id: url,
        status: 'queued',
        updated_at: new Date().toISOString(),
      },
    ]);

    await user.click(screen.getByRole('link', { name: '全部收藏' }));
    const openLinks = await screen.findAllByRole('link', { name: '查看全文' });
    await user.click(openLinks[0]);

    expect(await screen.findByText('正在获取网页信息')).toBeInTheDocument();
    expect(screen.queryByText('过期版本标题不应出现')).not.toBeInTheDocument();
    expect(screen.queryByText('图片提取不应混入')).not.toBeInTheDocument();

    const callsAfterLoad = getExtractionsSpy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(getExtractionsSpy.mock.calls.length).toBe(callsAfterLoad);

    // Worker completes in backend -> user clicks on-demand "刷新状态"
    adapter.setMockCollectionExtractions(created.id, [
      {
        id: 'ext-current-failed',
        content_version: created.content_version,
        source_kind: 'url',
        source_id: url,
        status: 'failed',
        updated_at: new Date().toISOString(),
      },
    ]);

    await user.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => {
      expect(screen.queryByText('正在获取网页信息')).not.toBeInTheDocument();
    });
    // Failed background fetch shows silent fallback URL without error alert
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: url })).toBeInTheDocument();

    // Explicit manual refresh returns 503 when disabled -> shows user-friendly alert
    adapter.setMockUrlExtractionBehavior({ unconfigured: true });
    await user.click(screen.getByRole('button', { name: '重新获取' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前平台尚未开启网页抓取功能');

    // Re-enable and refresh successfully
    adapter.setMockUrlExtractionBehavior({
      unconfigured: false,
      status: 'succeeded',
      siteName: 'Spark Docs',
      sourceTitle: '刷新后的网页标题',
      summary: '重新获取得到的摘要内容。',
    });
    await user.click(screen.getByRole('button', { name: '重新获取' }));

    expect(await screen.findByText('Spark Docs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '刷新后的网页标题' })).toHaveAttribute('href', url);
    expect(screen.getByText('重新获取得到的摘要内容。')).toBeInTheDocument();
    expect(refreshUrlSpy).toHaveBeenCalledTimes(2);
    expect(refreshUrlSpy.mock.calls[0]?.[1]).toBe(refreshUrlSpy.mock.calls[1]?.[1]);

    // Subsequent manual refresh after 202 uses a fresh Idempotency-Key
    adapter.setMockUrlExtractionBehavior({
      unconfigured: false,
      status: 'succeeded',
      siteName: 'Spark Docs V2',
      sourceTitle: '第二次刷新标题',
      summary: '第二次刷新摘要。',
    });
    await user.click(screen.getByRole('button', { name: '重新获取' }));
    expect(await screen.findByRole('link', { name: '第二次刷新标题' })).toBeInTheDocument();
    expect(refreshUrlSpy).toHaveBeenCalledTimes(3);
    expect(refreshUrlSpy.mock.calls[2]?.[1]).not.toBe(refreshUrlSpy.mock.calls[1]?.[1]);
  });

  it('sends POST /collections/{id}/extractions with CSRF, Idempotency-Key and empty body in real API client', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: {
              id: 'u1',
              email: 'u1@example.com',
              role: 'user',
              status: 'active',
              ai_enabled: false,
              ai_policy_version: 1,
            },
            csrf_token: 'csrf-test-token',
            expires_at: '2030-01-01T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const api = createRealApiClient();
      await api.login({ email: 'u1@example.com', password: 'password123456' });

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'ext-1',
            source_kind: 'url',
            source_id: 'https://example.com',
            content_version: 1,
            status: 'queued',
            updated_at: '2026-11-19T00:00:00Z',
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await api.refreshUrlExtraction('col-123', 'idem-url-1');
      expect(result.status).toBe('queued');
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('/api/v1/collections/col-123/extractions');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get('X-CSRF-Token')).toBe('csrf-test-token');
      expect(headers.get('Idempotency-Key')).toBe('idem-url-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
