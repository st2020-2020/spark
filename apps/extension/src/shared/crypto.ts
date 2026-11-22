import type { BrowserKind } from './types';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function deriveChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToBase64Url(new Uint8Array(digest));
}

export function formatPairingCode(challenge: string): { raw: string; grouped: string } {
  const raw = challenge.slice(0, 8);
  return {
    raw,
    grouped: `${raw.slice(0, 4)} ${raw.slice(4, 8)}`,
  };
}

export function detectBrowserKind(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): BrowserKind {
  return /\bEdg\//.test(userAgent) ? 'edge' : 'chrome';
}

export function generateUuid(): string {
  return crypto.randomUUID();
}

export function generateIdempotencyKey(): string {
  return `ext-${crypto.randomUUID()}`;
}
