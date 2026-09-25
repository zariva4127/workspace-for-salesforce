import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgProfile } from '../src/shared/org/profiles';

const session: Record<string, unknown> = {};
const local: Record<string, unknown> = {};
const area = (data: Record<string, unknown>) => ({
  get: vi.fn(async (key: string | null) => key === null ? { ...data } : ({ [key]: data[key] })),
  set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }),
  remove: vi.fn(async (key: string) => { delete data[key]; }),
});
const sid = '00D000000000001!validated-browser-session';
const tab = { id: 7, windowId: 2, active: true, url: 'https://acme.lightning.force.com/lightning/page/home' };

let connectFromSalesforceTab: typeof import('../src/sidepanel/services/tabSessionAuth').connectFromSalesforceTab;

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    tabs: { get: vi.fn(async () => tab) },
    cookies: {
      getAllCookieStores: vi.fn(async () => [{ id: 'profile-1', tabIds: [7] }]),
      getAll: vi.fn(async (filter: chrome.cookies.GetAllDetails) => filter.domain === 'salesforce.com' ? [] : [{ name: 'sid', value: sid, domain: filter.url?.includes('lightning') ? 'acme.lightning.force.com' : 'acme.my.salesforce.com' }]),
    },
    storage: { session: area(session), local: area(local) },
  });
  ({ connectFromSalesforceTab } = await import('../src/sidepanel/services/tabSessionAuth'));
});

beforeEach(() => { for (const key of Object.keys(session)) delete session[key]; for (const key of Object.keys(local)) delete local[key]; });

describe('Salesforce tab-session authentication', () => {
  it('validates the current org/user and keeps the SID out of persistent storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/userinfo')
      ? new Response(JSON.stringify({ user_id: '005000000000001', organization_id: '00D000000000001', preferred_username: 'user@example.com' }), { status: 200 })
      : new Response(JSON.stringify({ records: [{ Id: '00D000000000001' }] }), { status: 200 })));
    const profile: OrgProfile = { key: 'acme', myDomain: 'acme', apiHost: 'acme.my.salesforce.com', lightningHost: 'acme.lightning.force.com', environment: 'production', lastSeen: Date.now() };
    const result = await connectFromSalesforceTab(profile, 7);
    expect(result).toMatchObject({ accessToken: sid, orgId: '00D000000000001', userId: '005000000000001', authSource: 'tab-session', sourceTabId: 7 });
    expect(JSON.stringify(session)).toContain(sid);
    expect(JSON.stringify(local)).not.toContain(sid);
  });

  it('rejects a session whose org does not match the source tab SID', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/userinfo')
      ? new Response(JSON.stringify({ user_id: '005000000000001', organization_id: '00D000000000999' }), { status: 200 })
      : new Response(JSON.stringify({ records: [{ Id: '00D000000000999' }] }), { status: 200 })));
    const profile: OrgProfile = { key: 'acme', myDomain: 'acme', apiHost: 'acme.my.salesforce.com', lightningHost: 'acme.lightning.force.com', environment: 'production', lastSeen: Date.now() };
    await expect(connectFromSalesforceTab(profile, 7)).rejects.toThrow(/different Salesforce org/);
  });

  it('uses session-native SOAP identity when OAuth userinfo rejects a browser SID', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/userinfo')) return new Response('{}', { status: 403 });
      if (url.includes('/Soap/')) return new Response('<env:Envelope><env:Body><getUserInfoResponse><result><organizationId>00D000000000001</organizationId><userId>005000000000001</userId><userName>user@example.com</userName></result></getUserInfoResponse></env:Body></env:Envelope>');
      return new Response(JSON.stringify({ records: [{ Id: '00D000000000001' }] }), { status: 200 });
    }));
    const profile: OrgProfile = { key: 'acme', myDomain: 'acme', apiHost: 'acme.my.salesforce.com', lightningHost: 'acme.lightning.force.com', environment: 'production', lastSeen: Date.now() };
    await expect(connectFromSalesforceTab(profile, 7)).resolves.toMatchObject({ userId: '005000000000001', authSource: 'tab-session' });
  });

  it('accepts a Salesforce Setup page as the originating tab', async () => {
    const original = tab.url;
    tab.url = 'https://acme.my.salesforce-setup.com/lightning/setup/SetupOneHome/home';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/userinfo')
      ? new Response(JSON.stringify({ user_id: '005000000000001', organization_id: '00D000000000001' }), { status: 200 })
      : new Response(JSON.stringify({ records: [{ Id: '00D000000000001' }] }), { status: 200 })));
    const profile: OrgProfile = { key: 'acme', myDomain: 'acme', apiHost: 'acme.my.salesforce.com', lightningHost: 'acme.lightning.force.com', environment: 'production', lastSeen: Date.now() };
    try {
      await expect(connectFromSalesforceTab(profile, 7)).resolves.toMatchObject({ orgId: '00D000000000001', sourceTabId: 7 });
    } finally {
      tab.url = original;
    }
  });
});
