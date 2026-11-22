import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExtensionApiClient, ExtensionApiError } from '../shared/api';
import { FIXED_SPARK_ORIGIN } from '../shared/config';
import {
  deriveChallenge,
  detectBrowserKind,
  formatPairingCode,
  generateIdempotencyKey,
  generateVerifier,
} from '../shared/crypto';
import {
  getAccountBucket,
  getDefaultStorage,
  getExpiredAccountHint,
  getPendingPairing,
  getSession,
  saveAccountDraft,
  setSession,
  upsertPendingSubmission,
  type StorageAreaLike,
} from '../shared/storage';
import { validateAndBuildCollectionPayload } from '../shared/validation';
import { handleExtensionMessage, type BackgroundDeps, type ExtensionMessage } from '../background/serviceWorker';
import { mountExtensionPopup } from '../popup/popup';

function createMemoryStorage(): StorageAreaLike & { dump(): Record<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    async get(keys) {
      if (keys == null) {
        return Object.fromEntries(store.entries());
      }
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
      }
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (store.has(k)) out[k] = structuredClone(store.get(k));
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = store.has(k) ? structuredClone(store.get(k)) : def;
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, structuredClone(v));
      }
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        store.delete(k);
      }
    },
    dump() {
      return Object.fromEntries(store.entries());
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('Spark extension fixed origin, crypto & validation', () => {
  it('defaults production origin to https://spark.stwqy.cloud and sets TRUSTED_CONTEXTS storage access level', () => {
    expect(FIXED_SPARK_ORIGIN).toBe('https://spark.stwqy.cloud');

    const setAccessLevel = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
          setAccessLevel,
        },
      },
    });
    getDefaultStorage();
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    vi.unstubAllGlobals();
  });

  it('generates 43-char base64url PKCE verifier/challenge and 4+4 pairing code', async () => {
    const verifier = generateVerifier();
    const challenge = await deriveChallenge(verifier);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);

    const code = formatPairingCode(challenge);
    expect(code.raw).toBe(challenge.slice(0, 8));
    expect(code.grouped).toBe(`${challenge.slice(0, 4)} ${challenge.slice(4, 8)}`);

    expect(detectBrowserKind('Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36')).toBe('chrome');
    expect(detectBrowserKind('Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0')).toBe('edge');
  });

  it('validates collection limits, deduplicates project_ids, and emits strict payload keys', () => {
    const overTitle = validateAndBuildCollectionPayload({
      id: 'col-1',
      original_url: 'https://example.com/a',
      manual_title: '😀'.repeat(201),
      selected_text: '',
      intent: '',
      project_ids: [],
    });
    expect(overTitle).toMatchObject({ ok: false, field: 'manual_title' });

    const overCombined = validateAndBuildCollectionPayload({
      id: 'col-2',
      original_url: 'https://example.com/b',
      manual_title: 'OK',
      selected_text: 'a'.repeat(49990),
      intent: 'b'.repeat(11),
      project_ids: [],
    });
    expect(overCombined).toMatchObject({ ok: false, field: 'selected_text' });

    const tooManyProjects = validateAndBuildCollectionPayload({
      id: 'col-3',
      original_url: 'https://example.com/c',
      manual_title: 'OK',
      selected_text: '',
      intent: '',
      project_ids: Array.from({ length: 51 }, (_, i) => `p-${i}`),
    });
    expect(tooManyProjects).toMatchObject({ ok: false, field: 'project_ids' });

    const valid = validateAndBuildCollectionPayload({
      id: 'col-4',
      original_url: ' https://example.com/d ',
      manual_title: '',
      selected_text: '',
      intent: '',
      project_ids: ['p1', 'p2', 'p1'],
    });
    expect(valid).toEqual({
      ok: true,
      payload: {
        id: 'col-4',
        original_url: 'https://example.com/d',
        project_ids: ['p1', 'p2'],
      },
    });
  });
});

describe('Extension API client security & error handling', () => {
  it('uses credentials: omit and redirect: error on FIXED_SPARK_ORIGIN and blocks unknown origins', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(201, { id: 'c1' }, { 'Idempotent-Replayed': 'true' }))
      .mockResolvedValueOnce(
        jsonResponse(404, { error: { code: 'extension_grant_pending', message: 'waiting' } }),
      );

    const client = createExtensionApiClient(fetchMock);
    await expect(
      client.createCollection(
        'https://evil.example.com',
        'tok-secret',
        { id: 'c0', original_url: 'https://news.ycombinator.com', project_ids: [] },
        'fixture-key-1',
      ),
    ).rejects.toMatchObject({ status: 403, code: 'origin_not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();

    const receipt = await client.createCollection(
      `${FIXED_SPARK_ORIGIN}/ignored-path`,
      'tok-secret',
      { id: 'c1', original_url: 'https://news.ycombinator.com', project_ids: [] },
      'fixture-key-1',
    );
    expect(receipt).toEqual({ id: 'c1', replayed: true });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${FIXED_SPARK_ORIGIN}/api/v1/extension/collections`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok-secret',
          'Idempotency-Key': 'fixture-key-1',
        }),
      }),
    );

    await expect(client.redeemToken(FIXED_SPARK_ORIGIN, 'v'.repeat(43))).rejects.toMatchObject({
      status: 404,
      code: 'extension_grant_pending',
    } satisfies Partial<ExtensionApiError>);
  });
});

describe('Extension background worker & account isolation', () => {
  let currentToken = 'tok-a';
  let currentAccountId = 'acc-a';
  let currentEmail = 'alice@spark.test';
  let nowMs = Date.parse('2026-11-21T10:00:00Z');

  function makeDeps(apiOverrides: Partial<ReturnType<typeof createExtensionApiClient>> = {}) {
    const storage = createMemoryStorage();
    const openedTabs: string[] = [];
    const baseApi = createExtensionApiClient(async () => jsonResponse(500, {}));
    const api = {
      ...baseApi,
      redeemToken: vi.fn(async () => ({
        token: currentToken,
        account_id: currentAccountId,
        account_label: currentEmail,
        expires_at: '2026-11-28T10:00:00Z',
      })),
      getSession: vi.fn(async () => ({
        account_id: currentAccountId,
        account_label: currentEmail,
        expires_at: '2026-11-28T10:00:00Z',
      })),
      revokeSession: vi.fn(async () => undefined),
      listProjects: vi.fn(async () => ({ items: [{ id: 'p-1', name: '设计系统' }] })),
      createCollection: vi.fn(async (_origin, _token, payload) => ({
        id: payload.id,
        replayed: false,
      })),
      ...apiOverrides,
    };

    const deps: BackgroundDeps = {
      storage,
      api,
      requestOriginPermission: vi.fn(async () => true),
      openTab: vi.fn(async (url) => {
        openedTabs.push(url);
      }),
      readActiveTabCapture: vi.fn(async () => ({
        url: 'https://docs.example.com/article',
        title: 'Example Article',
        selected_text: 'Highlighted line',
        source: 'active_tab' as const,
      })),
      now: () => nowMs,
    };

    return { deps, storage, api, openedTabs };
  }

  it('rejects foreign origin pairing, opens fixed fragment-only pairing URL without verifier, and handles pending -> success exchange', async () => {
    const redeemToken = vi
      .fn<ReturnType<typeof createExtensionApiClient>['redeemToken']>()
      .mockRejectedValueOnce(new ExtensionApiError(404, 'extension_grant_pending', 'pending'))
      .mockResolvedValueOnce({
        token: 'tok-secret-value',
        account_id: 'acc-1',
        account_label: 'user@spark.test',
        expires_at: '2026-11-28T10:00:00Z',
      });

    const { deps, storage, openedTabs } = makeDeps({ redeemToken });

    const foreignRes = await handleExtensionMessage(
      { type: 'START_PAIRING', origin: 'https://other-site.example' },
      deps,
    );
    expect(foreignRes).toMatchObject({ ok: false, status: 403, code: 'origin_not_allowed' });

    const startRes = await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    expect(startRes.ok).toBe(true);
    expect(openedTabs).toHaveLength(1);
    const opened = new URL(openedTabs[0]!);
    expect(opened.origin).toBe(FIXED_SPARK_ORIGIN);
    expect(opened.pathname).toBe('/extension/pair');
    expect(opened.search).toBe('');
    expect(opened.hash).toMatch(/^#challenge=[A-Za-z0-9_-]{43}&browser=(chrome|edge)$/);

    const storedPairing = await getPendingPairing(storage);
    expect(storedPairing).not.toBeNull();
    expect(opened.hash).not.toContain(storedPairing!.verifier);

    // 404 pending keeps pending pairing intact for user retry
    const pendingRes = await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);
    expect(pendingRes).toMatchObject({ ok: false, code: 'extension_grant_pending', status: 404 });
    expect(await getPendingPairing(storage)).not.toBeNull();

    // 200 clears pending pairing and saves session
    const okRes = await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);
    expect(okRes.ok).toBe(true);
    expect(await getPendingPairing(storage)).toBeNull();
    expect(await getSession(storage)).toMatchObject({
      account_id: 'acc-1',
      account_label: 'user@spark.test',
      origin: FIXED_SPARK_ORIGIN,
    });
  });

  it('ignores sessions from a different origin build and refuses to send their Bearer token', async () => {
    const { deps, storage, api } = makeDeps();
    await setSession(storage, {
      token: 'stale-other-origin-token',
      account_id: 'acc-1',
      account_label: 'old@spark.test',
      expires_at: '2026-11-28T10:00:00Z',
      origin: 'http://localhost:5173',
      browser: 'chrome',
      connected_at: '2026-11-21T09:00:00Z',
    });

    const stateRes = await handleExtensionMessage({ type: 'GET_STATE' }, deps);
    expect(stateRes).toMatchObject({
      ok: true,
      state: { fixed_origin: FIXED_SPARK_ORIGIN, session: null },
    });

    const verifyRes = await handleExtensionMessage({ type: 'VERIFY_SESSION' }, deps);
    expect(verifyRes).toMatchObject({ ok: false, status: 401 });
    expect(api.getSession).not.toHaveBeenCalled();
  });

  it('clears pending pairing on 401 extension_grant_invalid', async () => {
    const { deps, storage } = makeDeps({
      redeemToken: vi.fn(async () => {
        throw new ExtensionApiError(401, 'extension_grant_invalid', 'invalid');
      }),
    });
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    const res = await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);
    expect(res).toMatchObject({ ok: false, code: 'extension_grant_invalid', status: 401 });
    expect(await getPendingPairing(storage)).toBeNull();
  });

  it('freezes pending submission on network/401, retries with identical id & idempotency_key, and isolates accounts', async () => {
    const createCollection = vi
      .fn<ReturnType<typeof createExtensionApiClient>['createCollection']>()
      .mockRejectedValueOnce(new ExtensionApiError(0, 'network_error', 'offline'))
      .mockRejectedValueOnce(new ExtensionApiError(401, 'extension_session_expired', 'revoked'))
      .mockResolvedValueOnce({ id: 'col-fixed-1', replayed: true });

    const { deps, storage } = makeDeps({ createCollection });

    // Pair Account A
    currentToken = 'tok-a';
    currentAccountId = 'acc-a';
    currentEmail = 'alice@spark.test';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);

    // Save draft for Account A
    await handleExtensionMessage(
      {
        type: 'SAVE_DRAFT',
        account_id: 'acc-a',
        draft: {
          context_key: 'https://docs.example.com/article',
          updated_at: new Date(nowMs).toISOString(),
          manual_title: 'Alice Title',
          original_url: 'https://docs.example.com/article',
          selected_text: 'Alice quote',
          intent: 'for alpha',
          project_ids: ['p-1'],
          project_names: { 'p-1': '设计系统' },
        },
      },
      deps,
    );

    const idemKey = generateIdempotencyKey();
    // Attempt 1 fails with network_error -> frozen pending submission stays in acc-a bucket
    const submit1 = await handleExtensionMessage(
      {
        type: 'SUBMIT_COLLECTION',
        account_id: 'acc-a',
        context_key: 'https://docs.example.com/article',
        idempotency_key: idemKey,
        payload: {
          id: 'col-fixed-1',
          original_url: 'https://docs.example.com/article',
          manual_title: 'Alice Title',
          selected_text: 'Alice quote',
          intent: 'for alpha',
          project_ids: ['p-1'],
        },
        project_names: { 'p-1': '设计系统' },
      },
      deps,
    );
    expect(submit1).toMatchObject({ ok: false, code: 'network_error' });

    // Attempt 2 returns 401 extension_session_expired -> clears active session, keeps pending + sets expired hint
    const retry1 = await handleExtensionMessage(
      { type: 'RETRY_PENDING', account_id: 'acc-a', submission_id: 'col-fixed-1' },
      deps,
    );
    expect(retry1).toMatchObject({ ok: false, code: 'extension_session_expired', status: 401 });
    expect(await getSession(storage)).toBeNull();
    const stateAfter401 = await handleExtensionMessage({ type: 'GET_STATE' }, deps);
    expect(stateAfter401).toMatchObject({
      ok: true,
      state: {
        expired_account_hint: {
          account_id: 'acc-a',
          account_label: 'alice@spark.test',
        },
      },
    });

    // Now switch to Account B on the same fixed site
    currentToken = 'tok-b';
    currentAccountId = 'acc-b';
    currentEmail = 'bob@spark.test';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);

    // Account B sees clean state (no Alice draft or pending submission)
    const stateB = await handleExtensionMessage({ type: 'GET_STATE' }, deps);
    expect(stateB).toMatchObject({
      ok: true,
      state: {
        session: { account_id: 'acc-b' },
        draft: null,
        pending_submissions: [],
      },
    });

    // Cross-account retry attempt is blocked before any HTTP call
    const crossRetry = await handleExtensionMessage(
      { type: 'RETRY_PENDING', account_id: 'acc-a', submission_id: 'col-fixed-1' },
      deps,
    );
    expect(crossRetry).toMatchObject({ ok: false, code: 'account_mismatch', status: 409 });

    // Switch back to Account A -> Alice's draft and frozen pending snapshot reappear!
    currentToken = 'tok-a2';
    currentAccountId = 'acc-a';
    currentEmail = 'alice@spark.test';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);

    const stateA2 = await handleExtensionMessage({ type: 'GET_STATE' }, deps);
    expect(stateA2).toMatchObject({
      ok: true,
      state: {
        draft: { manual_title: 'Alice Title' },
        pending_submissions: [{ id: 'col-fixed-1', idempotency_key: idemKey }],
      },
    });

    // Retry succeeds with exact original id + idempotency_key and removes pending + draft
    const retryOk = await handleExtensionMessage(
      { type: 'RETRY_PENDING', account_id: 'acc-a', submission_id: 'col-fixed-1' },
      deps,
    );
    expect(retryOk).toEqual({ ok: true, receipt: { id: 'col-fixed-1', replayed: true } });
    expect(createCollection).toHaveBeenLastCalledWith(
      FIXED_SPARK_ORIGIN,
      'tok-a2',
      expect.objectContaining({ id: 'col-fixed-1', manual_title: 'Alice Title' }),
      idemKey,
    );
    const bucketA = await getAccountBucket(storage, FIXED_SPARK_ORIGIN, 'acc-a', 'alice@spark.test');
    expect(bucketA.pending_submissions).toHaveLength(0);
    expect(Object.keys(bucketA.drafts)).toHaveLength(0);
  });

  it('drops pending snapshot on 404 project_unavailable while keeping account draft intact', async () => {
    const { deps, storage } = makeDeps({
      createCollection: vi.fn(async () => {
        throw new ExtensionApiError(404, 'project_unavailable', 'gone');
      }),
    });
    currentToken = 'tok-a';
    currentAccountId = 'acc-a';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);
    await handleExtensionMessage(
      {
        type: 'SAVE_DRAFT',
        account_id: 'acc-a',
        draft: {
          context_key: 'https://docs.example.com/article',
          updated_at: new Date(nowMs).toISOString(),
          manual_title: 'Keep Draft',
          original_url: 'https://docs.example.com/article',
          selected_text: '',
          intent: '',
          project_ids: ['p-missing'],
          project_names: { 'p-missing': '已归档' },
        },
      },
      deps,
    );

    const res = await handleExtensionMessage(
      {
        type: 'SUBMIT_COLLECTION',
        account_id: 'acc-a',
        context_key: 'https://docs.example.com/article',
        idempotency_key: generateIdempotencyKey(),
        payload: {
          id: 'col-404',
          original_url: 'https://docs.example.com/article',
          manual_title: 'Keep Draft',
          project_ids: ['p-missing'],
        },
        project_names: { 'p-missing': '已归档' },
      },
      deps,
    );
    expect(res).toMatchObject({ ok: false, status: 404, code: 'project_unavailable' });

    const bucket = await getAccountBucket(storage, FIXED_SPARK_ORIGIN, 'acc-a', currentEmail);
    expect(bucket.pending_submissions).toHaveLength(0);
    expect(bucket.drafts['https://docs.example.com/article']?.manual_title).toBe('Keep Draft');
  });

  it('prevents stale in-flight VERIFY_SESSION 200 and delayed 401 responses from clobbering switched or disconnected sessions', async () => {
    let resolveVerify!: (v: { account_id: string; account_label: string; expires_at: string }) => void;
    let rejectList!: (err: unknown) => void;
    let rejectSubmit!: (err: unknown) => void;

    const getSessionApi = vi.fn(
      () =>
        new Promise<{ account_id: string; account_label: string; expires_at: string }>((resolve) => {
          resolveVerify = resolve;
        }),
    );
    const listProjectsApi = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectList = reject;
        }),
    );
    const createCollectionApi = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );

    const { deps, storage } = makeDeps({
      getSession: getSessionApi,
      listProjects: listProjectsApi,
      createCollection: createCollectionApi,
    });

    // Pair Account A (tok-a1)
    currentToken = 'tok-a1';
    currentAccountId = 'acc-a';
    currentEmail = 'alice@spark.test';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);

    // Start in-flight VERIFY_SESSION, LIST_PROJECTS, and SUBMIT_COLLECTION under Account A
    const inflightVerify = handleExtensionMessage({ type: 'VERIFY_SESSION' }, deps);
    const inflightList = handleExtensionMessage({ type: 'LIST_PROJECTS', account_id: 'acc-a' }, deps);
    const inflightSubmit = handleExtensionMessage(
      {
        type: 'SUBMIT_COLLECTION',
        account_id: 'acc-a',
        context_key: 'https://docs.example.com/article',
        idempotency_key: generateIdempotencyKey(),
        payload: {
          id: 'col-race-1',
          original_url: 'https://docs.example.com/article',
          manual_title: 'Race Test',
          project_ids: [],
        },
        project_names: {},
      },
      deps,
    );
    await vi.waitFor(() => {
      expect(getSessionApi).toHaveBeenCalledTimes(1);
      expect(listProjectsApi).toHaveBeenCalledTimes(1);
      expect(createCollectionApi).toHaveBeenCalledTimes(1);
    });

    // While A's requests are in-flight, user switches to Account B (tok-b)
    currentToken = 'tok-b';
    currentAccountId = 'acc-b';
    currentEmail = 'bob@spark.test';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);

    // Now A's delayed VERIFY_SESSION 200 + LIST_PROJECTS 401 + SUBMIT_COLLECTION 401 finish!
    resolveVerify({
      account_id: 'acc-a',
      account_label: 'alice@spark.test',
      expires_at: '2026-12-01T00:00:00Z',
    });
    rejectList(new ExtensionApiError(401, 'extension_session_expired', 'stale A expired'));
    rejectSubmit(new ExtensionApiError(401, 'extension_session_expired', 'stale A expired'));

    const [verifyRes, listRes, submitRes] = await Promise.all([
      inflightVerify,
      inflightList,
      inflightSubmit,
    ]);
    expect(verifyRes).toMatchObject({ ok: false, status: 409, code: 'account_mismatch' });
    expect(listRes).toMatchObject({ ok: false, status: 401 });
    expect(submitRes).toMatchObject({ ok: false, status: 401 });

    // Account B's active session MUST remain intact and expired hint MUST NOT point to A
    expect(await getSession(storage)).toMatchObject({
      account_id: 'acc-b',
      token: 'tok-b',
      account_label: 'bob@spark.test',
    });
    expect(await getExpiredAccountHint(storage)).toBeNull();

    // Also test: user intentionally disconnects B while B's delayed LIST_PROJECTS returns 401
    let rejectListB!: (err: unknown) => void;
    listProjectsApi.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectListB = reject;
        }),
    );
    const inflightListB = handleExtensionMessage({ type: 'LIST_PROJECTS', account_id: 'acc-b' }, deps);
    await vi.waitFor(() => expect(listProjectsApi).toHaveBeenCalledTimes(2));

    await handleExtensionMessage({ type: 'DISCONNECT_SESSION', mode: 'revoke' }, deps);
    expect(await getSession(storage)).toBeNull();
    expect(await getExpiredAccountHint(storage)).toBeNull();

    rejectListB(new ExtensionApiError(401, 'extension_session_expired', 'disconnected B'));
    await inflightListB;
    expect(await getSession(storage)).toBeNull();
    expect(await getExpiredAccountHint(storage)).toBeNull();
  });

  it('serializes delayed BUCKETS storage mutations and keeps newer draft when stale submission finishes', async () => {
    const baseStorage = createMemoryStorage();
    const delayedStorage: StorageAreaLike = {
      async get(keys) {
        await new Promise((r) => setTimeout(r, 12));
        return baseStorage.get(keys);
      },
      async set(items) {
        await new Promise((r) => setTimeout(r, 12));
        return baseStorage.set(items);
      },
      async remove(keys) {
        await new Promise((r) => setTimeout(r, 12));
        return baseStorage.remove(keys);
      },
    };

    // Part A: Concurrent BUCKETS RMW across SAVE_DRAFT (A & B) and upsertPendingSubmission (A) under async latency
    await Promise.all([
      saveAccountDraft(delayedStorage, FIXED_SPARK_ORIGIN, 'acc-a', 'alice@spark.test', {
        context_key: 'https://example.com/1',
        updated_at: '2026-11-21T10:00:00.000Z',
        manual_title: 'Alice Delayed Draft',
        original_url: 'https://example.com/1',
        selected_text: '',
        intent: '',
        project_ids: [],
        project_names: {},
      }),
      upsertPendingSubmission(delayedStorage, FIXED_SPARK_ORIGIN, 'acc-a', 'alice@spark.test', {
        id: 'pending-delayed-1',
        idempotency_key: 'fixture-key-2',
        payload: {
          id: 'pending-delayed-1',
          original_url: 'https://example.com/2',
          project_ids: [],
        },
        project_names: {},
        context_key: 'https://example.com/2',
        created_at: '2026-11-21T10:00:00.000Z',
      }),
      saveAccountDraft(delayedStorage, FIXED_SPARK_ORIGIN, 'acc-b', 'bob@spark.test', {
        context_key: 'https://example.com/b',
        updated_at: '2026-11-21T10:00:01.000Z',
        manual_title: 'Bob Delayed Draft',
        original_url: 'https://example.com/b',
        selected_text: '',
        intent: '',
        project_ids: [],
        project_names: {},
      }),
    ]);

    const bucketAAfterConcurrent = await getAccountBucket(
      delayedStorage,
      FIXED_SPARK_ORIGIN,
      'acc-a',
      'alice@spark.test',
    );
    const bucketBAfterConcurrent = await getAccountBucket(
      delayedStorage,
      FIXED_SPARK_ORIGIN,
      'acc-b',
      'bob@spark.test',
    );
    expect(bucketAAfterConcurrent.drafts['https://example.com/1']?.manual_title).toBe('Alice Delayed Draft');
    expect(bucketAAfterConcurrent.pending_submissions.map((p) => p.id)).toEqual(['pending-delayed-1']);
    expect(bucketBAfterConcurrent.drafts['https://example.com/b']?.manual_title).toBe('Bob Delayed Draft');

    // Part B: Late SUBMIT_COLLECTION completion clears pending snapshot ONLY, keeping edited newer draft intact
    let resolveSubmit!: (res: { id: string; replayed: boolean }) => void;
    const createCollection = vi.fn(
      () =>
        new Promise<{ id: string; replayed: boolean }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const { deps, storage } = makeDeps({ createCollection });

    currentToken = 'tok-a';
    currentAccountId = 'acc-a';
    currentEmail = 'alice@spark.test';
    await handleExtensionMessage({ type: 'START_PAIRING' }, deps);
    await handleExtensionMessage({ type: 'REDEEM_PAIRING' }, deps);

    const ctxUrl = 'https://docs.example.com/versioned';
    await handleExtensionMessage(
      {
        type: 'SAVE_DRAFT',
        account_id: 'acc-a',
        draft: {
          context_key: ctxUrl,
          updated_at: '2026-11-21T10:00:00.000Z',
          manual_title: 'Draft V1',
          original_url: ctxUrl,
          selected_text: 'quote v1',
          intent: '',
          project_ids: [],
          project_names: {},
        },
      },
      deps,
    );

    const lateSubmitPromise = handleExtensionMessage(
      {
        type: 'SUBMIT_COLLECTION',
        account_id: 'acc-a',
        context_key: ctxUrl,
        idempotency_key: generateIdempotencyKey(),
        payload: {
          id: 'col-v1',
          original_url: ctxUrl,
          manual_title: 'Draft V1',
          selected_text: 'quote v1',
          project_ids: [],
        },
        project_names: {},
      },
      deps,
    );
    await vi.waitFor(() => expect(createCollection).toHaveBeenCalledTimes(1));

    // User edits draft while old V1 submission is still in flight
    await handleExtensionMessage(
      {
        type: 'SAVE_DRAFT',
        account_id: 'acc-a',
        draft: {
          context_key: ctxUrl,
          updated_at: '2026-11-21T10:00:05.000Z',
          manual_title: 'Draft V2 Edited',
          original_url: ctxUrl,
          selected_text: 'quote v2 edited',
          intent: 'new intent',
          project_ids: ['p-1'],
          project_names: { 'p-1': '设计系统' },
        },
      },
      deps,
    );

    resolveSubmit({ id: 'col-v1', replayed: false });
    const lateRes = await lateSubmitPromise;
    expect(lateRes).toEqual({ ok: true, receipt: { id: 'col-v1', replayed: false } });

    const finalBucketA = await getAccountBucket(storage, FIXED_SPARK_ORIGIN, 'acc-a', 'alice@spark.test');
    expect(finalBucketA.pending_submissions.find((p) => p.id === 'col-v1')).toBeUndefined();
    expect(finalBucketA.drafts[ctxUrl]).toMatchObject({
      updated_at: '2026-11-21T10:00:05.000Z',
      manual_title: 'Draft V2 Edited',
      selected_text: 'quote v2 edited',
      intent: 'new intent',
    });
  });
});

describe('Extension popup DOM interaction & privacy guard', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows fixed origin without arbitrary input box, pairs, paginates projects, and submits cleanly', async () => {
    const secretVerifier = 'VERIFIER_DO_NOT_LOG_12345678901234567890123';
    const secretToken = 'BEARER_DO_NOT_LOG_SECRET';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let paired = false;
    let pendingPair = false;
    const sentMessages: ExtensionMessage[] = [];

    const sendMessage = vi.fn(async (msg: ExtensionMessage) => {
      sentMessages.push(msg);
      if (msg.type === 'GET_STATE') {
        return {
          ok: true as const,
          state: {
            fixed_origin: FIXED_SPARK_ORIGIN,
            session: paired
              ? {
                  account_id: 'acc-1',
                  account_label: 'maker@spark.test',
                  expires_at: '2026-11-28T10:00:00Z',
                  origin: FIXED_SPARK_ORIGIN,
                  browser: 'edge' as const,
                  connected_at: '2026-11-21T10:00:00Z',
                }
              : null,
            pending_pairing:
              !paired && pendingPair
                ? {
                    origin: FIXED_SPARK_ORIGIN,
                    browser: 'edge' as const,
                    challenge: 'XyZ12345restOfChallenge00000000000000000000',
                    pair_code: 'XyZ1 2345',
                    created_at: '2026-11-21T10:00:00Z',
                    expired: false,
                  }
                : null,
            expired_account_hint: null,
            active_capture: {
              url: 'https://example.org/post',
              title: 'Web Post Title',
              selected_text: '',
              source: 'active_tab' as const,
            },
            draft: null,
            pending_submissions: [],
          },
        };
      }
      if (msg.type === 'START_PAIRING') {
        pendingPair = true;
        return {
          ok: true as const,
          pairing: {
            origin: FIXED_SPARK_ORIGIN,
            browser: 'edge' as const,
            challenge: 'XyZ12345restOfChallenge00000000000000000000',
            pair_code: 'XyZ1 2345',
            created_at: '2026-11-21T10:00:00Z',
          },
        };
      }
      if (msg.type === 'REDEEM_PAIRING') {
        paired = true;
        pendingPair = false;
        return {
          ok: true as const,
          session: {
            account_id: 'acc-1',
            account_label: 'maker@spark.test',
            expires_at: '2026-11-28T10:00:00Z',
            origin: FIXED_SPARK_ORIGIN,
            browser: 'edge' as const,
            connected_at: '2026-11-21T10:00:00Z',
          },
        };
      }
      if (msg.type === 'LIST_PROJECTS') {
        if (msg.q === 'Beta') {
          return { ok: true as const, projects: { items: [{ id: 'p-beta', name: 'Beta 项目' }] } };
        }
        if (msg.cursor === 'page-2') {
          return { ok: true as const, projects: { items: [{ id: 'p-2', name: '第二个项目' }] } };
        }
        return {
          ok: true as const,
          projects: { items: [{ id: 'p-1', name: 'Alpha 研究' }], next_cursor: 'page-2' },
        };
      }
      if (msg.type === 'SAVE_DRAFT') return { ok: true as const };
      if (msg.type === 'SUBMIT_COLLECTION') {
        return { ok: true as const, receipt: { id: msg.payload.id, replayed: false } };
      }
      return { ok: true as const };
    });

    const openUrl = vi.fn();
    const root = document.getElementById('app')!;
    await mountExtensionPopup({ root, sendMessage, openUrl });

    // No freeform server URL input exists; fixed target and scope box are displayed instead.
    expect(root.querySelector('#ext-origin-input')).toBeNull();
    expect(root.textContent).toContain(FIXED_SPARK_ORIGIN);
    expect(root.querySelector('[aria-label="扩展操作权限说明"]')).not.toBeNull();

    const startBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('打开 Spark 授权页'),
    )!;
    startBtn.click();

    await vi.waitFor(() => {
      expect(root.textContent).toContain('XyZ1 2345');
    });

    // Complete pairing
    const confirmBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('我已确认，完成连接'),
    )!;
    confirmBtn.click();

    await vi.waitFor(() => {
      expect(root.textContent).toContain('Alpha 研究');
    });

    // Load page 2 projects
    const loadMoreBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('加载更多项目'),
    )!;
    loadMoreBtn.click();
    await vi.waitFor(() => {
      expect(root.textContent).toContain('第二个项目');
    });

    // Select a project chip
    const projOpt = Array.from(root.querySelectorAll<HTMLButtonElement>('.sp-project-option')).find((b) =>
      b.textContent?.includes('Alpha 研究'),
    )!;
    projOpt.click();
    expect(root.querySelector('.sp-project-chip')?.textContent).toContain('Alpha 研究');

    // Over-limit title stops submission cleanly without clearing input
    const titleInput = root.querySelector<HTMLInputElement>('#ext-title')!;
    titleInput.value = '字'.repeat(201);
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    const saveBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('保存到 Spark'),
    )!;
    saveBtn.click();
    await vi.waitFor(() => {
      expect(root.querySelector('[role="alert"]')?.textContent).toContain('200');
    });
    expect(root.querySelector<HTMLInputElement>('#ext-title')!.value).toHaveLength(201);

    // Fix title and submit page-only (empty selection)
    const titleInput2 = root.querySelector<HTMLInputElement>('#ext-title')!;
    titleInput2.value = 'Saved Title';
    titleInput2.dispatchEvent(new Event('input', { bubbles: true }));
    const saveBtn2 = Array.from(root.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('保存到 Spark'),
    )!;
    saveBtn2.click();

    await vi.waitFor(() => {
      expect(root.textContent).toContain('已保存到 Spark');
    });
    const submitCall = sentMessages.find((m) => m.type === 'SUBMIT_COLLECTION');
    expect(submitCall).toMatchObject({
      type: 'SUBMIT_COLLECTION',
      payload: {
        original_url: 'https://example.org/post',
        manual_title: 'Saved Title',
        project_ids: ['p-1'],
      },
    });
    if (submitCall && submitCall.type === 'SUBMIT_COLLECTION') {
      expect(submitCall.payload.selected_text).toBeUndefined();
    }

    const combinedLogs = JSON.stringify([
      ...consoleSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]);
    expect(combinedLogs).not.toContain(secretVerifier);
    expect(combinedLogs).not.toContain(secretToken);
  });
});
