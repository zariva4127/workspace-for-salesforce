/**
 * Derives a stable org identity from a Salesforce hostname.
 *
 * All org-scoped settings, tokens, and caches are keyed by `OrgIdentity.key`,
 * which is derived from the My Domain name plus its environment suffix
 * (for example `acme--uat.sandbox`). Lightning, My Domain, and Setup hosts of the
 * same org therefore map to the same key.
 */

export type Environment =
  | 'production'
  | 'sandbox'
  | 'scratch'
  | 'developer'
  | 'trailhead'
  | 'demo'
  | 'unknown';

export interface OrgIdentity {
  /** Storage key, e.g. `acme--uat.sandbox`. Only [a-z0-9-.] characters. */
  key: string;
  /** My Domain name, e.g. `acme--uat`. */
  myDomain: string;
  /** Environment inferred from the hostname. The API result is authoritative once connected. */
  environment: Environment;
  /** How confident the hostname-based environment is. */
  environmentSource: 'hostname' | 'hostname-heuristic';
  /** Host for REST/OAuth, e.g. `acme--uat.sandbox.my.salesforce.com`. */
  apiHost: string;
  /** Host for Lightning Experience pages, e.g. `acme--uat.sandbox.lightning.force.com`. */
  lightningHost: string;
}

/** Enhanced-domain environment suffixes (the label between the My Domain name and the base domain). */
const SUFFIX_ENV: Record<string, Environment> = {
  sandbox: 'sandbox',
  scratch: 'scratch',
  develop: 'developer',
  trailblaze: 'trailhead',
  demo: 'demo',
  patch: 'developer',
  free: 'developer',
};

const BASE_DOMAINS = [
  { suffix: '.my.salesforce.com', kind: 'api' },
  { suffix: '.lightning.force.com', kind: 'lightning' },
  { suffix: '.my.salesforce-setup.com', kind: 'setup' },
] as const;

const LEGACY_INSTANCE = /^(cs|na|eu|ap|um|gs|usa|can)\d+[a-z]?$/i;
const MY_DOMAIN_NAME = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

export const LOGIN_HOSTS = new Set(['login.salesforce.com', 'test.salesforce.com']);

/**
 * Parses a Salesforce hostname into an org identity, or returns null for hosts
 * that don't identify a specific org (login pages, unrelated sites).
 */
export function parseOrgHost(hostname: string): OrgIdentity | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const base = BASE_DOMAINS.find((b) => host.endsWith(b.suffix));
  if (!base) return null;

  const labels = host.slice(0, -base.suffix.length).split('.').filter(Boolean);
  if (labels.length === 0 || labels.length > 2) return null;

  const myDomain = labels[0]!;
  if (!MY_DOMAIN_NAME.test(myDomain)) return null;

  let envSuffix: string | undefined;
  let environment: Environment = 'production';
  let environmentSource: OrgIdentity['environmentSource'] = 'hostname';

  if (labels.length === 2) {
    const second = labels[1]!;
    if (SUFFIX_ENV[second]) {
      envSuffix = second;
      environment = SUFFIX_ENV[second];
    } else if (LEGACY_INSTANCE.test(second)) {
      // Legacy instanced My Domain (acme--uat.cs42.my.salesforce.com). Not an env suffix.
      environment = myDomain.includes('--') ? 'sandbox' : 'unknown';
      environmentSource = 'hostname-heuristic';
    } else {
      return null;
    }
  } else if (myDomain.includes('--')) {
    // Pre-enhanced-domain sandboxes used `mydomain--sandboxname` without a suffix label.
    environment = 'sandbox';
    environmentSource = 'hostname-heuristic';
  }

  const mid = envSuffix ? `.${envSuffix}` : '';
  return {
    key: `${myDomain}${mid}`,
    myDomain,
    environment,
    environmentSource,
    apiHost: `${myDomain}${mid}.my.salesforce.com`,
    lightningHost: `${myDomain}${mid}.lightning.force.com`,
  };
}

/** Parses a full URL; returns null for non-https or non-Salesforce URLs. */
export function parseOrgUrl(url: string | undefined): OrgIdentity | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return parseOrgHost(u.hostname);
  } catch {
    return null;
  }
}

/**
 * True when an OAuth `instance_url` belongs to the expected org. Used after
 * sign-in to reject tokens for a different org than the one in the active tab.
 */
export function instanceMatchesOrg(instanceUrl: string, org: Pick<OrgIdentity, 'key'>): boolean {
  const parsed = parseOrgUrl(instanceUrl);
  return parsed !== null && parsed.key === org.key;
}

/** Org keys are used inside storage keys, so they must never contain separators. */
export function isValidOrgKey(key: string): boolean {
  return /^[a-z0-9](?:[a-z0-9.-]{0,120})$/.test(key) && !key.includes('..');
}

export interface OrganizationRecord {
  IsSandbox?: boolean;
  OrganizationType?: string;
  TrialExpirationDate?: string | null;
}

/**
 * Combines the hostname environment with the Organization record returned by the API.
 * The API's IsSandbox flag is authoritative for sandboxes; scratch, Developer Edition,
 * and Trailhead orgs are only distinguishable by their enhanced-domain suffix.
 */
export function resolveEnvironment(hostEnv: Environment, org: OrganizationRecord | undefined): Environment {
  if (!org) return hostEnv;
  if (hostEnv === 'scratch' || hostEnv === 'trailhead' || hostEnv === 'demo') return hostEnv;
  if (org.IsSandbox) return 'sandbox';
  if (hostEnv === 'developer' || org.OrganizationType === 'Developer Edition') return 'developer';
  return 'production';
}

export const ENVIRONMENT_LABELS: Record<Environment, string> = {
  production: 'Production',
  sandbox: 'Sandbox',
  scratch: 'Scratch org',
  developer: 'Developer Edition',
  trailhead: 'Trailhead Playground',
  demo: 'Demo org',
  unknown: 'Unknown environment',
};

export const DEFAULT_ENV_COLORS: Record<Environment, string> = {
  production: '#ba0517',
  sandbox: '#2e844a',
  scratch: '#7526e3',
  developer: '#0b827c',
  trailhead: '#0176d3',
  demo: '#a96404',
  unknown: '#5c5c5c',
};
