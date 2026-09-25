import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, DANGER, SURFACES, accentTokens, contrastRatio, migrateTheme, resolveScheme, type Scheme } from '../src/shared/theme/accent';
import { DEFAULT_ENV_COLORS } from '../src/shared/org/identity';

const schemes: Scheme[] = ['light', 'dark', 'contrast'];
const inputs = [...Object.values(ACCENT_PRESETS).map((p) => p.hex), ...Object.values(DEFAULT_ENV_COLORS), '#ffff00', '#111111', '#7fffd4'];

describe('accent tokens', () => {
  it('keep accent text readable on the page surface in every scheme', () => {
    for (const scheme of schemes) {
      for (const hex of inputs) {
        const t = accentTokens(hex, scheme);
        const min = scheme === 'contrast' ? 7 : 4.5;
        expect(contrastRatio(t.accent, SURFACES[scheme]), `${hex} ${scheme}`).toBeGreaterThanOrEqual(min);
      }
    }
  });

  it('keep text on filled accent controls readable', () => {
    for (const scheme of schemes) for (const hex of inputs) {
      const t = accentTokens(hex, scheme);
      expect(contrastRatio(t.contrast, t.accent), `${hex} ${scheme}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('shift a red accent (production badge) so destructive actions stay distinct', () => {
    const t = accentTokens(DEFAULT_ENV_COLORS.production, 'light');
    expect(t.adjusted).toBe('destructive');
    expect(t.accent).not.toBe(DANGER.light);
  });

  it('leave good colors alone and explain readability adjustments', () => {
    expect(accentTokens(ACCENT_PRESETS.blue.hex, 'light').adjusted).toBeUndefined();
    expect(accentTokens('#ffff00', 'light').adjusted).toBe('readability');
  });

  it('produce distinct hover and pressed states', () => {
    const t = accentTokens(ACCENT_PRESETS.teal.hex, 'light');
    expect(new Set([t.accent, t.hover, t.pressed]).size).toBe(3);
  });

  it('fall back for invalid input', () => {
    expect(accentTokens('not a color', 'light').accent).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('theme settings', () => {
  it('resolves system mode from the OS preference', () => {
    expect(resolveScheme('system', true)).toBe('dark');
    expect(resolveScheme('system', false)).toBe('light');
    expect(resolveScheme('contrast', false)).toBe('contrast');
  });

  it('migrates older saved themes', () => {
    expect(migrateTheme('salesforce', undefined)).toEqual({ mode: 'light', accent: 'blue' });
    expect(migrateTheme('dark', 'teal')).toEqual({ mode: 'dark', accent: 'teal' });
    expect(migrateTheme(undefined, 'bogus')).toEqual({ mode: 'system', accent: 'org' });
  });
});

describe('preset accents', () => {
  it('keep their own hue unless they collide with destructive red', () => {
    expect(accentTokens(ACCENT_PRESETS.pink.hex, 'light').adjusted).toBeUndefined();
    expect(accentTokens('#e02020', 'light').adjusted).toBe('destructive');
  });
});
