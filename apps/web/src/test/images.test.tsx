import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { EMPTY_DOCUMENT } from '../lib/document';
import { createTestAdapter, type TestAdapter } from '../test-adapter/mockServer';

beforeAll(() => {
  // jsdom omits Range/Document geometry APIs used by ProseMirror on click & text input.
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

function renderWithAdapter(initialEntries: string[] = ['/inbox'], adapter: TestAdapter = createTestAdapter()) {
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

function makeImageFile(name: string, type = 'image/png', sizeBytes = 64): File {
  const bytes = new Uint8Array(Math.min(sizeBytes, 256));
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  const file = new File([bytes], name, { type });
  if (sizeBytes !== bytes.byteLength) {
    Object.defineProperty(file, 'size', { value: sizeBytes });
  }
  return file;
}

async function loginAsAdmin(user: ReturnType<typeof userEvent.setup>, adapter = createTestAdapter()) {
  const rendered = renderWithAdapter(['/login'], adapter);
  await user.type(await screen.findByLabelText('邮箱'), 'admin@spark.local');
  await user.type(screen.getByLabelText('密码'), 'SparkAdmin1234!');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await screen.findByRole('heading', { name: '收件箱' });
  return rendered;
}

async function waitForUploadReady(filename: string) {
  await screen.findByText(filename);
  await waitFor(() => {
    const card = screen.getByText(filename).closest('.sp-upload-card');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText(/已就绪/)).toBeInTheDocument();
  });
}

describe('v0.3-T04 multi-image upload & presentation', () => {
  it('recovers an image-only quick capture after closing and reloading, and saves without another PUT', async () => {
    const user = userEvent.setup();
    const api = createTestAdapter();
    const { user: account } = await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const put = vi.spyOn(api, 'uploadFileBytes');
    const get = vi.spyOn(api, 'getUpload');
    const create = vi.spyOn(api, 'createCollection');
    const mounted = renderWithAdapter(['/projects'], api);
    const open = async () => {
      await user.click((await screen.findAllByRole('button', { name: '记一条' }))[0]);
      return within(await screen.findByRole('dialog', { name: '记一条' }));
    };
    let sheet = await open();
    await user.upload(sheet.getByLabelText('选择图片文件'), makeImageFile('纸本.png'));
    await waitForUploadReady('纸本.png');
    await user.click(sheet.getByRole('button', { name: '关闭弹窗' }));
    const key = `spark:draft:v1:${account.id}:inbox`;
    const images = JSON.parse(localStorage.getItem(key)!).images;
    expect(images).toEqual([{ uploadId: expect.any(String), name: '纸本.png', size: 64 }]);
    mounted.unmount();
    renderWithAdapter(['/projects'], api);
    sheet = await open();
    await waitForUploadReady('纸本.png');
    expect(get).toHaveBeenCalledWith(images[0].uploadId);
    await user.click(sheet.getByRole('button', { name: '保存收藏' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '记一条' })).toBeNull());
    expect(create.mock.calls[0][0].upload_ids).toEqual([images[0].uploadId]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('asks before closing an incomplete upload and keeps its filename for reselection', async () => {
    const ui = userEvent.setup();
    const api = createTestAdapter();
    await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    vi.spyOn(api, 'uploadFileBytes').mockImplementation((_grant, _file, _progress, signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithAdapter(['/projects'], api);
    const capture = (await screen.findAllByRole('button', { name: '记一条' }))[0];
    await ui.click(capture);
    await ui.upload(screen.getByLabelText('选择图片文件'), makeImageFile('未完成.png'));
    await ui.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '记一条' })).toBeVisible();
    await ui.click(screen.getByRole('button', { name: '关闭弹窗' }));
    expect(screen.queryByRole('dialog', { name: '记一条' })).toBeNull();
    await ui.click(capture);
    await screen.findByText('上次上传未完成，请移除后重新选择图片。');
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();
    confirm.mockRestore();
  });

  it.each(['expired', 'rejected'] as const)('retains a %s restored image until explicitly removed', async status => {
    const user = userEvent.setup();
    const api = createTestAdapter();
    const { user: account } = await api.login({ email: 'admin@spark.local', password: 'SparkAdmin1234!' });
    const uploadId = crypto.randomUUID();
    const key = `spark:draft:v1:${account.id}:inbox`;
    localStorage.setItem(key, JSON.stringify({ collectionId: crypto.randomUUID(), idempotencyKey: 'test-key',
      document: EMPTY_DOCUMENT, intent: '', originalUrl: '', manualTitle: '', projectIds: [], tagIds: [], aiExcluded: false,
      images: [{ uploadId, name: '原图.png', size: 64 }] }));
    vi.spyOn(api, 'getUpload').mockResolvedValue({ id: uploadId, status, expires_at: new Date().toISOString() });
    renderWithAdapter(['/inbox'], api);
    expect(await screen.findByText(/请移除后重新选择图片/)).toBeVisible();
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem(key)!).images[0].uploadId).toBe(uploadId);
    await user.click(screen.getByRole('button', { name: '移除图片 原图.png' }));
    expect(screen.queryByText('原图.png')).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('validates MIME, 5 MiB limit, 9-image cap, and supports picker, paste and drop', async () => {
    const user = userEvent.setup({ applyAccept: false });
    await loginAsAdmin(user);

    const fileInput = screen.getByLabelText('选择图片文件') as HTMLInputElement;

    // Unsupported MIME type rejected
    const badFile = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await user.upload(fileInput, badFile);
    expect(await screen.findByRole('alert')).toHaveTextContent(/仅支持 JPEG、PNG、GIF、WebP 图片/);

    // File > 5 MiB rejected
    const oversized = makeImageFile('huge.png', 'image/png', 5 * 1024 * 1024 + 1);
    await user.upload(fileInput, oversized);
    expect(await screen.findByRole('alert')).toHaveTextContent(/单张图片不能超过 5 MiB/);

    // Paste valid image into editor
    const editor = screen.getByRole('textbox', { name: '收藏正文编辑器' });
    const pastedImg = makeImageFile('pasted.webp', 'image/webp', 120);
    fireEvent.paste(editor, {
      clipboardData: {
        files: [pastedImg],
        items: [{ kind: 'file', getAsFile: () => pastedImg }],
      },
    });
    await waitForUploadReady('pasted.webp');

    // Drag & drop 9 more images while 1 exists -> accepts 8 more (9 total) and warns
    const dropped = Array.from({ length: 9 }, (_, i) =>
      makeImageFile(`drop-${i + 1}.jpg`, 'image/jpeg', 90),
    );
    fireEvent.drop(editor, {
      dataTransfer: {
        types: ['Files'],
        files: dropped,
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/最多 9 张图片，已跳过超出部分/);
    await waitForUploadReady('drop-8.jpg');
    expect(screen.queryByText('drop-9.jpg')).not.toBeInTheDocument();
    expect(screen.getByText('图片 9 / 9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加图片' })).toBeDisabled();
  });

  it('shows progress, cancels in-flight upload via AbortSignal, retries failures, reorders and preserves positions', async () => {
    const user = userEvent.setup();
    const adapter = createTestAdapter();
    const origUploadBytes = adapter.uploadFileBytes.bind(adapter);

    let holdAbortSignal: AbortSignal | undefined;
    let releaseFirstUpload: (() => void) | null = null;
    const uploadSpy = vi
      .spyOn(adapter, 'uploadFileBytes')
      .mockImplementationOnce(async (_grant, _file, onProgress, signal) => {
        holdAbortSignal = signal;
        onProgress?.(35);
        await new Promise<void>((resolve, reject) => {
          releaseFirstUpload = resolve;
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true,
          });
        });
      })
      .mockImplementation((grant, file, onProgress, signal) =>
        origUploadBytes(grant, file, onProgress, signal),
      );

    await loginAsAdmin(user, adapter);
    const fileInput = screen.getByLabelText('选择图片文件');

    // Start upload that stays in flight at 35%
    await user.upload(fileInput, makeImageFile('slow.png'));
    expect(await screen.findByText('上传中 35%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();

    // Cancel aborts AbortSignal cleanly without error state
    await user.click(screen.getByRole('button', { name: '取消上传 slow.png' }));
    expect(holdAbortSignal?.aborted).toBe(true);
    expect(screen.queryByText('slow.png')).not.toBeInTheDocument();
    expect(releaseFirstUpload).toBeTypeOf('function');

    uploadSpy.mockRestore();

    // Next upload fails on object storage PUT once, then succeeds on retry
    const grants = vi.spyOn(adapter, 'createUpload');
    adapter.setMockUploadBehavior({ failPutRemaining: 1 });
    await user.upload(fileInput, makeImageFile('first.png'));
    await screen.findByText(/图片上传到对象存储失败/);
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '重试上传 first.png' }));
    await waitForUploadReady('first.png');
    expect(grants).toHaveBeenCalledTimes(2);
    expect(grants.mock.calls[1][1]).toBe(grants.mock.calls[0][1]);
    const [firstGrant, retryGrant] = await Promise.all(grants.mock.results.map((r) => r.value));
    expect(retryGrant.id).toBe(firstGrant.id);

    // Add second image and move it before first.png
    await user.upload(fileInput, makeImageFile('second.png'));
    await waitForUploadReady('second.png');

    await user.click(screen.getByRole('button', { name: '前移待保存图片 second.png' }));
    await user.click(screen.getByRole('button', { name: '保存收藏' }));

    // Inbox card shows image indicator badge
    expect(await screen.findByRole('img', { name: '含图片' })).toBeInTheDocument();

    // Open detail page and verify attachment positions were persisted in [second.png, first.png] order
    const openLinks = screen.getAllByRole('link', { name: /查看全文/ });
    await user.click(openLinks[0]);

    const imgs = await screen.findAllByRole('img', { name: /\.png$/ });
    expect(imgs.map((img) => img.getAttribute('alt'))).toEqual(['second.png', 'first.png']);
  });

  it('handles unconfigured upload service without losing text draft', async () => {
    const user = userEvent.setup();
    const { adapter } = await loginAsAdmin(user);

    const editor = screen.getByRole('textbox', { name: '收藏正文编辑器' });
    await user.click(editor);
    await user.type(editor, '这条文字需要在上传失败时继续保留');

    adapter.setMockUploadBehavior({ unconfigured: true });
    const fileInput = screen.getByLabelText('选择图片文件');
    await user.upload(fileInput, makeImageFile('blocked.png'));

    expect(await screen.findByText(/尚未配置或暂无法使用图片上传服务/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();

    // Remove failed upload -> text collection saves normally
    await user.click(screen.getByRole('button', { name: '移除图片 blocked.png' }));
    const saveBtn = screen.getByRole('button', { name: '保存收藏' });
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);

    expect(await screen.findByText('这条文字需要在上传失败时继续保留')).toBeInTheDocument();
  });

  it('supports detail edit (keep/reorder/remove/add), lightbox zoom, expired download refresh, and triage gallery', async () => {
    const user = userEvent.setup();
    const { adapter } = await loginAsAdmin(user);

    const fileInput = screen.getByLabelText('选择图片文件');
    await user.upload(fileInput, [makeImageFile('alpha.png'), makeImageFile('beta.png')]);
    await waitForUploadReady('alpha.png');
    await waitForUploadReady('beta.png');

    await user.click(screen.getByRole('button', { name: '保存收藏' }));
    await screen.findByRole('img', { name: '含图片' });

    // Visit Unclassified -> TriagePage and check compact attachment gallery renders inside front card
    await user.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('link', {
        name: /待归类/,
      }),
    );
    await user.click(await screen.findByRole('link', { name: /开始整理/ }));
    expect(await screen.findByLabelText('图片附件，共 2 张')).toBeInTheDocument();

    // Open detail page from triage card
    await user.click(screen.getByRole('link', { name: /查看详情/ }));
    await screen.findByRole('heading', { name: /图片附件 \(2\)/ });

    // Open Lightbox on alpha.png, navigate to beta.png, close with Escape
    await user.click(await screen.findByRole('button', { name: '放大查看图片 alpha.png' }));
    const dialog = await screen.findByRole('dialog', { name: '图片预览 alpha.png' });
    expect(within(dialog).getByText(/1 \/ 2/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /在新标签打开原图/ })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '下一张图片' }));
    expect(await screen.findByRole('dialog', { name: '图片预览 beta.png' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Simulate expired short-lived download URL -> image error recovers via getDownload refetch
    adapter.setMockUploadBehavior({ expireDownloadOnce: true });
    const downloadSpy = vi.spyOn(adapter, 'getDownload');
    const detailImg = screen.getByRole('img', { name: 'alpha.png' });
    fireEvent.error(detailImg);
    await waitFor(() => {
      expect(downloadSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    downloadSpy.mockRestore();

    // Enter edit mode: reorder beta before alpha, remove alpha, add gamma.png
    await user.click(screen.getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '前移已有图片 beta.png' }));
    await user.click(screen.getByRole('button', { name: '移除已有图片 alpha.png' }));

    const editFileInput = screen.getByLabelText('选择新增图片');
    await user.upload(editFileInput, makeImageFile('gamma.png'));
    await waitForUploadReady('gamma.png');

    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await screen.findByRole('heading', { name: /图片附件 \(2\)/ });

    const finalImgs = await screen.findAllByRole('img', { name: /\.png$/ });
    expect(finalImgs.map((img) => img.getAttribute('alt'))).toEqual(['beta.png', 'gamma.png']);
  });

  it('isolates pending uploads and upload/attachment ownership across accounts', async () => {
    const user = userEvent.setup();
    const { adapter } = await loginAsAdmin(user);

    // Admin creates a ready upload and holds one raw upload ID
    const fileInput = screen.getByLabelText('选择图片文件');
    await user.upload(fileInput, makeImageFile('admin-only.png'));
    await waitForUploadReady('admin-only.png');

    const adminGrant = await adapter.createUpload(
      { filename: 'secret.png', size_bytes: 64, mime_type: 'image/png' },
      '00000000-0000-4000-8000-000000000901',
    );
    await adapter.uploadFileBytes(adminGrant, makeImageFile('secret.png'));
    await adapter.completeUpload(adminGrant.id);

    const adminSavedGrant = await adapter.createUpload(
      { filename: 'owned-att.png', size_bytes: 64, mime_type: 'image/png' },
      '00000000-0000-4000-8000-000000000904',
    );
    await adapter.uploadFileBytes(adminSavedGrant, makeImageFile('owned-att.png'));
    await adapter.completeUpload(adminSavedGrant.id);
    const adminCollection = await adapter.createCollection(
      {
        id: '00000000-0000-4000-8000-000000000905',
        document: EMPTY_DOCUMENT,
        intent: '',
        upload_ids: [adminSavedGrant.id],
        project_ids: [],
        tag_ids: [],
      },
      '00000000-0000-4000-8000-000000000906',
    );
    const adminAttachmentId = adminCollection.attachments[0].id;

    // Logout admin and register a second user
    await user.click(
      within(screen.getByRole('complementary', { name: '主导航' })).getByRole('button', {
        name: '账号菜单',
      }),
    );
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await user.click(await screen.findByRole('link', { name: '使用邀请码注册' }));

    await user.type(screen.getByLabelText('邮箱'), 'bob@example.com');
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    await screen.findByText(/测试适配器模拟验证码/);
    const code = adapter.getLastVerificationCode('bob@example.com')!;
    await user.type(screen.getByLabelText('6 位邮箱验证码'), code);
    await user.type(screen.getByLabelText('邀请码'), 'SPARK-TEST-0002');
    await user.type(screen.getByLabelText('设置密码（12 至 128 位）'), 'BobPassword123!');
    await user.click(screen.getByRole('button', { name: '验证并注册' }));
    await screen.findByRole('heading', { name: '收件箱' });

    // Previous user's pending upload tray must be empty after switching accounts
    expect(screen.queryByText('admin-only.png')).not.toBeInTheDocument();

    // User B cannot attach User A's uploadId or download User A's attachment
    await expect(
      adapter.createCollection(
        {
          id: '00000000-0000-4000-8000-000000000902',
          document: EMPTY_DOCUMENT,
          intent: '',
          upload_ids: [adminGrant.id],
          project_ids: [],
          tag_ids: [],
        },
        '00000000-0000-4000-8000-000000000903',
      ),
    ).rejects.toThrow(/附件尚未上传确认完成/);
    await expect(adapter.getDownload(adminAttachmentId)).rejects.toThrow(/附件不存在/);
  });

  it('polls verifying uploads until ready/rejected and sanitizes filenames for POST /uploads', async () => {
    const user = userEvent.setup();
    const { adapter } = await loginAsAdmin(user);
    const createUploadSpy = vi.spyOn(adapter, 'createUpload');

    // Async verification path (complete -> 202 verifying -> poll getUpload -> ready)
    adapter.setMockUploadBehavior({ completeStatus: 'verifying_then_ready' });
    const fileInput = screen.getByLabelText('选择图片文件');
    await user.upload(fileInput, makeImageFile('folder/async-ok.png'));

    expect(await screen.findByText('校验中…')).toBeInTheDocument();
    await waitForUploadReady('folder/async-ok.png');
    expect(createUploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'folder_async-ok.png' }),
      expect.any(String),
    );
    createUploadSpy.mockRestore();

    // Async verification rejection path (verifying -> rejected with T03 error_code)
    adapter.setMockUploadBehavior({ completeStatus: 'verifying_then_rejected' });
    await user.upload(fileInput, makeImageFile('corrupt.png'));
    expect(await screen.findByText(/图片文件内容损坏或与扩展名格式不匹配/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存收藏' })).toBeDisabled();
  });
});
