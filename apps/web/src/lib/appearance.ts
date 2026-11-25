// Appearance = color palette × light/dark mode, from the account when signed in, otherwise from this browser.
// The CSS side lives in styles/tokens.css and keys off <html data-palette> and <html data-mode>.

export type ThemePref = 'system' | 'light' | 'dark';
export type PaletteId = 'mint' | 'sea' | 'matcha' | 'sakura';

export interface PaletteOption {
  id: PaletteId;
  label: string;
  hint: string;
  /** Primary, soft tint and second hue — used only to draw the picker swatches. */
  swatches: [string, string, string];
}

export const PALETTES: PaletteOption[] = [
  { id: 'mint', label: '薄荷晨雾', hint: '薄荷绿 · 蜜桃', swatches: ['#2a8369', '#e0f2eb', '#ffd9c7'] },
  { id: 'sea', label: '海盐蓝', hint: '雾蓝 · 柠檬黄', swatches: ['#3274aa', '#e2eef8', '#fff1a6'] },
  { id: 'matcha', label: '抹茶奶白', hint: '抹茶绿 · 奶油米', swatches: ['#557f45', '#e9f0df', '#f3e3c3'] },
  { id: 'sakura', label: '樱花雾粉', hint: '樱粉 · 薄荷', swatches: ['#ae5468', '#fbe6ea', '#cfe6de'] },
];

export const DEFAULT_PALETTE: PaletteId = 'mint';

const THEME_KEY = 'spark:theme';
const PALETTE_KEY = 'spark:palette';

function isPaletteId(value: unknown): value is PaletteId {
  return PALETTES.some((p) => p.id === value);
}

export function readThemePref(): ThemePref {
  try {
    const val = window.localStorage.getItem(THEME_KEY);
    if (val === 'light' || val === 'dark') return val;
  } catch {
    // Storage unavailable (private mode, blocked site data): fall back to the system setting.
  }
  return 'system';
}

export function readPalette(): PaletteId {
  try {
    const val = window.localStorage.getItem(PALETTE_KEY);
    if (isPaletteId(val)) return val;
  } catch {
    // Storage unavailable: use the default palette.
  }
  return DEFAULT_PALETTE;
}

function systemDarkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

function resolveMode(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemDarkQuery()?.matches ? 'dark' : 'light';
}

let accountAppearance: { palette: PaletteId; theme: ThemePref } | null = null;

export function showAccountAppearance(value: typeof accountAppearance) {
  accountAppearance = value;
  syncDocument();
}

// The very first paint applies the theme instantly; later switches cross-fade the whole page.
let firstSyncDone = false;

function syncDocument(): void {
  const root = document.documentElement;
  const palette = accountAppearance?.palette ?? readPalette();
  const mode = resolveMode(accountAppearance?.theme ?? readThemePref());
  const changed =
    root.getAttribute('data-palette') !== palette || root.getAttribute('data-mode') !== mode;

  const apply = () => {
    // A transition may run after another preference change, logout or system mode switch.
    if ((accountAppearance?.palette ?? readPalette()) !== palette ||
        resolveMode(accountAppearance?.theme ?? readThemePref()) !== mode) return;
    root.setAttribute('data-palette', palette);
    root.setAttribute('data-mode', mode);
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      const bg = getComputedStyle(root).getPropertyValue('--sp-bg').trim();
      if (bg) meta.content = bg;
    }
  };

  const reduceMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canCrossFade =
    firstSyncDone && changed && !reduceMotion && typeof document.startViewTransition === 'function';
  firstSyncDone = true;
  if (canCrossFade) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

let systemListenerAttached = false;

/** Applies the stored appearance; safe to call more than once. */
export function initAppearance(): void {
  syncDocument();
  if (systemListenerAttached) return;
  const query = systemDarkQuery();
  if (!query) return;
  systemListenerAttached = true;
  query.addEventListener('change', () => {
    if ((accountAppearance?.theme ?? readThemePref()) === 'system') syncDocument();
  });
}
