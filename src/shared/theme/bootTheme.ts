/**
 * Snapshot of the theme saved for the pre-render boot script (theme-boot.js).
 * It holds the CSS variables for every scheme so "System" can resolve at load
 * time without waiting for settings to load from extension storage.
 */
import { accentTokens, type AccentTokens, type Scheme, type ThemeMode } from './accent';

export const BOOT_THEME_KEY = 'sfw:theme';

export function accentVars(t: AccentTokens): Record<string, string> {
  return {
    '--accent': t.accent,
    '--accent-hover': t.hover,
    '--accent-pressed': t.pressed,
    '--accent-soft': t.soft,
    '--accent-soft-hover': t.softHover,
    '--accent-contrast': t.contrast,
    '--focus': t.focus,
  };
}

export interface BootTheme {
  mode: ThemeMode;
  vars: Record<Scheme, Record<string, string>>;
}

export function bootTheme(mode: ThemeMode, accentHex: string): BootTheme {
  const schemes: Scheme[] = ['light', 'dark', 'contrast'];
  return { mode, vars: Object.fromEntries(schemes.map((s) => [s, accentVars(accentTokens(accentHex, s))])) as BootTheme['vars'] };
}
