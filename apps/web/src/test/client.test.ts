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
});
