export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(raw);
}

export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}

export function formatShortcut(key: string): string {
  const mac = isMacPlatform();
  if (key === 'Enter') {
    return mac ? '⌘↵' : 'Ctrl+Enter';
  }
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

export function shortcutHintText(label: string, key: string): string {
  if (isTouchDevice()) return label;
  return `${label} (${formatShortcut(key)})`;
}
