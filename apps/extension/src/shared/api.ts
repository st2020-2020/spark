import { isTrustedSparkOrigin } from './config';
import type {
  ExtensionCollectionCreate,
  ExtensionProjectPage,
  ExtensionSession,
} from './types';

export interface ExtensionTokenResult {
  token: string;
  account_id: string;
  account_label: string;
  expires_at: string;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class ExtensionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ExtensionApiError';
    this.status = status;
    this.code = code;
  }
}

export function buildPinnedApiUrl(origin: string, path: string): string {
  const normalizedOrigin = new URL(origin).origin;
  if (!isTrustedSparkOrigin(normalizedOrigin)) {
    throw new ExtensionApiError(
      403,
      'origin_not_allowed',
      '已阻止向非固定 Spark 站点发送扩展请求。',
    );
  }
  if (!path.startsWith('/')) {
    throw new Error('API path must start with /');
  }
  return `${normalizedOrigin}/api/v1${path}`;
}

async function parseError(res: Response): Promise<ExtensionApiError> {
  let code = 'request_failed';
  let message = `请求失败（HTTP ${res.status}）`;
  try {
    const payload = (await res.json()) as ApiErrorBody;
    if (payload?.error?.code) {
      code = payload.error.code;
    }
    if (payload?.error?.message) {
      message = payload.error.message;
    }
  } catch {
    // Response may be non-JSON on gateway/proxy error; keep status summary.
  }
  return new ExtensionApiError(res.status, code, message);
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  origin: string,
  path: string,
  init: {
    method: 'GET' | 'POST' | 'DELETE';
    token?: string;
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<{ status: number; data: T; headers: Headers }> {
  const url = buildPinnedApiUrl(origin, path);
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (init.token) {
    headers.Authorization = `Bearer ${init.token}`;
  }
  if (init.idempotencyKey) {
    headers['Idempotency-Key'] = init.idempotencyKey;
  }
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ExtensionApiError(
      0,
      'network_error',
      '无法连接固定 Spark 服务或检测到重定向拦截，已阻止发送凭据并保留当前内容。',
    );
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  if (res.status === 204) {
    return { status: res.status, data: undefined as T, headers: res.headers };
  }

  try {
    const data = (await res.json()) as T;
    return { status: res.status, data, headers: res.headers };
  } catch {
    throw new ExtensionApiError(0, 'invalid_response', '服务端响应中断或格式异常，请稍后重试或前往 Spark 核对。');
  }
}

export interface ExtensionApiClient {
  redeemToken(origin: string, verifier: string): Promise<ExtensionTokenResult>;
  getSession(origin: string, token: string): Promise<Omit<ExtensionSession, 'token' | 'origin' | 'browser' | 'connected_at'>>;
  revokeSession(origin: string, token: string): Promise<void>;
  listProjects(
    origin: string,
    token: string,
    query?: { q?: string; limit?: number; cursor?: string },
  ): Promise<ExtensionProjectPage>;
  createCollection(
    origin: string,
    token: string,
    payload: ExtensionCollectionCreate,
    idempotencyKey: string,
  ): Promise<{ id: string; replayed: boolean }>;
}

export function createExtensionApiClient(fetchImpl: typeof fetch = fetch): ExtensionApiClient {
  return {
    async redeemToken(origin, verifier) {
      const { data } = await requestJson<ExtensionTokenResult>(fetchImpl, origin, '/extension/token', {
        method: 'POST',
        body: { verifier },
      });
      return data;
    },

    async getSession(origin, token) {
      const { data } = await requestJson<{
        account_id: string;
        account_label: string;
        expires_at: string;
      }>(fetchImpl, origin, '/extension/session', {
        method: 'GET',
        token,
      });
      return data;
    },

    async revokeSession(origin, token) {
      await requestJson<void>(fetchImpl, origin, '/extension/session', {
        method: 'DELETE',
        token,
      });
    },

    async listProjects(origin, token, query) {
      const params = new URLSearchParams();
      if (query?.q?.trim()) params.set('q', query.q.trim());
      if (query?.limit) params.set('limit', String(query.limit));
      if (query?.cursor) params.set('cursor', query.cursor);
      const qs = params.toString();
      const { data } = await requestJson<ExtensionProjectPage>(
        fetchImpl,
        origin,
        `/extension/projects${qs ? `?${qs}` : ''}`,
        {
          method: 'GET',
          token,
        },
      );
      return data;
    },

    async createCollection(origin, token, payload, idempotencyKey) {
      const { data, headers } = await requestJson<{ id: string }>(
        fetchImpl,
        origin,
        '/extension/collections',
        {
          method: 'POST',
          token,
          body: payload,
          idempotencyKey,
        },
      );
      return {
        id: data.id,
        replayed: headers.get('Idempotent-Replayed')?.toLowerCase() === 'true',
      };
    },
  };
}
