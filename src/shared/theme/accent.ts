/**
 * Accent color system. Turns one brand color (a preset or the org's badge
 * color) into a full set of accessible tokens for the current light/dark mode:
 * accent, hover, pressed, subtle backgrounds, text-on-accent, and focus ring.
 *
 * Guarantees:
 * - Accent text/links reach 4.5:1 against the page surface (7:1 in high contrast).
 * - Text on accent-filled controls reaches 4.5:1.
 * - An accent too close to the destructive red is shifted, so Delete and other
 *   destructive actions stay visually distinct.
 */

export type ThemeMode = 'system' | 'light' | 'dark' | 'contrast';
export type Scheme = 'light' | 'dark' | 'contrast';

export const ACCENT_PRESETS = {
  blue: { label: 'Salesforce blue', hex: '#0176d3' },
  teal: { label: 'Teal', hex: '#0b827c' },
  violet: { label: 'Violet', hex: '#7526e3' },
  green: { label: 'Green', hex: '#2e844a' },
  amber: { label: 'Amber', hex: '#a96404' },
  pink: { label: 'Pink', hex: '#c23a82' },
  graphite: { label: 'Graphite', hex: '#475467' },
} as const;

export type AccentPreset = keyof typeof ACCENT_PRESETS;
/** 'org' follows the selected org's badge color. */
export type AccentChoice = 'org' | AccentPreset;

export const DEFAULT_THEME: { mode: ThemeMode; accent: AccentChoice } = { mode: 'system', accent: 'org' };

/** Surfaces the accent is measured against, per scheme (must match styles.css). */
export const SURFACES: Record<Scheme, string> = { light: '#ffffff', dark: '#1a1e24', contrast: '#000000' };
export const DANGER: Record<Scheme, string> = { light: '#ba0517', dark: '#ff6b76', contrast: '#ff808b' };

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function parseHex(hex: string): [number, number, number] | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const v = m[1]!.length === 3 ? m[1]!.replace(/./g, (c) => c + c) : m[1]!;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsl([r, g, b]: [number, number, number]): Hsl {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

export function luminance(hex: string): number {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function adjustLightness(hex: string, delta: number): string {
  const hsl = rgbToHsl(parseHex(hex)!);
  return toHex(hslToRgb({ ...hsl, l: Math.max(0, Math.min(1, hsl.l + delta)) }));
}

/** Darkens (on light surfaces) or lightens (on dark ones) until the color reaches `min` contrast. */
export function ensureContrast(hex: string, surface: string, min: number): string {
  const lighten = luminance(surface) < 0.5;
  let c = hex;
  for (let i = 0; i < 60 && contrastRatio(c, surface) < min; i++) c = adjustLightness(c, lighten ? 0.02 : -0.02);
  return c;
}

function mix(a: string, b: string, weightA: number): string {
  const [x, y] = [parseHex(a)!, parseHex(b)!];
  return toHex([0, 1, 2].map((i) => x[i]! * weightA + y[i]! * (1 - weightA)) as [number, number, number]);
}

function hueDistance(a: string, b: string): number {
  const d = Math.abs(rgbToHsl(parseHex(a)!).h - rgbToHsl(parseHex(b)!).h) % 360;
  return d > 180 ? 360 - d : d;
}

export interface AccentTokens {
  accent: string;
  hover: string;
  pressed: string;
  soft: string;
  softHover: string;
  contrast: string;
  focus: string;
  /** Why the color differs from what was chosen, if it does. */
  adjusted?: 'readability' | 'destructive';
}

export function accentTokens(input: string, scheme: Scheme): AccentTokens {
  const surface = SURFACES[scheme];
  let base = parseHex(input) ? toHex(parseHex(input)!) : ACCENT_PRESETS.blue.hex;
  let adjusted: AccentTokens['adjusted'];

  // Keep accent visibly different from destructive red (e.g. a red production badge).
  const hsl = rgbToHsl(parseHex(base)!);
  if (hsl.s > 0.25 && hueDistance(base, DANGER.light) < 20) {
    base = toHex(hslToRgb({ ...hsl, h: (hsl.h + 360 - 40) % 360 }));
    adjusted = 'destructive';
  }

  const min = scheme === 'contrast' ? 7 : 4.5;
  const accent = ensureContrast(base, surface, min);
  if (!adjusted && accent !== base) adjusted = 'readability';

  const dark = scheme !== 'light';
  const hover = adjustLightness(accent, dark ? 0.07 : -0.07);
  const pressed = adjustLightness(accent, dark ? 0.13 : -0.13);
  const soft = mix(accent, surface, dark ? 0.2 : 0.1);
  const softHover = mix(accent, surface, dark ? 0.3 : 0.17);
  // Text on accent-filled controls: whichever of white/near-black reads better.
  const contrast = contrastRatio('#ffffff', accent) >= contrastRatio('#0b0f14', accent) ? '#ffffff' : '#0b0f14';
  const focus = scheme === 'contrast' ? '#ffde59' : ensureContrast(accent, surface, 3);
  return { accent, hover, pressed, soft, softHover, contrast, focus, ...(adjusted ? { adjusted } : {}) };
}

export function resolveScheme(mode: ThemeMode, prefersDark: boolean): Scheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** Maps settings saved by earlier versions ('salesforce' theme) onto mode + accent. */
export function migrateTheme(theme: string | undefined, accent: string | undefined): { mode: ThemeMode; accent: AccentChoice } {
  const mode: ThemeMode = theme === 'light' || theme === 'dark' || theme === 'contrast' || theme === 'system' ? theme : theme === 'salesforce' ? 'light' : DEFAULT_THEME.mode;
  const valid = accent === 'org' || (accent !== undefined && accent in ACCENT_PRESETS);
  const acc: AccentChoice = valid ? (accent as AccentChoice) : theme === 'salesforce' ? 'blue' : DEFAULT_THEME.accent;
  return { mode, accent: acc };
}
