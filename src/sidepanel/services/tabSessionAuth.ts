/**
 * Connects with the authenticated Salesforce tab's session, matching the
 * guarded flow used by the sibling Chrome extension. The SID is validated
 * against Salesforce before it is kept in chrome.storage.session.
 */
import type { TokenSet } from '../../shared/auth/oauth';
import type { OrgProfile } from '../../shared/org/profiles';
import { instanceMatchesOrg } from '../../shared/org/identity';
import { safeSalesforceOrigin } from '../../shared/salesforce/sessionDomain';
import { tokenStore } from './platform';

type Identity = { user_id?: string; organization_id?: string; preferred_username?: string };
type OrgResult = { records?: Array<{ Id?: string }> };

export class TabSessionError extends Error {
  constructor(message: string) { super(message); this.name = 'TabSessionError'; }
}

async function json<T>(origin: string, token: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) throw new TabSessionError(response.status === 403 ? 'The signed-in Salesforce user does not have API access.' : 'This Salesforce browser session cannot be used by the API.');
  return response.json() as Promise<T>;
}

async function identityFor(origin: string, token: string): Promise<Identity> {
  try {
    const identity = await json<Identity>(origin, token, '/services/oauth2/userinfo');
    if (identity.user_id && identity.organization_id) return identity;
  } catch { /* Browser SIDs do not always carry the OpenID scope. */ }
  const escaped = token.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
  const response = await fetch(`${origin}/services/Soap/u/62.0`, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12_000),
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'getUserInfo' },
    body: `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com"><env:Header><urn:SessionHeader><urn:sessionId>${escaped}</urn:sessionId></urn:SessionHeader><env:Body><urn:getUserInfo/></env:Body></env:Envelope>`,
  });
  const xml = await response.text();
  if (!response.ok || /<(?:[\w]+:)?Fault[ >]/.test(xml)) throw new TabSessionError('Salesforce could not validate this browser session. Check that the user has API access.');
  const field = (name: string) => xml.match(new RegExp(String.raw`<(?:[\w]+:)?${name}(?:\s[^>]*)?>([^<]*)</(?:[\w]+:)?${name}>`))?.[1];
  return { user_id: field('userId'), organization_id: field('organizationId'), preferred_username: field('userName') };
}

export async function connectFromSalesforceTab(profile: OrgProfile, tabId: number): Promise<TokenSet> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !safeSalesforceOrigin(tab.url)) throw new TabSessionError('The originating tab is no longer a Salesforce page.');
  const store = (await chrome.cookies.getAllCookieStores()).find((s) => s.tabIds.includes(tabId));
  if (!store) throw new TabSessionError('No Salesforce browser session is available for this tab.');
  const tabOrigin = new URL(tab.url).origin;
  const expectedOrigin = `https://${profile.apiHost}`;
  const sets = await Promise.all([
    chrome.cookies.getAll({ url: tabOrigin, name: 'sid', storeId: store.id }),
    chrome.cookies.getAll({ url: expectedOrigin, name: 'sid', storeId: store.id }),
    chrome.cookies.getAll({ domain: 'salesforce.com', name: 'sid', storeId: store.id }),
  ]);
  const sourceOrgIds = new Set(sets[0].map((c) => c.value.split('!')[0]).filter((id): id is string => !!id && /^00D[a-zA-Z0-9]{12,15}$/.test(id)));
  const candidates = sets.flatMap((cookies, group) => cookies.map((cookie) => ({
    token: cookie.value,
    origin: group === 0 ? expectedOrigin : safeSalesforceOrigin(cookie.domain) ?? expectedOrigin,
  }))).filter((x, i, all) => x.token.length > 20 && all.findIndex((y) => y.token === x.token && y.origin === x.origin) === i);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      if (!safeSalesforceOrigin(candidate.origin)) continue;
      const tokenOrgId = candidate.token.split('!')[0] ?? '';
      if (sourceOrgIds.size && !sourceOrgIds.has(tokenOrgId)) continue;
      const query = encodeURIComponent('SELECT Id FROM Organization LIMIT 1');
      const [org, identity] = await Promise.all([
        json<OrgResult>(candidate.origin, candidate.token, `/services/data/v62.0/query/?q=${query}`),
        identityFor(candidate.origin, candidate.token),
      ]);
      const orgId = identity.organization_id ?? org.records?.[0]?.Id;
      const userId = identity.user_id;
      if (!orgId || !userId || !/^00D/.test(orgId) || !/^005/.test(userId)) throw new TabSessionError('Salesforce did not return a valid current user identity.');
      if (tokenOrgId && tokenOrgId.slice(0, 15) !== orgId.slice(0, 15)) throw new TabSessionError('The browser session belongs to a different Salesforce org.');
      if (candidate.origin === expectedOrigin && !instanceMatchesOrg(candidate.origin, profile)) throw new TabSessionError('The Salesforce tab and selected org do not match.');
      const current = await chrome.tabs.get(tabId);
      if (!current.url || new URL(current.url).origin !== tabOrigin) throw new TabSessionError('The Salesforce tab changed during authentication.');
      const tokens: TokenSet = {
        accessToken: candidate.token, instanceUrl: candidate.origin,
        idUrl: `${candidate.origin}/id/${orgId}/${userId}`, orgId, userId,
        issuedAt: Date.now(), authSource: 'tab-session', sourceTabId: tabId,
      };
      await tokenStore.save(profile.key, tokens, false);
      return tokens;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new TabSessionError('No API-capable Salesforce session was found. Sign in to Salesforce and reopen the extension.');
}
