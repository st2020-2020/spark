import type {
  ExtensionMessage,
  ExtensionMessageResult,
  ExtensionStateSnapshot,
  PublicSessionInfo,
} from '../background/serviceWorker';
import {
  EXTENSION_SCOPE_LIST,
  EXTENSION_SCOPE_SUMMARY,
  ensureTrustedStorageAccessLevel,
} from '../shared/config';
import { generateIdempotencyKey, generateUuid } from '../shared/crypto';
import type { ExtensionProjectOption, PendingSubmission } from '../shared/types';
import {
  MAX_PROJECTS,
  MAX_TEXT_AND_INTENT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
  countUnicodeChars,
  isValidCollectionUrl,
  validateAndBuildCollectionPayload,
} from '../shared/validation';

export type SendMessageFn = (msg: ExtensionMessage) => Promise<ExtensionMessageResult>;

function sendToBackground(msg: ExtensionMessage): Promise<ExtensionMessageResult> {
  return chrome.runtime.sendMessage<ExtensionMessageResult>(msg);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeBtn(
  label: string,
  opts: { className?: string; disabled?: boolean; ariaPressed?: boolean; ariaLabel?: string; onClick: () => void },
): HTMLButtonElement {
  const btn = el('button', opts.className ?? 'sp-btn', label);
  btn.type = 'button';
  if (opts.disabled) btn.disabled = true;
  if (opts.ariaPressed !== undefined) btn.setAttribute('aria-pressed', String(opts.ariaPressed));
  if (opts.ariaLabel) btn.setAttribute('aria-label', opts.ariaLabel);
  btn.addEventListener('click', opts.onClick);
  return btn;
}

function openExternalTab(url: string): void {
  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    void chrome.tabs.create({ url, active: true });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export interface PopupControllerOptions {
  root: HTMLElement;
  sendMessage?: SendMessageFn;
  openUrl?: (url: string) => void;
}

export async function mountExtensionPopup(opts: PopupControllerOptions): Promise<void> {
  ensureTrustedStorageAccessLevel();
  const sendMessage = opts.sendMessage ?? sendToBackground;
  const openUrl = opts.openUrl ?? openExternalTab;
  const root = opts.root;

  let snapshot: ExtensionStateSnapshot | null = null;
  let pairError: string | null = null;
  let pairBusy = false;

  let sessionPanelOpen = false;
  let sessionBusy = false;
  let sessionError: string | null = null;
  let sessionNotice: string | null = null;

  let collectionId = generateUuid();
  let idempotencyKey = generateIdempotencyKey();
  let hasSubmittedCurrent = false;
  let contextKey = '__manual__';
  let originalUrl = '';
  let manualTitle = '';
  let selectedText = '';
  let intent = '';
  let projectIds: string[] = [];
  let projectNames: Record<string, string> = {};

  let projects: ExtensionProjectOption[] = [];
  let nextCursor: string | undefined;
  let projectQuery = '';
  let projectsLoading = false;
  let projectsError: string | null = null;
  let searchTimer: number | undefined;

  let submitBusy = false;
  let submitError: string | null = null;
  let submitField: string | undefined;
  let lastSavedReceipt: { id: string; replayed: boolean; origin: string } | null = null;
  let draftTimer: number | undefined;

  function hydrateFormFromState(next: ExtensionStateSnapshot): void {
    const cap = next.active_capture;
    contextKey = cap.url.trim() || '__manual__';
    if (next.draft) {
      originalUrl = next.draft.original_url || cap.url;
      manualTitle = next.draft.manual_title;
      selectedText = next.draft.selected_text;
      intent = next.draft.intent;
      projectIds = [...next.draft.project_ids];
      projectNames = { ...next.draft.project_names };
    } else {
      originalUrl = cap.url;
      manualTitle = cap.title;
      selectedText = cap.selected_text;
      intent = '';
      projectIds = [];
      projectNames = {};
    }
    collectionId = generateUuid();
    idempotencyKey = generateIdempotencyKey();
    hasSubmittedCurrent = false;
  }

  function markSnapshotModified(): void {
    if (hasSubmittedCurrent) {
      idempotencyKey = generateIdempotencyKey();
      hasSubmittedCurrent = false;
    }
    submitError = null;
    submitField = undefined;
    scheduleDraftSave();
  }

  function scheduleDraftSave(): void {
    const session = snapshot?.session;
    if (!session) return;
    if (draftTimer !== undefined) {
      window.clearTimeout(draftTimer);
    }
    draftTimer = window.setTimeout(() => {
      void persistDraftNow();
    }, 150);
  }

  async function persistDraftNow(): Promise<void> {
    const session = snapshot?.session;
    if (!session) return;
    await sendMessage({
      type: 'SAVE_DRAFT',
      account_id: session.account_id,
      draft: {
        context_key: contextKey,
        updated_at: new Date().toISOString(),
        manual_title: manualTitle,
        original_url: originalUrl,
        selected_text: selectedText,
        intent,
        project_ids: projectIds,
        project_names: projectNames,
      },
    });
  }

  async function loadProjects(reset = true): Promise<void> {
    const session = snapshot?.session;
    if (!session) return;
    projectsLoading = true;
    projectsError = null;
    if (reset) {
      nextCursor = undefined;
    }
    render();
    const res = await sendMessage({
      type: 'LIST_PROJECTS',
      account_id: session.account_id,
      q: projectQuery,
      limit: 30,
      cursor: reset ? undefined : nextCursor,
    });
    projectsLoading = false;
    if (res.ok && 'projects' in res) {
      const page = res.projects;
      projects = reset ? page.items : [...projects, ...page.items];
      for (const p of page.items) {
        projectNames[p.id] = p.name;
      }
      nextCursor = page.next_cursor;
    } else if (!res.ok) {
      projectsError = res.message;
      if (res.status === 401) {
        await refreshAll(false);
        return;
      }
    }
    render();
  }

  async function refreshAll(rehydrateForm = true): Promise<void> {
    const res = await sendMessage({ type: 'GET_STATE' });
    if (res.ok && 'state' in res && res.state) {
      snapshot = res.state;
      if (rehydrateForm) {
        hydrateFormFromState(snapshot);
      }
      if (snapshot.session) {
        void loadProjects(true);
      } else {
        projects = [];
        nextCursor = undefined;
      }
    }
    render();
  }

  async function handleStartPairing(): Promise<void> {
    pairError = null;
    pairBusy = true;
    render();
    const res = await sendMessage({ type: 'START_PAIRING' });
    pairBusy = false;
    if (res.ok && 'pairing' in res) {
      await refreshAll(false);
      return;
    }
    if (!res.ok) {
      pairError = res.message;
    }
    render();
  }

  async function handleRedeemPairing(): Promise<void> {
    pairError = null;
    pairBusy = true;
    render();
    const res = await sendMessage({ type: 'REDEEM_PAIRING' });
    pairBusy = false;
    if (res.ok && 'session' in res) {
      sessionPanelOpen = false;
      sessionError = null;
      sessionNotice = null;
      await refreshAll(true);
      return;
    }
    if (!res.ok) {
      pairError = res.message;
      await refreshAll(false);
    }
    render();
  }

  async function handleSubmit(): Promise<void> {
    const session = snapshot?.session;
    if (!session || submitBusy) return;
    if (draftTimer !== undefined) {
      window.clearTimeout(draftTimer);
    }
    const validation = validateAndBuildCollectionPayload({
      id: collectionId,
      original_url: originalUrl,
      manual_title: manualTitle,
      selected_text: selectedText,
      intent,
      project_ids: projectIds,
    });
    if (!validation.ok) {
      submitError = validation.message;
      submitField = validation.field;
      render();
      return;
    }

    await persistDraftNow();
    submitBusy = true;
    submitError = null;
    submitField = undefined;
    lastSavedReceipt = null;
    hasSubmittedCurrent = true;
    render();

    const res = await sendMessage({
      type: 'SUBMIT_COLLECTION',
      account_id: session.account_id,
      context_key: contextKey,
      idempotency_key: idempotencyKey,
      payload: validation.payload,
      project_names: { ...projectNames },
    });
    submitBusy = false;

    if (res.ok && 'receipt' in res) {
      lastSavedReceipt = { ...res.receipt, origin: session.origin };
      manualTitle = '';
      selectedText = '';
      intent = '';
      collectionId = generateUuid();
      idempotencyKey = generateIdempotencyKey();
      hasSubmittedCurrent = false;
      await refreshAll(false);
      return;
    }

    if (!res.ok) {
      submitError = res.message;
      if (res.code === 'project_unavailable') {
        submitField = 'project_ids';
        void loadProjects(true);
      }
      if (res.status === 401) {
        await refreshAll(false);
        return;
      }
      await refreshAll(false);
    }
    render();
  }

  async function handleRetryPending(item: PendingSubmission, session: PublicSessionInfo): Promise<void> {
    submitBusy = true;
    submitError = null;
    render();
    const res = await sendMessage({
      type: 'RETRY_PENDING',
      account_id: session.account_id,
      submission_id: item.id,
    });
    submitBusy = false;
    if (res.ok && 'receipt' in res) {
      lastSavedReceipt = { ...res.receipt, origin: session.origin };
      await refreshAll(false);
      return;
    }
    if (!res.ok) {
      submitError = res.message;
      await refreshAll(false);
    }
    render();
  }

  function renderHeader(state: ExtensionStateSnapshot): HTMLElement {
    const header = el('header', 'sp-ext-header');
    const brand = el('div', 'sp-ext-brand');
    brand.append(el('span', 'sp-ext-brand-badge', 'S'), el('span', '', 'Spark 收集助手'));

    const statusPill = state.session
      ? el('span', 'sp-pill sp-pill--active', state.session.account_label)
      : state.pending_pairing
        ? el('span', 'sp-pill sp-pill--warning', '等待网页确认')
        : state.expired_account_hint
          ? el('span', 'sp-pill sp-pill--warning', '授权已失效')
          : el('span', 'sp-pill', '未连接');

    header.append(brand, statusPill);
    return header;
  }

  function renderUnconnectedView(state: ExtensionStateSnapshot): HTMLElement {
    const card = el('section', 'sp-card');
    card.setAttribute('aria-label', '连接 Spark 账号');

    if (state.expired_account_hint) {
      const hintBanner = el('div', 'sp-banner sp-banner--warning');
      hintBanner.setAttribute('role', 'status');
      hintBanner.append(
        el(
          'span',
          '',
          `账号 ${state.expired_account_hint.account_label} 的授权已到期或已在 Spark 设置中撤销。使用同一账号重新连接可恢复待重试请求与本地草稿；如改绑其他账号，旧账号草稿会自动隔离保存。`,
        ),
      );
      card.append(hintBanner);
    }

    if (pairError) {
      const errEl = el('div', 'sp-banner sp-banner--error');
      errEl.setAttribute('role', 'alert');
      errEl.textContent = pairError;
      card.append(errEl);
    }

    if (state.pending_pairing) {
      const pending = state.pending_pairing;
      card.append(el('h2', 'sp-title', '核对并完成扩展连接'));
      card.append(el('p', 'sp-help', `目标服务：${pending.origin}`));
      card.append(el('div', 'sp-pair-code', pending.pair_code));
      card.append(
        el(
          'p',
          'sp-help',
          '请确认 Spark 授权页上显示相同的 8 位配对码（大小写敏感）并点击「确认授权绑定」，随后返回此处点击完成连接。',
        ),
      );

      if (pending.expired) {
        const expEl = el('div', 'sp-banner sp-banner--warning');
        expEl.textContent = '当前配对码已超过 5 分钟，请重新发起连接。';
        card.append(expEl);
      }

      const actions = el('div', 'sp-row');
      actions.append(
        makeBtn(pairBusy ? '连接中…' : '我已确认，完成连接', {
          className: 'sp-btn sp-btn--primary',
          disabled: pairBusy,
          onClick: () => void handleRedeemPairing(),
        }),
        makeBtn('重新打开授权页', {
          disabled: pairBusy,
          onClick: () => void sendMessage({ type: 'REOPEN_PAIRING_TAB' }),
        }),
        makeBtn('重新生成配对码', {
          className: 'sp-btn sp-btn--quiet',
          disabled: pairBusy,
          onClick: () => void handleStartPairing(),
        }),
        makeBtn('取消', {
          className: 'sp-btn sp-btn--quiet',
          disabled: pairBusy,
          onClick: async () => {
            pairError = null;
            await sendMessage({ type: 'CANCEL_PAIRING' });
            await refreshAll(false);
          },
        }),
      );
      card.append(actions);
      return card;
    }

    card.append(el('h2', 'sp-title', '连接你的 Spark 空间'));

    const targetBox = el('div', 'sp-ext-target');
    targetBox.append(
      el('span', 'sp-label', '固定 Spark 服务'),
      el('code', 'sp-ext-target-origin', state.fixed_origin),
    );
    card.append(targetBox);

    const scopeBox = el('div', 'sp-ext-scope');
    scopeBox.setAttribute('aria-label', '扩展操作权限说明');
    scopeBox.append(el('strong', 'sp-label', '本次授予的最小权限'));
    const scopeList = el('ul', 'sp-ext-scope-list');
    for (const item of EXTENSION_SCOPE_LIST) {
      scopeList.append(el('li', '', item));
    }
    scopeBox.append(scopeList);
    card.append(scopeBox);

    card.append(
      makeBtn(pairBusy ? '正在打开授权页…' : '打开 Spark 授权页', {
        className: 'sp-btn sp-btn--primary',
        disabled: pairBusy,
        onClick: () => void handleStartPairing(),
      }),
    );

    return card;
  }

  function renderSessionPanel(session: PublicSessionInfo): HTMLElement {
    const panel = el('section', 'sp-card');
    panel.setAttribute('aria-label', '连接与账号管理');
    panel.append(el('h2', 'sp-title', '当前连接设备'));
    panel.append(el('p', 'sp-help', `账号：${session.account_label}`));
    panel.append(el('p', 'sp-help', `固定服务：${session.origin}`));
    panel.append(el('p', 'sp-help', `到期：${new Date(session.expires_at).toLocaleString('zh-CN')}`));
    panel.append(el('p', 'sp-help', `权限范围：${EXTENSION_SCOPE_SUMMARY}`));
    panel.append(
      el(
        'p',
        'sp-help',
        '断开或切换账号时，当前账号的本地草稿与待重试记录仅留在本机该账号分区，新账号无法看到或发送。',
      ),
    );

    if (sessionError) {
      const err = el('div', 'sp-banner sp-banner--error');
      err.setAttribute('role', 'alert');
      err.textContent = sessionError;
      panel.append(err);
    }
    if (sessionNotice) {
      const notice = el('div', 'sp-banner sp-banner--success');
      notice.setAttribute('role', 'status');
      notice.textContent = sessionNotice;
      panel.append(notice);
    }

    const row = el('div', 'sp-row');
    row.append(
      makeBtn('刷新连接状态', {
        className: 'sp-btn sp-btn--sm',
        disabled: sessionBusy,
        onClick: async () => {
          sessionBusy = true;
          sessionError = null;
          sessionNotice = null;
          render();
          const res = await sendMessage({ type: 'VERIFY_SESSION' });
          sessionBusy = false;
          if (res.ok) {
            sessionNotice = '当前授权有效';
            await refreshAll(false);
          } else {
            sessionError = res.message;
            await refreshAll(false);
          }
        },
      }),
      makeBtn('撤销设备并切换账号', {
        className: 'sp-btn sp-btn--sm sp-btn--danger',
        disabled: sessionBusy,
        onClick: async () => {
          sessionBusy = true;
          sessionError = null;
          render();
          const res = await sendMessage({ type: 'DISCONNECT_SESSION', mode: 'revoke' });
          sessionBusy = false;
          if (res.ok) {
            sessionPanelOpen = false;
            await refreshAll(true);
          } else {
            sessionError = res.message;
            render();
          }
        },
      }),
      makeBtn('清空本账号草稿', {
        className: 'sp-btn sp-btn--sm sp-btn--quiet',
        disabled: sessionBusy,
        onClick: async () => {
          await sendMessage({ type: 'CLEAR_ALL_DRAFTS', account_id: session.account_id });
          manualTitle = snapshot?.active_capture.title ?? '';
          originalUrl = snapshot?.active_capture.url ?? '';
          selectedText = snapshot?.active_capture.selected_text ?? '';
          intent = '';
          projectIds = [];
          sessionNotice = '已清空本账号本地草稿';
          render();
        },
      }),
    );
    panel.append(row);
    return panel;
  }

  function renderPendingBanner(item: PendingSubmission, session: PublicSessionInfo): HTMLElement {
    const box = el('section', 'sp-banner sp-banner--warning');
    box.setAttribute('aria-label', '待确认提交');
    const summaryTitle = item.payload.manual_title || item.payload.original_url;
    box.append(el('strong', '', `待重试收藏：${summaryTitle}`));
    if (item.last_error_message) {
      box.append(el('span', '', item.last_error_message));
    } else {
      box.append(el('span', '', '上次提交结果未确认，可使用原幂等请求重试。'));
    }

    const actions = el('div', 'sp-row');
    actions.append(
      makeBtn('用原请求重试', {
        className: 'sp-btn sp-btn--sm sp-btn--primary',
        disabled: submitBusy,
        onClick: () => void handleRetryPending(item, session),
      }),
      makeBtn('去 Spark 核对', {
        className: 'sp-btn sp-btn--sm',
        onClick: () => openUrl(`${session.origin}/collections/${item.id}`),
      }),
      makeBtn('放弃', {
        className: 'sp-btn sp-btn--sm sp-btn--quiet',
        disabled: submitBusy,
        onClick: async () => {
          await sendMessage({
            type: 'DISCARD_PENDING',
            account_id: session.account_id,
            submission_id: item.id,
          });
          await refreshAll(false);
        },
      }),
    );
    if (item.last_error_code === 'duplicate_resource' || item.last_error_code === 'idempotency_mismatch') {
      actions.append(
        makeBtn('作为新收藏保存', {
          className: 'sp-btn sp-btn--sm',
          onClick: async () => {
            originalUrl = item.payload.original_url;
            manualTitle = item.payload.manual_title ?? '';
            selectedText = item.payload.selected_text ?? '';
            intent = item.payload.intent ?? '';
            projectIds = [...item.payload.project_ids];
            projectNames = { ...projectNames, ...item.project_names };
            collectionId = generateUuid();
            idempotencyKey = generateIdempotencyKey();
            hasSubmittedCurrent = false;
            await sendMessage({
              type: 'DISCARD_PENDING',
              account_id: session.account_id,
              submission_id: item.id,
            });
            await refreshAll(false);
          },
        }),
      );
    }
    box.append(actions);
    return box;
  }

  function renderComposer(state: ExtensionStateSnapshot, session: PublicSessionInfo): HTMLElement {
    const container = el('div', 'sp-stack');

    const topBar = el('div', 'sp-row-between');
    const sourceText =
      state.active_capture.source === 'context_menu'
        ? '来自右键选区/页面菜单'
        : state.active_capture.source === 'active_tab'
          ? '已读取当前标签页'
          : '手动输入网址保存';
    topBar.append(
      el('span', 'sp-help', sourceText),
      makeBtn(sessionPanelOpen ? '收起连接管理' : '连接管理', {
        className: 'sp-btn sp-btn--quiet',
        onClick: () => {
          sessionPanelOpen = !sessionPanelOpen;
          render();
        },
      }),
    );
    container.append(topBar);

    if (sessionPanelOpen) {
      container.append(renderSessionPanel(session));
    }

    for (const pending of state.pending_submissions) {
      container.append(renderPendingBanner(pending, session));
    }

    if (lastSavedReceipt) {
      const okBox = el('div', 'sp-banner sp-banner--success');
      okBox.setAttribute('role', 'status');
      okBox.append(
        el(
          'span',
          '',
          lastSavedReceipt.replayed
            ? '已保存到 Spark（幂等重放命中，未重复创建）。'
            : '已保存到 Spark。',
        ),
      );
      const linkBtn = makeBtn('在 Spark 中查看', {
        className: 'sp-link',
        onClick: () => openUrl(`${lastSavedReceipt!.origin}/collections/${lastSavedReceipt!.id}`),
      });
      okBox.append(linkBtn);
      container.append(okBox);
    }

    const card = el('section', 'sp-card');
    card.setAttribute('aria-label', '保存网页或选文');

    if (submitError) {
      const errBox = el('div', 'sp-banner sp-banner--error');
      errBox.setAttribute('role', 'alert');
      errBox.textContent = submitError;
      card.append(errBox);
    }

    // URL field
    const urlField = el('div', 'sp-field');
    const urlLabelRow = el('div', 'sp-label-row');
    const urlLabel = el('label', 'sp-label', '网页地址');
    urlLabel.setAttribute('for', 'ext-url');
    const urlCount = countUnicodeChars(originalUrl.trim());
    urlLabelRow.append(
      urlLabel,
      el('span', `sp-counter ${urlCount > MAX_URL_CHARS ? 'sp-counter--over' : ''}`, `${urlCount} / ${MAX_URL_CHARS}`),
    );
    const urlInput = el(
      'input',
      `sp-input ${submitField === 'original_url' || (originalUrl.trim() && !isValidCollectionUrl(originalUrl)) ? 'sp-input--invalid' : ''}`,
    );
    urlInput.id = 'ext-url';
    urlInput.type = 'url';
    urlInput.placeholder = 'https://example.com/article';
    urlInput.value = originalUrl;
    urlInput.addEventListener('input', () => {
      originalUrl = urlInput.value;
      markSnapshotModified();
    });
    urlField.append(urlLabelRow, urlInput);
    card.append(urlField);

    // Title field
    const titleField = el('div', 'sp-field');
    const titleLabelRow = el('div', 'sp-label-row');
    const titleLabel = el('label', 'sp-label', '标题');
    titleLabel.setAttribute('for', 'ext-title');
    const titleCount = countUnicodeChars(manualTitle.trim());
    titleLabelRow.append(
      titleLabel,
      el('span', `sp-counter ${titleCount > MAX_TITLE_CHARS ? 'sp-counter--over' : ''}`, `${titleCount} / ${MAX_TITLE_CHARS}`),
    );
    const titleInput = el(
      'input',
      `sp-input ${submitField === 'manual_title' || titleCount > MAX_TITLE_CHARS ? 'sp-input--invalid' : ''}`,
    );
    titleInput.id = 'ext-title';
    titleInput.type = 'text';
    titleInput.placeholder = '可选网页标题（最多 200 字）';
    titleInput.value = manualTitle;
    titleInput.addEventListener('input', () => {
      manualTitle = titleInput.value;
      markSnapshotModified();
      const counter = titleLabelRow.lastElementChild;
      if (counter) {
        const nextCount = countUnicodeChars(manualTitle.trim());
        counter.textContent = `${nextCount} / ${MAX_TITLE_CHARS}`;
        counter.className = `sp-counter ${nextCount > MAX_TITLE_CHARS ? 'sp-counter--over' : ''}`;
      }
    });
    titleField.append(titleLabelRow, titleInput);
    card.append(titleField);

    // Selection text field
    const textField = el('div', 'sp-field');
    const textLabelRow = el('div', 'sp-label-row');
    const textLabel = el('label', 'sp-label', '选中纯文本（不选则只存标题与网址）');
    textLabel.setAttribute('for', 'ext-text');
    const combinedCount = countUnicodeChars(selectedText.trim()) + countUnicodeChars(intent.trim());
    const combinedCounterEl = el(
      'span',
      `sp-counter ${combinedCount > MAX_TEXT_AND_INTENT_CHARS ? 'sp-counter--over' : ''}`,
      `选文+用途 ${combinedCount.toLocaleString()} / ${MAX_TEXT_AND_INTENT_CHARS.toLocaleString()}`,
    );
    textLabelRow.append(textLabel, combinedCounterEl);
    const textArea = el(
      'textarea',
      `sp-textarea ${submitField === 'selected_text' || combinedCount > MAX_TEXT_AND_INTENT_CHARS ? 'sp-textarea--invalid' : ''}`,
    );
    textArea.id = 'ext-text';
    textArea.placeholder = '网页中选取的文字内容（仅保存纯文本）…';
    textArea.value = selectedText;
    const syncCombinedCounter = () => {
      const total = countUnicodeChars(selectedText.trim()) + countUnicodeChars(intent.trim());
      combinedCounterEl.textContent = `选文+用途 ${total.toLocaleString()} / ${MAX_TEXT_AND_INTENT_CHARS.toLocaleString()}`;
      combinedCounterEl.className = `sp-counter ${total > MAX_TEXT_AND_INTENT_CHARS ? 'sp-counter--over' : ''}`;
    };
    textArea.addEventListener('input', () => {
      selectedText = textArea.value;
      markSnapshotModified();
      syncCombinedCounter();
    });
    textField.append(textLabelRow, textArea);
    card.append(textField);

    // Intent field
    const intentField = el('div', 'sp-field');
    const intentLabel = el('label', 'sp-label', '用途说明');
    intentLabel.setAttribute('for', 'ext-intent');
    const intentArea = el('textarea', `sp-textarea ${submitField === 'intent' ? 'sp-textarea--invalid' : ''}`);
    intentArea.id = 'ext-intent';
    intentArea.placeholder = '补一句为什么收藏或准备怎么用…';
    intentArea.value = intent;
    intentArea.addEventListener('input', () => {
      intent = intentArea.value;
      markSnapshotModified();
      syncCombinedCounter();
    });
    intentField.append(intentLabel, intentArea);
    card.append(intentField);

    // Projects picker
    const projField = el('div', 'sp-field');
    const projLabelRow = el('div', 'sp-label-row');
    const projLabel = el('label', 'sp-label', '归属项目');
    projLabel.setAttribute('for', 'ext-project-search');
    projLabelRow.append(projLabel, el('span', 'sp-counter', `已选 ${projectIds.length} / ${MAX_PROJECTS}`));
    projField.append(projLabelRow);

    if (projectIds.length > 0) {
      const chipsWrap = el('div', 'sp-project-chips');
      for (const pid of projectIds) {
        const chip = el('span', 'sp-project-chip');
        const pName = projectNames[pid] ?? '已选项目';
        chip.append(el('span', '', pName));
        const rm = makeBtn('×', {
          className: 'sp-project-chip-remove',
          ariaLabel: `移除项目 ${pName}`,
          onClick: () => {
            projectIds = projectIds.filter((id) => id !== pid);
            markSnapshotModified();
            render();
          },
        });
        chip.append(rm);
        chipsWrap.append(chip);
      }
      projField.append(chipsWrap);
    }

    const searchInput = el('input', 'sp-input');
    searchInput.id = 'ext-project-search';
    searchInput.type = 'search';
    searchInput.placeholder = '搜索进行中的项目…';
    searchInput.value = projectQuery;
    searchInput.addEventListener('input', () => {
      projectQuery = searchInput.value;
      if (searchTimer !== undefined) {
        window.clearTimeout(searchTimer);
      }
      searchTimer = window.setTimeout(() => {
        void loadProjects(true);
      }, 220);
    });
    projField.append(searchInput);

    if (projectsError) {
      const pErr = el('p', 'sp-help', projectsError);
      projField.append(pErr);
    }

    if (projects.length > 0) {
      const optionsList = el('div', 'sp-project-options');
      optionsList.setAttribute('role', 'group');
      optionsList.setAttribute('aria-label', '可选项目');
      for (const p of projects) {
        const selected = projectIds.includes(p.id);
        const opt = el('button', 'sp-project-option');
        opt.type = 'button';
        opt.setAttribute('aria-pressed', String(selected));
        opt.append(el('span', '', p.name));
        if (selected) {
          opt.append(el('span', '', '✓'));
        }
        opt.addEventListener('click', () => {
          projectNames[p.id] = p.name;
          if (selected) {
            projectIds = projectIds.filter((id) => id !== p.id);
          } else if (projectIds.length < MAX_PROJECTS) {
            projectIds = [...projectIds, p.id];
          }
          markSnapshotModified();
          render();
        });
        optionsList.append(opt);
      }
      projField.append(optionsList);
    } else if (!projectsLoading) {
      projField.append(el('p', 'sp-help', projectQuery.trim() ? '没有匹配的进行中项目' : '暂无进行中的项目（可留空进收件箱）'));
    }

    if (nextCursor) {
      projField.append(
        makeBtn(projectsLoading ? '加载中…' : '加载更多项目', {
          className: 'sp-btn sp-btn--sm',
          disabled: projectsLoading,
          onClick: () => void loadProjects(false),
        }),
      );
    }
    card.append(projField);

    const footer = el('div', 'sp-row-between');
    footer.append(
      makeBtn('重置本页草稿', {
        className: 'sp-btn sp-btn--quiet',
        disabled: submitBusy,
        onClick: async () => {
          await sendMessage({
            type: 'CLEAR_DRAFT',
            account_id: session.account_id,
            context_key: contextKey,
          });
          manualTitle = state.active_capture.title;
          originalUrl = state.active_capture.url;
          selectedText = state.active_capture.selected_text;
          intent = '';
          projectIds = [];
          collectionId = generateUuid();
          idempotencyKey = generateIdempotencyKey();
          hasSubmittedCurrent = false;
          submitError = null;
          render();
        },
      }),
      makeBtn(submitBusy ? '保存中…' : '保存到 Spark', {
        className: 'sp-btn sp-btn--primary',
        disabled: submitBusy,
        onClick: () => void handleSubmit(),
      }),
    );
    card.append(footer);

    container.append(card);
    return container;
  }

  function render(): void {
    const activeId = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
    const selStart =
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
        ? document.activeElement.selectionStart
        : null;
    const selEnd =
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
        ? document.activeElement.selectionEnd
        : null;

    root.replaceChildren();
    if (!snapshot) {
      root.append(el('p', 'sp-help', '正在加载…'));
      return;
    }
    root.append(renderHeader(snapshot));
    if (!snapshot.session) {
      root.append(renderUnconnectedView(snapshot));
    } else {
      root.append(renderComposer(snapshot, snapshot.session));
    }

    if (activeId) {
      const nextActive = document.getElementById(activeId);
      if (nextActive instanceof HTMLElement) {
        nextActive.focus();
        if (
          selStart !== null &&
          selEnd !== null &&
          (nextActive instanceof HTMLInputElement || nextActive instanceof HTMLTextAreaElement)
        ) {
          nextActive.setSelectionRange(selStart, selEnd);
        }
      }
    }
  }

  await refreshAll(true);
}

if (typeof document !== 'undefined' && document.getElementById('app')) {
  void mountExtensionPopup({ root: document.getElementById('app')! });
}
