import type { ExtensionCollectionCreate } from './types';

export const MAX_TITLE_CHARS = 200;
export const MAX_URL_CHARS = 4096;
export const MAX_TEXT_AND_INTENT_CHARS = 50000;
export const MAX_PROJECTS = 50;
export const PAIRING_TTL_MS = 5 * 60 * 1000;

export function countUnicodeChars(value: string): number {
  return Array.from(value).length;
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function normalizeSparkOrigin(
  raw: string,
): { ok: true; origin: string; isInsecureRemote: boolean } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: '请输入 Spark 服务地址（如 http://localhost:5173 或 https://你的域名）' };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: '服务地址必须使用 http:// 或 https:// 协议' };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, message: '服务地址不能包含用户名或密码' };
    }
    if (!parsed.hostname) {
      return { ok: false, message: '服务地址缺少主机名' };
    }
    return {
      ok: true,
      origin: parsed.origin,
      isInsecureRemote: parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname),
    };
  } catch {
    return { ok: false, message: '服务地址格式无效，请检查协议和域名' };
  }
}

export function isValidCollectionUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || countUnicodeChars(trimmed) > MAX_URL_CHARS) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export interface CollectionInputFields {
  id: string;
  original_url: string;
  manual_title: string;
  selected_text: string;
  intent: string;
  project_ids: string[];
}

export type ValidationResult =
  | { ok: true; payload: ExtensionCollectionCreate }
  | {
      ok: false;
      field: 'original_url' | 'manual_title' | 'selected_text' | 'intent' | 'project_ids';
      message: string;
    };

export function validateAndBuildCollectionPayload(input: CollectionInputFields): ValidationResult {
  const originalUrl = input.original_url.trim();
  if (!originalUrl) {
    return { ok: false, field: 'original_url', message: '网页地址不能为空' };
  }
  if (countUnicodeChars(originalUrl) > MAX_URL_CHARS) {
    return {
      ok: false,
      field: 'original_url',
      message: `网页地址不能超过 ${MAX_URL_CHARS.toLocaleString()} 个字符（当前 ${countUnicodeChars(originalUrl).toLocaleString()}）`,
    };
  }
  if (!isValidCollectionUrl(originalUrl)) {
    return {
      ok: false,
      field: 'original_url',
      message: '仅支持保存无凭据的 http:// 或 https:// 网页地址（暂不支持浏览器内部页）',
    };
  }

  const manualTitle = input.manual_title.trim();
  const titleChars = countUnicodeChars(manualTitle);
  if (titleChars > MAX_TITLE_CHARS) {
    return {
      ok: false,
      field: 'manual_title',
      message: `标题请缩短至 ${MAX_TITLE_CHARS} 个字符以内（当前 ${titleChars} / ${MAX_TITLE_CHARS}）`,
    };
  }

  const selectedText = input.selected_text.trim();
  const intent = input.intent.trim();
  const selectedChars = countUnicodeChars(selectedText);
  const intentChars = countUnicodeChars(intent);
  const combinedChars = selectedChars + intentChars;
  if (combinedChars > MAX_TEXT_AND_INTENT_CHARS) {
    const excess = combinedChars - MAX_TEXT_AND_INTENT_CHARS;
    const targetField = intentChars > selectedChars ? 'intent' : 'selected_text';
    const fieldLabel = intent ? '选文与用途合计' : '选文';
    return {
      ok: false,
      field: targetField,
      message: `${fieldLabel}超出 ${MAX_TEXT_AND_INTENT_CHARS.toLocaleString()} 字符上限（需删减 ${excess.toLocaleString()} 字）`,
    };
  }

  const dedupedProjects = Array.from(new Set(input.project_ids.filter(Boolean)));
  if (dedupedProjects.length > MAX_PROJECTS) {
    return {
      ok: false,
      field: 'project_ids',
      message: `最多关联 ${MAX_PROJECTS} 个项目（当前 ${dedupedProjects.length} 个）`,
    };
  }

  const payload: ExtensionCollectionCreate = {
    id: input.id,
    original_url: originalUrl,
    ...(manualTitle ? { manual_title: manualTitle } : {}),
    ...(selectedText ? { selected_text: selectedText } : {}),
    ...(intent ? { intent } : {}),
    project_ids: dedupedProjects,
  };

  return { ok: true, payload };
}
