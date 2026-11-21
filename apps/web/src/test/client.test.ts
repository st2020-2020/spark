import { describe, expect, it, vi } from 'vitest';
import { createRealApiClient, UPLOAD_TRANSFER_TIMEOUT_MS } from '../api/client';
import { ApiError } from '../api/errors';
import { EMPTY_DOCUMENT } from '../lib/document';

describe('realApiClient', () => {
  it('attaches X-CSRF-Token and Idempotency-Key on mutations and never fakes success on 503', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

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
          csrf_token: 'csrf-secret-123',
          expires_at: '2030-01-01T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const client = createRealApiClient();
    await client.login({ email: 'u1@example.com', password: 'password123456' });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'service_unavailable',
            message: 'db down',
            request_id: 'req-99',
          },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      client.createCollection(
        {
          id: '11111111-1111-4111-8111-111111111111',
          document: EMPTY_DOCUMENT,
          intent: '',
          upload_ids: [],
          project_ids: [],
          tag_ids: [],
        },
        'spk-11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
      requestId: 'req-99',
    } satisfies Partial<ApiError>);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(secondInit.credentials).toBe('include');
    expect(secondInit.headers).toMatchObject({
      'X-CSRF-Token': 'csrf-secret-123',
      'Idempotency-Key': 'spk-11111111-1111-4111-8111-111111111111',
    });

    vi.unstubAllGlobals();
  });

  it('retains the session token for retry after a logout transport failure', async () => {
    const client = createRealApiClient();
    client.setCsrfToken('session-A');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(client.logout()).rejects.toMatchObject({ code: 'network_error' });
      await client.logout();
      expect(fetchMock.mock.calls[1][1].headers['X-CSRF-Token']).toBe('session-A');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the new session when an earlier account receives a late 401', async () => {
    const client = createRealApiClient();
    const expired = vi.fn();
    client.setUnauthorizedHandler(expired);
    client.setCsrfToken('session-A');
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() =>
      new Promise<Response>((resolve) => { finish = resolve; }),
    ).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const stale = client.getCollection('stale');
      client.setCsrfToken('session-B');
      finish(new Response(null, { status: 401 }));
      await expect(stale).rejects.toMatchObject({ status: 401 });
      expect(expired).not.toHaveBeenCalled();
      await client.revokeSession('other');
      expect(fetchMock.mock.calls[1][1].headers['X-CSRF-Token']).toBe('session-B');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an uncertain write if the successful response body is interrupted', async () => {
    const client = createRealApiClient();
    client.setCsrfToken('session-A');
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError()); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    try {
      const write = client.updateProjectDecisions('item', {
        base_decision_version: 1, operations: [{ id: 'project', action: 'include' }],
      }, crypto.randomUUID());
      await expect(write).rejects.toMatchObject({ status: 0, code: 'invalid_response' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('subscribes to same-origin /api/v1/organization/events with credentials and cleans up', () => {
    const listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
    const closeMock = vi.fn();
    let capturedUrl = '';
    let capturedInit: EventSourceInit | undefined;
    let instanceReadyState = 1;

    class MockEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      constructor(url: string | URL, init?: EventSourceInit) {
        capturedUrl = String(url);
        capturedInit = init;
      }
      get readyState() {
        return instanceReadyState;
      }
      addEventListener(type: string, cb: (ev: MessageEvent) => void) {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(cb);
      }
      removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
        listeners.get(type)?.delete(cb);
      }
      close() {
        instanceReadyState = 2;
        closeMock();
      }
    }

    vi.stubGlobal('EventSource', MockEventSource);
    const client = createRealApiClient();
    const onReady = vi.fn();
    const onOrganization = vi.fn();
    const onError = vi.fn();

    const unsub = client.subscribeOrganizationEvents({ onReady, onOrganization, onError });
    expect(capturedUrl).toBe('/api/v1/organization/events');
    expect(capturedInit).toEqual({ withCredentials: true });

    for (const cb of listeners.get('ready') ?? []) {
      cb(new MessageEvent('ready', { data: '{}' }));
    }
    expect(onReady).toHaveBeenCalledTimes(1);

    for (const cb of listeners.get('organization') ?? []) {
      cb(
        new MessageEvent('organization', {
          data: JSON.stringify({
            collection_id: 'col-1',
            status: 'succeeded',
            has_suggestion: true,
          }),
        }),
      );
      cb(new MessageEvent('organization', { data: 'not-json' }));
    }
    expect(onOrganization).toHaveBeenCalledTimes(1);
    expect(onOrganization).toHaveBeenCalledWith({
      collection_id: 'col-1',
      status: 'succeeded',
      has_suggestion: true,
    });

    instanceReadyState = 2;
    for (const cb of listeners.get('error') ?? []) {
      cb(new MessageEvent('error'));
    }
    expect(onError).toHaveBeenCalledWith({ closed: true });
    expect(closeMock).toHaveBeenCalled();

    unsub();
    expect(listeners.get('ready')?.size ?? 0).toBe(0);
    expect(listeners.get('organization')?.size ?? 0).toBe(0);
    vi.unstubAllGlobals();
  });

  it('downloads export ZIP with filename and surfaces 429 Retry-After metadata', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    fetchMock.mockResolvedValueOnce(
      new Response(new Blob(['zip-bytes'], { type: 'application/zip' }), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="spark-export-20261119.zip"',
        },
      }),
    );

    const client = createRealApiClient();
    await expect(client.exportMyData('markdown')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
    client.setCsrfToken('test-export');
    const res = await client.exportMyData('markdown');
    expect(res.filename).toBe('spark-export-20261119.zip');
    expect(res.blob.size).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me/export?format=markdown',
      expect.objectContaining({ method: 'GET', credentials: 'include' }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'rate_limited',
            message: '导出过于频繁',
            request_id: 'req-429',
          },
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'Retry-After': '45',
          },
        },
      ),
    );

    await expect(client.exportMyData('json')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfter: '45',
    } satisfies Partial<ApiError>);

    vi.unstubAllGlobals();
  });

  it('sends Idempotency-Key on updateProjectDecisions and calls undoProjectDecisions with CSRF token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const client = createRealApiClient();
    client.setCsrfToken('csrf-triage-1');
    const operationKey = crypto.randomUUID();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'col-1', decision_version: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.updateProjectDecisions(
      'col-1',
      {
        base_decision_version: 1,
        operations: [
          {
            id: 'proj-1',
            action: 'include',
            expected_suggestion: { run_id: 'run-1', project_version: 1 },
          },
        ],
      },
      operationKey,
    );

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/collections/col-1/projects');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'X-CSRF-Token': 'csrf-triage-1',
      'Idempotency-Key': operationKey,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'col-1', decision_version: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await client.undoProjectDecisions('col-1', {
      operation_key: operationKey,
      base_decision_version: 2,
    });

    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/collections/col-1/projects/undo');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      'X-CSRF-Token': 'csrf-triage-1',
    });

    vi.unstubAllGlobals();
  });

  it('bounds XHR uploadFileBytes with timeout, does not auto-retry, and keeps AbortSignal cancel separate', async () => {
    class MockXHR {
      static instances: MockXHR[] = [];
      method = '';
      url = '';
      headers: Record<string, string> = {};
      timeout = 0;
      aborted = false;
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;

      constructor() {
        MockXHR.instances.push(this);
      }
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
      send(_body: unknown) {}
    }

    vi.stubGlobal('XMLHttpRequest', MockXHR);
    try {
      const client = createRealApiClient();
      const grant = {
        id: 'up-1',
        method: 'PUT' as const,
        url: 'https://oss.example.com/object',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '12' },
        expires_at: '2030-01-01T00:00:00Z',
      };
      const file = new File(['hello-bytes!'], 'sample.png', { type: 'image/png' });

      // Timeout case: sets bounded timeout, skips forbidden Content-Length, fails with upload_timeout and zero auto-retries
      const timeoutPromise = client.uploadFileBytes(grant, file, undefined, undefined, 2500);
      expect(MockXHR.instances).toHaveLength(1);
      const xhr1 = MockXHR.instances[0];
      expect(xhr1.timeout).toBe(2500);
      expect(xhr1.headers).toEqual({ 'Content-Type': 'image/png' });
      xhr1.ontimeout?.();
      await expect(timeoutPromise).rejects.toMatchObject({
        status: 0,
        code: 'upload_timeout',
        message: '图片上传超时，请检查网络后重试。',
      } satisfies Partial<ApiError>);
      expect(MockXHR.instances).toHaveLength(1);

      // Default bounded timeout + AbortSignal cancellation keeps AbortError distinct
      const ac = new AbortController();
      const abortPromise = client.uploadFileBytes(grant, file, undefined, ac.signal);
      expect(MockXHR.instances).toHaveLength(2);
      const xhr2 = MockXHR.instances[1];
      expect(xhr2.timeout).toBe(UPLOAD_TRANSFER_TIMEOUT_MS);
      ac.abort();
      expect(xhr2.aborted).toBe(true);
      await expect(abortPromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(MockXHR.instances).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
