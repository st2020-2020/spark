import {
  ExtensionApiError,
  createExtensionApiClient,
  type ExtensionApiClient,
} from '../shared/api';
import {
  deriveChallenge,
  detectBrowserKind,
  formatPairingCode,
  generateIdempotencyKey,
  generateVerifier,
} from '../shared/crypto';
import {
  FIXED_SPARK_ORIGIN,
  ensureTrustedStorageAccessLevel,
  isTrustedSparkOrigin,
} from '../shared/config';
import {
  clearAccountDrafts,
  clearSessionIfMatches,
  completePendingSubmission,
  consumeContextCapture,
  expireSessionIfMatches,
  freezePendingSubmission,
  getAccountBucket,
  getDefaultStorage,
  getExpiredAccountHint,
  getPendingPairing,
  getSession,
  removeAccountDraft,
  removePendingSubmission,
  saveAccountDraft,
  setContextCapture,
  setExpiredAccountHint,
  setPendingPairing,
  setSession,
  updateSessionIfMatches,
  upsertPendingSubmission,
  withSessionLock,
  type ExpiredAccountHint,
  type StorageAreaLike,
} from '../shared/storage';
import type {
  AccountDraft,
  ActivePageCapture,
  ExtensionCollectionCreate,
  ExtensionProjectPage,
  ExtensionSession,
  PendingPairing,
  PendingSubmission,
} from '../shared/types';
import {
  PAIRING_TTL_MS,
  validateAndBuildCollectionPayload,
} from '../shared/validation';

export type PublicSessionInfo = Omit<ExtensionSession, 'token'>;
export type PublicPairingInfo = Omit<PendingPairing, 'verifier'>;

export interface ExtensionStateSnapshot {
  fixed_origin: string;
  session: PublicSessionInfo | null;
  pending_pairing: (PublicPairingInfo & { expired: boolean }) | null;
  expired_account_hint: ExpiredAccountHint | null;
  active_capture: ActivePageCapture;
  draft: AccountDraft | null;
  pending_submissions: PendingSubmission[];
}

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'START_PAIRING'; origin?: string }
  | { type: 'REOPEN_PAIRING_TAB' }
  | { type: 'CANCEL_PAIRING' }
  | { type: 'REDEEM_PAIRING' }
  | { type: 'VERIFY_SESSION' }
  | { type: 'DISCONNECT_SESSION'; mode: 'revoke' | 'local' }
  | { type: 'LIST_PROJECTS'; account_id: string; q?: string; limit?: number; cursor?: string }
  | { type: 'SAVE_DRAFT'; account_id: string; draft: AccountDraft }
  | { type: 'CLEAR_DRAFT'; account_id: string; context_key: string }
  | { type: 'CLEAR_ALL_DRAFTS'; account_id: string }
  | {
      type: 'SUBMIT_COLLECTION';
      account_id: string;
      context_key: string;
      idempotency_key: string;
      payload: ExtensionCollectionCreate;
      project_names: Record<string, string>;
    }
  | { type: 'RETRY_PENDING'; account_id: string; submission_id: string }
  | { type: 'DISCARD_PENDING'; account_id: string; submission_id: string };

export type ExtensionMessageResult =
  | { ok: true; state?: ExtensionStateSnapshot }
  | { ok: true; pairing: PublicPairingInfo }
  | { ok: true; session: PublicSessionInfo }
  | { ok: true; projects: ExtensionProjectPage }
  | { ok: true; receipt: { id: string; replayed: boolean } }
  | { ok: false; code: string; status: number; message: string; field?: string };

export interface BackgroundDeps {
  storage: StorageAreaLike;
  api: ExtensionApiClient;
  requestOriginPermission: (origin: string) => Promise<boolean>;
  openTab: (url: string) => Promise<void>;
  readActiveTabCapture: () => Promise<ActivePageCapture>;
  now: () => number;
}

const MENU_SAVE_SELECTION = 'spark-save-selection';
const MENU_SAVE_PAGE = 'spark-save-page';

function toPublicSession(session: ExtensionSession | null): PublicSessionInfo | null {
  if (!session) return null;
  const { token: _t, ...rest } = session;
  return rest;
}

function toPublicPairing(pairing: PendingPairing | null): PublicPairingInfo | null {
  if (!pairing) return null;
  const { verifier: _v, ...rest } = pairing;
  return rest;
}

async function getTrustedSession(storage: StorageAreaLike): Promise<ExtensionSession | null> {
  const session = await getSession(storage);
  if (!session || !isTrustedSparkOrigin(session.origin)) {
    return null;
  }
  return session;
}

function createDefaultDeps(): BackgroundDeps {
  return {
    storage: getDefaultStorage(),
    api: createExtensionApiClient(fetch),
    async requestOriginPermission(origin: string): Promise<boolean> {
      if (!chrome.permissions) return true;
      const pattern = `${origin}/*`;
      const has = await chrome.permissions.contains({ origins: [pattern] });
      if (has) return true;
      return chrome.permissions.request({ origins: [pattern] });
    },
    async openTab(url: string): Promise<void> {
      await chrome.tabs.create({ url, active: true });
    },
    async readActiveTabCapture(): Promise<ActivePageCapture> {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = tab?.url ?? '';
      const title = tab?.title ?? '';
      let selectedText = '';
      if (tab?.id && /^https?:\/\//i.test(url) && chrome.scripting) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => window.getSelection()?.toString() ?? '',
          });
          selectedText = typeof results?.[0]?.result === 'string' ? results[0].result : '';
        } catch {
          selectedText = '';
        }
      }
      return {
        url,
        title,
        selected_text: selectedText,
        source: url ? 'active_tab' : 'empty',
      };
    },
    now: () => Date.now(),
  };
}

function mapApiErrorMessage(err: ExtensionApiError): string {
  switch (err.code) {
    case 'extension_grant_pending':
      return '尚未检测到网页端确认，请先在 Spark 授权页点击「确认授权绑定」，再回到这里完成连接。';
    case 'extension_grant_invalid':
      return '当前配对已过期、已使用或被撤销，请重新生成配对码发起连接。';
    case 'extension_session_expired':
      return '当前扩展授权已到期或已在 Spark 设置中撤销，请重新连接后继续。';
    case 'project_unavailable':
      return '部分已选项目不存在、已暂停或无权访问，请重新选择项目后再保存。';
    case 'operation_in_progress':
      return '上一笔相同请求仍在处理中，请稍后用原请求重试或前往 Spark 核对。';
    case 'duplicate_resource':
      return '该收藏标识已存在或超出幂等保留期，请先去 Spark 核对，或点击「作为新收藏保存」。';
    case 'idempotency_mismatch':
      return '请求内容与原幂等键不一致，已阻止重复覆盖，请以新请求提交。';
    default:
      return err.message;
  }
}

export async function handleExtensionMessage(
  msg: ExtensionMessage,
  deps: BackgroundDeps,
): Promise<ExtensionMessageResult> {
  const { storage, api } = deps;

  switch (msg.type) {
    case 'GET_STATE': {
      const [rawSession, rawPending, rawExpiredHint, ctxCapture] = await Promise.all([
        getSession(storage),
        getPendingPairing(storage),
        getExpiredAccountHint(storage),
        consumeContextCapture(storage, deps.now()),
      ]);
      const session = rawSession && isTrustedSparkOrigin(rawSession.origin) ? rawSession : null;
      const pending = rawPending && isTrustedSparkOrigin(rawPending.origin) ? rawPending : null;
      const expiredHint =
        rawExpiredHint && isTrustedSparkOrigin(rawExpiredHint.origin) ? rawExpiredHint : null;
      const activeCapture: ActivePageCapture = ctxCapture
        ? {
            url: ctxCapture.url,
            title: ctxCapture.title,
            selected_text: ctxCapture.selected_text,
            source: 'context_menu',
          }
        : await deps.readActiveTabCapture();

      const contextKey = activeCapture.url.trim() || '__manual__';
      let draft: AccountDraft | null = null;
      let pendingSubmissions: PendingSubmission[] = [];

      if (session) {
        const bucket = await getAccountBucket(
          storage,
          session.origin,
          session.account_id,
          session.account_label,
        );
        draft = bucket.drafts[contextKey] ?? null;
        pendingSubmissions = bucket.pending_submissions;
      }

      const publicPairing = toPublicPairing(pending);
      const isPairingExpired = publicPairing
        ? deps.now() - Date.parse(publicPairing.created_at) > PAIRING_TTL_MS
        : false;

      return {
        ok: true,
        state: {
          fixed_origin: FIXED_SPARK_ORIGIN,
          session: toPublicSession(session),
          pending_pairing: publicPairing ? { ...publicPairing, expired: isPairingExpired } : null,
          expired_account_hint: session ? null : expiredHint,
          active_capture: activeCapture,
          draft,
          pending_submissions: pendingSubmissions,
        },
      };
    }

    case 'START_PAIRING': {
      if (msg.origin !== undefined && !isTrustedSparkOrigin(msg.origin)) {
        return {
          ok: false,
          code: 'origin_not_allowed',
          status: 403,
          message: `当前扩展仅允许连接固定站点 ${FIXED_SPARK_ORIGIN}。`,
        };
      }

      const granted = await deps.requestOriginPermission(FIXED_SPARK_ORIGIN);
      if (!granted) {
        return {
          ok: false,
          code: 'permission_denied',
          status: 0,
          message: `需要允许扩展访问固定站点 ${FIXED_SPARK_ORIGIN}，才能完成连接与保存。`,
        };
      }

      const verifier = generateVerifier();
      const challenge = await deriveChallenge(verifier);
      const browser = detectBrowserKind();
      const code = formatPairingCode(challenge);
      const pairing: PendingPairing = {
        origin: FIXED_SPARK_ORIGIN,
        browser,
        verifier,
        challenge,
        pair_code: code.grouped,
        created_at: new Date(deps.now()).toISOString(),
      };

      await setPendingPairing(storage, pairing);

      const pairUrl = `${FIXED_SPARK_ORIGIN}/extension/pair#challenge=${encodeURIComponent(challenge)}&browser=${encodeURIComponent(browser)}`;
      await deps.openTab(pairUrl);

      return { ok: true, pairing: toPublicPairing(pairing)! };
    }

    case 'REOPEN_PAIRING_TAB': {
      const pairing = await getPendingPairing(storage);
      if (!pairing || !isTrustedSparkOrigin(pairing.origin)) {
        return { ok: false, code: 'no_pending_pairing', status: 400, message: '当前没有进行中的配对请求。' };
      }
      const pairUrl = `${FIXED_SPARK_ORIGIN}/extension/pair#challenge=${encodeURIComponent(pairing.challenge)}&browser=${encodeURIComponent(pairing.browser)}`;
      await deps.openTab(pairUrl);
      return { ok: true, pairing: toPublicPairing(pairing)! };
    }

    case 'CANCEL_PAIRING': {
      await setPendingPairing(storage, null);
      return { ok: true };
    }

    case 'REDEEM_PAIRING': {
      const pairing = await getPendingPairing(storage);
      if (!pairing || !isTrustedSparkOrigin(pairing.origin)) {
        return {
          ok: false,
          code: 'extension_grant_invalid',
          status: 401,
          message: '没有待完成的配对请求，请重新点击「打开 Spark 授权页」。',
        };
      }

      try {
        const result = await api.redeemToken(FIXED_SPARK_ORIGIN, pairing.verifier);
        const session: ExtensionSession = {
          token: result.token,
          account_id: result.account_id,
          account_label: result.account_label,
          expires_at: result.expires_at,
          origin: FIXED_SPARK_ORIGIN,
          browser: pairing.browser,
          connected_at: new Date(deps.now()).toISOString(),
        };
        await withSessionLock(storage, async () => {
          await setSession(storage, session);
          await setPendingPairing(storage, null);
          await setExpiredAccountHint(storage, null);
        });
        return { ok: true, session: toPublicSession(session)! };
      } catch (err) {
        if (err instanceof ExtensionApiError) {
          if (err.code === 'extension_grant_invalid' || err.status === 401) {
            await withSessionLock(storage, async () => {
              const latestPairing = await getPendingPairing(storage);
              if (latestPairing?.challenge === pairing.challenge) {
                await setPendingPairing(storage, null);
              }
            });
          }
          return {
            ok: false,
            code: err.code,
            status: err.status,
            message: mapApiErrorMessage(err),
          };
        }
        return { ok: false, code: 'network_error', status: 0, message: '兑换连接失败，请稍后重试。' };
      }
    }

    case 'VERIFY_SESSION': {
      const session = await getTrustedSession(storage);
      if (!session) {
        return {
          ok: false,
          code: 'extension_session_expired',
          status: 401,
          message: '扩展尚未连接 Spark 账号。',
        };
      }
      try {
        const latest = await api.getSession(session.origin, session.token);
        const updated = await updateSessionIfMatches(storage, session, (current) => ({
          ...current,
          account_id: latest.account_id,
          account_label: latest.account_label,
          expires_at: latest.expires_at,
        }));
        if (!updated) {
          return {
            ok: false,
            code: 'account_mismatch',
            status: 409,
            message: '当前连接会话已在请求期间变更或断开，请刷新扩展状态。',
          };
        }
        return { ok: true, session: toPublicSession(updated)! };
      } catch (err) {
        if (err instanceof ExtensionApiError && err.status === 401) {
          await expireSessionIfMatches(storage, session);
          return {
            ok: false,
            code: err.code,
            status: 401,
            message: mapApiErrorMessage(err),
          };
        }
        if (err instanceof ExtensionApiError) {
          return { ok: false, code: err.code, status: err.status, message: mapApiErrorMessage(err) };
        }
        return { ok: false, code: 'network_error', status: 0, message: '无法校验连接状态。' };
      }
    }

    case 'DISCONNECT_SESSION': {
      const session = await getTrustedSession(storage);
      if (session && msg.mode === 'revoke') {
        try {
          await api.revokeSession(session.origin, session.token);
        } catch (err) {
          if (!(err instanceof ExtensionApiError && err.status === 401)) {
            if (err instanceof ExtensionApiError) {
              return { ok: false, code: err.code, status: err.status, message: mapApiErrorMessage(err) };
            }
            return { ok: false, code: 'network_error', status: 0, message: '撤销远端设备失败，请检查网络后重试。' };
          }
        }
      }
      await clearSessionIfMatches(storage, session);
      return { ok: true };
    }

    case 'LIST_PROJECTS': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return {
          ok: false,
          code: 'extension_session_expired',
          status: 401,
          message: '当前账号连接已失效或已切换，请刷新扩展状态。',
        };
      }
      try {
        const projects = await api.listProjects(session.origin, session.token, {
          q: msg.q,
          limit: msg.limit,
          cursor: msg.cursor,
        });
        return { ok: true, projects };
      } catch (err) {
        if (err instanceof ExtensionApiError && err.status === 401) {
          await expireSessionIfMatches(storage, session);
          return { ok: false, code: err.code, status: 401, message: mapApiErrorMessage(err) };
        }
        if (err instanceof ExtensionApiError) {
          return { ok: false, code: err.code, status: err.status, message: mapApiErrorMessage(err) };
        }
        return { ok: false, code: 'network_error', status: 0, message: '读取项目列表失败。' };
      }
    }

    case 'SAVE_DRAFT': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return { ok: false, code: 'account_mismatch', status: 409, message: '当前连接账号已切换。' };
      }
      await saveAccountDraft(storage, session.origin, session.account_id, session.account_label, msg.draft);
      return { ok: true };
    }

    case 'CLEAR_DRAFT': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return { ok: false, code: 'account_mismatch', status: 409, message: '当前连接账号已切换。' };
      }
      await removeAccountDraft(storage, session.origin, session.account_id, msg.context_key);
      return { ok: true };
    }

    case 'CLEAR_ALL_DRAFTS': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return { ok: false, code: 'account_mismatch', status: 409, message: '当前连接账号已切换。' };
      }
      await clearAccountDrafts(storage, session.origin, session.account_id);
      return { ok: true };
    }

    case 'SUBMIT_COLLECTION': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return {
          ok: false,
          code: 'account_mismatch',
          status: 409,
          message: '当前连接的 Spark 账号已变更或断开，为防误发已阻止提交，请刷新界面确认账号。',
        };
      }

      const validated = validateAndBuildCollectionPayload({
        id: msg.payload.id,
        original_url: msg.payload.original_url,
        manual_title: msg.payload.manual_title ?? '',
        selected_text: msg.payload.selected_text ?? '',
        intent: msg.payload.intent ?? '',
        project_ids: msg.payload.project_ids,
      });
      if (!validated.ok) {
        return {
          ok: false,
          code: 'validation_failed',
          status: 422,
          field: validated.field,
          message: validated.message,
        };
      }

      const submission = await freezePendingSubmission(
        storage,
        session.origin,
        session.account_id,
        session.account_label,
        {
          id: validated.payload.id,
          idempotency_key: msg.idempotency_key || generateIdempotencyKey(),
          payload: validated.payload,
          project_names: msg.project_names,
          context_key: msg.context_key,
          created_at: new Date(deps.now()).toISOString(),
          last_attempt_at: new Date(deps.now()).toISOString(),
        },
      );

      return executeSubmission(deps, session, submission);
    }

    case 'RETRY_PENDING': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return {
          ok: false,
          code: 'account_mismatch',
          status: 409,
          message: '当前连接账号与待重试记录所属账号不一致，请切回原账号后再重试。',
        };
      }
      const bucket = await getAccountBucket(
        storage,
        session.origin,
        session.account_id,
        session.account_label,
      );
      const target = bucket.pending_submissions.find((item) => item.id === msg.submission_id);
      if (!target) {
        return { ok: false, code: 'not_found', status: 404, message: '未找到对应的待重试快照。' };
      }
      target.last_attempt_at = new Date(deps.now()).toISOString();
      await upsertPendingSubmission(
        storage,
        session.origin,
        session.account_id,
        session.account_label,
        target,
      );
      return executeSubmission(deps, session, target);
    }

    case 'DISCARD_PENDING': {
      const session = await getTrustedSession(storage);
      if (!session || session.account_id !== msg.account_id) {
        return { ok: false, code: 'account_mismatch', status: 409, message: '当前连接账号已切换。' };
      }
      await removePendingSubmission(storage, session.origin, session.account_id, msg.submission_id);
      return { ok: true };
    }
  }
}

async function executeSubmission(
  deps: BackgroundDeps,
  session: ExtensionSession,
  submission: PendingSubmission,
): Promise<ExtensionMessageResult> {
  const { storage, api } = deps;
  try {
    const receipt = await api.createCollection(
      session.origin,
      session.token,
      submission.payload,
      submission.idempotency_key,
    );
    await completePendingSubmission(storage, session.origin, session.account_id, submission);
    return { ok: true, receipt };
  } catch (err) {
    if (err instanceof ExtensionApiError) {
      const friendly = mapApiErrorMessage(err);
      const isDefiniteRejection = err.status === 400 || err.status === 404 || err.status === 422;
      if (isDefiniteRejection) {
        await removePendingSubmission(storage, session.origin, session.account_id, submission.id);
      } else {
        submission.last_error_code = err.code;
        submission.last_error_status = err.status;
        submission.last_error_message = friendly;
        await upsertPendingSubmission(
          storage,
          session.origin,
          session.account_id,
          session.account_label,
          submission,
        );
      }
      if (err.status === 401) {
        await expireSessionIfMatches(storage, session);
      }
      return { ok: false, code: err.code, status: err.status, message: friendly };
    }
    return { ok: false, code: 'network_error', status: 0, message: '保存收藏失败，请重试。' };
  }
}

function registerContextMenus(): void {
  if (!chrome.contextMenus) return;
  void chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_SELECTION,
      title: '收藏选文到 Spark',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: '收藏此页到 Spark',
      contexts: ['page'],
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  ensureTrustedStorageAccessLevel();
  chrome.runtime.onInstalled?.addListener(() => {
    ensureTrustedStorageAccessLevel();
    registerContextMenus();
  });
  chrome.runtime.onStartup?.addListener(() => {
    ensureTrustedStorageAccessLevel();
    registerContextMenus();
  });

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    void (async () => {
      const storage = getDefaultStorage();
      await setContextCapture(storage, {
        tab_id: tab?.id,
        url: tab?.url ?? info.pageUrl ?? '',
        title: tab?.title ?? '',
        selected_text: info.selectionText ?? '',
        captured_at: Date.now(),
        source: 'context_menu',
      });
      try {
        if (chrome.action?.openPopup) {
          await chrome.action.openPopup();
          return;
        }
      } catch {
        // Fall through to compact popup window when openPopup is unsupported in context.
      }
      await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html?source=context'),
        type: 'popup',
        width: 430,
        height: 660,
      });
    })();
  });

  chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
    if (sender.id && typeof chrome.runtime.getURL === 'function') {
      const extOrigin = new URL(chrome.runtime.getURL('popup.html')).origin;
      if (sender.url && !sender.url.startsWith(extOrigin)) {
        return false;
      }
    }
    const deps = createDefaultDeps();
    void handleExtensionMessage(rawMsg as ExtensionMessage, deps).then(sendResponse);
    return true;
  });
}
