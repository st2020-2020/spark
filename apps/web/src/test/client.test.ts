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
});
