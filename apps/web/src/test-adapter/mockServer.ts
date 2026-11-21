import { mockActivity } from './activity';
import { ApiError } from '../api/errors';
import type { OrganizationEventsHandlers, SparkApi } from '../api/client';
import type {
  Accepted,
  Attachment,
  Collection,
  CollectionCreate,
  CollectionSummary,
  Extraction,
  ImageAnalysisPreferences,
  InviteBatch,
  InviteCode,
  Organization,
  OrganizationEvent,
  Project,
  ProjectAssociation,
  ResurfaceResult,
  Revision,
  SearchHit,
  Session,
  Tag,
  Upload,
  User,
} from '../api/types';
import {
  derivePlainText,
  extractFirstHttpUrl,
  inspectSparkDocumentSupport,
  isValidHttpUrl,
} from '../lib/document';
import { parseSearchTerms } from '../lib/highlight';
import { generateUuid } from '../lib/idempotency';

interface StoredUser extends User {
  password: string;
  image_analysis_enabled?: boolean;
  image_consent_version?: string;
}

interface StoredSession extends Session {
  user_id: string;
  csrf_token: string;
  revoked: boolean;
}

interface StoredInviteCode extends InviteCode {
  raw_code: string;
}

export type MockOrganizationMode =
  | 'succeed'
  | 'succeed_no_project'
  | 'fail_then_succeed'
  | 'quota_exceeded'
  | 'integration_not_configured';

export interface MockUploadBehavior {
  unconfigured?: boolean;
  failPutRemaining?: number;
  completeStatus?:
    | 'ready'
    | 'rejected'
    | 'expired'
    | 'verifying_then_ready'
    | 'verifying_then_rejected';
  expireDownloadOnce?: boolean;
}

export interface MockUrlExtractionBehavior {
  unconfigured?: boolean;
  status?: Extraction['status'];
  sourceTitle?: string;
  siteName?: string;
  summary?: string;
  text?: string;
}

export interface MockPurgeBehavior {
  unconfigured?: boolean;
  initialStatus?: Accepted['status'];
  conflictOnce?: boolean;
  failOnce?: boolean;
}

export interface MockImageAnalysisBehavior {
  available?: boolean;
  status?: Extraction['status'];
  text?: string;
  imageDescription?: string;
  truncated?: boolean;
  errorCode?: string;
  quotaExceeded?: boolean;
}

interface StoredCollection extends Collection {
  user_id: string;
  extractions: Extraction[];
  revisions: Revision[];
  mock_org_step?: number;
  mock_org_attempts?: number;
}

interface StoredUpload extends Upload {
  user_id: string;
  filename: string;
  dataUrl?: string;
}

interface StoredAttachmentMeta {
  id: string;
  user_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  dataUrl: string;
}

export interface TestAdapter extends SparkApi {
  reset(): void;
  getLastVerificationCode(email: string): string | undefined;
  simulateExternalCollectionEdit(collectionId: string, textAppend: string): void;
  setMockOrganizationMode(mode: MockOrganizationMode): void;
  setMockTrialEligibility(opts: { ai_trial_eligible?: boolean; ai_platform_enabled?: boolean }): void;
  setMockUploadBehavior(behavior: MockUploadBehavior): void;
  setMockUrlExtractionBehavior(behavior: MockUrlExtractionBehavior): void;
  setMockCollectionExtractions(collectionId: string, items: Extraction[]): void;
  setMockPurgeBehavior(behavior: MockPurgeBehavior): void;
  setMockPurgeStatus(collectionId: string, status: Accepted['status']): void;
  setMockImageAnalysisBehavior(behavior: MockImageAnalysisBehavior): void;
  emitMockOrganizationReady(): void;
  emitMockOrganizationEvent(event: OrganizationEvent): void;
  emitMockOrganizationError(closed?: boolean): void;
  getOrganizationSubscriberCount(): number;
}

const DEFAULT_ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_BATCH_ID = '00000000-0000-4000-8000-000000000101';

export function createTestAdapter(): TestAdapter {
  let users: StoredUser[] = [];
  let sessions: StoredSession[] = [];
  let currentSessionId: string | null = null;
  let clientCsrfToken: string | null = null;
  let unauthorizedHandler: (() => void) | null = null;

  let verifications: Map<
    string,
    { id: string; email: string; purpose: 'register' | 'password_reset'; code: string; attempts: number; consumed: boolean }
  > = new Map();
  let lastCodesByEmail: Map<string, string> = new Map();

  let inviteImports: Map<
    string,
    { id: string; name: string; rows: Array<{ code: string; expires_at?: string; max_uses: number }>; expires_at: string; committed: boolean }
  > = new Map();
  let inviteBatches: InviteBatch[] = [];
  let inviteCodes: StoredInviteCode[] = [];

  let projects: Array<Project & { user_id: string }> = [];
  let tags: Array<Tag & { user_id: string }> = [];
  let uploads: Map<string, StoredUpload> = new Map();
  let attachments: Map<string, StoredAttachmentMeta> = new Map();
  let collections: StoredCollection[] = [];
  const revisitEnabled = new Map<string, boolean>();
  const openedAt = new Map<string, number>();
  const dailyRevisit = new Map<string, Array<{ id: string; reason: ResurfaceResult['items'][number]['reason'] }>>();
  let purges: Map<string, { user_id: string; operation_id: string; status: Accepted['status'] }> =
    new Map();
  let idempotencyStore: Map<string, { digest: string; result: unknown }> = new Map();
  let projectUndoStore: Map<
    string,
    {
      userId: string;
      collectionId: string;
      operationKey: string;
      resultingDecisionVersion: number;
      contentVersion: number;
      previousProjects: ProjectAssociation[];
      expiresAtMs: number;
      used: boolean;
      replayBaseVersion?: number;
      cachedUndoResult?: Collection;
    }
  > = new Map();
  let mockOrganizationMode: MockOrganizationMode = 'succeed';
  let mockAiTrialEligible = true;
  let mockAiPlatformEnabled = true;
  let mockUploadBehavior: MockUploadBehavior = {};
  let mockUrlExtractionBehavior: MockUrlExtractionBehavior = {};
  let mockPurgeBehavior: MockPurgeBehavior = {};
  let mockImageAnalysisBehavior: MockImageAnalysisBehavior = {};
  const orgSubscribers = new Set<{ userId: string; handlers: OrganizationEventsHandlers }>();
  const pendingOrgTimers = new Map<string, number>();

  function clearPendingOrgTimers(): void {
    for (const timerId of pendingOrgTimers.values()) {
      window.clearTimeout(timerId);
    }
    pendingOrgTimers.clear();
  }

  let budgetConfig = {
    version: 1,
    platform_daily_units: 50000000,
    user_daily_units: 2000000,
    worker_concurrency: 2,
  };
  let modelConfig = {
    version: 1,
    enabled: false,
    provider: 'test-adapter-mock',
    model_id: 'mock-organizer-v1',
    region: 'cn-shanghai',
    deployment_scope: 'mock-isolated',
    credential_configured: false,
  };

  function seed(): void {
    const now = new Date().toISOString();
    users = [
      {
        id: DEFAULT_ADMIN_ID,
        email: 'admin@spark.local',
        password: 'SparkAdmin1234!',
        role: 'admin',
        status: 'active',
        ai_enabled: false,
        ai_policy_version: 1,
      },
    ];
    sessions = [];
    currentSessionId = null;
    clientCsrfToken = null;
    verifications = new Map();
    lastCodesByEmail = new Map();
    inviteImports = new Map();
    inviteBatches = [
      {
        id: DEFAULT_BATCH_ID,
        name: '测试适配器初始批次',
        status: 'active',
        total_codes: 2,
        used_codes: 0,
        created_at: now,
      },
    ];
    inviteCodes = [
      {
        id: '00000000-0000-4000-8000-000000000201',
        batch_id: DEFAULT_BATCH_ID,
        raw_code: 'SPARK-TEST-0001',
        max_uses: 1,
        used_count: 0,
        disabled: false,
      },
      {
        id: '00000000-0000-4000-8000-000000000202',
        batch_id: DEFAULT_BATCH_ID,
        raw_code: 'SPARK-TEST-0002',
        max_uses: 5,
        used_count: 0,
        disabled: false,
      },
    ];
    projects = [];
    tags = [];
    uploads = new Map();
    attachments = new Map();
    collections = [];
    revisitEnabled.clear();
    openedAt.clear();
    dailyRevisit.clear();
    purges = new Map();
    idempotencyStore = new Map();
    projectUndoStore = new Map();
    mockOrganizationMode = 'succeed';
    mockAiTrialEligible = true;
    mockAiPlatformEnabled = true;
    mockUploadBehavior = {};
    mockUrlExtractionBehavior = {};
    mockPurgeBehavior = {};
    mockImageAnalysisBehavior = {};
    clearPendingOrgTimers();
    orgSubscribers.clear();
  }

  seed();

  function requireUser(checkCsrf = false): StoredUser {
    if (!currentSessionId) {
      unauthorizedHandler?.();
      throw new ApiError({
        status: 401,
        code: 'session_expired',
        message: '未登录或会话已过期',
        requestId: generateUuid(),
      });
    }
    const sess = sessions.find((s) => s.id === currentSessionId && !s.revoked);
    if (!sess) {
      currentSessionId = null;
      unauthorizedHandler?.();
      throw new ApiError({
        status: 401,
        code: 'session_expired',
        message: '会话已失效，请重新登录',
        requestId: generateUuid(),
      });
    }
    if (checkCsrf && (!clientCsrfToken || clientCsrfToken !== sess.csrf_token)) {
      throw new ApiError({
        status: 403,
        code: 'csrf_failed',
        message: 'CSRF 校验失败',
        requestId: generateUuid(),
      });
    }
    const user = users.find((u) => u.id === sess.user_id && u.status === 'active');
    if (!user) {
      throw new ApiError({
        status: 401,
        code: 'session_expired',
        message: '账号不可用或会话已撤销',
        requestId: generateUuid(),
      });
    }
    return user;
  }

  function requireAdmin(checkCsrf = false): StoredUser {
    const user = requireUser(checkCsrf);
    if (user.role !== 'admin') {
      throw new ApiError({
        status: 403,
        code: 'forbidden',
        message: '需要管理员权限',
        requestId: generateUuid(),
      });
    }
    return user;
  }

  function toPublicUser(u: StoredUser): User {
    return {
      id: u.id,
      email: u.email,
      role: u.role,
      status: u.status,
      ai_enabled: u.ai_enabled,
      ai_policy_version: u.ai_policy_version,
    };
  }

  function computeDisplayTitle(c: Pick<StoredCollection, 'manual_title' | 'document' | 'original_url' | 'organization'>): string {
    if (c.manual_title && c.manual_title.trim()) return c.manual_title.trim();
    if (c.organization.generated_title) return c.organization.generated_title;
    const plain = derivePlainText(c.document).trim();
    if (plain) {
      return plain.split('\n')[0].slice(0, 60);
    }
    if (c.original_url) {
      try {
        return new URL(c.original_url).hostname;
      } catch {
        return c.original_url;
      }
    }
    return '未命名收藏';
  }

  function collectionHasActiveSuggestion(c: StoredCollection): boolean {
    if (c.deleted_at) return false;
    return c.projects.some((pa) => {
      if (pa.decision !== 'suggested') return false;
      const proj = projects.find((p) => p.id === pa.project_id && p.user_id === c.user_id);
      if (!proj || proj.state !== 'active') return false;
      if (pa.project_version !== undefined && proj.version !== pa.project_version) return false;
      return true;
    });
  }

  function buildImageExtractions(
    targetAttachments: Attachment[],
    contentVersion: number,
    user: StoredUser,
    aiExcluded: boolean,
  ): Extraction[] {
    const available = mockImageAnalysisBehavior.available ?? true;
    if (!available || !user.image_analysis_enabled || aiExcluded || targetAttachments.length === 0) {
      return [];
    }
    const now = new Date().toISOString();
    const isQuotaPaused = Boolean(
      mockImageAnalysisBehavior.quotaExceeded || budgetConfig.user_daily_units <= 0,
    );
    return targetAttachments.map((att) => {
      if (isQuotaPaused) {
        return {
          id: generateUuid(),
          source_kind: 'image',
          source_id: att.id,
          content_version: contentVersion,
          status: 'blocked',
          error_code: 'quota_exceeded',
          updated_at: now,
        };
      }
      const status = mockImageAnalysisBehavior.status ?? 'succeeded';
      const includeOutput = status === 'succeeded' || status === 'partial';
      return {
        id: generateUuid(),
        source_kind: 'image',
        source_id: att.id,
        content_version: contentVersion,
        status,
        text: includeOutput
          ? (mockImageAnalysisBehavior.text ?? 'Mock 图中文字：Spark Receipt 2026')
          : undefined,
        image_description: includeOutput
          ? (mockImageAnalysisBehavior.imageDescription ?? 'Mock AI 画面描述：包含笔记摘要的浅色卡片截图')
          : undefined,
        truncated:
          mockImageAnalysisBehavior.truncated ?? (status === 'partial' ? true : undefined),
        error_code: mockImageAnalysisBehavior.errorCode,
        updated_at: now,
      };
    });
  }

  function matchCurrentUrlExtraction(c: StoredCollection): Extraction | undefined {
    if (c.deleted_at || !c.original_url) return undefined;
    return c.extractions.find(
      (ext) =>
        ext.source_kind === 'url' &&
        ext.source_id === c.original_url &&
        ext.content_version === c.content_version,
    );
  }

  function toSummary(c: StoredCollection): CollectionSummary {
    const sortedAttachments = [...c.attachments].sort((a, b) => a.position - b.position);
    const matchedUrl = matchCurrentUrlExtraction(c);
    return {
      id: c.id,
      display_title: c.display_title,
      excerpt: derivePlainText(c.document).trim().slice(0, 180) || c.original_url || c.intent || '（图片收藏）',
      content_types: [...c.content_types],
      projects: structuredClone(c.projects),
      tags: structuredClone(c.tags),
      organization_status: c.organization.status,
      has_suggestion: collectionHasActiveSuggestion(c),
      original_url: c.original_url || undefined,
      cover_attachment_id: sortedAttachments[0]?.id,
      attachment_count: sortedAttachments.length,
      link_preview: matchedUrl
        ? {
            status: matchedUrl.status,
            source_title: matchedUrl.source_title,
            site_name: matchedUrl.site_name,
            summary: matchedUrl.summary,
          }
        : undefined,
      read_at: c.read_at,
      created_at: c.created_at,
      updated_at: c.updated_at,
      resource_version: c.resource_version,
    };
  }

  function notifySubscribers(userId: string, event: OrganizationEvent): void {
    for (const sub of orgSubscribers) {
      if (sub.userId === userId) {
        sub.handlers.onOrganization?.(event);
      }
    }
  }

  function scheduleMockOrganization(col: StoredCollection, user: StoredUser): void {
    const existing = pendingOrgTimers.get(col.id);
    if (existing !== undefined) {
      window.clearTimeout(existing);
      pendingOrgTimers.delete(col.id);
    }
    if (col.organization.status !== 'queued') return;

    const runStep = () => {
      pendingOrgTimers.delete(col.id);
      const currentCol = collections.find((c) => c.id === col.id && c.user_id === user.id);
      if (!currentCol) return;
      if (currentCol.organization.status !== 'queued' && currentCol.organization.status !== 'running') {
        return;
      }
      advanceMockOrganization(currentCol, user);
      notifySubscribers(user.id, {
        collection_id: currentCol.id,
        status: currentCol.organization.status,
        has_suggestion: collectionHasActiveSuggestion(currentCol),
      });
      if (currentCol.organization.status === 'running') {
        const nextId = window.setTimeout(runStep, 60);
        pendingOrgTimers.set(currentCol.id, nextId);
      }
    };

    const timerId = window.setTimeout(runStep, 60);
    pendingOrgTimers.set(col.id, timerId);
  }

  function refreshProjectCounts(userId: string): void {
    for (const proj of projects) {
      if (proj.user_id !== userId) continue;
      proj.collection_count = collections.filter(
        (c) =>
          c.user_id === userId &&
          !c.deleted_at &&
          c.projects.some(
            (pa) =>
              pa.project_id === proj.id &&
              (pa.decision === 'manual' || pa.decision === 'confirmed' || pa.decision === 'auto'),
          ),
      ).length;
    }
  }

  function toPublicCollection(c: StoredCollection): Collection {
    const { user_id: _u, extractions: _e, revisions: _r, ...rest } = c;
    return {
      ...structuredClone(rest),
      has_suggestion: collectionHasActiveSuggestion(c),
    };
  }

  function createSessionFor(user: StoredUser) {
    const csrf = `csrf-${generateUuid()}`;
    const sess: StoredSession = {
      id: generateUuid(),
      user_id: user.id,
      device_label: 'Web 测试适配器浏览器会话',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      current: true,
      csrf_token: csrf,
      revoked: false,
    };
    for (const prev of sessions) {
      prev.current = false;
    }
    sessions.unshift(sess);
    currentSessionId = sess.id;
    clientCsrfToken = csrf;
    return {
      user: toPublicUser(user),
      csrf_token: csrf,
      expires_at: sess.expires_at,
      ai_trial_eligible: mockAiTrialEligible,
      ai_platform_enabled: mockAiPlatformEnabled,
    };
  }

  function checkIdempotency<T>(userId: string, operation: string, key: string, payload: unknown): T | null {
    const mapKey = `${userId}:${operation}:${key}`;
    const existing = idempotencyStore.get(mapKey);
    if (!existing) return null;
    const digest = JSON.stringify(payload);
    if (existing.digest !== digest) {
      throw new ApiError({
        status: 409,
        code: 'idempotency_mismatch',
        message: '幂等键重复但请求内容不一致',
        requestId: generateUuid(),
      });
    }
    return existing.result as T;
  }

  function saveIdempotency(userId: string, operation: string, key: string, payload: unknown, result: unknown): void {
    const mapKey = `${userId}:${operation}:${key}`;
    idempotencyStore.set(mapKey, { digest: JSON.stringify(payload), result });
  }

  function hasTextOrIntentMaterial(col: Pick<StoredCollection, 'document' | 'intent'>): boolean {
    return derivePlainText(col.document).trim().length > 0 || col.intent.trim().length > 0;
  }

  function buildInitialOrganization(
    col: Pick<StoredCollection, 'content_version' | 'document' | 'intent' | 'ai_excluded'>,
    user: StoredUser,
  ): Organization {
    const now = new Date().toISOString();
    if (!user.ai_enabled) {
      return {
        content_version: col.content_version,
        status: 'skipped',
        stages: [{ name: 'generate', status: 'skipped', attempts: 0, error_code: 'ai_disabled' }],
        error_code: 'ai_disabled',
        updated_at: now,
      };
    }
    if (col.ai_excluded) {
      return {
        content_version: col.content_version,
        status: 'skipped',
        stages: [{ name: 'generate', status: 'skipped', attempts: 0, error_code: 'ai_excluded' }],
        error_code: 'ai_excluded',
        updated_at: now,
      };
    }
    if (mockOrganizationMode === 'integration_not_configured') {
      return {
        content_version: col.content_version,
        status: 'skipped',
        stages: [
          {
            name: 'generate',
            status: 'skipped',
            attempts: 0,
            error_code: 'integration_not_configured',
          },
        ],
        error_code: 'integration_not_configured',
        updated_at: now,
      };
    }
    if (mockOrganizationMode === 'quota_exceeded') {
      return {
        run_id: generateUuid(),
        content_version: col.content_version,
        status: 'blocked',
        stages: [
          { name: 'generate', status: 'blocked', attempts: 0, error_code: 'quota_exceeded' },
        ],
        error_code: 'quota_exceeded',
        updated_at: now,
      };
    }
    if (!hasTextOrIntentMaterial(col)) {
      return {
        content_version: col.content_version,
        status: 'skipped',
        stages: [
          {
            name: 'generate',
            status: 'skipped',
            attempts: 0,
            error_code: 'insufficient_material',
          },
        ],
        error_code: 'insufficient_material',
        updated_at: now,
      };
    }
    return {
      run_id: generateUuid(),
      content_version: col.content_version,
      status: 'queued',
      stages: [
        { name: 'generate', status: 'queued', attempts: 0 },
        { name: 'match_projects', status: 'queued', attempts: 0 },
        { name: 'apply', status: 'queued', attempts: 0 },
      ],
      updated_at: now,
    };
  }

  function advanceMockOrganization(col: StoredCollection, user: StoredUser): void {
    const status = col.organization.status;
    if (status !== 'queued' && status !== 'running') return;
    const now = new Date().toISOString();
    const step = (col.mock_org_step ?? 0) + 1;
    col.mock_org_step = step;

    if (step === 1) {
      col.organization = {
        ...col.organization,
        status: 'running',
        stages: [
          { name: 'generate', status: 'running', attempts: 1 },
          { name: 'match_projects', status: 'queued', attempts: 0 },
          { name: 'apply', status: 'queued', attempts: 0 },
        ],
        updated_at: now,
      };
      return;
    }

    const attempts = col.mock_org_attempts ?? 1;
    if (mockOrganizationMode === 'fail_then_succeed' && attempts === 1) {
      col.organization = {
        ...col.organization,
        status: 'failed',
        stages: [
          { name: 'generate', status: 'failed', attempts: 1, error_code: 'provider_timeout' },
          { name: 'match_projects', status: 'skipped', attempts: 0 },
          { name: 'apply', status: 'skipped', attempts: 0 },
        ],
        error_code: 'provider_timeout',
        updated_at: now,
      };
      return;
    }

    const plain = derivePlainText(col.document).trim();
    const intentText = col.intent.trim();
    const sourceSnippet = (plain || intentText).slice(0, 60);
    const evidenceSource: 'original_text' | 'intent' = plain ? 'original_text' : 'intent';
    const generatedTitle = (plain.split('\n')[0] || intentText || '整理结果').slice(0, 32);
    const summary = plain
      ? `核心内容围绕「${plain.slice(0, 48)}」${intentText ? `，用途为${intentText.slice(0, 36)}` : ''}。`
      : `用途记录：${intentText.slice(0, 60)}。`;

    const orgRunId = col.organization.run_id ?? generateUuid();

    if (mockOrganizationMode !== 'succeed_no_project') {
      const activeProjects = projects.filter(
        (p) => p.user_id === user.id && p.state === 'active',
      );
      const matchedProject =
        activeProjects.find((p) => {
          const hay = `${plain}\n${intentText}`.toLowerCase();
          return (
            hay.includes(p.name.toLowerCase()) ||
            p.focus_points.some((fp) => hay.includes(fp.toLowerCase()))
          );
        }) ?? activeProjects[0];

      if (matchedProject) {
        const existingIdx = col.projects.findIndex(
          (pa) => pa.project_id === matchedProject.id,
        );
        if (existingIdx === -1) {
          col.projects.push({
            project_id: matchedProject.id,
            name: matchedProject.name,
            decision: 'suggested',
            reason: `内容与项目「${matchedProject.name}」的关注方向相符`,
            project_version: matchedProject.version,
            suggestion_run_id: orgRunId,
            evidence: [
              {
                source_id: evidenceSource,
                quote: sourceSnippet,
              },
            ],
          });
          col.decision_version += 1;
        }
      }
    }

    col.organization = {
      run_id: orgRunId,
      content_version: col.content_version,
      status: 'succeeded',
      stages: [
        { name: 'generate', status: 'succeeded', attempts: 1 },
        { name: 'match_projects', status: 'succeeded', attempts: 1 },
        { name: 'apply', status: 'succeeded', attempts: 1 },
      ],
      generated_title: generatedTitle,
      summary,
      updated_at: now,
    };
    col.display_title = computeDisplayTitle(col);
    col.resource_version += 1;
    col.updated_at = now;
  }

  return {
    isTestAdapter: true,

    reset() {
      seed();
    },

    getLastVerificationCode(email: string) {
      return lastCodesByEmail.get(email.trim().toLowerCase());
    },

    simulateExternalCollectionEdit(collectionId: string, textAppend: string) {
      const col = collections.find((c) => c.id === collectionId);
      if (!col) return;
      col.content_version += 1;
      col.resource_version += 1;
      col.document = {
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            ...col.document.content.content,
            { type: 'paragraph', content: [{ type: 'text', text: textAppend }] },
          ],
        },
      };
      col.display_title = computeDisplayTitle(col);
      col.updated_at = new Date().toISOString();
    },

    setMockOrganizationMode(mode: MockOrganizationMode) {
      mockOrganizationMode = mode;
    },

    setMockTrialEligibility(opts: { ai_trial_eligible?: boolean; ai_platform_enabled?: boolean }) {
      if (opts.ai_trial_eligible !== undefined) mockAiTrialEligible = opts.ai_trial_eligible;
      if (opts.ai_platform_enabled !== undefined) mockAiPlatformEnabled = opts.ai_platform_enabled;
    },

    setMockUploadBehavior(behavior: MockUploadBehavior) {
      mockUploadBehavior = { ...behavior };
    },

    setMockUrlExtractionBehavior(behavior: MockUrlExtractionBehavior) {
      mockUrlExtractionBehavior = { ...behavior };
    },

    setMockCollectionExtractions(collectionId: string, items: Extraction[]) {
      const col = collections.find((c) => c.id === collectionId);
      if (!col) return;
      col.extractions = structuredClone(items);
    },

    setMockPurgeBehavior(behavior: MockPurgeBehavior) {
      mockPurgeBehavior = { ...behavior };
    },

    setMockPurgeStatus(collectionId: string, status: Accepted['status']) {
      const existing = purges.get(collectionId);
      if (!existing) return;
      existing.status = status;
    },

    setMockImageAnalysisBehavior(behavior: MockImageAnalysisBehavior) {
      mockImageAnalysisBehavior = { ...behavior };
    },


    emitMockOrganizationReady() {
      const sess = currentSessionId ? sessions.find((s) => s.id === currentSessionId && !s.revoked) : undefined;
      if (!sess) return;
      for (const sub of orgSubscribers) {
        if (sub.userId === sess.user_id) {
          sub.handlers.onReady?.();
        }
      }
    },

    emitMockOrganizationEvent(event: OrganizationEvent) {
      const sess = currentSessionId ? sessions.find((s) => s.id === currentSessionId && !s.revoked) : undefined;
      if (!sess) return;
      notifySubscribers(sess.user_id, event);
    },

    emitMockOrganizationError(closed = false) {
      const sess = currentSessionId ? sessions.find((s) => s.id === currentSessionId && !s.revoked) : undefined;
      if (!sess) return;
      for (const sub of orgSubscribers) {
        if (sub.userId === sess.user_id) {
          sub.handlers.onError?.({ closed });
        }
      }
    },

    getOrganizationSubscriberCount() {
      return orgSubscribers.size;
    },

    subscribeOrganizationEvents(handlers) {
      const sess = currentSessionId ? sessions.find((s) => s.id === currentSessionId && !s.revoked) : undefined;
      if (!sess) {
        queueMicrotask(() => {
          handlers.onError?.({ closed: true });
        });
        return () => {};
      }
      const entry = { userId: sess.user_id, handlers };
      orgSubscribers.add(entry);
      queueMicrotask(() => {
        if (orgSubscribers.has(entry)) {
          handlers.onReady?.();
        }
      });
      return () => {
        orgSubscribers.delete(entry);
      };
    },

    setCsrfToken(token) {
      clientCsrfToken = token;
    },

    setUnauthorizedHandler(handler) {
      unauthorizedHandler = handler;
    },

    async healthLive() {
      return { status: 'ok' };
    },

    async healthReady() {
      return { status: 'ok' };
    },

    async sendVerification(body) {
      const normalized = body.email.trim().toLowerCase();
      const id = generateUuid();
      const code = String(Math.floor(100000 + Math.random() * 900000));
      verifications.set(id, {
        id,
        email: normalized,
        purpose: body.purpose,
        code,
        attempts: 0,
        consumed: false,
      });
      lastCodesByEmail.set(normalized, code);
      return {
        challenge_id: id,
        expires_in: 600,
        resend_after: 60,
      };
    },

    async register(body) {
      const normalized = body.email.trim().toLowerCase();
      const challenge = verifications.get(body.challenge_id);
      if (!challenge || challenge.consumed || challenge.email !== normalized || challenge.purpose !== 'register') {
        throw new ApiError({
          status: 422,
          code: 'registration_failed',
          message: '邮箱验证码无效或已过期',
          requestId: generateUuid(),
        });
      }
      if (challenge.code !== body.verification_code) {
        challenge.attempts += 1;
        throw new ApiError({
          status: 422,
          code: 'registration_failed',
          message: '验证码不正确',
          requestId: generateUuid(),
        });
      }
      const invite = inviteCodes.find((c) => c.raw_code === body.invite_code.trim());
      const batch = invite ? inviteBatches.find((b) => b.id === invite.batch_id) : undefined;
      if (!invite || !batch || batch.status !== 'active' || invite.disabled || invite.used_count >= invite.max_uses) {
        throw new ApiError({
          status: 409,
          code: 'invite_unavailable',
          message: '邀请码不可用、已禁用或已达到使用上限',
          requestId: generateUuid(),
        });
      }
      if (users.some((u) => u.email === normalized)) {
        throw new ApiError({
          status: 422,
          code: 'registration_failed',
          message: '注册失败，请检查邮箱、验证码与邀请码',
          requestId: generateUuid(),
        });
      }
      challenge.consumed = true;
      invite.used_count += 1;
      batch.used_codes += 1;
      const newUser: StoredUser = {
        id: generateUuid(),
        email: normalized,
        password: body.password,
        role: 'user',
        status: 'active',
        ai_enabled: false,
        ai_policy_version: 1,
      };
      users.push(newUser);
      return createSessionFor(newUser);
    },

    async login(body) {
      const normalized = body.email.trim().toLowerCase();
      const user = users.find((u) => u.email === normalized && u.password === body.password);
      if (!user || user.status !== 'active') {
        throw new ApiError({
          status: 401,
          code: 'authentication_failed',
          message: '邮箱或密码错误，或账号已停用',
          requestId: generateUuid(),
        });
      }
      return createSessionFor(user);
    },

    async resetPassword(body) {
      const normalized = body.email.trim().toLowerCase();
      const challenge = verifications.get(body.challenge_id);
      const user = users.find((u) => u.email === normalized);
      if (
        !challenge ||
        challenge.consumed ||
        challenge.email !== normalized ||
        challenge.purpose !== 'password_reset' ||
        challenge.code !== body.verification_code ||
        !user
      ) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '重置密码校验失败，请确认邮箱和验证码正确',
          requestId: generateUuid(),
        });
      }
      challenge.consumed = true;
      user.password = body.new_password;
      for (const s of sessions) {
        if (s.user_id === user.id) s.revoked = true;
      }
      currentSessionId = null;
      clientCsrfToken = null;
    },

    async logout() {
      if (currentSessionId) {
        const sess = sessions.find((s) => s.id === currentSessionId);
        if (sess) sess.revoked = true;
      }
      currentSessionId = null;
      clientCsrfToken = null;
    },

    async currentSession() {
      if (!currentSessionId) {
        throw new ApiError({
          status: 401,
          code: 'session_expired',
          message: '未登录',
          requestId: generateUuid(),
        });
      }
      const sess = sessions.find((s) => s.id === currentSessionId && !s.revoked);
      const user = sess ? users.find((u) => u.id === sess.user_id && u.status === 'active') : undefined;
      if (!sess || !user) {
        currentSessionId = null;
        throw new ApiError({
          status: 401,
          code: 'session_expired',
          message: '会话已过期',
          requestId: generateUuid(),
        });
      }
      clientCsrfToken = sess.csrf_token;
      return {
        user: toPublicUser(user),
        csrf_token: sess.csrf_token,
        expires_at: sess.expires_at,
        ai_trial_eligible: mockAiTrialEligible,
        ai_platform_enabled: mockAiPlatformEnabled,
      };
    },

    async getActivity(query) {
      const user = requireUser();
      return mockActivity(query, collections.filter(c => c.user_id === user.id && !c.deleted_at).map(c => c.created_at));
    },
    async recordCollectionOpened(id) {
      const user = requireUser(true);
      const c = collections.find(c => c.id === id && c.user_id === user.id);
      if (!c) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (c.deleted_at) throw new ApiError({ status: 409, code: 'collection_in_trash', message: '收藏位于回收站' });
      openedAt.set(id, Date.now());
    },
    async getResurfacePreferences() {
      return { enabled: revisitEnabled.get(requireUser().id) ?? true };
    },
    async setResurfacePreferences({ enabled }) {
      revisitEnabled.set(requireUser(true).id, enabled);
      return { enabled };
    },
    async getResurface(tz) {
      const user = requireUser();
      const format = new Intl.DateTimeFormat('sv-SE', { timeZone: tz });
      const now = Date.now();
      const date = format.format(now);
      if (revisitEnabled.get(user.id) === false) return { date, items: [] };
      const key = `${user.id}/${date}`;
      const visible = collections.filter(c => c.user_id === user.id && !c.deleted_at);
      if (!dailyRevisit.has(key)) {
        const reasons = ['unclassified', 'inactive_project', 'anniversary'] as const;
        const candidates = visible.map(c => {
          const created = Date.parse(c.created_at);
          const assigned = c.projects.filter(p => ['manual', 'auto', 'confirmed'].includes(p.decision));
          const active = assigned.some(p => projects.some(project => project.id === p.project_id && project.state === 'active'));
          const createdDate = format.format(created);
          let rank = 3;
          if (!assigned.length && now - created >= 7 * 86_400_000) rank = 0;
          else if (active && now - (openedAt.get(c.id) ?? created) >= 30 * 86_400_000) rank = 1;
          else if (createdDate < date && createdDate.slice(5) === date.slice(5)) rank = 2;
          return { id: c.id, rank };
        }).filter(c => c.rank < 3).sort((a, b) => a.rank - b.rank);
        dailyRevisit.set(key, candidates.slice(0, 3).map(c => ({ id: c.id, reason: reasons[c.rank] })));
      }
      const items = (dailyRevisit.get(key) ?? []).flatMap(({ id, reason }) => {
        const c = visible.find(item => item.id === id);
        return c ? [{ collection: toSummary(c), reason }] : [];
      });
      return { date, items };
    },
    async hideResurfaceItem(id, date, tz) {
      const user = requireUser(true);
      if (new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(Date.now()) !== date) {
        throw new ApiError({ status: 409, code: 'resource_conflict', message: '日期已更新' });
      }
      const key = `${user.id}/${date}`;
      dailyRevisit.set(key, (dailyRevisit.get(key) ?? []).filter(item => item.id !== id));
    },
    async updatePreferences(body) {
      const user = requireUser(true);
      user.ai_enabled = body.ai_enabled;
      user.ai_policy_version += 1;
      return toPublicUser(user);
    },

    async getImageAnalysisPreferences(): Promise<ImageAnalysisPreferences> {
      const user = requireUser(false);
      return {
        enabled: Boolean(user.image_analysis_enabled),
        available: mockImageAnalysisBehavior.available ?? true,
        required_consent_version: 'deepseek-images-v1',
      };
    },

    async setImageAnalysisPreferences(body): Promise<ImageAnalysisPreferences> {
      const user = requireUser(true);
      const available = mockImageAnalysisBehavior.available ?? true;
      if (body.enabled) {
        if (!available) {
          throw new ApiError({
            status: 503,
            code: 'integration_not_configured',
            message: '当前平台尚未启用图片理解服务。',
          });
        }
        if (body.consent_version !== 'deepseek-images-v1') {
          throw new ApiError({
            status: 422,
            code: 'validation_failed',
            message: '需要确认最新的 deepseek-images-v1 图片授权版本。',
          });
        }
        user.image_analysis_enabled = true;
        user.image_consent_version = body.consent_version;
      } else {
        user.image_analysis_enabled = false;
      }
      return {
        enabled: Boolean(user.image_analysis_enabled),
        available,
        required_consent_version: 'deepseek-images-v1',
      };
    },

    async getUsage() {
      requireUser(false);
      return {
        budget_day: new Date().toISOString().slice(0, 10),
        timezone: 'Asia/Shanghai',
        limit_units: budgetConfig.user_daily_units,
        reserved_units: 0,
        settled_units: 0,
        blocked: Boolean(mockImageAnalysisBehavior.quotaExceeded || budgetConfig.user_daily_units <= 0),
      };
    },

    async exportMyData() {
      requireUser(false);
      throw new ApiError({ status: 503, code: 'service_unavailable', message: '数据导出需要连接真实服务。' });
    },

    async listSessions() {
      const user = requireUser(false);
      return {
        items: sessions
          .filter((s) => s.user_id === user.id && !s.revoked)
          .map(({ user_id: _u, csrf_token: _c, revoked: _r, ...rest }) => rest),
      };
    },

    async revokeSession(id) {
      const user = requireUser(true);
      const sess = sessions.find((s) => s.id === id && s.user_id === user.id && !s.revoked);
      if (!sess) {
        throw new ApiError({ status: 404, code: 'not_found', message: '会话不存在' });
      }
      sess.revoked = true;
      if (sess.id === currentSessionId) {
        currentSessionId = null;
        clientCsrfToken = null;
      }
    },

    async createProject(body, idempotencyKey) {
      const user = requireUser(true);
      const replay = checkIdempotency<Project>(user.id, 'createProject', idempotencyKey, body);
      if (replay) return replay;

      const now = new Date().toISOString();
      const proj: Project & { user_id: string } = {
        id: generateUuid(),
        user_id: user.id,
        name: body.name.trim(),
        description: body.description,
        focus_points: body.focus_points,
        state: 'active',
        version: 1,
        collection_count: 0,
        created_at: now,
        updated_at: now,
      };
      projects.unshift(proj);
      const { user_id: _u, ...pub } = proj;
      saveIdempotency(user.id, 'createProject', idempotencyKey, body, pub);
      return pub;
    },

    async listProjects(query) {
      const user = requireUser(false);
      refreshProjectCounts(user.id);
      let items = projects
        .filter((p) => p.user_id === user.id)
        .filter((p) => !query?.state || p.state === query.state)
        .map(({ user_id: _u, ...rest }) => rest);
      if (query?.limit) {
        items = items.slice(0, query.limit);
      }
      return { items };
    },

    async getProject(id) {
      const user = requireUser(false);
      refreshProjectCounts(user.id);
      const proj = projects.find((p) => p.id === id && p.user_id === user.id);
      if (!proj) {
        throw new ApiError({ status: 404, code: 'not_found', message: '项目不存在' });
      }
      const { user_id: _u, ...pub } = proj;
      return pub;
    },

    async updateProject(id, body) {
      const user = requireUser(true);
      const proj = projects.find((p) => p.id === id && p.user_id === user.id);
      if (!proj) {
        throw new ApiError({ status: 404, code: 'not_found', message: '项目不存在' });
      }
      if (proj.version !== body.base_version) {
        throw new ApiError({
          status: 409,
          code: 'resource_conflict',
          message: '项目已被更新，请刷新当前版本后再保存',
          details: { current_version: proj.version },
        });
      }
      if (body.name !== undefined) proj.name = body.name.trim();
      if (body.description !== undefined) proj.description = body.description;
      if (body.focus_points !== undefined) proj.focus_points = body.focus_points;
      if (body.state !== undefined) proj.state = body.state;
      proj.version += 1;
      proj.updated_at = new Date().toISOString();
      refreshProjectCounts(user.id);
      const { user_id: _u, ...pub } = proj;
      return pub;
    },

    async createTag(body, idempotencyKey) {
      const user = requireUser(true);
      const replay = checkIdempotency<Tag>(user.id, 'createTag', idempotencyKey, body);
      if (replay) return replay;

      const trimmed = body.name.trim();
      const existing = tags.find(
        (t) =>
          t.user_id === user.id &&
          t.name.toLowerCase() === trimmed.toLowerCase() &&
          t.parent_id === body.parent_id,
      );
      if (existing) {
        const { user_id: _u, ...pub } = existing;
        return pub;
      }
      const tag: Tag & { user_id: string } = {
        id: generateUuid(),
        user_id: user.id,
        name: trimmed,
        parent_id: body.parent_id,
        path: trimmed,
        collection_count: 0,
      };
      tags.push(tag);
      const { user_id: _u, ...pub } = tag;
      saveIdempotency(user.id, 'createTag', idempotencyKey, body, pub);
      return pub;
    },

    async listTags(query) {
      const user = requireUser(false);
      const q = query?.q?.trim().toLowerCase();
      const items = tags
        .filter((t) => t.user_id === user.id)
        .filter((t) => !q || t.name.toLowerCase().includes(q) || t.path.toLowerCase().includes(q))
        .map(({ user_id: _u, ...rest }) => rest);
      return { items };
    },

    async renameTag(id, body) {
      const user = requireUser(true);
      const tag = tags.find((t) => t.id === id && t.user_id === user.id);
      if (!tag) throw new ApiError({ status: 404, code: 'not_found', message: '标签不存在' });
      if (tag.name !== body.expected_name) {
        throw new ApiError({ status: 409, code: 'resource_conflict', message: '标签名已变更' });
      }
      tag.name = body.name.trim();
      tag.path = tag.name;
      const { user_id: _u, ...pub } = tag;
      return pub;
    },

    async createUpload(body, idempotencyKey) {
      const user = requireUser(true);
      if (mockUploadBehavior.unconfigured) {
        throw new ApiError({
          status: 503,
          code: 'integration_not_configured',
          message: '当前环境尚未配置对象存储服务凭证',
        });
      }
      const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      if (
        !body.filename ||
        !body.filename.trim() ||
        body.filename.length > 200 ||
        /[/\\\u0000-\u001F\u007F]/.test(body.filename) ||
        body.size_bytes <= 0 ||
        body.size_bytes > 5 * 1024 * 1024 ||
        !allowedMimes.has(body.mime_type)
      ) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '图片文件名、格式或大小不符合要求',
        });
      }
      const replay = checkIdempotency<string>(user.id, 'upload', idempotencyKey, body);
      const id = replay ?? generateUuid();
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const key = `mock-upload:${user.id}:${id}:${idempotencyKey}`;
      if (replay && uploads.get(id)?.status !== 'pending') {
        throw new ApiError({ status: 409, code: 'upload_not_pending', message: '上传已结束，请重新选择图片。' });
      }
      if (!replay) {
        uploads.set(id, {
          id,
          user_id: user.id,
          filename: body.filename,
          status: 'pending',
          size_bytes: body.size_bytes,
          mime_type: body.mime_type,
          expires_at: expiresAt,
        });
        saveIdempotency(user.id, 'upload', idempotencyKey, body, id);
      }
      return {
        id,
        method: 'PUT',
        url: `mock-oss://${key}`,
        headers: { 'Content-Type': body.mime_type },
        expires_at: expiresAt,
      };
    },

    async uploadFileBytes(grant, file, onProgress, signal) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const item = uploads.get(grant.id);
      if (!item) {
        throw new ApiError({ status: 404, code: 'not_found', message: '上传会话不存在' });
      }
      if (mockUploadBehavior.failPutRemaining && mockUploadBehavior.failPutRemaining > 0) {
        mockUploadBehavior.failPutRemaining -= 1;
        throw new ApiError({
          status: 502,
          code: 'upload_failed',
          message: '图片上传到对象存储失败，请重试',
        });
      }
      onProgress?.(40);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        const onAbort = () => {
          reader.abort();
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }
        reader.onload = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(String(reader.result ?? ''));
        };
        reader.onerror = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve('');
        };
        reader.onabort = () => {
          signal?.removeEventListener('abort', onAbort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        reader.readAsDataURL(file);
      });
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      item.dataUrl = dataUrl;
      onProgress?.(100);
    },

    async completeUpload(id) {
      const user = requireUser(true);
      const item = uploads.get(id);
      if (!item || item.user_id !== user.id) {
        throw new ApiError({ status: 404, code: 'not_found', message: '上传会话不存在' });
      }
      if (mockUploadBehavior.completeStatus === 'rejected') {
        item.status = 'rejected';
        item.error_code = 'invalid_image';
      } else if (mockUploadBehavior.completeStatus === 'expired') {
        item.status = 'expired';
        item.error_code = 'upload_expired';
      } else if (
        mockUploadBehavior.completeStatus === 'verifying_then_ready' ||
        mockUploadBehavior.completeStatus === 'verifying_then_rejected'
      ) {
        item.status = 'verifying';
      } else {
        item.status = 'ready';
      }
      const { user_id: _u, filename: _f, dataUrl: _d, ...pub } = item;
      return pub;
    },

    async getUpload(id) {
      const user = requireUser(false);
      const item = uploads.get(id);
      if (!item || item.user_id !== user.id) {
        throw new ApiError({ status: 404, code: 'not_found', message: '上传会话不存在' });
      }
      if (item.status === 'verifying') {
        if (mockUploadBehavior.completeStatus === 'verifying_then_ready') {
          item.status = 'ready';
        } else if (mockUploadBehavior.completeStatus === 'verifying_then_rejected') {
          item.status = 'rejected';
          item.error_code = 'invalid_image';
        }
      }
      const { user_id: _u, filename: _f, dataUrl: _d, ...pub } = item;
      return pub;
    },

    async getDownload(attachmentId) {
      const user = requireUser(false);
      const att = attachments.get(attachmentId);
      if (!att || att.user_id !== user.id) {
        throw new ApiError({ status: 404, code: 'not_found', message: '附件不存在' });
      }
      if (mockUploadBehavior.expireDownloadOnce) {
        mockUploadBehavior.expireDownloadOnce = false;
        return {
          url: 'mock-expired://stale-download',
          expires_at: new Date(Date.now() - 1000).toISOString(),
        };
      }
      return {
        url: att.dataUrl,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },

    async createCollection(body: CollectionCreate, idempotencyKey) {
      const user = requireUser(true);
      const replay = checkIdempotency<Collection>(user.id, 'createCollection', idempotencyKey, body);
      if (replay) return replay;

      const support = inspectSparkDocumentSupport(body.document);
      if (!support.supported) {
        throw new ApiError({
          status: 422,
          code: 'unsupported_document',
          message: support.reason ?? '不支持的文档格式',
        });
      }

      const plainText = derivePlainText(body.document).trim();
      const detectedUrl = body.original_url?.trim() || extractFirstHttpUrl(body.document);
      if (detectedUrl && !isValidHttpUrl(detectedUrl)) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '仅支持无凭据的 HTTP(S) 网址',
        });
      }
      if (!plainText && !detectedUrl && body.upload_ids.length === 0) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '正文、有效网址或图片附件至少保留一项',
        });
      }
      if (body.upload_ids.length > 9 || new Set(body.upload_ids).size !== body.upload_ids.length) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '每条收藏最多只能关联 9 张不重复的图片附件',
        });
      }

      const boundAttachments = body.upload_ids.map((uid, idx) => {
        const up = uploads.get(uid);
        if (!up || up.user_id !== user.id || up.status !== 'ready') {
          throw new ApiError({
            status: 422,
            code: 'invalid_attachment',
            message: '附件尚未上传确认完成',
          });
        }
        up.status = 'attached';
        const attId = generateUuid();
        attachments.set(attId, {
          id: attId,
          user_id: user.id,
          filename: up.filename,
          mime_type: up.mime_type ?? 'image/png',
          size_bytes: up.size_bytes ?? 1,
          dataUrl: up.dataUrl ?? '',
        });
        return {
          id: attId,
          filename: up.filename,
          mime_type: up.mime_type ?? 'image/png',
          size_bytes: up.size_bytes ?? 1,
          position: idx,
        };
      });

      const projAssocs = body.project_ids.map((pid) => {
        const proj = projects.find((p) => p.id === pid && p.user_id === user.id);
        if (!proj) {
          throw new ApiError({ status: 404, code: 'not_found', message: '关联项目不存在' });
        }
        return {
          project_id: proj.id,
          name: proj.name,
          decision: 'manual' as const,
          project_version: proj.version,
        };
      });

      const tagAssocs = body.tag_ids.map((tid) => {
        const tag = tags.find((t) => t.id === tid && t.user_id === user.id);
        if (!tag) {
          throw new ApiError({ status: 404, code: 'not_found', message: '关联标签不存在' });
        }
        return {
          tag_id: tag.id,
          path: tag.path,
          decision: 'manual' as const,
        };
      });

      const contentTypes: Array<'text' | 'url' | 'image'> = [];
      if (plainText) contentTypes.push('text');
      if (detectedUrl) contentTypes.push('url');
      if (boundAttachments.length > 0) contentTypes.push('image');

      const now = new Date().toISOString();
      const normalizedIntent = body.intent ?? '';
      const org = buildInitialOrganization(
        {
          content_version: 1,
          document: body.document,
          intent: normalizedIntent,
          ai_excluded: Boolean(body.ai_excluded),
        },
        user,
      );

      const col: StoredCollection = {
        id: body.id,
        user_id: user.id,
        document: body.document,
        intent: normalizedIntent,
        original_url: detectedUrl,
        manual_title: body.manual_title?.trim() || undefined,
        display_title: '',
        content_types: contentTypes,
        content_version: 1,
        resource_version: 1,
        decision_version: 1,
        attachments: boundAttachments,
        projects: projAssocs,
        tags: tagAssocs,
        organization: org,
        ai_excluded: Boolean(body.ai_excluded),
        created_at: now,
        updated_at: now,
        extractions: buildImageExtractions(boundAttachments, 1, user, Boolean(body.ai_excluded)),
        revisions: [
          {
            content_version: 1,
            document: body.document,
            intent: body.intent,
            original_url: detectedUrl,
            manual_title: body.manual_title?.trim() || undefined,
            attachment_ids: boundAttachments.map((a) => a.id),
            created_at: now,
          },
        ],
        mock_org_step: 0,
        mock_org_attempts: org.status === 'queued' ? 1 : 0,
      };
      col.display_title = computeDisplayTitle(col);
      collections.unshift(col);
      refreshProjectCounts(user.id);
      const pub = toPublicCollection(col);
      saveIdempotency(user.id, 'createCollection', idempotencyKey, body, pub);
      scheduleMockOrganization(col, user);
      return pub;
    },

    async listCollections(query) {
      const user = requireUser(false);
      const scope = query?.scope ?? 'active';
      const filtered = collections
        .filter((c) => c.user_id === user.id)
        .filter((c) => {
          if (scope === 'trash') return Boolean(c.deleted_at);
          if (c.deleted_at) return false;
          if (scope === 'unclassified') {
            return !c.projects.some(
              (p) => p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto',
            );
          }
          return true;
        })
        .filter((c) => {
          if (!query?.project_id) return true;
          return c.projects.some(
            (p) =>
              p.project_id === query.project_id &&
              (p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto'),
          );
        })
        .filter((c) => {
          if (!query?.tag_id) return true;
          return c.tags.some(
            (t) =>
              t.tag_id === query.tag_id &&
              (t.decision === 'manual' || t.decision === 'confirmed' || t.decision === 'auto'),
          );
        })
        .filter(c => !query?.created_from || Date.parse(c.created_at) >= Date.parse(query.created_from))
        .filter(c => !query?.created_to || Date.parse(c.created_at) < Date.parse(query.created_to))
        .filter((c) => !query?.type || c.content_types.includes(query.type))
        .filter((c) => {
          if (query?.read === undefined) return true;
          return query.read ? Boolean(c.read_at) : !c.read_at;
        })
        .filter((c) => {
          if (query?.has_suggestion === undefined) return true;
          return collectionHasActiveSuggestion(c) === query.has_suggestion;
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

      const limit = query?.limit ?? 30;
      const offset = query?.cursor ? Number(query.cursor) || 0 : 0;
      const slice = filtered.slice(offset, offset + limit);
      const nextCursor = offset + limit < filtered.length ? String(offset + limit) : undefined;
      return {
        items: slice.map(toSummary),
        next_cursor: nextCursor,
        ...(query?.has_suggestion !== undefined ? { total: filtered.length } : {}),
      };
    },

    async getCollection(id) {
      const user = requireUser(false);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      return toPublicCollection(col);
    },

    async updateCollection(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_in_trash',
          message: '收藏位于回收站中，请先恢复后再编辑',
        });
      }
      if (col.content_version !== body.base_content_version) {
        throw new ApiError({
          status: 409,
          code: 'content_conflict',
          message: '内容已被更新，请对比服务器版本后重新保存。',
          details: { current_content_version: col.content_version },
        });
      }

      if (body.document !== undefined) col.document = body.document;
      if (body.intent !== undefined) col.intent = body.intent;
      if (body.original_url !== undefined) {
        col.original_url =
          body.original_url === '' ? extractFirstHttpUrl(col.document) : body.original_url.trim();
      }
      if (body.manual_title !== undefined) {
        col.manual_title = body.manual_title === '' ? undefined : body.manual_title.trim();
      }
      let nextAttachments = [...col.attachments];
      if (body.attachment_ids !== undefined) {
        const seen = new Set<string>();
        const reordered: typeof nextAttachments = [];
        const existingMap = new Map(col.attachments.map((a) => [a.id, a]));
        for (const aid of body.attachment_ids) {
          if (seen.has(aid)) {
            throw new ApiError({
              status: 422,
              code: 'validation_failed',
              message: '附件列表包含重复项',
            });
          }
          const matched = existingMap.get(aid);
          if (!matched) {
            throw new ApiError({
              status: 422,
              code: 'invalid_attachment',
              message: '所选已有附件不存在或不属于当前收藏',
            });
          }
          seen.add(aid);
          reordered.push({ ...matched });
        }
        nextAttachments = reordered;
      }
      const uploadIds = body.upload_ids ?? [];
      if (new Set(uploadIds).size !== uploadIds.length) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '新增上传列表中包含重复项',
        });
      }
      if (nextAttachments.length + uploadIds.length > 9) {
        throw new ApiError({
          status: 422,
          code: 'validation_failed',
          message: '每条收藏最多只能包含 9 张图片附件',
        });
      }
      const newlyBoundAttachments: Attachment[] = [];
      if (uploadIds.length > 0) {
        for (const uid of uploadIds) {
          const up = uploads.get(uid);
          if (!up || up.user_id !== user.id || up.status !== 'ready') {
            throw new ApiError({
              status: 422,
              code: 'invalid_attachment',
              message: '新增图片尚未上传完成',
            });
          }
          up.status = 'attached';
          const attId = generateUuid();
          attachments.set(attId, {
            id: attId,
            user_id: user.id,
            filename: up.filename,
            mime_type: up.mime_type ?? 'image/png',
            size_bytes: up.size_bytes ?? 1,
            dataUrl: up.dataUrl ?? '',
          });
          const bound: Attachment = {
            id: attId,
            filename: up.filename,
            mime_type: up.mime_type ?? 'image/png',
            size_bytes: up.size_bytes ?? 1,
            position: nextAttachments.length,
          };
          nextAttachments.push(bound);
          newlyBoundAttachments.push(bound);
        }
      }
      col.attachments = nextAttachments.map((att, idx) => ({ ...att, position: idx }));
      const activeAttachmentIds = new Set(col.attachments.map((att) => att.id));
      col.extractions = [
        ...col.extractions.filter(
          (ext) => ext.source_kind !== 'image' || activeAttachmentIds.has(ext.source_id),
        ),
        ...buildImageExtractions(
          newlyBoundAttachments,
          col.content_version + 1,
          user,
          col.ai_excluded,
        ),
      ];

      const plain = derivePlainText(col.document).trim();
      const nextTypes: Array<'text' | 'url' | 'image'> = [];
      if (plain) nextTypes.push('text');
      if (col.original_url) nextTypes.push('url');
      if (col.attachments.length > 0) nextTypes.push('image');
      col.content_types = nextTypes;
      col.content_version += 1;
      col.resource_version += 1;
      col.updated_at = new Date().toISOString();
      col.organization = buildInitialOrganization(col, user);
      col.mock_org_step = 0;
      col.mock_org_attempts = col.organization.status === 'queued' ? 1 : 0;
      col.display_title = computeDisplayTitle(col);
      col.revisions.unshift({
        content_version: col.content_version,
        document: col.document,
        intent: col.intent,
        original_url: col.original_url,
        manual_title: col.manual_title,
        attachment_ids: col.attachments.map((a) => a.id),
        created_at: col.updated_at,
      });

      scheduleMockOrganization(col, user);
      return toPublicCollection(col);
    },

    async trashCollection(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.resource_version !== body.base_resource_version) {
        throw new ApiError({
          status: 409,
          code: 'resource_conflict',
          message: '收藏状态已变更，请刷新后重试',
        });
      }
      const now = new Date();
      col.deleted_at = now.toISOString();
      col.purge_after = new Date(now.getTime() + 30 * 86400_000).toISOString();
      col.resource_version += 1;
      col.updated_at = col.deleted_at;
      refreshProjectCounts(user.id);
      return toPublicCollection(col);
    },

    async restoreCollection(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.resource_version !== body.base_resource_version) {
        throw new ApiError({
          status: 409,
          code: 'resource_conflict',
          message: '收藏版本已变更，请刷新后重试',
        });
      }
      col.deleted_at = undefined;
      col.purge_after = undefined;
      col.resource_version += 1;
      col.updated_at = new Date().toISOString();
      refreshProjectCounts(user.id);
      return toPublicCollection(col);
    },

    async purgeCollection(id, body, idempotencyKey) {
      const user = requireUser(true);
      const existingPurge = purges.get(id);
      if (existingPurge && existingPurge.user_id === user.id) {
        return { operation_id: existingPurge.operation_id, status: existingPurge.status };
      }
      const replay = checkIdempotency<Accepted>(
        user.id,
        'purgeCollection',
        idempotencyKey,
        { id, body },
      );
      if (replay) return replay;

      if (mockPurgeBehavior.unconfigured) {
        throw new ApiError({
          status: 503,
          code: 'integration_not_configured',
          message: '永久删除暂未开启。',
        });
      }
      if (mockPurgeBehavior.failOnce) {
        mockPurgeBehavior.failOnce = false;
        throw new ApiError({
          status: 503,
          code: 'service_unavailable',
          message: '服务暂时不可用，请稍后重试',
        });
      }

      const idx = collections.findIndex((c) => c.id === id && c.user_id === user.id);
      if (idx === -1) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      const col = collections[idx];
      if (!col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_not_in_trash',
          message: '请先将收藏移入回收站。',
        });
      }
      if (mockPurgeBehavior.conflictOnce) {
        mockPurgeBehavior.conflictOnce = false;
        col.resource_version += 1;
        throw new ApiError({
          status: 409,
          code: 'resource_conflict',
          message: '资源版本已变更，请刷新后重试',
        });
      }
      if (col.resource_version !== body.base_resource_version) {
        throw new ApiError({ status: 409, code: 'resource_conflict', message: '版本已变更' });
      }
      collections.splice(idx, 1);
      refreshProjectCounts(user.id);
      const status = mockPurgeBehavior.initialStatus ?? 'completed';
      const operationId = generateUuid();
      purges.set(id, { user_id: user.id, operation_id: operationId, status });
      const res: Accepted = { operation_id: operationId, status };
      saveIdempotency(user.id, 'purgeCollection', idempotencyKey, { id, body }, res);
      return res;
    },

    async getCollectionPurgeStatus(id) {
      const user = requireUser(false);
      const existing = purges.get(id);
      if (!existing || existing.user_id !== user.id) {
        throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      }
      return { operation_id: existing.operation_id, status: existing.status };
    },

    async setReadState(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      col.read_at = body.read ? col.read_at ?? new Date().toISOString() : undefined;
      col.resource_version += 1;
      return toPublicCollection(col);
    },

    async setAIExclusion(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_in_trash',
          message: '收藏位于回收站，无法修改 AI 整理授权',
        });
      }
      col.ai_excluded = body.excluded;
      if (
        body.excluded &&
        (col.organization.status === 'queued' || col.organization.status === 'running')
      ) {
        col.organization = {
          content_version: col.content_version,
          status: 'skipped',
          stages: [
            { name: 'generate', status: 'skipped', attempts: 0, error_code: 'ai_excluded' },
          ],
          error_code: 'ai_excluded',
          updated_at: new Date().toISOString(),
        };
      }
      col.resource_version += 1;
      return toPublicCollection(col);
    },

    async updateProjectDecisions(id, body, idempotencyKey) {
      const user = requireUser(true);
      if (idempotencyKey) {
        const cached = checkIdempotency<Collection>(
          user.id,
          `patch-projects:${id}`,
          idempotencyKey,
          body,
        );
        if (cached) return cached;
      }

      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_in_trash',
          message: '收藏位于回收站，无法调整项目归属',
        });
      }
      if (col.decision_version !== body.base_decision_version) {
        throw new ApiError({
          status: 409,
          code: 'decision_conflict',
          message: '关联版本已更新，请刷新后重试',
        });
      }

      // Validate all operations and expected suggestions before mutating
      for (const op of body.operations) {
        const proj = projects.find((p) => p.id === op.id && p.user_id === user.id);
        if (!proj) throw new ApiError({ status: 404, code: 'not_found', message: '项目不存在' });
        if (op.expected_suggestion) {
          const currentAssoc = col.projects.find((p) => p.project_id === op.id);
          const versionMatches =
            currentAssoc?.project_version === undefined ||
            currentAssoc.project_version === op.expected_suggestion.project_version;
          const runMatches =
            !currentAssoc?.suggestion_run_id ||
            currentAssoc.suggestion_run_id === op.expected_suggestion.run_id;
          const projectStillActiveAndMatched =
            proj.state === 'active' && proj.version === op.expected_suggestion.project_version;
          if (
            !currentAssoc ||
            currentAssoc.decision !== 'suggested' ||
            !versionMatches ||
            !runMatches ||
            !projectStillActiveAndMatched
          ) {
            throw new ApiError({
              status: 409,
              code: 'suggestion_conflict',
              message: '这条建议已在其他地方处理，请刷新后重试',
            });
          }
        }
      }

      const previousProjects: ProjectAssociation[] = col.projects.map((p) => ({
        ...p,
        evidence: p.evidence ? p.evidence.map((e) => ({ ...e })) : undefined,
      }));

      let changed = false;
      for (const op of body.operations) {
        const proj = projects.find((p) => p.id === op.id && p.user_id === user.id)!;
        const idx = col.projects.findIndex((p) => p.project_id === op.id);
        if (op.action === 'reset') {
          if (idx !== -1) {
            col.projects.splice(idx, 1);
            changed = true;
          }
        } else if (op.action === 'include') {
          if (idx !== -1) {
            const cur = col.projects[idx];
            if (cur.decision === 'suggested') {
              col.projects[idx] = { ...cur, decision: 'confirmed' };
              changed = true;
            } else if (cur.decision === 'rejected') {
              col.projects[idx] = { ...cur, decision: 'manual' };
              changed = true;
            }
          } else {
            col.projects.push({
              project_id: proj.id,
              name: proj.name,
              decision: 'manual',
              project_version: proj.version,
            });
            changed = true;
          }
        } else if (op.action === 'exclude') {
          if (idx !== -1) {
            if (col.projects[idx].decision !== 'rejected') {
              col.projects[idx] = { ...col.projects[idx], decision: 'rejected' };
              changed = true;
            }
          } else {
            col.projects.push({
              project_id: proj.id,
              name: proj.name,
              decision: 'rejected',
              project_version: proj.version,
            });
            changed = true;
          }
        }
      }

      let result: Collection;
      if (changed) {
        col.decision_version += 1;
        col.resource_version += 1;
        col.updated_at = new Date().toISOString();
        refreshProjectCounts(user.id);
        result = toPublicCollection(col);
        if (idempotencyKey && idempotencyKey.length >= 16) {
          const receipt = {
            operation_key: idempotencyKey,
            decision_version: col.decision_version,
            expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          };
          projectUndoStore.set(`${user.id}:${id}:${idempotencyKey}`, {
            userId: user.id,
            collectionId: id,
            operationKey: idempotencyKey,
            resultingDecisionVersion: col.decision_version,
            contentVersion: col.content_version,
            previousProjects,
            expiresAtMs: Date.now() + 10 * 60_000,
            used: false,
          });
          result = { ...result, undo_receipt: receipt };
        }
      } else {
        result = toPublicCollection(col);
      }

      if (idempotencyKey) {
        saveIdempotency(user.id, `patch-projects:${id}`, idempotencyKey, body, result);
      }
      return result;
    },

    async undoProjectDecisions(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });

      const entry = projectUndoStore.get(`${user.id}:${id}:${body.operation_key}`);
      if (!entry || entry.userId !== user.id || entry.collectionId !== id) {
        throw new ApiError({
          status: 409,
          code: 'undo_unavailable',
          message: '撤销回执不可用或已过期',
        });
      }
      if (entry.used) {
        if (entry.replayBaseVersion === body.base_decision_version && entry.cachedUndoResult) {
          return entry.cachedUndoResult;
        }
        throw new ApiError({
          status: 409,
          code: 'undo_unavailable',
          message: '该次操作已撤销，无法重复使用回执',
        });
      }
      if (Date.now() > entry.expiresAtMs) {
        throw new ApiError({
          status: 409,
          code: 'undo_unavailable',
          message: '撤销回执已过期，无法撤销',
        });
      }
      if (col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_in_trash',
          message: '收藏位于回收站，无法撤销项目决定',
        });
      }
      if (
        col.decision_version !== body.base_decision_version ||
        col.decision_version !== entry.resultingDecisionVersion
      ) {
        throw new ApiError({
          status: 409,
          code: 'decision_conflict',
          message: '关联版本已更新，无法撤销上一步操作',
        });
      }

      for (const prevAssoc of entry.previousProjects) {
        if (prevAssoc.decision === 'suggested') {
          if (col.content_version !== entry.contentVersion) {
            throw new ApiError({
              status: 409,
              code: 'suggestion_conflict',
              message: '正文版本已变更，原有 AI 建议已失效',
            });
          }
          const proj = projects.find((p) => p.id === prevAssoc.project_id && p.user_id === user.id);
          if (
            !proj ||
            proj.state !== 'active' ||
            (prevAssoc.project_version !== undefined && proj.version !== prevAssoc.project_version)
          ) {
            throw new ApiError({
              status: 409,
              code: 'suggestion_conflict',
              message: '建议关联的项目状态或版本已变更，无法恢复原建议',
            });
          }
        }
      }

      col.projects = entry.previousProjects.map((p) => ({
        ...p,
        evidence: p.evidence ? p.evidence.map((e) => ({ ...e })) : undefined,
      }));
      col.decision_version += 1;
      col.resource_version += 1;
      col.updated_at = new Date().toISOString();
      refreshProjectCounts(user.id);

      const restored = toPublicCollection(col);
      entry.used = true;
      entry.replayBaseVersion = body.base_decision_version;
      entry.cachedUndoResult = restored;
      return restored;
    },

    async updateTagDecisions(id, body) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.decision_version !== body.base_decision_version) {
        throw new ApiError({ status: 409, code: 'decision_conflict', message: '关联版本冲突' });
      }
      for (const op of body.operations) {
        const tag = tags.find((t) => t.id === op.id && t.user_id === user.id);
        if (!tag) throw new ApiError({ status: 404, code: 'not_found', message: '标签不存在' });
        const idx = col.tags.findIndex((t) => t.tag_id === op.id);
        if (op.action === 'reset') {
          if (idx !== -1) col.tags.splice(idx, 1);
        } else if (op.action === 'include') {
          if (idx !== -1) col.tags[idx] = { ...col.tags[idx], decision: 'confirmed' };
          else col.tags.push({ tag_id: tag.id, path: tag.path, decision: 'manual' });
        } else if (op.action === 'exclude') {
          if (idx !== -1) col.tags[idx] = { ...col.tags[idx], decision: 'rejected' };
          else col.tags.push({ tag_id: tag.id, path: tag.path, decision: 'rejected' });
        }
      }
      col.decision_version += 1;
      col.resource_version += 1;
      col.updated_at = new Date().toISOString();
      return toPublicCollection(col);
    },

    async getOrganization(id) {
      const user = requireUser(false);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      return col.organization;
    },

    async restartOrganization(id, idempotencyKey) {
      const user = requireUser(true);
      const replay = checkIdempotency<Organization>(user.id, 'restartOrganization', idempotencyKey, {
        id,
      });
      if (replay) return replay;

      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_in_trash',
          message: '收藏位于回收站，请先恢复后再整理',
        });
      }
      if (!user.ai_enabled) {
        throw new ApiError({ status: 403, code: 'ai_disabled', message: 'AI 自动整理未开启' });
      }
      if (col.ai_excluded) {
        throw new ApiError({ status: 403, code: 'ai_excluded', message: '该条收藏已设置不参与 AI 整理' });
      }
      if (mockOrganizationMode === 'integration_not_configured') {
        throw new ApiError({
          status: 503,
          code: 'integration_not_configured',
          message: '当前平台尚未配置模型服务凭证，已完整保存你的原文。',
        });
      }
      if (!hasTextOrIntentMaterial(col)) {
        throw new ApiError({
          status: 422,
          code: 'insufficient_material',
          message: '当前收藏缺少可供整理的文字或用途说明，补充后再试。',
        });
      }
      if (mockOrganizationMode === 'quota_exceeded') {
        throw new ApiError({
          status: 429,
          code: 'quota_exceeded',
          message: '今日 AI 额度已达上限，收藏仍可正常保存。',
        });
      }
      const nextAttempts = (col.mock_org_attempts ?? 0) + 1;
      const nextOrg = buildInitialOrganization(col, user);
      col.organization = nextOrg;
      col.mock_org_step = 0;
      col.mock_org_attempts = nextAttempts;
      saveIdempotency(user.id, 'restartOrganization', idempotencyKey, { id }, nextOrg);
      scheduleMockOrganization(col, user);
      return nextOrg;
    },

    async getExtractions(id) {
      const user = requireUser(false);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.deleted_at) return { items: [] };
      const activeAttachmentIds = new Set(col.attachments.map((a) => a.id));
      return {
        items: structuredClone(
          col.extractions.filter(
            (ext) => ext.source_kind !== 'image' || activeAttachmentIds.has(ext.source_id),
          ),
        ),
      };
    },

    async refreshUrlExtraction(id, idempotencyKey) {
      const user = requireUser(true);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      const replay = checkIdempotency<Extraction>(user.id, 'refreshUrlExtraction', idempotencyKey, {
        id,
      });
      if (replay) {
        return (col && matchCurrentUrlExtraction(col)) ?? replay;
      }

      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      if (col.deleted_at) {
        throw new ApiError({
          status: 409,
          code: 'collection_in_trash',
          message: '收藏位于回收站，请先恢复后再操作',
        });
      }
      if (mockUrlExtractionBehavior.unconfigured) {
        throw new ApiError({
          status: 503,
          code: 'integration_not_configured',
          message: '当前平台尚未开启网页抓取功能',
        });
      }
      if (!col.original_url) {
        throw new ApiError({
          status: 422,
          code: 'missing_url',
          message: '当前收藏没有可重新获取的主要网址',
        });
      }
      const existing = matchCurrentUrlExtraction(col);
      if (existing && (existing.status === 'queued' || existing.status === 'running')) {
        saveIdempotency(user.id, 'refreshUrlExtraction', idempotencyKey, { id }, existing);
        return existing;
      }

      const status = mockUrlExtractionBehavior.status ?? 'queued';
      const next: Extraction = {
        id: generateUuid(),
        content_version: col.content_version,
        source_kind: 'url',
        source_id: col.original_url,
        status,
        source_title:
          status === 'succeeded'
            ? mockUrlExtractionBehavior.sourceTitle ?? '已获取网页标题'
            : undefined,
        site_name:
          status === 'succeeded' ? mockUrlExtractionBehavior.siteName ?? 'Example Site' : undefined,
        summary:
          status === 'succeeded'
            ? mockUrlExtractionBehavior.summary ?? '这是网页正文的简洁摘要内容。'
            : undefined,
        text:
          status === 'succeeded'
            ? mockUrlExtractionBehavior.text ?? '这是用于搜索的网页正文片段。'
            : undefined,
        updated_at: new Date().toISOString(),
      };
      col.extractions.unshift(next);
      saveIdempotency(user.id, 'refreshUrlExtraction', idempotencyKey, { id }, next);
      return next;
    },

    async listRevisions(id) {
      const user = requireUser(false);
      const col = collections.find((c) => c.id === id && c.user_id === user.id);
      if (!col) throw new ApiError({ status: 404, code: 'not_found', message: '收藏不存在' });
      return { items: col.revisions };
    },

    async searchCollections(query) {
      const user = requireUser(false);
      const terms = parseSearchTerms(query.q);
      const scope = query.scope ?? 'active';

      const hits: SearchHit[] = [];
      const sorted = [...collections]
        .filter((c) => c.user_id === user.id)
        .filter((c) => {
          if (scope === 'trash') return Boolean(c.deleted_at);
          if (c.deleted_at) return false;
          if (scope === 'unclassified') {
            return !c.projects.some(
              (p) => p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto',
            );
          }
          return true;
        })
        .filter((c) => {
          if (!query.project_id) return true;
          return c.projects.some(
            (p) =>
              p.project_id === query.project_id &&
              (p.decision === 'manual' || p.decision === 'confirmed' || p.decision === 'auto'),
          );
        })
        .filter((c) => {
          if (!query.tag_id) return true;
          return c.tags.some(
            (t) =>
              t.tag_id === query.tag_id &&
              (t.decision === 'manual' || t.decision === 'confirmed' || t.decision === 'auto'),
          );
        })
        .filter((c) => !query.type || c.content_types.includes(query.type))
        .filter((c) => {
          if (query.read === undefined) return true;
          return query.read ? Boolean(c.read_at) : !c.read_at;
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

      for (const c of sorted) {
        const plain = derivePlainText(c.document);
        const tagText = c.tags.map((t) => t.path).join(' ');
        const activeAttachmentIds = new Set(c.attachments.map((a) => a.id));
        const urlExtText = c.extractions
          .filter((e) => e.source_kind === 'url')
          .map((e) => e.text ?? '')
          .join('\n');
        const activeImageExts = c.extractions.filter(
          (e) =>
            e.source_kind === 'image' &&
            activeAttachmentIds.has(e.source_id) &&
            (e.status === 'succeeded' || e.status === 'partial'),
        );
        const imageText = activeImageExts.map((e) => e.text ?? '').filter(Boolean).join('\n');
        const imageDesc = activeImageExts
          .map((e) => e.image_description ?? '')
          .filter(Boolean)
          .join('\n');
        const fields: Array<{
          field:
            | 'title'
            | 'text'
            | 'intent'
            | 'url'
            | 'extraction'
            | 'image_text'
            | 'image_description'
            | 'tag';
          value: string;
        }> = [
          { field: 'title', value: c.display_title ?? '' },
          { field: 'text', value: plain },
          { field: 'intent', value: c.intent ?? '' },
          { field: 'url', value: c.original_url ?? '' },
          { field: 'extraction', value: urlExtText },
          { field: 'image_text', value: imageText },
          { field: 'image_description', value: imageDesc },
          { field: 'tag', value: tagText },
        ];
        const haystack = fields.map((f) => f.value.toLowerCase()).join('\n');
        if (!terms.every((t) => haystack.includes(t.toLowerCase()))) {
          continue;
        }
        const snippets: SearchHit['snippets'] = [];
        for (const f of fields) {
          if (!f.value) continue;
          const lower = f.value.toLowerCase();
          if (terms.some((t) => lower.includes(t.toLowerCase()))) {
            snippets.push({ field: f.field, text: f.value.slice(0, 160) });
          }
        }
        hits.push({ collection: toSummary(c), snippets });
      }
      return { items: hits };
    },

    async previewInviteImport(body) {
      requireAdmin(true);
      const lines = body.csv
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const errors: Array<{ row: number; code: string; message: string }> = [];
      const rows: Array<{ code: string; expires_at?: string; max_uses: number }> = [];
      const seen = new Set<string>();

      lines.forEach((line, index) => {
        const rowNum = index + 1;
        if (index === 0 && line.toLowerCase().startsWith('code,')) {
          return;
        }
        const parts = line.split(',').map((s) => s.trim());
        const code = parts[0] ?? '';
        const expiresAt = parts[1] || undefined;
        const maxUsesRaw = parts[2] ? Number(parts[2]) : 1;

        if (!/^[A-Za-z0-9-]{12,64}$/.test(code)) {
          errors.push({
            row: rowNum,
            code: 'invalid_code',
            message: '邀请码需为 12 至 64 位字母、数字或连字符',
          });
          return;
        }
        if (seen.has(code) || inviteCodes.some((c) => c.raw_code === code)) {
          errors.push({ row: rowNum, code: 'duplicate_code', message: '邀请码与已有或当前文件重复' });
          return;
        }
        if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
          errors.push({ row: rowNum, code: 'invalid_expiry', message: '到期时间格式无效' });
          return;
        }
        if (!Number.isInteger(maxUsesRaw) || maxUsesRaw < 1) {
          errors.push({ row: rowNum, code: 'invalid_max_uses', message: '可用次数需为正整数' });
          return;
        }
        seen.add(code);
        rows.push({ code, expires_at: expiresAt, max_uses: maxUsesRaw });
      });

      const id = generateUuid();
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      inviteImports.set(id, { id, name: body.name.trim(), rows, expires_at: expiresAt, committed: false });
      return {
        id,
        valid_rows: rows.length,
        errors,
        expires_at: expiresAt,
      };
    },

    async commitInviteImport(id) {
      requireAdmin(true);
      const preview = inviteImports.get(id);
      if (!preview) {
        throw new ApiError({ status: 410, code: 'import_expired', message: '导入预览不存在或已过期' });
      }
      if (preview.committed) {
        const existing = inviteBatches.find((b) => b.name === preview.name);
        if (existing) return existing;
      }
      const batchId = generateUuid();
      const batch: InviteBatch = {
        id: batchId,
        name: preview.name,
        status: 'active',
        total_codes: preview.rows.length,
        used_codes: 0,
        created_at: new Date().toISOString(),
      };
      inviteBatches.unshift(batch);
      for (const row of preview.rows) {
        inviteCodes.push({
          id: generateUuid(),
          batch_id: batchId,
          raw_code: row.code,
          max_uses: row.max_uses,
          used_count: 0,
          disabled: false,
          expires_at: row.expires_at,
        });
      }
      preview.committed = true;
      return batch;
    },

    async listInviteBatches() {
      requireAdmin(false);
      return { items: inviteBatches };
    },

    async setInviteBatchStatus(id, body) {
      requireAdmin(true);
      const batch = inviteBatches.find((b) => b.id === id);
      if (!batch) throw new ApiError({ status: 404, code: 'not_found', message: '批次不存在' });
      batch.status = body.status;
      return batch;
    },

    async listInviteCodes(batchId) {
      requireAdmin(false);
      return {
        items: inviteCodes
          .filter((c) => c.batch_id === batchId)
          .map(({ raw_code: _rc, ...rest }) => rest),
      };
    },

    async setInviteCodeStatus(id, body) {
      requireAdmin(true);
      const code = inviteCodes.find((c) => c.id === id);
      if (!code) throw new ApiError({ status: 404, code: 'not_found', message: '邀请码不存在' });
      code.disabled = body.disabled;
      const { raw_code: _rc, ...pub } = code;
      return pub;
    },

    async listUsers(query) {
      requireAdmin(false);
      const limit = Math.max(1, Math.min(100, query?.limit ?? 50));
      const offset = query?.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
      const slice = users.slice(offset, offset + limit);
      const nextCursor = offset + limit < users.length ? String(offset + limit) : undefined;
      return {
        items: slice.map(toPublicUser),
        next_cursor: nextCursor,
      };
    },

    async setUserStatus(id, body) {
      requireAdmin(true);
      const user = users.find((u) => u.id === id);
      if (!user) throw new ApiError({ status: 404, code: 'not_found', message: '用户不存在' });
      user.status = body.status;
      if (body.status === 'disabled') {
        for (const s of sessions) {
          if (s.user_id === user.id) s.revoked = true;
        }
      }
      return toPublicUser(user);
    },

    async getBudgets() {
      requireAdmin(false);
      return budgetConfig;
    },

    async setBudgets(body) {
      requireAdmin(true);
      if (body.base_version !== budgetConfig.version) {
        throw new ApiError({ status: 409, code: 'resource_conflict', message: '预算版本冲突' });
      }
      budgetConfig = {
        version: budgetConfig.version + 1,
        platform_daily_units: body.platform_daily_units,
        user_daily_units: body.user_daily_units,
        worker_concurrency: body.worker_concurrency,
      };
      return budgetConfig;
    },

    async getModelConfig() {
      requireAdmin(false);
      return modelConfig;
    },

    async setModelConfig(body) {
      requireAdmin(true);
      if (body.base_version !== modelConfig.version) {
        throw new ApiError({ status: 409, code: 'resource_conflict', message: '模型配置版本冲突' });
      }
      modelConfig = {
        version: modelConfig.version + 1,
        enabled: body.enabled,
        provider: body.provider,
        model_id: body.model_id,
        region: body.region,
        deployment_scope: body.deployment_scope,
        credential_configured: false,
      };
      return modelConfig;
    },

    async listFailures() {
      requireAdmin(false);
      return { items: [] };
    },
  };
}
