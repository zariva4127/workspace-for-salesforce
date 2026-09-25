import { describe, expect, it } from 'vitest';
import { MemoryStore, OrgScopedStore, orgPrefix } from '../src/shared/storage/kv';
import { ProfileRepository, badgeColor, readableTextColor } from '../src/shared/org/profiles';
import { TokenStore } from '../src/shared/auth/tokenStore';
import { MetadataCache } from '../src/shared/cache/metadataCache';
import { instanceMatchesOrg, parseOrgHost, resolveEnvironment } from '../src/shared/org/identity';
import type { TokenSet } from '../src/shared/auth/oauth';

const prod = parseOrgHost('acme.lightning.force.com')!;
const uat = parseOrgHost('acme--uat.sandbox.lightning.force.com')!;

const tokens = (n: string): TokenSet => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  instanceUrl: `https://${n}.my.salesforce.com`,
  idUrl: 'https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA',
  orgId: '00D000000000001AAA',
  userId: '005000000000001AAA',
  issuedAt: 1,
});

describe('org-scoped storage', () => {
  it('keeps values for different orgs separate', async () => {
    const base = new MemoryStore();
    const a = new OrgScopedStore(base, prod.key);
    const b = new OrgScopedStore(base, uat.key);
    await a.set('soqlHistory', ['SELECT Id FROM Account']);
    await b.set('soqlHistory', ['SELECT Id FROM Contact']);
    expect(await a.get('soqlHistory')).toEqual(['SELECT Id FROM Account']);
    expect(await b.get('soqlHistory')).toEqual(['SELECT Id FROM Contact']);
    expect(await a.keys()).toEqual(['soqlHistory']);
  });

  it('clearing one org leaves other orgs and global keys intact', async () => {
    const base = new MemoryStore();
    await base.set('settings', { theme: 'dark' });
    const a = new OrgScopedStore(base, prod.key);
    const b = new OrgScopedStore(base, uat.key);
    await a.set('x', 1);
    await b.set('x', 2);
    await a.clear();
    expect(await a.get('x')).toBeUndefined();
    expect(await b.get('x')).toBe(2);
    expect(await base.get('settings')).toEqual({ theme: 'dark' });
  });

  it('does not let one org key prefix-match another', async () => {
    // "acme" must not see keys of "acme--uat.sandbox" or "acme2".
    const base = new MemoryStore();
    const acme = new OrgScopedStore(base, 'acme');
    await new OrgScopedStore(base, 'acme2').set('k', 1);
    await new OrgScopedStore(base, 'acme--uat.sandbox').set('k', 2);
    expect(await acme.keys()).toEqual([]);
    await acme.clear();
    expect(await base.keys()).toHaveLength(2);
  });

  it('rejects org keys that could escape their namespace', () => {
    expect(() => orgPrefix('acme:other')).toThrow();
    expect(() => orgPrefix('')).toThrow();
    expect(() => orgPrefix('../x')).toThrow();
  });
});

describe('profiles', () => {
  it('stores independent labels and colors per org and forgets only one', async () => {
    const repo = new ProfileRepository(new MemoryStore());
    await repo.touch(prod);
    await repo.touch(uat);
    await repo.updateProfile(prod.key, { label: 'ACME PROD', color: '#ff0000' });
    await repo.updateProfile(uat.key, { label: 'ACME UAT' });
    expect((await repo.getProfile(prod.key))?.label).toBe('ACME PROD');
    expect((await repo.getProfile(uat.key))?.label).toBe('ACME UAT');
    await repo.forget(prod.key);
    expect(await repo.getProfile(prod.key)).toBeUndefined();
    expect((await repo.listOrgs()).map((o) => o.key)).toEqual([uat.key]);
  });

  it('uses environment default colors unless overridden', () => {
    expect(badgeColor({ environment: 'production' })).toBe('#ba0517');
    expect(badgeColor({ environment: 'sandbox' })).toBe('#2e844a');
    expect(badgeColor({ environment: 'sandbox', environmentOverride: 'production' })).toBe('#ba0517');
    expect(badgeColor({ environment: 'sandbox', color: '#123456' })).toBe('#123456');
  });

  it('picks readable badge text colors', () => {
    expect(readableTextColor('#ffff00')).toBe('#000000');
    expect(readableTextColor('#ba0517')).toBe('#ffffff');
  });
});

describe('tokens', () => {
  it('stores tokens per org and never persists access tokens', async () => {
    const session = new MemoryStore();
    const local = new MemoryStore();
    const store = new TokenStore(session, local);
    await store.save(prod.key, tokens('acme'), true);
    await store.save(uat.key, tokens('uat'), false);

    expect((await store.get(prod.key))?.accessToken).toBe('access-acme');
    expect((await store.get(uat.key))?.accessToken).toBe('access-uat');

    const persisted = await store.getPersistedRefresh(prod.key);
    expect(persisted?.refreshToken).toBe('refresh-acme');
    expect(persisted).not.toHaveProperty('accessToken');
    expect(await store.getPersistedRefresh(uat.key)).toBeUndefined();

    const localDump = JSON.stringify(await Promise.all((await local.keys()).map((k) => local.get(k))));
    expect(localDump).not.toContain('access-');

    await store.clear(prod.key);
    expect(await store.get(prod.key)).toBeUndefined();
    expect((await store.get(uat.key))?.accessToken).toBe('access-uat');
  });

  it('accepts tokens only for the org in the tab', () => {
    expect(instanceMatchesOrg('https://acme.my.salesforce.com', prod)).toBe(true);
    expect(instanceMatchesOrg('https://acme--uat.sandbox.my.salesforce.com', prod)).toBe(false);
    expect(instanceMatchesOrg('https://other.my.salesforce.com', prod)).toBe(false);
  });
});

describe('metadata cache', () => {
  it('caches per org with expiry and refresh', async () => {
    const base = new MemoryStore();
    let now = 0;
    let calls = 0;
    const loader = async () => ++calls;
    const cacheA = new MetadataCache(new OrgScopedStore(base, prod.key), 1000, () => now);
    const cacheB = new MetadataCache(new OrgScopedStore(base, uat.key), 1000, () => now);

    expect((await cacheA.get('global', loader)).value).toBe(1);
    expect((await cacheA.get('global', loader)).fromCache).toBe(true);
    expect((await cacheB.get('global', loader)).value).toBe(2); // other org: separate entry
    now = 1500;
    expect((await cacheA.get('global', loader)).value).toBe(3); // expired
    expect((await cacheA.get('global', loader, { force: true })).value).toBe(4); // manual refresh
  });

  it('shares one in-flight request for concurrent loads', async () => {
    const cache = new MetadataCache(new OrgScopedStore(new MemoryStore(), prod.key), 1000);
    let calls = 0;
    const loader = () => new Promise<number>((r) => setTimeout(() => r(++calls), 5));
    const [a, b] = await Promise.all([cache.get('k', loader), cache.get('k', loader)]);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('environment resolution', () => {
  it('prefers the API sandbox flag over the hostname', () => {
    expect(resolveEnvironment('production', { IsSandbox: true })).toBe('sandbox');
    expect(resolveEnvironment('sandbox', { IsSandbox: false, OrganizationType: 'Enterprise Edition' })).toBe('production');
    expect(resolveEnvironment('scratch', { IsSandbox: false })).toBe('scratch');
    expect(resolveEnvironment('production', { IsSandbox: false, OrganizationType: 'Developer Edition' })).toBe('developer');
    expect(resolveEnvironment('sandbox', undefined)).toBe('sandbox');
  });
});
