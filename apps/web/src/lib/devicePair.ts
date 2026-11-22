import type { ExtensionGrantCreate } from '../api/types';

export interface PendingExtensionPair {
  challenge: string;
  browser: ExtensionGrantCreate['browser'];
}

export interface PendingDesktopPair {
  challenge: string;
}

export type DeviceSessionKind = 'web' | 'extension' | 'desktop';

export const DESKTOP_DEVICE_LABEL = 'Spark macOS 桌面端';

const EXT_PAIR_STORAGE_KEY = 'spark:ext-pair';
const DESKTOP_PAIR_STORAGE_KEY = 'spark:desktop-pair';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidPairChallenge(challenge: string): boolean {
  return CHALLENGE_RE.test(challenge);
}

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

export function parseDesktopPairFragment(hash: string): PendingDesktopPair | null {
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!cleaned) return null;
  const params = new URLSearchParams(cleaned);
  const challenge = params.get('challenge')?.trim() ?? '';
  if (!CHALLENGE_RE.test(challenge)) return null;
  return { challenge };
}

export function stripLocationHash(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function saveSessionJson(storageKey: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Ignore storage unavailability; React state still keeps the parsed fragment for current mount.
  }
}

function clearSessionKey(storageKey: string): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Ignore
  }
}

export function savePendingExtensionPair(pair: PendingExtensionPair): void {
  saveSessionJson(EXT_PAIR_STORAGE_KEY, pair);
}

export function loadPendingExtensionPair(): PendingExtensionPair | null {
  try {
    const raw = window.sessionStorage.getItem(EXT_PAIR_STORAGE_KEY);
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
  clearSessionKey(EXT_PAIR_STORAGE_KEY);
}

export function savePendingDesktopPair(pair: PendingDesktopPair): void {
  saveSessionJson(DESKTOP_PAIR_STORAGE_KEY, pair);
}

export function loadPendingDesktopPair(): PendingDesktopPair | null {
  try {
    const raw = window.sessionStorage.getItem(DESKTOP_PAIR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingDesktopPair>;
    if (typeof parsed.challenge === 'string' && CHALLENGE_RE.test(parsed.challenge)) {
      return { challenge: parsed.challenge };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPendingDesktopPair(): void {
  clearSessionKey(DESKTOP_PAIR_STORAGE_KEY);
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

export function isDesktopDeviceLabel(deviceLabel: string): boolean {
  const trimmed = deviceLabel.trim();
  return trimmed === DESKTOP_DEVICE_LABEL || trimmed.startsWith('Spark macOS 桌面端');
}

export function resolveSessionKind(sess: {
  kind?: string;
  device_label: string;
}): DeviceSessionKind {
  if (sess.kind === 'desktop' || sess.kind === 'extension' || sess.kind === 'web') {
    return sess.kind;
  }
  if (isDesktopDeviceLabel(sess.device_label)) return 'desktop';
  if (isExtensionDeviceLabel(sess.device_label)) return 'extension';
  return 'web';
}

export function resolveSafeRedirectPath(candidate: unknown, fallback = '/inbox'): string {
  if (typeof candidate !== 'string') return fallback;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return fallback;
  return trimmed;
}
