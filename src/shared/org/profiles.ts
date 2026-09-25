import { DEFAULT_THEME, migrateTheme, type AccentChoice, type ThemeMode } from '../theme/accent';
/**
 * Global settings and per-org profiles (display name, badge color, overrides).
 * Tokens are NOT stored here; see auth/tokenStore.ts.
 */
import type { KVStore } from '../storage/kv';
import { OrgScopedStore } from '../storage/kv';
import { DEFAULT_ENV_COLORS, resolveEnvironment, type Environment, type OrgIdentity } from './identity';

export type ThemePreference = ThemeMode;

export interface GlobalSettings {
  /** Consumer Key of the Connected App / External Client App. Not a secret. */
  clientId: string;
  theme: ThemePreference;
  /** Accent color: a preset, or 'org' to follow the selected org's badge color. */
  accent: AccentChoice;
  /** Keep the refresh token in local storage so the connection survives a browser restart. */
  rememberConnection: boolean;
  /** Metadata cache lifetime. */
  cacheTtlHours: number;
  /** Redact email addresses in exported bug reports. */
  redactEmailsInExports: boolean;
  /** Start OAuth automatically when an org is detected and no saved session exists. */
  autoConnect: boolean;
  /** Offer create, edit, and delete for records (Salesforce permissions still apply). */
  allowRecordChanges: boolean;
}

export const DEFAULT_SETTINGS: GlobalSettings = {
  clientId: '',
  theme: DEFAULT_THEME.mode,
  accent: DEFAULT_THEME.accent,
  rememberConnection: false,
  cacheTtlHours: 24,
  redactEmailsInExports: true,
  autoConnect: true,
  allowRecordChanges: true,
};

export interface OrgProfile {
  key: string;
  myDomain: string;
  apiHost: string;
  lightningHost: string;
  /** Environment from hostname, refined by the API after connecting. */
  environment: Environment;
  /** User-chosen overrides. */
  label?: string;
  color?: string;
  environmentOverride?: Environment;
  clientIdOverride?: string;
  apiVersion?: string;
  /** Last known non-secret identity info. */
  orgId?: string;
  orgName?: string;
  /** Salesforce Organization.OrganizationType, e.g. Enterprise Edition. */
  organizationType?: string;
  username?: string;
  lastSeen: number;
}

const SETTINGS_KEY = 'settings';
const ORG_INDEX_KEY = 'orgIndex';

export function effectiveEnvironment(p: Pick<OrgProfile, 'environment' | 'environmentOverride'>): Environment {
  return p.environmentOverride ?? p.environment;
}

/** Re-evaluates the detected environment using Salesforce's org type when available. */
export function detectedEnvironment(p: Pick<OrgProfile, 'environment' | 'organizationType'>): Environment {
  return resolveEnvironment(
    p.environment,
    p.organizationType ? { OrganizationType: p.organizationType, IsSandbox: p.environment === 'sandbox' } : undefined,
  );
}

export function badgeColor(p: Pick<OrgProfile, 'color' | 'environment' | 'environmentOverride'>): string {
  return p.color ?? DEFAULT_ENV_COLORS[effectiveEnvironment(p)];
}

export function displayName(p: Pick<OrgProfile, 'label' | 'orgName' | 'myDomain'>): string {
  return p.label?.trim() || p.orgName || p.myDomain;
}

/** Picks black or white text for a badge background (WCAG relative luminance). */
export function readableTextColor(hex: string): '#000000' | '#ffffff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? '#000000' : '#ffffff';
}

export class ProfileRepository {
  constructor(private readonly local: KVStore) {}

  async getSettings(): Promise<GlobalSettings> {
    const stored = (await this.local.get<Partial<GlobalSettings> & { theme?: string }>(SETTINGS_KEY)) ?? {};
    const { mode, accent } = migrateTheme(stored.theme, stored.accent);
    return { ...DEFAULT_SETTINGS, ...stored, theme: mode, accent };
  }

  async saveSettings(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const next = { ...(await this.getSettings()), ...patch };
    await this.local.set(SETTINGS_KEY, next);
    return next;
  }

  scoped(orgKey: string): OrgScopedStore {
    return new OrgScopedStore(this.local, orgKey);
  }

  async listOrgs(): Promise<OrgProfile[]> {
    const keys = (await this.local.get<string[]>(ORG_INDEX_KEY)) ?? [];
    const profiles = await Promise.all(keys.map((k) => this.getProfile(k)));
    return profiles.filter((p): p is OrgProfile => !!p).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  async getProfile(orgKey: string): Promise<OrgProfile | undefined> {
    return this.scoped(orgKey).get<OrgProfile>('profile');
  }

  /** Registers an org seen in a tab, creating a profile on first sight. */
  async touch(identity: OrgIdentity): Promise<OrgProfile> {
    const existing = await this.getProfile(identity.key);
    const profile: OrgProfile = existing
      ? { ...existing, lastSeen: Date.now() }
      : {
          key: identity.key,
          myDomain: identity.myDomain,
          apiHost: identity.apiHost,
          lightningHost: identity.lightningHost,
          environment: identity.environment,
          lastSeen: Date.now(),
        };
    await this.saveProfile(profile);
    return profile;
  }

  async saveProfile(profile: OrgProfile): Promise<void> {
    await this.scoped(profile.key).set('profile', profile);
    const keys = (await this.local.get<string[]>(ORG_INDEX_KEY)) ?? [];
    if (!keys.includes(profile.key)) await this.local.set(ORG_INDEX_KEY, [...keys, profile.key]);
  }

  async updateProfile(orgKey: string, patch: Partial<OrgProfile>): Promise<OrgProfile | undefined> {
    const current = await this.getProfile(orgKey);
    if (!current) return undefined;
    const next = { ...current, ...patch, key: current.key };
    await this.saveProfile(next);
    return next;
  }

  /** Removes the org's profile and every org-scoped key in this store. */
  async forget(orgKey: string): Promise<void> {
    await this.scoped(orgKey).clear();
    const keys = (await this.local.get<string[]>(ORG_INDEX_KEY)) ?? [];
    await this.local.set(
      ORG_INDEX_KEY,
      keys.filter((k) => k !== orgKey),
    );
  }
}
