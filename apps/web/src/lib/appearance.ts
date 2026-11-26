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

type Appearance = { palette: PaletteId; theme: ThemePref };
const APPEARANCE_KEY = 'spark:appearance';
const defaultAppearance: Appearance = { palette: DEFAULT_PALETTE, theme: 'system' };
// A disabled or full store can still preserve the appearance until this page is closed.
let unsavedBrowserAppearance: Appearance | null = null;

function isTheme(value: unknown): value is ThemePref {
  return value === 'dark' || value === 'light' || value === 'system';
}

function browserAppearance(): Appearance {
  if (unsavedBrowserAppearance) return unsavedBrowserAppearance;
  try {
    const stored = localStorage.getItem(APPEARANCE_KEY);
    if (stored) {
      const pair = JSON.parse(stored);
      if (isPaletteId(pair?.palette) && isTheme(pair?.theme)) return pair;
    }
    // Earlier releases stored anonymous preferences separately.
    const palette = localStorage.getItem(PALETTE_KEY);
    const theme = localStorage.getItem(THEME_KEY);
    return { palette: isPaletteId(palette) ? palette : DEFAULT_PALETTE, theme: isTheme(theme) ? theme : 'system' };
  } catch {
    return defaultAppearance;
  }
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

let accountAppearance: Appearance | null = null;

export function showAccountAppearance(value: typeof accountAppearance) {
  if (value) {
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(value));
      unsavedBrowserAppearance = null;
    } catch {
      unsavedBrowserAppearance = value;
    }
  }
  accountAppearance = value;
  syncDocument();
}

// The very first paint applies the theme instantly; later switches cross-fade the whole page.
let firstSyncDone = false;

function syncDocument(): void {
  const root = document.documentElement;
  const { palette, theme } = accountAppearance ?? browserAppearance();
  const mode = resolveMode(theme);
  const changed =
    root.getAttribute('data-palette') !== palette || root.getAttribute('data-mode') !== mode;

  const apply = () => {
    // A transition may run after another preference change, logout or system mode switch.
    const latest = accountAppearance ?? browserAppearance();
    if (latest.palette !== palette || resolveMode(latest.theme) !== mode) return;
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

let listenersAttached = false;

/** Applies the stored appearance; safe to call more than once. */
export function initAppearance(): void {
  syncDocument();
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener('storage', event => {
    if (event.storageArea !== window.localStorage ||
        ![null, APPEARANCE_KEY, PALETTE_KEY, THEME_KEY].includes(event.key)) return;
    unsavedBrowserAppearance = null;
    if (!accountAppearance) syncDocument();
  });
  systemDarkQuery()?.addEventListener('change', () => {
    if ((accountAppearance ?? browserAppearance()).theme === 'system') syncDocument();
  });
}
