import { describe, expect, it, vi } from 'vitest';
import { createRealApiClient } from '../api/client';
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
});
