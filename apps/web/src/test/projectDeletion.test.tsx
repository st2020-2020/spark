import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppProviders, AppRoutes } from '../App';
import { createRealApiClient } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { loadDraft, saveDraft, type CollectionDraft } from '../lib/drafts';
import { loadAcceptedPurges, saveAcceptedPurges } from '../lib/purge';
import { loadSidebarPrefs, saveSidebarPrefs } from '../lib/sidebarPrefs';
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

function makeDoc(text: string) {
  return {
    schema_version: 1 as const,
    content: {
      type: 'doc' as const,
      content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
    },
  };
}

async function setupAdmin() {
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

describe('v0.10.0 project deletion and async cleanup safety', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls real DELETE /projects/{id}?base_version=... with CSRF and Idempotency-Key and no body', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: {
            id: 'u-del-1',
            email: 'u1@example.com',
            role: 'user',
            status: 'active',
            ai_enabled: false,
            ai_policy_version: 1,
          },
          csrf_token: 'csrf-proj-del',
          expires_at: '2030-01-01T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const api = createRealApiClient();
    await api.login({ email: 'u1@example.com', password: 'password123456' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteProject('proj-1', 3, 'idem-del-1');

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects/proj-1?base_version=3');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get('X-CSRF-Token')).toBe('csrf-proj-del');
    expect(headers.get('Idempotency-Key')).toBe('idem-del-1');
  });

  it('deletes project from detail with exact name confirmation, handles 409 conflict + new key, preserves notes & images, and clears sidebar pins', async () => {
    const { api, user } = await setupAdmin();
    const project = await api.createProject(
      { name: '即将解散的课题', description: '说明', focus_points: [] },
      'p-del-1',
    );
    saveSidebarPrefs(user.id, {
      pinnedProjectIds: [project.id],
      pinnedProjectMeta: { [project.id]: project.name },
    });

    const imgFile = new File(['pngbytes'], 'photo.png', { type: 'image/png' });
    const grant = await api.createUpload(
      { filename: 'photo.png', mime_type: 'image/png', size_bytes: imgFile.size },
      'up-grant-1',
    );
    await api.uploadFileBytes(grant, imgFile);
    const uploaded = await api.completeUpload(grant.id);
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: makeDoc('被删除项目下保留的图文笔记'),
        intent: '',
        upload_ids: [uploaded.id],
        project_ids: [project.id],
        tag_ids: [],
      },
      'col-keep-1',
    );

    const deleteSpy = vi.spyOn(api, 'deleteProject');
    const ui = userEvent.setup();
    mount(api, `/projects/${project.id}`);

    await screen.findByRole('heading', { name: '即将解散的课题' });
    await ui.click(screen.getByRole('button', { name: '删除项目' }));

    const dialog = await screen.findByRole('dialog', { name: '确认删除项目' });
    expect(
      within(dialog).getByText('删除项目后无法恢复。项目下的笔记和图片都会保留，只解除与这个项目的关联。'),
    ).toBeInTheDocument();

    const confirmBtn = within(dialog).getByRole('button', { name: '确认删除' });
    expect(confirmBtn).toBeDisabled();

    const confirmInput = within(dialog).getByLabelText('请输入「即将解散的课题」确认删除');
    await ui.type(confirmInput, '错误名称');
    expect(confirmBtn).toBeDisabled();

    // Simulate concurrent edit advancing version to v2 before confirm submit -> 409 resource_conflict
    await api.updateProject(project.id, {
      base_version: project.version,
      name: '即将解散的课题',
      description: '外部更新',
    });

    await ui.clear(confirmInput);
    await ui.type(confirmInput, '即将解散的课题');
    expect(confirmBtn).toBeEnabled();
    await ui.click(confirmBtn);

    expect(await within(dialog).findByText(/项目已更新至 v2/)).toBeInTheDocument();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy.mock.calls[0]?.[1]).toBe(1);

    // Retry submit against updated v2 -> mints a new Idempotency-Key & succeeds
    await ui.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认删除项目' })).not.toBeInTheDocument());
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy.mock.calls[1]?.[1]).toBe(2);
    expect(deleteSpy.mock.calls[1]?.[2]).not.toBe(deleteSpy.mock.calls[0]?.[2]);

    // Navigates back to /projects and removes sidebar pin & meta immediately
    expect(await screen.findByRole('heading', { name: '项目' })).toBeInTheDocument();
    expect(loadSidebarPrefs(user.id).pinnedProjectIds).toBeNull();
    expect(screen.queryByRole('link', { name: '即将解散的课题' })).not.toBeInTheDocument();

    // Linked note and uploaded image remain completely intact (moved to unclassified)
    const preserved = await api.getCollection(col.id);
    expect(preserved.deleted_at).toBeUndefined();
    expect(preserved.projects).toHaveLength(0);
    expect(preserved.attachments).toHaveLength(1);
    expect(preserved.resource_version).toBeGreaterThan(col.resource_version);
  });

  it('guards unsaved active draft & pending images before project delete, preserves all drafts on cancel, and transfers lossless drafts safely', async () => {
    const { api, user } = await setupAdmin();
    const projA = await api.createProject({ name: '草稿测试A', description: '', focus_points: [] }, 'pa');
    const projB = await api.createProject({ name: '草稿测试B', description: '', focus_points: [] }, 'pb');

    // Existing inbox draft & unrelated project B draft referencing projA
    const existingInbox: CollectionDraft = {
      collectionId: crypto.randomUUID(),
      idempotencyKey: 'k-inbox',
      document: makeDoc('收件箱已有草稿'),
      intent: '',
      originalUrl: '',
      manualTitle: '',
      projectIds: [projA.id, projB.id],
      tagIds: [],
      associationNames: { [projA.id]: projA.name, [projB.id]: projB.name },
      aiExcluded: false,
      updatedAt: new Date().toISOString(),
    };
    const otherProjDraft: CollectionDraft = {
      ...existingInbox,
      collectionId: crypto.randomUUID(),
      idempotencyKey: 'k-other',
      document: makeDoc('其他项目草稿'),
    };
    saveDraft(user.id, 'inbox', existingInbox);
    saveDraft(user.id, `project:${projB.id}`, otherProjDraft);

    // Seed ready image upload and write unsaved text + ready image in projA composer
    const readyFile = new File(['readybytes'], 'ready.png', { type: 'image/png' });
    const grant = await api.createUpload(
      { filename: 'ready.png', mime_type: 'image/png', size_bytes: readyFile.size },
      'up-ready',
    );
    await api.uploadFileBytes(grant, readyFile);
    const readyUpload = await api.completeUpload(grant.id);
    saveDraft(user.id, `project:${projA.id}`, {
      collectionId: crypto.randomUUID(),
      idempotencyKey: 'k-pa',
      document: makeDoc('项目A未保存草稿'),
      intent: '',
      originalUrl: '',
      manualTitle: '',
      projectIds: [projA.id],
      tagIds: [],
      images: [{ uploadId: readyUpload.id, name: 'ready.png', size: readyFile.size }],
      aiExcluded: false,
      updatedAt: new Date().toISOString(),
    });

    const ui = userEvent.setup();
    const view = mount(api, `/projects/${projA.id}`);
    await screen.findByRole('heading', { name: '草稿测试A' });

    // Open delete modal while inbox is occupied -> explicit warning + checkbox; cancelling touches ZERO drafts
    await ui.click(screen.getByRole('button', { name: '删除项目' }));
    const dialog1 = await screen.findByRole('dialog', { name: '确认删除项目' });
    expect(within(dialog1).getByText(/含 1 张已上传图片.*收件箱已有其他草稿/)).toBeInTheDocument();
    await ui.type(within(dialog1).getByLabelText('请输入「草稿测试A」确认删除'), '草稿测试A');
    expect(within(dialog1).getByRole('button', { name: '确认删除' })).toBeDisabled();

    await ui.click(within(dialog1).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认删除项目' })).not.toBeInTheDocument());
    expect(loadDraft<CollectionDraft>(user.id, `project:${projA.id}`).data?.document).toEqual(makeDoc('项目A未保存草稿'));
    expect(loadDraft<CollectionDraft>(user.id, 'inbox').data?.document).toEqual(makeDoc('收件箱已有草稿'));
    expect(loadDraft<CollectionDraft>(user.id, `project:${projB.id}`).data?.projectIds).toEqual([projA.id, projB.id]);

    // Clear inbox so transfer to inbox is lossless, then delete projA
    localStorage.removeItem(`spark:draft:v1:${user.id}:inbox`);
    await ui.click(screen.getByRole('button', { name: '删除项目' }));
    const dialog2 = await screen.findByRole('dialog', { name: '确认删除项目' });
    expect(within(dialog2).getByText(/继续删除会将其转存到收件箱草稿/)).toBeInTheDocument();
    await ui.type(within(dialog2).getByLabelText('请输入「草稿测试A」确认删除'), '草稿测试A');
    await ui.click(within(dialog2).getByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('heading', { name: '项目' })).toBeInTheDocument();

    // Inbox received projA's draft + ready image with deleted projectId stripped; otherProjDraft only stripped projA.id
    const transferredInbox = loadDraft<CollectionDraft>(user.id, 'inbox').data!;
    expect(transferredInbox.document).toEqual(makeDoc('项目A未保存草稿'));
    expect(transferredInbox.images).toEqual([{ uploadId: readyUpload.id, name: 'ready.png', size: readyFile.size }]);
    expect(transferredInbox.projectIds).toEqual([]);
    expect(loadDraft<CollectionDraft>(user.id, `project:${projA.id}`).data).toBeNull();
    const keptOther = loadDraft<CollectionDraft>(user.id, `project:${projB.id}`).data!;
    expect(keptOther.document).toEqual(makeDoc('其他项目草稿'));
    expect(keptOther.projectIds).toEqual([projB.id]);
    view.unmount();

    // Also verify pending temporary upload file triggers discard confirmation inside modal
    api.setMockUploadBehavior({ failPutRemaining: 1 });
    mount(api, `/projects/${projB.id}`);
    await screen.findByRole('heading', { name: '草稿测试B' });
    const fileInput = document.querySelector('input[type="file"][multiple]') as HTMLInputElement;
    const tempFile = new File(['abc'], 'temp-pending.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [tempFile] } });
    await screen.findByText(/temp-pending\.png/);

    await ui.click(screen.getByRole('button', { name: '删除项目' }));
    const pendingDialog = await screen.findByRole('dialog', { name: '确认删除项目' });
    expect(within(pendingDialog).getByText(/当前有未完成上传的临时图片/)).toBeInTheDocument();
    await ui.type(within(pendingDialog).getByLabelText('请输入「草稿测试B」确认删除'), '草稿测试B');
    expect(within(pendingDialog).getByRole('button', { name: '确认删除' })).toBeDisabled();
    await ui.click(within(pendingDialog).getByRole('checkbox'));
    expect(within(pendingDialog).getByRole('button', { name: '确认删除' })).toBeEnabled();
  });

  it('hides note trash while editing, avoids persisting note titles in purge sessionStorage, and isolates account switches', async () => {
    const { api, user: userA } = await setupAdmin();
    const col = await api.createCollection(
      {
        id: crypto.randomUUID(),
        document: makeDoc('敏感私人笔记标题不应该写入存储'),
        intent: '',
        upload_ids: [],
        project_ids: [],
        tag_ids: [],
      },
      'col-priv-1',
    );

    const ui = userEvent.setup();
    const view1 = mount(api, `/collections/${col.id}`);
    await screen.findByText('敏感私人笔记标题不应该写入存储');
    expect(screen.getByRole('button', { name: '移入回收站' })).toBeInTheDocument();

    // Entering edit mode hides 移入回收站 to avoid accidental delete while editing
    await ui.click(screen.getByRole('button', { name: '编辑' }));
    expect(screen.queryByRole('button', { name: '移入回收站' })).not.toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: '取消' }));
    view1.unmount();
    cleanup();

    // Trash & purge -> sessionStorage holds minimal IDs/status ONLY, never note title, with accurate copy
    const latestCol = await api.getCollection(col.id);
    await api.trashCollection(col.id, { base_resource_version: latestCol.resource_version });
    api.setMockPurgeBehavior({ initialStatus: 'queued' });
    const view2 = mount(api, '/trash');
    await screen.findByText('敏感私人笔记标题不应该写入存储');
    await ui.click(screen.getByRole('button', { name: '永久删除' }));
    await ui.click(await screen.findByRole('button', { name: '确认永久删除' }));

    expect(await screen.findByText('已移出回收站，等待清理附件。可点击「刷新状态」确认结果。')).toBeInTheDocument();
    const storedRaw = sessionStorage.getItem(`spark:accepted-purges:v1:${userA.id}`) ?? '';
    expect(storedRaw).not.toContain('敏感私人笔记标题');
    expect(loadAcceptedPurges(userA.id)).toHaveLength(1);

    api.setMockPurgeStatus(col.id, 'completed');
    await ui.click(screen.getByRole('button', { name: '刷新状态' }));
    expect(await screen.findByText('笔记和附件已永久删除，无法恢复。')).toBeInTheDocument();

    // Register User B with an existing queued purge receipt in sessionStorage; verify User A state never overwrites User B
    const userBVer = await api.sendVerification({ email: 'user-b-purge@example.test', purpose: 'register' });
    const userBCode = api.getLastVerificationCode('user-b-purge@example.test')!;
    const userBRes = await api.register({
      email: 'user-b-purge@example.test',
      password: 'Password1234!',
      challenge_id: userBVer.challenge_id,
      verification_code: userBCode,
      invite_code: 'SPARK-TEST-0001',
    });
    const fakeBOpId = crypto.randomUUID();
    const fakeBColId = crypto.randomUUID();
    saveAcceptedPurges(userBRes.user.id, [
      { collectionId: fakeBColId, operationId: fakeBOpId, status: 'queued' },
    ]);

    view2.unmount();
    cleanup();
    // Mount Trash as User B directly without User A's transition leaking over User B
    mount(api, '/trash');
    await screen.findByRole('heading', { name: '回收站' });
    expect(loadAcceptedPurges(userBRes.user.id)).toEqual([
      { collectionId: fakeBColId, operationId: fakeBOpId, status: 'queued' },
    ]);
    expect(loadAcceptedPurges(userA.id)).toHaveLength(1);
  });

  it('does not navigate or write toasts if account logs out while project delete request is in flight', async () => {
    const { api } = await setupAdmin();
    const proj = await api.createProject({ name: '在途登出测试项目', description: '', focus_points: [] }, 'p-inflight');

    let resolveDelete!: () => void;
    vi.spyOn(api, 'deleteProject').mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveDelete = res;
        }),
    );

    let triggerLogout!: () => Promise<void>;
    function AuthProbe() {
      const { logout } = useAuth();
      triggerLogout = logout;
      return null;
    }

    const ui = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[`/projects/${proj.id}`]}>
        <AppProviders api={api}>
          <AuthProbe />
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: '在途登出测试项目' });

    await ui.click(screen.getByRole('button', { name: '删除项目' }));
    const dialog = await screen.findByRole('dialog', { name: '确认删除项目' });
    await ui.type(within(dialog).getByLabelText('请输入「在途登出测试项目」确认删除'), '在途登出测试项目');
    await ui.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(resolveDelete).toBeTypeOf('function'));

    // Logout while delete request is still in flight
    await act(async () => {
      await triggerLogout();
    });
    await screen.findByRole('heading', { name: /欢迎回来|登录/ });

    // Settle stale delete response after logout -> must not navigate away from login or show stale toast
    await act(async () => {
      resolveDelete();
    });
    expect(screen.queryByText(/在途登出测试项目.*已删除/)).not.toBeInTheDocument();
  });
});
