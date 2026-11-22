import { ensureTrustedStorageAccessLevel } from './config';
import type {
  AccountBucket,
  AccountDraft,
  ContextCapture,
  ExtensionSession,
  PendingPairing,
  PendingSubmission,
} from './types';

export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const KEYS = {
  PENDING_PAIRING: 'spark_ext_pending_pairing',
  SESSION: 'spark_ext_session',
  BUCKETS: 'spark_ext_account_buckets',
  CONTEXT_CAPTURE: 'spark_ext_context_capture',
  EXPIRED_HINT: 'spark_ext_last_expired_account',
} as const;

const MAX_DRAFTS_PER_BUCKET = 25;
const CONTEXT_CAPTURE_TTL_MS = 60 * 1000;

const bucketQueues = new WeakMap<StorageAreaLike, Promise<void>>();
const sessionQueues = new WeakMap<StorageAreaLike, Promise<void>>();

function runSerialized<T>(
  queues: WeakMap<StorageAreaLike, Promise<void>>,
  storage: StorageAreaLike,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = queues.get(storage) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    storage,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function withSessionLock<T>(storage: StorageAreaLike, fn: () => Promise<T>): Promise<T> {
  return runSerialized(sessionQueues, storage, fn);
}

function withBucketsLock<T>(storage: StorageAreaLike, fn: () => Promise<T>): Promise<T> {
  return runSerialized(bucketQueues, storage, fn);
}

export function isSameSessionCredential(
  a: ExtensionSession | null,
  b: ExtensionSession,
): boolean {
  return Boolean(a && a.origin === b.origin && a.account_id === b.account_id && a.token === b.token);
}

export function draftMatchesSubmissionPayload(
  draft: AccountDraft,
  payload: PendingSubmission['payload'],
): boolean {
  const sameProjects =
    draft.project_ids.length === payload.project_ids.length &&
    draft.project_ids.every((id, idx) => id === payload.project_ids[idx]);
  return (
    draft.original_url.trim() === payload.original_url &&
    draft.manual_title.trim() === (payload.manual_title ?? '') &&
    draft.selected_text.trim() === (payload.selected_text ?? '') &&
    draft.intent.trim() === (payload.intent ?? '') &&
    sameProjects
  );
}

export interface ExpiredAccountHint {
  origin: string;
  account_id: string;
  account_label: string;
}

export function accountBucketKey(origin: string, accountId: string): string {
  return `${origin}::${accountId}`;
}

export function getDefaultStorage(): StorageAreaLike {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    ensureTrustedStorageAccessLevel();
    return chrome.storage.local;
  }
  throw new Error('chrome.storage.local is unavailable');
}

export async function getPendingPairing(storage: StorageAreaLike): Promise<PendingPairing | null> {
  const res = await storage.get(KEYS.PENDING_PAIRING);
  const val = res[KEYS.PENDING_PAIRING];
  if (!val || typeof val !== 'object') return null;
  return val as PendingPairing;
}

export async function setPendingPairing(
  storage: StorageAreaLike,
  pairing: PendingPairing | null,
): Promise<void> {
  if (!pairing) {
    await storage.remove(KEYS.PENDING_PAIRING);
    return;
  }
  await storage.set({ [KEYS.PENDING_PAIRING]: pairing });
}

export async function getSession(storage: StorageAreaLike): Promise<ExtensionSession | null> {
  const res = await storage.get(KEYS.SESSION);
  const val = res[KEYS.SESSION];
  if (!val || typeof val !== 'object') return null;
  return val as ExtensionSession;
}

export async function setSession(
  storage: StorageAreaLike,
  session: ExtensionSession | null,
): Promise<void> {
  if (!session) {
    await storage.remove(KEYS.SESSION);
    return;
  }
  await storage.set({ [KEYS.SESSION]: session });
}

export async function getExpiredAccountHint(
  storage: StorageAreaLike,
): Promise<ExpiredAccountHint | null> {
  const res = await storage.get(KEYS.EXPIRED_HINT);
  const val = res[KEYS.EXPIRED_HINT];
  if (!val || typeof val !== 'object') return null;
  return val as ExpiredAccountHint;
}

export async function setExpiredAccountHint(
  storage: StorageAreaLike,
  hint: ExpiredAccountHint | null,
): Promise<void> {
  if (!hint) {
    await storage.remove(KEYS.EXPIRED_HINT);
    return;
  }
  await storage.set({ [KEYS.EXPIRED_HINT]: hint });
}

export function updateSessionIfMatches(
  storage: StorageAreaLike,
  expected: ExtensionSession,
  updater: (current: ExtensionSession) => ExtensionSession,
): Promise<ExtensionSession | null> {
  return withSessionLock(storage, async () => {
    const current = await getSession(storage);
    if (!isSameSessionCredential(current, expected)) {
      return null;
    }
    const updated = updater(current!);
    await setSession(storage, updated);
    return updated;
  });
}

export function expireSessionIfMatches(
  storage: StorageAreaLike,
  expected: ExtensionSession,
): Promise<boolean> {
  return withSessionLock(storage, async () => {
    const current = await getSession(storage);
    if (!isSameSessionCredential(current, expected)) {
      return false;
    }
    await setExpiredAccountHint(storage, {
      origin: expected.origin,
      account_id: expected.account_id,
      account_label: expected.account_label,
    });
    await setSession(storage, null);
    return true;
  });
}

export function clearSessionIfMatches(
  storage: StorageAreaLike,
  expected: ExtensionSession | null,
): Promise<boolean> {
  return withSessionLock(storage, async () => {
    const current = await getSession(storage);
    if (expected && current && !isSameSessionCredential(current, expected)) {
      return false;
    }
    await setSession(storage, null);
    await setExpiredAccountHint(storage, null);
    return true;
  });
}

async function readBuckets(storage: StorageAreaLike): Promise<Record<string, AccountBucket>> {
  const res = await storage.get(KEYS.BUCKETS);
  const raw = res[KEYS.BUCKETS];
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, AccountBucket>;
}

async function writeBuckets(
  storage: StorageAreaLike,
  buckets: Record<string, AccountBucket>,
): Promise<void> {
  await storage.set({ [KEYS.BUCKETS]: buckets });
}

export async function getAccountBucket(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  accountLabel = '',
): Promise<AccountBucket> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const existing = buckets[key];
    if (existing) {
      return existing;
    }
    return {
      origin,
      account_id: accountId,
      account_label: accountLabel,
      drafts: {},
      pending_submissions: [],
    };
  });
}

export async function saveAccountDraft(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  accountLabel: string,
  draft: AccountDraft,
): Promise<void> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket: AccountBucket = buckets[key] ?? {
      origin,
      account_id: accountId,
      account_label: accountLabel,
      drafts: {},
      pending_submissions: [],
    };
    bucket.account_label = accountLabel || bucket.account_label;
    bucket.drafts[draft.context_key] = draft;

    const entries = Object.entries(bucket.drafts).sort((a, b) =>
      b[1].updated_at.localeCompare(a[1].updated_at),
    );
    if (entries.length > MAX_DRAFTS_PER_BUCKET) {
      bucket.drafts = Object.fromEntries(entries.slice(0, MAX_DRAFTS_PER_BUCKET));
    }
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
  });
}

export async function removeAccountDraft(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  contextKey: string,
): Promise<void> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket = buckets[key];
    if (!bucket || !bucket.drafts[contextKey]) return;
    delete bucket.drafts[contextKey];
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
  });
}

export async function freezePendingSubmission(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  accountLabel: string,
  submission: PendingSubmission,
): Promise<PendingSubmission> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket: AccountBucket = buckets[key] ?? {
      origin,
      account_id: accountId,
      account_label: accountLabel,
      drafts: {},
      pending_submissions: [],
    };
    bucket.account_label = accountLabel || bucket.account_label;
    const currentDraft = bucket.drafts[submission.context_key];
    const frozen: PendingSubmission = {
      ...submission,
      draft_updated_at:
        submission.draft_updated_at ??
        (currentDraft && draftMatchesSubmissionPayload(currentDraft, submission.payload)
          ? currentDraft.updated_at
          : undefined),
    };
    const idx = bucket.pending_submissions.findIndex((item) => item.id === frozen.id);
    if (idx >= 0) {
      bucket.pending_submissions[idx] = frozen;
    } else {
      bucket.pending_submissions.unshift(frozen);
    }
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
    return frozen;
  });
}

export async function completePendingSubmission(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  submission: PendingSubmission,
): Promise<void> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket = buckets[key];
    if (!bucket) return;
    bucket.pending_submissions = bucket.pending_submissions.filter((item) => item.id !== submission.id);
    const currentDraft = bucket.drafts[submission.context_key];
    if (
      currentDraft &&
      submission.draft_updated_at &&
      currentDraft.updated_at === submission.draft_updated_at &&
      draftMatchesSubmissionPayload(currentDraft, submission.payload)
    ) {
      delete bucket.drafts[submission.context_key];
    }
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
  });
}

export async function upsertPendingSubmission(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  accountLabel: string,
  submission: PendingSubmission,
): Promise<void> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket: AccountBucket = buckets[key] ?? {
      origin,
      account_id: accountId,
      account_label: accountLabel,
      drafts: {},
      pending_submissions: [],
    };
    bucket.account_label = accountLabel || bucket.account_label;
    const idx = bucket.pending_submissions.findIndex((item) => item.id === submission.id);
    if (idx >= 0) {
      bucket.pending_submissions[idx] = submission;
    } else {
      bucket.pending_submissions.unshift(submission);
    }
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
  });
}

export async function removePendingSubmission(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
  submissionId: string,
): Promise<void> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket = buckets[key];
    if (!bucket) return;
    bucket.pending_submissions = bucket.pending_submissions.filter((item) => item.id !== submissionId);
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
  });
}

export async function clearAccountDrafts(
  storage: StorageAreaLike,
  origin: string,
  accountId: string,
): Promise<void> {
  return withBucketsLock(storage, async () => {
    const buckets = await readBuckets(storage);
    const key = accountBucketKey(origin, accountId);
    const bucket = buckets[key];
    if (!bucket) return;
    bucket.drafts = {};
    buckets[key] = bucket;
    await writeBuckets(storage, buckets);
  });
}

export async function setContextCapture(
  storage: StorageAreaLike,
  capture: ContextCapture | null,
): Promise<void> {
  if (!capture) {
    await storage.remove(KEYS.CONTEXT_CAPTURE);
    return;
  }
  await storage.set({ [KEYS.CONTEXT_CAPTURE]: capture });
}

export async function consumeContextCapture(
  storage: StorageAreaLike,
  now = Date.now(),
): Promise<ContextCapture | null> {
  const res = await storage.get(KEYS.CONTEXT_CAPTURE);
  const val = res[KEYS.CONTEXT_CAPTURE];
  await storage.remove(KEYS.CONTEXT_CAPTURE);
  if (!val || typeof val !== 'object') return null;
  const capture = val as ContextCapture;
  if (now - capture.captured_at > CONTEXT_CAPTURE_TTL_MS) {
    return null;
  }
  return capture;
}
