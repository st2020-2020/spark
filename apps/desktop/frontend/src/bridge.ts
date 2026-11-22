export type Session = {
  connected: boolean;
  account_id?: string;
  account_label?: string;
  expires_at?: string;
  expired?: boolean;
};
export type Phase =
  | 'local_saved'
  | 'syncing'
  | 'synced'
  | 'needs_review'
  | 'auth_paused';
export const phase: Record<Phase, string> = {
  local_saved: '本机已收下 · 待同步',
  syncing: '同步中',
  synced: '已同步',
  needs_review: '需人工核对',
  auth_paused: '会话失效 · 已暂停',
};
export type State = {
  session: Session;
  counts: Partial<Record<Phase, number>>;
  origin: string;
  palette: string;
  mode: string;
  capture_key: string;
  screenshot_key: string;
};
export type Choice = { id: string; name: string; collection_count: number };
export type FileImage = { filename: string; data_b64: string; mime: string };
export type Outbox = {
  id: string;
  raw_text: string;
  intent?: string;
  original_url?: string;
  last_error_message?: string;
  state: Phase;
  created_at: string;
  attachments?: { id: string; filename: string }[];
  project_ids: string[];
  tag_ids: string[];
};
export type Hit = {
  id: string;
  display_title: string;
  snippet: string;
  original_url?: string;
  created_at: string;
  sync_state: Phase;
};
export type Summary = {
  id: string;
  display_title: string;
  excerpt?: string;
  created_at: string;
  original_url?: string;
  cover_attachment_id?: string;
  projects?: { project_id: string; name: string; decision: string }[];
  tags?: { tag_id: string; path: string; decision: string }[];
};
export type Detail = {
  item?: Outbox;
  offline?: boolean;
  collection?: Summary & {
    plain_text?: string;
    document?: { content: DocNode };
    intent?: string;
    attachments?: { id: string; filename: string }[];
    organization?: { summary?: string; status: string };
    image_notes?: { text: string }[];
  };
};
type DocNode = { type: string; text?: string; content?: DocNode[] };
export function plain(n?: DocNode): string {
  if (!n) return '';
  if (n.type === 'hardBreak') return '\n';
  return (
    n.text ??
    n.content
      ?.map(plain)
      .join(
        ['doc', 'bulletList', 'orderedList', 'listItem'].includes(n.type)
          ? '\n'
          : '',
      ) ??
    ''
  );
}
export type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
export function bridge(account = ''): Request {
  return async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ) => {
    const response = await fetch('/local/' + path, {
      method,
      signal,
      cache: 'no-store',
      headers: {
        'X-Spark-Desktop': '1',
        'X-Spark-Account': account,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || '连接暂不可用，请稍后重试。');
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
}
export const message = (e: unknown) =>
  e instanceof Error ? e.message : '操作未完成，请重试。';
export function detectURL(text: string) {
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'，。；！？]+/gi)) {
    try {
      const raw = m[0].replace(/[).,;!?]+$/, '');
      const u = new URL(raw);
      if (!u.username && !u.password) return raw;
    } catch {
      /* continue scanning */
    }
  }
  return '';
}
export function dateLabel(iso: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(iso));
}
export function active(d: string) {
  return ['manual', 'confirmed', 'auto'].includes(d);
}
export function fileImage(file: File): Promise<FileImage> {
  if (
    file.size > 5 * 1024 * 1024 ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
  )
    return Promise.reject(
      new Error('请选择 5 MiB 以内的 PNG、JPEG、GIF 或 WebP 图片。'),
    );
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      resolve({
        filename: file.name || '剪贴板.png',
        mime: file.type,
        data_b64: String(r.result).split(',')[1],
      });
    r.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
    r.readAsDataURL(file);
  });
}
