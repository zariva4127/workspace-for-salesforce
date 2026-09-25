/**
 * Detects what the user is looking at from the active tab's URL only.
 * No DOM access is needed: Lightning encodes the object and record in the path,
 * and Chrome reports Lightning's client-side navigations through tabs.onUpdated.
 */
import { isSalesforceId, to18 } from '../salesforce/ids';
import { LOGIN_HOSTS, parseOrgHost, type OrgIdentity } from '../org/identity';

export type PageType =
  | 'record'
  | 'recordRelated'
  | 'recordEdit'
  | 'objectHome'
  | 'objectNew'
  | 'objectManager'
  | 'setup'
  | 'flowBuilder'
  | 'home'
  | 'appPage'
  | 'classicRecord'
  | 'visualforce'
  | 'login'
  | 'other'
  | 'notSalesforce';

export interface PageContext {
  url?: string;
  isSalesforce: boolean;
  org: OrgIdentity | null;
  pageType: PageType;
  objectApiName?: string;
  /** Always normalized to 18 characters when present. */
  recordId?: string;
  relatedListId?: string;
  setupPage?: string;
  flowId?: string;
  /** Custom tab or app page API name for /lightning/n/ URLs. */
  appPageName?: string;
}

const OBJECT_API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const NOT_SALESFORCE: PageContext = { isSalesforce: false, org: null, pageType: 'notSalesforce' };

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function objectName(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  const decoded = safeDecode(segment);
  return OBJECT_API_NAME.test(decoded) ? decoded : undefined;
}

function recordId(segment: string | undefined): string | undefined {
  return segment && isSalesforceId(segment) ? to18(segment) : undefined;
}

export function detectPageContext(url: string | undefined | null): PageContext {
  if (!url) return NOT_SALESFORCE;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return NOT_SALESFORCE;
  }
  if (u.protocol !== 'https:') return NOT_SALESFORCE;

  const host = u.hostname.toLowerCase();
  if (LOGIN_HOSTS.has(host)) {
    return { url, isSalesforce: true, org: null, pageType: 'login' };
  }
  const org = parseOrgHost(host);
  if (!org) return { ...NOT_SALESFORCE, url };

  const base: PageContext = { url, isSalesforce: true, org, pageType: 'other' };
  const parts = u.pathname.split('/').filter(Boolean);

  // Legacy Lightning hash URLs: /one/one.app#/sObject/001.../view
  if (parts[0] === 'one' && u.hash.startsWith('#/sObject/')) {
    const hashParts = u.hash.slice(2).split('/');
    const id = recordId(hashParts[1]);
    if (id) return { ...base, pageType: 'record', recordId: id };
    return base;
  }

  if (parts[0] === 'lightning') {
    return { ...base, ...parseLightningPath(parts.slice(1)) };
  }

  if (parts[0] === 'builder_platform_interaction' && parts[1] === 'flowBuilder.app') {
    const flowId = recordId(u.searchParams.get('flowId') ?? undefined);
    return { ...base, pageType: 'flowBuilder', ...(flowId ? { flowId } : {}) };
  }

  if (parts[0] === 'apex' && parts[1]) {
    return { ...base, pageType: 'visualforce', appPageName: safeDecode(parts[1]) };
  }

  // Salesforce Classic record: /0015g00000AbCdE or /0015g00000AbCdEAAZ/e
  if (parts.length >= 1 && parts.length <= 2) {
    const id = recordId(parts[0]);
    if (id) return { ...base, pageType: 'classicRecord', recordId: id };
  }

  return base;
}

function parseLightningPath(p: string[]): Partial<PageContext> {
  const [section, a, b, c, d] = p;
  switch (section) {
    case 'r': {
      // /lightning/r/{Object}/{Id}/{view|edit|related/{rel}/view}  or  /lightning/r/{Id}/view
      const directId = recordId(a);
      if (directId) return { pageType: 'record', recordId: directId };
      const obj = objectName(a);
      const id = recordId(b);
      if (!id) return obj ? { pageType: 'objectHome', objectApiName: obj } : { pageType: 'other' };
      const ctx: Partial<PageContext> = { recordId: id, ...(obj ? { objectApiName: obj } : {}) };
      if (c === 'related' && d) return { ...ctx, pageType: 'recordRelated', relatedListId: safeDecode(d) };
      if (c === 'edit') return { ...ctx, pageType: 'recordEdit' };
      return { ...ctx, pageType: 'record' };
    }
    case 'o': {
      const obj = objectName(a);
      if (!obj) return { pageType: 'other' };
      return { pageType: b === 'new' ? 'objectNew' : 'objectHome', objectApiName: obj };
    }
    case 'setup': {
      if (a === 'ObjectManager' && b && b !== 'home') {
        // Custom objects may appear by their 01I durable ID instead of API name.
        const obj = objectName(b);
        return {
          pageType: 'objectManager',
          setupPage: 'ObjectManager',
          ...(obj && !isSalesforceId(b) ? { objectApiName: obj } : {}),
        };
      }
      return { pageType: 'setup', ...(a ? { setupPage: safeDecode(a) } : {}) };
    }
    case 'page':
      return { pageType: a === 'home' ? 'home' : 'appPage' };
    case 'n':
      return { pageType: 'appPage', ...(a ? { appPageName: safeDecode(a) } : {}) };
    default:
      return { pageType: 'other' };
  }
}

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  record: 'Record page',
  recordRelated: 'Related list',
  recordEdit: 'Record edit',
  objectHome: 'Object list',
  objectNew: 'New record',
  objectManager: 'Object Manager',
  setup: 'Setup',
  flowBuilder: 'Flow Builder',
  home: 'Home',
  appPage: 'App page',
  classicRecord: 'Classic record page',
  visualforce: 'Visualforce page',
  login: 'Login page',
  other: 'Salesforce page',
  notSalesforce: 'Not a Salesforce page',
};

/** True when two contexts describe the same place (used to debounce redundant updates). */
export function sameContext(a: PageContext, b: PageContext): boolean {
  return (
    a.org?.key === b.org?.key &&
    a.pageType === b.pageType &&
    a.objectApiName === b.objectApiName &&
    a.recordId === b.recordId &&
    a.relatedListId === b.relatedListId &&
    a.setupPage === b.setupPage &&
    a.flowId === b.flowId
  );
}
