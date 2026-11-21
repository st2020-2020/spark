import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createRealApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import type { Collection, Extraction, Organization } from '../api/types';
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

  it('requires the new text disclosure before reusing a historical image and never resubmits the image', async () => {
    const ui = userEvent.setup();
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    api.setMockImageAnalysisBehavior({ status: 'succeeded', text: '网格间隔 24', imageDescription: '蓝色方格' });
    const col = await createImageAttachmentCollection(api, { text: '随手一记', filename: '网格.png' });
    const read = await api.setReadState(col.id, { read: true });
    await api.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-tags-v1' });
    const snapshot: Collection = { ...read, organization: { ...read.organization, status: 'succeeded',
      error_code: undefined, image_material_status: 'consent_required' } };
    vi.spyOn(api, 'getCollection').mockImplementation(async () => structuredClone(snapshot));
    const restart = vi.spyOn(api, 'restartOrganization')
      .mockRejectedValueOnce(new ApiError({ status: 403, code: 'image_material_consent_required', message: '授权已过期' }))
      .mockImplementation(async () => {
        snapshot.organization = { ...snapshot.organization, status: 'queued', image_material_status: undefined };
        return snapshot.organization;
      });
    const upload = vi.spyOn(api, 'createUpload');
    const imageWrite = vi.spyOn(api, 'setImageAnalysisPreferences');
    const write = vi.spyOn(api, 'updatePreferences');
    renderWithAdapter(['/collections/' + col.id], api);
    await screen.findByText('上次整理缺少使用图片识别结果的授权。');
    await screen.findByRole('button', { name: '授权使用图片识别结果' });
    await ui.click(screen.getByRole('button', { name: '重新整理' }));
    const dialog = await screen.findByRole('dialog', { name: '更新文字整理授权' });
    expect(dialog).toHaveTextContent('第三方文字模型');
    expect(dialog).toHaveTextContent('新建主题项目');
    expect(dialog).toHaveTextContent('图中文字和 AI 画面描述');
    await ui.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(write).not.toHaveBeenCalled();
    await ui.click(screen.getByRole('button', { name: '授权使用图片识别结果' }));
    await ui.click(screen.getByRole('button', { name: '确认更新授权' }));
    await screen.findByText(/重新整理会检查已有识别结果/);
    expect(write).toHaveBeenCalledExactlyOnceWith({ ai_enabled: true, consent_version: 'spark-ai-image-notes-v1' });
    expect(restart).toHaveBeenCalledTimes(1);
    await ui.click(screen.getByRole('button', { name: '重新整理' }));
    await screen.findByText('整理排队中');
    expect(restart).toHaveBeenCalledTimes(2);
    expect(upload).not.toHaveBeenCalled();
    expect(imageWrite).not.toHaveBeenCalled();
  });

  it('refreshes recognition and project matching separately on SSE and labels exact attachment quotes', async () => {
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    const col = await createImageAttachmentCollection(api, { text: '周三白板', filename: '网格.png' });
    const read = await api.setReadState(col.id, { read: true });
    await api.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-image-material-v1' });
    const attachment = col.attachments[0].id;
    const extraction = { id: crypto.randomUUID(), source_kind: 'image' as const, source_id: attachment,
      content_version: col.content_version, updated_at: new Date().toISOString() };
    api.setMockCollectionExtractions(col.id, [{ ...extraction, status: 'queued' }]);
    const waiting: Organization = { ...col.organization, status: 'queued', error_code: undefined,
      image_material_status: 'waiting', stages: [{ name: 'extract_images', status: 'queued', attempts: 0 }] };
    const snapshot: Collection = { ...read, organization: waiting };
    vi.spyOn(api, 'getCollection').mockImplementation(async () => structuredClone(snapshot));
    const event = () => act(() => api.emitMockOrganizationEvent({ collection_id: col.id,
      status: snapshot.organization.status, has_suggestion: Boolean(snapshot.has_suggestion) }));
    renderWithAdapter(['/collections/' + col.id], api);
    await screen.findByText('等待图片识别');
    expect(screen.queryByText(/暂无匹配的项目建议/)).toBeNull();
    api.setMockCollectionExtractions(col.id, [{ ...extraction, status: 'succeeded', text: '网格间隔 24', image_description: '蓝色方格' }]);
    snapshot.organization = { ...waiting, status: 'running', image_material_status: undefined, stages: [] };
    event();
    await screen.findByText('网格间隔 24');
    await screen.findByText('正在整理');
    expect(screen.queryByText('本次整理使用了图片识别结果。')).toBeNull();
    snapshot.organization = { ...snapshot.organization, status: 'succeeded', image_material_status: 'included' };
    snapshot.has_suggestion = true;
    snapshot.projects = [{ project_id: crypto.randomUUID(), name: '网格研究', decision: 'suggested',
      evidence: [{ source_id: 'image_text:' + attachment, quote: '间隔 24' },
                 { source_id: 'image_description:' + attachment, quote: '蓝色方格' }] }];
    event();
    await screen.findByText('本次整理使用了图片识别结果。');
    const evidence = within(await screen.findByRole('list', { name: '推荐依据摘录' }));
    expect(evidence.getByText('图中文字 · 网格.png')).toBeVisible();
    expect(evidence.getByText('AI 画面描述 · 网格.png')).toBeVisible();
    expect(evidence.getByText('间隔 24')).toBeVisible();
    expect(evidence.getByText('蓝色方格')).toBeVisible();
    snapshot.projects = [];
    snapshot.has_suggestion = false;
    event();
    await screen.findByText(/暂无匹配的项目建议/);
    expect(screen.queryByRole('list', { name: '推荐依据摘录' })).toBeNull();
  });

  it('edits the saved image paragraph, preserves conflicting input and respects removal on reload', async () => {
    const ui = userEvent.setup(), api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    api.setMockImageAnalysisBehavior({ status: 'partial', truncated: true, text: '图号 42', imageDescription: '蓝色灯' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    const col = await createImageAttachmentCollection(api, { text: '我的原文' });
    const snapshot = await api.setReadState(col.id, { read: true });
    const note = { attachment_id: col.attachments[0].id, version: 1, state: 'generated' as const, text: '蓝色灯' };
    snapshot.image_notes = [note];
    vi.spyOn(api, 'getCollection').mockImplementation(async () => structuredClone(snapshot));
    const write = vi.spyOn(api, 'updateImageNote').mockImplementation(async (_id, body) => {
      if (body.base_version === 1) {
        snapshot.image_notes = [{ ...note, text: '另一端的说明', version: 2 }];
        throw new ApiError({ status: 409, code: 'image_note_conflict', message: '说明已更新' });
      }
      snapshot.image_notes = body.text.trim() ? [{ ...note, version: body.base_version + 1, state: 'edited', text: body.text }] : [];
      return structuredClone(snapshot);
    });
    const retry = vi.spyOn(api, 'retryImageAnalysis');
    const path = ['/collections/' + col.id];
    renderWithAdapter(path, api);
    await screen.findByText('图号 42');
    expect(screen.getAllByText('蓝色灯')).toHaveLength(1);
    await ui.click(screen.getByRole('button', { name: '编辑图片说明' }));
    const editor = screen.getByRole('textbox', { name: '图片说明' });
    await ui.clear(editor);
    await ui.type(editor, '手写说明');
    await ui.click(screen.getByRole('button', { name: '保存说明' }));
    await ui.click(await screen.findByRole('button', { name: '保留输入，基于最新版编辑' }));
    expect(editor).toHaveValue('手写说明');
    await ui.click(screen.getByRole('button', { name: '保存说明' }));
    await screen.findByText('手写说明');
    expect(screen.queryByText('蓝色灯')).toBeNull();
    await ui.click(screen.getByRole('button', { name: '编辑图片说明' }));
    await ui.clear(screen.getByRole('textbox', { name: '图片说明' }));
    await ui.click(screen.getByRole('button', { name: '删除说明' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    cleanup();
    renderWithAdapter(path, api);
    await screen.findByText('图号 42');
    expect(screen.getByText('我的原文')).toBeVisible();
    expect(screen.queryByText('蓝色灯')).toBeNull();
    expect(screen.queryByText('手写说明')).toBeNull();
    expect(write.mock.calls.map(args => args[1].base_version)).toEqual([1, 2, 3]);
    expect(retry).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'partial', truncated: true, text: '  ', label: '暂无图片摘录', note: '本次没有可展示的识别摘录' },
    { status: 'failed', truncated: false, text: '', error_code: 'image_output_truncated_empty',
      label: '暂无图片摘录', note: '本次没有可展示的识别摘录' },
    { status: 'succeeded', truncated: false, text: '', label: '识别完成', note: '未提取到文字或画面描述' },
    { status: 'failed', truncated: false, text: '', label: '识别失败', note: '原图' },
  ] as const)('distinguishes empty image output for $status without conflicting labels', async row => {
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const col = await createImageAttachmentCollection(api);
    api.setMockCollectionExtractions(col.id, [{ id: crypto.randomUUID(), source_kind: 'image',
      source_id: col.attachments[0].id, content_version: 1, updated_at: new Date().toISOString(),
      status: row.status, truncated: row.truncated, text: row.text,
      error_code: 'error_code' in row ? row.error_code : undefined }]);
    renderWithAdapter(['/collections/' + col.id], api);
    const panel = within(await screen.findByLabelText('图片理解结果'));
    expect(await panel.findByText(row.label)).toBeVisible();
    expect(panel.getByText(new RegExp(row.note))).toBeVisible();
    expect(panel.queryByText('部分识别')).toBeNull();
    expect(panel.queryByText(/图片中未识别出有效文字/)).toBeNull();
  });

  it.each(['truncated', 'settled legacy format failure'])('only submits a confirmed recovery for %s, replays a lost response and follows SSE', async reason => {
    const ui = userEvent.setup();
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    const col = await createImageAttachmentCollection(api, { filename: '合成蓝图.png' });
    const old: Extraction = { id: crypto.randomUUID(), source_id: col.attachments[0].id, source_kind: 'image',
      ...(reason === 'truncated' ? { status: 'partial' as const, truncated: true } :
        { status: 'failed' as const, error_code: 'invalid_model_output' }),
      image_retry_available: true, content_version: 1, updated_at: new Date().toISOString() };
    api.setMockCollectionExtractions(col.id, [old]);
    let accept!: () => void;
    const recover = api.retryImageAnalysis.bind(api);
    const retry = vi.spyOn(api, 'retryImageAnalysis')
      .mockImplementationOnce(async (...args) => {
        await recover(...args);
        throw new ApiError({ status: 0, code: 'network_error', message: '网络中断' });
      })
      .mockImplementationOnce(async (...args) => {
        await new Promise<void>(resolve => { accept = resolve; });
        return recover(...args);
      });
    const organize = vi.spyOn(api, 'restartOrganization');
    const imageConsent = vi.spyOn(api, 'setImageAnalysisPreferences');
    renderWithAdapter(['/collections/' + col.id], api);
    const panel = within(await screen.findByLabelText('图片理解结果'));
    await panel.findByRole('button', { name: '重新识别这张图片' });
    await ui.click(panel.getByRole('button', { name: '刷新状态' }));
    await ui.click(panel.getByRole('button', { name: '重新识别这张图片' }));
    const dialog = within(screen.getByRole('dialog', { name: '重新识别这张图片' }));
    expect(dialog.getByText(/DeepSeek/)).toHaveTextContent('合成蓝图.png');
    expect(dialog.getByText(/额度/)).toBeVisible();
    if (reason !== 'truncated') expect(dialog.getByText(/已结算/)).toHaveTextContent('再次使用');
    await ui.click(dialog.getByRole('button', { name: '取消' }));
    expect(retry).not.toHaveBeenCalled();

    for (let i = 0; i < 2; i++) {
      await ui.click(panel.getByRole('button', { name: '重新识别这张图片' }));
      await ui.dblClick(within(screen.getByRole('dialog')).getByRole('button', { name: '确认重新识别' }));
      if (i === 0) await panel.findByRole('alert');
    }
    expect(retry).toHaveBeenCalledTimes(2);
    expect(retry.mock.calls[0]).toEqual([old.source_id, {
      base_extraction_id: old.id, consent_version: 'deepseek-image-retry-v1',
    }, expect.any(String)]);
    expect(retry.mock.calls[1]).toEqual(retry.mock.calls[0]);
    expect(panel.getByRole('button', { name: '正在提交…' })).toBeDisabled();
    const { items: [queued] } = await api.getExtractions(col.id);
    expect(queued.status).toBe('queued');
    expect(queued.id).not.toBe(old.id);
    await act(async () => accept());
    await panel.findByText('正在分析图片');
    expect(panel.queryByRole('button', { name: '重新识别这张图片' })).toBeNull();
    const output = reason === 'truncated' ? { text: '标高 32' } : { image_description: '合成蓝图的测量标记' };
    api.setMockCollectionExtractions(col.id, [{ ...queued, status: 'succeeded', ...output }]);
    act(() => api.emitMockOrganizationEvent({ collection_id: col.id, status: col.organization.status, has_suggestion: false }));
    const singleResult = reason === 'truncated' ? '标高 32' : '合成蓝图的测量标记';
    await panel.findByText(singleResult);
    expect(panel.queryByText(reason === 'truncated' ? 'AI 画面描述' : '图中文字')).toBeNull();
    cleanup();
    renderWithAdapter(['/collections/' + col.id], api);
    const reloaded = within(await screen.findByLabelText('图片理解结果'));
    await reloaded.findByText(singleResult);
    expect(reloaded.queryByRole('button', { name: '重新识别这张图片' })).toBeNull();
    expect(retry).toHaveBeenCalledTimes(2);
    expect(organize).not.toHaveBeenCalled();
    expect(imageConsent).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_model_output', '无法解析'],
    ['image_provider_empty_output', '返回了空内容'],
    ['image_provider_content_filtered', '内容过滤'],
    ['image_provider_interrupted', '生成中断'],
    ['image_response_read_failed', '读取'],
    ['image_response_invalid', '响应格式'],
    ['image_provider_choice_invalid', '结果结构'],
    ['image_provider_content_invalid', '识别内容格式有误'],
    ['image_provider_finish_invalid', '结束状态'],
    ['usage_uncertain', '用量待核对'],
    ['unknown_future_code', '原图'],
  ])('explains %s without offering an unverified paid action', async (code, message) => {
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    const col = await createImageAttachmentCollection(api);
    api.setMockCollectionExtractions(col.id, [{ id: crypto.randomUUID(), source_id: col.attachments[0].id,
      source_kind: 'image', status: 'failed', error_code: code, content_version: 1, updated_at: new Date().toISOString(),
      image_retry_available: code !== 'invalid_model_output',
      text: code === 'image_provider_content_filtered' ? '未通过校验的合成片段' : undefined }]);
    renderWithAdapter(['/collections/' + col.id], api);
    const panel = within(await screen.findByLabelText('图片理解结果'));
    await panel.findByText('识别失败');
    expect(panel.getByText(new RegExp(message))).toBeVisible();
    expect(screen.queryByText(/未通过校验的合成片段/)).toBeNull();
    expect(panel.queryByRole('button', { name: '重新识别这张图片' })).toBeNull();
  });

  it('requeues only an undispatched quota-blocked recovery with a fresh intent key and its current ID', async () => {
    const ui = userEvent.setup();
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    api.setMockImageAnalysisBehavior({ status: 'failed', errorCode: 'image_output_truncated_empty' });
    const col = await createImageAttachmentCollection(api);
    const [original] = (await api.getExtractions(col.id)).items;
    const recover = api.retryImageAnalysis.bind(api);
    const calls = vi.spyOn(api, 'retryImageAnalysis');
    renderWithAdapter(['/collections/' + col.id], api);
    const panel = within(await screen.findByLabelText('图片理解结果'));
    const confirm = async (name: string) => {
      await ui.click(await panel.findByRole('button', { name }));
      await ui.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认重新识别' }));
    };
    await confirm('重新识别这张图片');
    await panel.findByText('正在分析图片');
    const [job] = (await api.getExtractions(col.id)).items;
    expect(job.id).not.toBe(original.id);
    const block = async (code: string, available: boolean) => {
      api.setMockCollectionExtractions(col.id, [{ ...job, status: 'blocked', error_code: code,
        image_retry_available: available, updated_at: new Date().toISOString() }]);
      await ui.click(panel.getByRole('button', { name: '刷新状态' }));
      await panel.findByText(code === 'quota_exceeded' ? '今日 AI 额度已暂停' : '暂未执行');
    };
    await block('quota_exceeded', false);
    expect(panel.queryByRole('button', { name: '重新排队' })).toBeNull();
    await block('usage_uncertain', true);
    expect(panel.queryByRole('button', { name: '重新排队' })).toBeNull();
    await block('quota_exceeded', true);
    expect(calls).toHaveBeenCalledTimes(1);

    api.setMockImageAnalysisBehavior({ quotaExceeded: true });
    await confirm('重新排队');
    expect(await panel.findByRole('alert')).toHaveTextContent('额度不足');
    api.setMockImageAnalysisBehavior({ quotaExceeded: false });
    calls.mockImplementationOnce(async (...args) => {
      await recover(...args);
      throw new ApiError({ status: 0, code: 'network_error', message: '响应丢失' });
    });
    await confirm('重新排队');
    expect(await panel.findByRole('alert')).toHaveTextContent('尚未确认提交结果');
    await confirm('重新排队');
    await panel.findByText('正在分析图片');
    expect(calls).toHaveBeenCalledTimes(4);
    const [first, refused, lost, replay] = calls.mock.calls;
    expect(first[1].base_extraction_id).toBe(original.id);
    expect(refused[1].base_extraction_id).toBe(job.id);
    expect(lost[1].base_extraction_id).toBe(job.id);
    expect(new Set([first[2], refused[2], lost[2]]).size).toBe(3);
    expect(replay).toEqual(lost);
    expect((await api.getExtractions(col.id)).items).toEqual([expect.objectContaining({ id: job.id, status: 'queued' })]);
    await block('quota_exceeded', true);
    await confirm('重新排队');
    await panel.findByText('正在分析图片');
    expect(calls.mock.calls[4][2]).not.toBe(replay[2]);
    expect((await api.getExtractions(col.id)).items[0].id).toBe(job.id);
  });

  it('reports quota refusal without hiding the original or starting a recovery on refresh', async () => {
    const ui = userEvent.setup();
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
    api.setMockImageAnalysisBehavior({ status: 'failed', errorCode: 'image_output_truncated_empty' });
    const col = await createImageAttachmentCollection(api);
    api.setMockImageAnalysisBehavior({ quotaExceeded: true });
    const retry = vi.spyOn(api, 'retryImageAnalysis');
    renderWithAdapter(['/collections/' + col.id], api);
    const panel = within(await screen.findByLabelText('图片理解结果'));
    await ui.click(await panel.findByRole('button', { name: '重新识别这张图片' }));
    await ui.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认重新识别' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('额度不足');
    await ui.click(panel.getByRole('button', { name: '刷新状态' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(panel.getByText('暂无图片摘录')).toBeVisible();
    expect(screen.getByRole('button', { name: /放大查看图片 whiteboard/ })).toBeVisible();
  });

  it.each(['no image consent', 'excluded', 'unavailable', 'field absent', 'contains excerpt', 'already running'])(
    'withholds the recovery action for %s', async reason => {
      const api = createTestAdapter();
      await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
      await api.updatePreferences({ ai_enabled: true, consent_version: 'spark-ai-image-material-v1' });
      if (reason !== 'no image consent') {
        await api.setImageAnalysisPreferences({ enabled: true, consent_version: 'deepseek-images-v1' });
      }
      api.setMockImageAnalysisBehavior({ available: reason !== 'unavailable' });
      const col = await createImageAttachmentCollection(api, { aiExcluded: reason === 'excluded' });
      api.setMockCollectionExtractions(col.id, [{ id: crypto.randomUUID(), source_kind: 'image',
        source_id: col.attachments[0].id, content_version: 1, updated_at: new Date().toISOString(),
        status: reason === 'already running' ? 'running' : 'partial', truncated: true,
        image_retry_available: reason === 'field absent' ? undefined : true,
        text: reason === 'contains excerpt' ? '合成摘录' : undefined }]);
      const retry = vi.spyOn(api, 'retryImageAnalysis');
      renderWithAdapter(['/collections/' + col.id], api);
      const panel = within(await screen.findByLabelText('图片理解结果'));
      await panel.findByText(col.attachments[0].filename);
      if (reason === 'no image consent') expect(await panel.findByRole('link', { name: '前往设置开启图片理解' })).toBeVisible();
      expect(panel.queryByRole('button', { name: '重新识别这张图片' })).toBeNull();
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('posts the selected base extraction and confirmation to the attachment retry endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'queued' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createRealApiClient();
    api.setCsrfToken('synthetic-csrf');
    const body = { base_extraction_id: crypto.randomUUID(), consent_version: 'deepseek-image-retry-v1' } as const;
    const attachment = crypto.randomUUID();
    const key = crypto.randomUUID();
    expect(await api.retryImageAnalysis(attachment, body, key)).toMatchObject({ status: 'queued' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/v1/attachments/' + attachment + '/image-analysis/retry',
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify(body),
        headers: expect.objectContaining({ 'X-CSRF-Token': 'synthetic-csrf', 'Idempotency-Key': key }) }));
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
    expect(screen.getByText('图片摘录')).toBeInTheDocument();

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
