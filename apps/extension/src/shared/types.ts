export type BrowserKind = 'chrome' | 'edge';

export interface ExtensionSession {
  token: string;
  account_id: string;
  account_label: string;
  expires_at: string;
  origin: string;
  browser: BrowserKind;
  connected_at: string;
}

export interface PendingPairing {
  origin: string;
  browser: BrowserKind;
  verifier: string;
  challenge: string;
  pair_code: string;
  created_at: string;
}

export interface ExtensionProjectOption {
  id: string;
  name: string;
}

export interface ExtensionProjectPage {
  items: ExtensionProjectOption[];
  next_cursor?: string;
}

export interface ExtensionCollectionCreate {
  id: string;
  original_url: string;
  manual_title?: string;
  selected_text?: string;
  intent?: string;
  project_ids: string[];
}

export interface AccountDraft {
  context_key: string;
  updated_at: string;
  manual_title: string;
  original_url: string;
  selected_text: string;
  intent: string;
  project_ids: string[];
  project_names: Record<string, string>;
}

export interface PendingSubmission {
  id: string;
  idempotency_key: string;
  payload: ExtensionCollectionCreate;
  project_names: Record<string, string>;
  context_key: string;
  draft_updated_at?: string;
  created_at: string;
  last_attempt_at?: string;
  last_error_code?: string;
  last_error_status?: number;
  last_error_message?: string;
}

export interface AccountBucket {
  origin: string;
  account_id: string;
  account_label: string;
  drafts: Record<string, AccountDraft>;
  pending_submissions: PendingSubmission[];
}

export interface ContextCapture {
  tab_id?: number;
  url: string;
  title: string;
  selected_text: string;
  captured_at: number;
  source: 'context_menu' | 'action';
}

export interface ActivePageCapture {
  url: string;
  title: string;
  selected_text: string;
  source: 'context_menu' | 'active_tab' | 'empty';
}
