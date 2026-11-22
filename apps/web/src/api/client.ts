import { ApiError, parseApiErrorResponse } from './errors';
import type {
  AIExclusion,
  Accepted,
  AssociationUpdate,
  BatchStatus,
  BudgetConfig,
  BudgetUpdate,
  CodeStatus,
  Collection,
  CollectionCreate,
  CollectionPage,
  CollectionThread,
  CollectionUpdate,
  DownloadGrant,
  ExportDownloadResult,
  ExportFormat,
  Extraction,
  ExtractionList,
  GetCollectionThreadQuery,
  ImageRetryRequest,
  ImageNoteUpdate,
  FailureList,
  Health,
  ActivityQuery,
  ActivityResult,
  ResurfaceResult,
  ResurfacePreferences,
  ImageAnalysisPreferences,
  ImageAnalysisPreferencesUpdate,
  InviteBatch,
  InviteBatchPage,
  InviteCode,
  InviteCodePage,
  InvitePreview,
  InvitePreviewRequest,
  ListCollectionsQuery,
  ListProjectsQuery,
  ListTagsQuery,
  LoginRequest,
  ModelConfig,
  ModelUpdate,
  Organization,
  OrganizationEvent,
  PasswordReset,
  Preferences,
  Project,
  ProjectCreate,
  ProjectPage,
  ProjectUpdate,
  ReadUpdate,
  RegisterRequest,
  ResourceCondition,
  RevisionPage,
  SearchCollectionsQuery,
  SearchPage,
  SessionList,
  SessionResult,
  Tag,
  TagCreate,
  TagDecisionUpdate,
  TagPage,
  TagRename,
  UndoProjectDecision,
  Upload,
  UploadGrant,
  UploadRequest,
  Usage,
  User,
  UserPage,
  UserStatus,
  VerificationRequest,
  VerificationResult,
} from './types';

export interface OrganizationEventsHandlers {
  onReady?: () => void;
  onOrganization?: (event: OrganizationEvent) => void;
  onError?: (info: { closed: boolean }) => void;
}

export interface SparkApi {
  readonly isTestAdapter: boolean;
  setCsrfToken(token: string | null): void;
  setUnauthorizedHandler(handler: (() => void) | null): void;
  subscribeOrganizationEvents(handlers: OrganizationEventsHandlers): () => void;

  healthLive(signal?: AbortSignal): Promise<Health>;
  healthReady(signal?: AbortSignal): Promise<Health>;

  sendVerification(body: VerificationRequest): Promise<VerificationResult>;
  register(body: RegisterRequest): Promise<SessionResult>;
  login(body: LoginRequest): Promise<SessionResult>;
  resetPassword(body: PasswordReset): Promise<void>;
  logout(): Promise<void>;
  currentSession(): Promise<SessionResult>;
  getActivity(query: ActivityQuery, signal?: AbortSignal): Promise<ActivityResult>;
  getResurface(tz: string, signal?: AbortSignal): Promise<ResurfaceResult>;
  getResurfacePreferences(signal?: AbortSignal): Promise<ResurfacePreferences>;
  setResurfacePreferences(body: ResurfacePreferences): Promise<ResurfacePreferences>;
  hideResurfaceItem(id: string, date: string, tz: string): Promise<void>;
  recordCollectionOpened(id: string): Promise<void>;
  updatePreferences(body: Preferences): Promise<User>;
  getImageAnalysisPreferences(): Promise<ImageAnalysisPreferences>;
  setImageAnalysisPreferences(
    body: ImageAnalysisPreferencesUpdate,
  ): Promise<ImageAnalysisPreferences>;
  getUsage(): Promise<Usage>;
  exportMyData(format: ExportFormat, signal?: AbortSignal): Promise<ExportDownloadResult>;
  listSessions(): Promise<SessionList>;
  revokeSession(id: string): Promise<void>;

  createProject(body: ProjectCreate, idempotencyKey: string): Promise<Project>;
  listProjects(query?: ListProjectsQuery): Promise<ProjectPage>;
  getProject(id: string): Promise<Project>;
  updateProject(id: string, body: ProjectUpdate): Promise<Project>;

  createTag(body: TagCreate, idempotencyKey: string): Promise<Tag>;
  listTags(query?: ListTagsQuery): Promise<TagPage>;
  renameTag(id: string, body: TagRename): Promise<Tag>;

  createUpload(body: UploadRequest, idempotencyKey: string): Promise<UploadGrant>;
  uploadFileBytes(
    grant: UploadGrant,
    file: File,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<void>;
  completeUpload(id: string): Promise<Upload>;
  getUpload(id: string): Promise<Upload>;
  getThumbnail(attachmentId: string, signal?: AbortSignal): Promise<Blob>;
  getDownload(attachmentId: string): Promise<DownloadGrant>;

  createCollection(body: CollectionCreate, idempotencyKey: string): Promise<Collection>;
  listCollections(query?: ListCollectionsQuery, signal?: AbortSignal): Promise<CollectionPage>;
  getCollection(id: string, signal?: AbortSignal): Promise<Collection>;
  getCollectionThread(
    id: string,
    query?: GetCollectionThreadQuery,
    signal?: AbortSignal,
  ): Promise<CollectionThread>;
  updateCollection(id: string, body: CollectionUpdate): Promise<Collection>;
  trashCollection(id: string, body: ResourceCondition): Promise<Collection>;
  restoreCollection(id: string, body: ResourceCondition): Promise<Collection>;
  purgeCollection(id: string, body: ResourceCondition, idempotencyKey: string): Promise<Accepted>;
  getCollectionPurgeStatus(id: string): Promise<Accepted>;
  setReadState(id: string, body: ReadUpdate): Promise<Collection>;
  setAIExclusion(id: string, body: AIExclusion): Promise<Collection>;
  updateProjectDecisions(
    id: string,
    body: AssociationUpdate,
    idempotencyKey?: string,
  ): Promise<Collection>;
  undoProjectDecisions(id: string, body: UndoProjectDecision): Promise<Collection>;
  updateTagDecisions(id: string, body: TagDecisionUpdate): Promise<Collection>;
  getOrganization(id: string): Promise<Organization>;
  restartOrganization(id: string, idempotencyKey: string): Promise<Organization>;
  updateImageNote(attachmentId: string, body: ImageNoteUpdate): Promise<Collection>;
  retryImageAnalysis(attachmentId: string, body: ImageRetryRequest, idempotencyKey: string): Promise<Extraction>;
  getExtractions(id: string): Promise<ExtractionList>;
  refreshUrlExtraction(id: string, idempotencyKey: string): Promise<Extraction>;
  listRevisions(id: string, query?: { cursor?: string; limit?: number }): Promise<RevisionPage>;
  searchCollections(query: SearchCollectionsQuery, signal?: AbortSignal): Promise<SearchPage>;

  previewInviteImport(body: InvitePreviewRequest, idempotencyKey: string): Promise<InvitePreview>;
  commitInviteImport(id: string, idempotencyKey: string): Promise<InviteBatch>;
  listInviteBatches(query?: { cursor?: string; limit?: number }): Promise<InviteBatchPage>;
  setInviteBatchStatus(id: string, body: BatchStatus): Promise<InviteBatch>;
  listInviteCodes(
    batchId: string,
    query?: { cursor?: string; limit?: number },
  ): Promise<InviteCodePage>;
  setInviteCodeStatus(id: string, body: CodeStatus): Promise<InviteCode>;
  listUsers(query?: { cursor?: string; limit?: number }): Promise<UserPage>;
  setUserStatus(id: string, body: UserStatus): Promise<User>;
  getBudgets(): Promise<BudgetConfig>;
  setBudgets(body: BudgetUpdate): Promise<BudgetConfig>;
  getModelConfig(): Promise<ModelConfig>;
  setModelConfig(body: ModelUpdate): Promise<ModelConfig>;
  listFailures(): Promise<FailureList>;
}

const API_BASE = '/api/v1';
export const UPLOAD_TRANSFER_TIMEOUT_MS = 60_000;

function buildQuery(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

interface RequestOptions {
  body?: unknown;
  requiresCsrf?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
  notifyUnauthorized?: boolean;
}

export function createRealApiClient(): SparkApi {
  let csrfToken: string | null = null;
  let unauthorizedHandler: (() => void) | null = null;

  async function fetchResponse(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: RequestOptions,
  ): Promise<Response> {
    const requestSession = csrfToken;
    const headers: Record<string, string> = {};
    if (options?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options?.requiresCsrf) {
      if (!csrfToken) {
        throw new ApiError({
          status: 403,
          code: 'csrf_failed',
          message: '缺少会话安全令牌，请刷新或重新登录后重试。',
        });
      }
      headers['X-CSRF-Token'] = csrfToken;
    }
    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        credentials: 'include',
        redirect: 'error',
        headers,
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options?.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      throw new ApiError({
        status: 0,
        code: 'network_error',
        message: '暂时无法连接，请检查网络或稍后重试。',
      });
    }

    if (!response.ok) {
      const apiErr = await parseApiErrorResponse(response);
      if (apiErr.status === 401 && options?.notifyUnauthorized !== false && csrfToken === requestSession) {
        csrfToken = null;
        unauthorizedHandler?.();
      }
      throw apiErr;
    }

    return response;
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: RequestOptions,
  ): Promise<T> {
    const response = await fetchResponse(method, path, options);

    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return (await response.json()) as T;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new ApiError({
        status: 0,
        code: 'invalid_response',
        message: '未收到完整响应，请重试。',
      });
    }
  }

  return {
    isTestAdapter: false,

    setCsrfToken(token) {
      csrfToken = token;
    },

    setUnauthorizedHandler(handler) {
      unauthorizedHandler = handler;
    },

    subscribeOrganizationEvents(handlers) {
      if (typeof EventSource === 'undefined') {
        return () => {};
      }
      const es = new EventSource(`${API_BASE}/organization/events`, {
        withCredentials: true,
      });
      const handleReady = () => {
        handlers.onReady?.();
      };
      const handleOrganization = (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as OrganizationEvent;
          if (
            parsed &&
            typeof parsed.collection_id === 'string' &&
            typeof parsed.status === 'string' &&
            typeof parsed.has_suggestion === 'boolean'
          ) {
            handlers.onOrganization?.(parsed);
          }
        } catch {
          // Ignore malformed event payload
        }
      };
      const handleError = () => {
        const closed = es.readyState === EventSource.CLOSED;
        if (closed) {
          es.close();
        }
        handlers.onError?.({ closed });
      };
      es.addEventListener('ready', handleReady);
      es.addEventListener('organization', handleOrganization);
      es.addEventListener('error', handleError);
      return () => {
        es.removeEventListener('ready', handleReady);
        es.removeEventListener('organization', handleOrganization);
        es.removeEventListener('error', handleError);
        es.close();
      };
    },

    healthLive: (signal) =>
      request<Health>('GET', '/health/live', { signal, notifyUnauthorized: false }),
    healthReady: (signal) =>
      request<Health>('GET', '/health/ready', { signal, notifyUnauthorized: false }),

    sendVerification: (body) =>
      request<VerificationResult>('POST', '/auth/verification', {
        body,
        notifyUnauthorized: false,
      }),

    register: async (body) => {
      const session = await request<SessionResult>('POST', '/auth/register', {
        body,
        notifyUnauthorized: false,
      });
      csrfToken = session.csrf_token;
      return session;
    },

    login: async (body) => {
      const session = await request<SessionResult>('POST', '/auth/login', {
        body,
        notifyUnauthorized: false,
      });
      csrfToken = session.csrf_token;
      return session;
    },

    resetPassword: (body) =>
      request<void>('POST', '/auth/password-reset', {
        body,
        notifyUnauthorized: false,
      }),

    logout: async () => {
      const requestSession = csrfToken;
      await request<void>('POST', '/auth/logout', { requiresCsrf: true, notifyUnauthorized: false });
      if (csrfToken === requestSession) csrfToken = null;
    },

    currentSession: async () => {
      const requestSession = csrfToken;
      const session = await request<SessionResult>('GET', '/auth/session', {
        notifyUnauthorized: false,
      });
      if (csrfToken === requestSession) csrfToken = session.csrf_token;
      return session;
    },

    getActivity: (query, signal) => request<ActivityResult>('GET', `/me/activity${buildQuery(query)}`, { signal }),
    getResurface: (tz, signal) => request<ResurfaceResult>('GET', `/me/resurface${buildQuery({ tz })}`, { signal }),
    getResurfacePreferences: (signal) => request<ResurfacePreferences>('GET', '/me/resurface/preferences', { signal }),
    setResurfacePreferences: (body) => request<ResurfacePreferences>('PUT', '/me/resurface/preferences', { body, requiresCsrf: true }),
    hideResurfaceItem: (id, date, tz) => request<void>('PUT', `/me/resurface/${encodeURIComponent(id)}/hidden${buildQuery({ date, tz })}`, { requiresCsrf: true }),
    recordCollectionOpened: (id) => request<void>('POST', `/collections/${encodeURIComponent(id)}/opened`, { requiresCsrf: true }),
    updatePreferences: (body) =>
      request<User>('PATCH', '/me/preferences', { body, requiresCsrf: true }),
    getImageAnalysisPreferences: () =>
      request<ImageAnalysisPreferences>('GET', '/me/image-analysis'),
    setImageAnalysisPreferences: (body) =>
      request<ImageAnalysisPreferences>('PUT', '/me/image-analysis', { body, requiresCsrf: true }),
    getUsage: () => request<Usage>('GET', '/me/usage'),
    exportMyData: async (format, signal) => {
      const response = await fetchResponse('GET', `/me/export${buildQuery({ format })}`, { signal, requiresCsrf: true });
      if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/zip') {
        throw new Error('导出服务返回了意外的文件格式，请稍后重试。');
      }
      const filename = response.headers.get('Content-Disposition')?.match(/filename="(spark-export-\d{8}\.zip)"/i)?.[1] ?? 'spark-export.zip';
      const blob = await response.blob();
      return { blob, filename };
    },
    listSessions: () => request<SessionList>('GET', '/sessions'),
    revokeSession: (id) =>
      request<void>('DELETE', `/sessions/${encodeURIComponent(id)}`, { requiresCsrf: true }),

    createProject: (body, idempotencyKey) =>
      request<Project>('POST', '/projects', {
        body,
        requiresCsrf: true,
        idempotencyKey,
      }),
    listProjects: (query) => request<ProjectPage>('GET', `/projects${buildQuery(query)}`),
    getProject: (id) => request<Project>('GET', `/projects/${encodeURIComponent(id)}`),
    updateProject: (id, body) =>
      request<Project>('PATCH', `/projects/${encodeURIComponent(id)}`, {
        body,
        requiresCsrf: true,
      }),

    createTag: (body, idempotencyKey) =>
      request<Tag>('POST', '/tags', { body, requiresCsrf: true, idempotencyKey }),
    listTags: (query) => request<TagPage>('GET', `/tags${buildQuery(query)}`),
    renameTag: (id, body) =>
      request<Tag>('PATCH', `/tags/${encodeURIComponent(id)}`, { body, requiresCsrf: true }),

    createUpload: (body, idempotencyKey) =>
      request<UploadGrant>('POST', '/uploads', {
        body,
        requiresCsrf: true,
        idempotencyKey,
      }),

    uploadFileBytes: (grant, file, onProgress, signal, timeoutMs = UPLOAD_TRANSFER_TIMEOUT_MS) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open(grant.method, grant.url, true);
        xhr.timeout = timeoutMs > 0 ? timeoutMs : UPLOAD_TRANSFER_TIMEOUT_MS;
        for (const [k, v] of Object.entries(grant.headers)) {
          const lower = k.toLowerCase();
          if (lower === 'content-length' || lower === 'host') continue;
          xhr.setRequestHeader(k, v);
        }
        const onAbort = () => xhr.abort();
        const cleanup = () => {
          signal?.removeEventListener('abort', onAbort);
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        };
        xhr.onload = () => {
          cleanup();
          if (xhr.status >= 200 && xhr.status < 300) {
            onProgress?.(100);
            resolve();
          } else {
            reject(
              new ApiError({
                status: xhr.status,
                code: xhr.status === 403 || xhr.status === 410 ? 'upload_expired' : 'upload_failed',
                message: `图片上传到对象存储失败（HTTP ${xhr.status}）。`,
              }),
            );
          }
        };
        xhr.onerror = () => {
          cleanup();
          reject(
            new ApiError({
              status: 0,
              code: 'network_error',
              message: '图片上传网络中断，请重试。',
            }),
          );
        };
        xhr.ontimeout = () => {
          cleanup();
          reject(
            new ApiError({
              status: 0,
              code: 'upload_timeout',
              message: '图片上传超时，请检查网络后重试。',
            }),
          );
        };
        xhr.onabort = () => {
          cleanup();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        xhr.send(file);
      }),

    completeUpload: (id) =>
      request<Upload>('POST', `/uploads/${encodeURIComponent(id)}/complete`, {
        requiresCsrf: true,
      }),
    getUpload: (id) => request<Upload>('GET', `/uploads/${encodeURIComponent(id)}`),
    getThumbnail: async (attachmentId, signal) => {
      const response = await fetchResponse('GET', `/attachments/${encodeURIComponent(attachmentId)}/thumbnail`, { signal });
      const thumbnail = await response.blob();
      if (thumbnail.type !== 'image/jpeg' || !thumbnail.size) throw new Error('未取得图片缩略图。');
      return thumbnail;
    },
    getDownload: (attachmentId) =>
      request<DownloadGrant>('GET', `/attachments/${encodeURIComponent(attachmentId)}/download`),

    createCollection: (body, idempotencyKey) =>
      request<Collection>('POST', '/collections', {
        body,
        requiresCsrf: true,
        idempotencyKey,
      }),
    listCollections: (query, signal) =>
      request<CollectionPage>('GET', `/collections${buildQuery(query)}`, { signal }),
    getCollection: (id, signal) =>
      request<Collection>('GET', `/collections/${encodeURIComponent(id)}`, { signal }),
    getCollectionThread: (id, query, signal) =>
      request<CollectionThread>(
        'GET',
        `/collections/${encodeURIComponent(id)}/thread${buildQuery(query)}`,
        { signal },
      ),
    updateCollection: (id, body) =>
      request<Collection>('PATCH', `/collections/${encodeURIComponent(id)}`, {
        body,
        requiresCsrf: true,
      }),
    trashCollection: (id, body) =>
      request<Collection>('DELETE', `/collections/${encodeURIComponent(id)}`, {
        body,
        requiresCsrf: true,
      }),
    restoreCollection: (id, body) =>
      request<Collection>('POST', `/collections/${encodeURIComponent(id)}/restore`, {
        body,
        requiresCsrf: true,
      }),
    purgeCollection: (id, body, idempotencyKey) =>
      request<Accepted>('POST', `/collections/${encodeURIComponent(id)}/purge`, {
        body,
        requiresCsrf: true,
        idempotencyKey,
      }),
    getCollectionPurgeStatus: (id) =>
      request<Accepted>('GET', `/collections/${encodeURIComponent(id)}/purge`),
    setReadState: (id, body) =>
      request<Collection>('PUT', `/collections/${encodeURIComponent(id)}/read`, {
        body,
        requiresCsrf: true,
      }),
    setAIExclusion: (id, body) =>
      request<Collection>('PUT', `/collections/${encodeURIComponent(id)}/ai-exclusion`, {
        body,
        requiresCsrf: true,
      }),
    updateProjectDecisions: (id, body, idempotencyKey) =>
      request<Collection>('PATCH', `/collections/${encodeURIComponent(id)}/projects`, {
        body,
        requiresCsrf: true,
        idempotencyKey,
      }),
    undoProjectDecisions: (id, body) =>
      request<Collection>('POST', `/collections/${encodeURIComponent(id)}/projects/undo`, {
        body,
        requiresCsrf: true,
      }),
    updateTagDecisions: (id, body) =>
      request<Collection>('PATCH', `/collections/${encodeURIComponent(id)}/tags`, {
        body,
        requiresCsrf: true,
      }),
    getOrganization: (id) =>
      request<Organization>('GET', `/collections/${encodeURIComponent(id)}/organization`),
    restartOrganization: (id, idempotencyKey) =>
      request<Organization>('POST', `/collections/${encodeURIComponent(id)}/organization`, {
        requiresCsrf: true,
        idempotencyKey,
      }),
    updateImageNote: (id, body) => request<Collection>('PATCH', `/attachments/${encodeURIComponent(id)}/image-note`, {
      body, requiresCsrf: true,
    }),
    retryImageAnalysis: (attachmentId, body, idempotencyKey) =>
      request<Extraction>('POST', `/attachments/${encodeURIComponent(attachmentId)}/image-analysis/retry`, {
        body, requiresCsrf: true, idempotencyKey,
      }),
    getExtractions: (id) =>
      request<ExtractionList>('GET', `/collections/${encodeURIComponent(id)}/extractions`),
    refreshUrlExtraction: (id, idempotencyKey) =>
      request<Extraction>('POST', `/collections/${encodeURIComponent(id)}/extractions`, {
        requiresCsrf: true,
        idempotencyKey,
      }),
    listRevisions: (id, query) =>
      request<RevisionPage>(
        'GET',
        `/collections/${encodeURIComponent(id)}/revisions${buildQuery(query)}`,
      ),
    searchCollections: (query, signal) =>
      request<SearchPage>('GET', `/search${buildQuery(query)}`, { signal }),

    previewInviteImport: (body, idempotencyKey) =>
      request<InvitePreview>('POST', '/admin/invite-imports', {
        body,
        requiresCsrf: true,
        idempotencyKey,
      }),
    commitInviteImport: (id, idempotencyKey) =>
      request<InviteBatch>('POST', `/admin/invite-imports/${encodeURIComponent(id)}/commit`, {
        requiresCsrf: true,
        idempotencyKey,
      }),
    listInviteBatches: (query) =>
      request<InviteBatchPage>('GET', `/admin/invite-batches${buildQuery(query)}`),
    setInviteBatchStatus: (id, body) =>
      request<InviteBatch>('PATCH', `/admin/invite-batches/${encodeURIComponent(id)}`, {
        body,
        requiresCsrf: true,
      }),
    listInviteCodes: (batchId, query) =>
      request<InviteCodePage>(
        'GET',
        `/admin/invite-batches/${encodeURIComponent(batchId)}/codes${buildQuery(query)}`,
      ),
    setInviteCodeStatus: (id, body) =>
      request<InviteCode>('PATCH', `/admin/invite-codes/${encodeURIComponent(id)}`, {
        body,
        requiresCsrf: true,
      }),
    listUsers: (query) => request<UserPage>('GET', `/admin/users${buildQuery(query)}`),
    setUserStatus: (id, body) =>
      request<User>('PATCH', `/admin/users/${encodeURIComponent(id)}`, {
        body,
        requiresCsrf: true,
      }),
    getBudgets: () => request<BudgetConfig>('GET', '/admin/budgets'),
    setBudgets: (body) =>
      request<BudgetConfig>('PUT', '/admin/budgets', { body, requiresCsrf: true }),
    getModelConfig: () => request<ModelConfig>('GET', '/admin/model-config'),
    setModelConfig: (body) =>
      request<ModelConfig>('PUT', '/admin/model-config', { body, requiresCsrf: true }),
    listFailures: () => request<FailureList>('GET', '/admin/failures'),
  };
}
