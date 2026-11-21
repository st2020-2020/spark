import type { CollectionType } from '../api/types';

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return formatDateTime(iso);
}

export function extractDomain(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatUnitsToYuan(units: number): string {
  return `¥${(units / 1_000_000).toFixed(4)}`;
}

export function formatRemainingTrashDays(purgeAfter?: string): string {
  if (!purgeAfter) return '即将清理';
  const target = new Date(purgeAfter).getTime();
  if (Number.isNaN(target)) return purgeAfter;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return '已到期等待清理';
  const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  return `剩余约 ${days} 天`;
}

export function organizationStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '整理排队中',
    running: '正在整理',
    succeeded: '已整理',
    partial: '部分整理',
    failed: '整理失败',
    skipped: '未整理',
    blocked: '额度受限暂停',
    superseded: '等待新版本整理',
  };
  return labels[status] ?? status;
}

export function projectStateLabel(state: string): string {
  const labels: Record<string, string> = {
    active: '进行中',
    paused: '已暂停',
    completed: '已结束',
  };
  return labels[state] ?? state;
}

export const contentTypeLabels: Record<NonNullable<CollectionType>, string> = {
  text: '文字',
  url: '网址',
  image: '图片',
};

export function searchFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    title: '标题',
    text: '正文',
    intent: '用途说明',
    url: '网址',
    extraction: '提取内容',
    image_text: '图中文字',
    image_description: 'AI 画面描述',
    tag: '标签',
  };
  return labels[field] ?? field;
}

export function formatDeviceLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '未知设备';
  if (!trimmed.includes('Mozilla/') && trimmed.length <= 44) {
    return trimmed;
  }

  let browser = '';
  if (trimmed.includes('HeadlessChrome')) browser = 'Headless Chrome';
  else if (trimmed.includes('Edg/')) browser = 'Edge';
  else if (trimmed.includes('Firefox/')) browser = 'Firefox';
  else if (trimmed.includes('Chrome/')) browser = 'Chrome';
  else if (trimmed.includes('Safari/')) browser = 'Safari';

  let os = '';
  if (trimmed.includes('iPhone')) os = 'iPhone';
  else if (trimmed.includes('iPad')) os = 'iPad';
  else if (trimmed.includes('Android')) os = 'Android';
  else if (trimmed.includes('Mac OS X') || trimmed.includes('Macintosh')) os = 'macOS';
  else if (trimmed.includes('Windows')) os = 'Windows';
  else if (trimmed.includes('Linux')) os = 'Linux';

  if (browser && os) return `${browser} · ${os}`;
  if (browser || os) return browser || os;
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}
