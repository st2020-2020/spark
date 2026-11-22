import type { ExtensionGrantCreate } from '../api/types';

export interface PendingExtensionPair {
  challenge: string;
  browser: ExtensionGrantCreate['browser'];
}

const PENDING_PAIR_STORAGE_KEY = 'spark:ext-pair';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function parseExtensionPairFragment(hash: string): PendingExtensionPair | null {
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!cleaned) return null;
  const params = new URLSearchParams(cleaned);
  const challenge = params.get('challenge')?.trim() ?? '';
  const browser = params.get('browser')?.trim() ?? '';
  if (!CHALLENGE_RE.test(challenge)) return null;
  if (browser !== 'chrome' && browser !== 'edge') return null;
  return { challenge, browser };
}

export function stripLocationHash(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

export function savePendingExtensionPair(pair: PendingExtensionPair): void {
  try {
    window.sessionStorage.setItem(PENDING_PAIR_STORAGE_KEY, JSON.stringify(pair));
  } catch {
    // Ignore storage unavailability; React state still keeps the parsed fragment for current mount.
  }
}

export function loadPendingExtensionPair(): PendingExtensionPair | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_PAIR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingExtensionPair>;
    if (
      typeof parsed.challenge === 'string' &&
      CHALLENGE_RE.test(parsed.challenge) &&
      (parsed.browser === 'chrome' || parsed.browser === 'edge')
    ) {
      return { challenge: parsed.challenge, browser: parsed.browser };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPendingExtensionPair(): void {
  try {
    window.sessionStorage.removeItem(PENDING_PAIR_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

export function formatPairCode(challenge: string): { raw: string; grouped: string } {
  const raw = challenge.slice(0, 8);
  return {
    raw,
    grouped: `${raw.slice(0, 4)} ${raw.slice(4, 8)}`,
  };
}

export function extensionDeviceDisplayName(browser: ExtensionGrantCreate['browser']): string {
  return browser === 'edge' ? 'Spark 浏览器扩展 (Edge)' : 'Spark 浏览器扩展 (Chrome)';
}

export function isExtensionDeviceLabel(deviceLabel: string): boolean {
  return deviceLabel.trim().startsWith('Spark 浏览器扩展');
}

export function resolveSafeRedirectPath(candidate: unknown, fallback = '/inbox'): string {
  if (typeof candidate !== 'string') return fallback;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  return trimmed;
}
