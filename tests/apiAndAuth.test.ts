import { describe, expect, it } from 'vitest';
import { SalesforceClient, parseLimitInfo, soqlString } from '../src/shared/api/client';
import { SalesforceApiError, explainError, isCancelled } from '../src/shared/api/errors';
import { OAuthError, buildAuthorizeUrl, parseAuthRedirect, parseIdentityUrl, parseTokenResponse, pkceChallenge } from '../src/shared/auth/oauth';
import { safeSalesforceOrigin } from '../src/shared/salesforce/sessionDomain';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler, tokens: { current: string; next?: string } = { current: 't1' }) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init.headers).get('Authorization') });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return handler(url, init);
  }) as typeof fetch;
  const c = new SalesforceClient({
    instanceUrl: 'https://acme.my.salesforce.com',
    getAccessToken: async () => tokens.current,
    refresh: async () => {
      if (!tokens.next) return undefined;
      tokens.current = tokens.next;
      return tokens.next;
    },
    fetchImpl,
    retryDelayMs: 0,
  });
  return { c, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('SalesforceClient', () => {
  it('follows pagination with nextRecordsUrl', async () => {
    const { c } = client((url) =>
      url.includes('/query?q=')
        ? json({ totalSize: 3, done: false, nextRecordsUrl: '/services/data/v62.0/query/01g-2000', records: [{ Id: 1 }, { Id: 2 }] })
        : json({ totalSize: 3, done: true, records: [{ Id: 3 }] }),
    );
    const res = await c.queryAll<{ Id: number }>('SELECT Id FROM Account');
    expect(res.records.map((r) => r.Id)).toEqual([1, 2, 3]);
    expect(res.truncated).toBe(false);
  });

  it('stops at maxRecords and reports truncation', async () => {
    const { c } = client(() => json({ totalSize: 10, done: false, nextRecordsUrl: '/services/data/v62.0/query/next', records: [{}, {}, {}] }));
    const res = await c.queryAll('SELECT Id FROM Account', { maxRecords: 5 });
    expect(res.records).toHaveLength(5);
    expect(res.truncated).toBe(true);
  });

  it('tracks API usage and stops paginating near the daily limit', async () => {
    const { c } = client(() =>
      json({ totalSize: 10, done: false, nextRecordsUrl: '/services/data/v62.0/query/next', records: [{}] }, 200, { 'Sforce-Limit-Info': 'api-usage=14000/15000' }),
    );
    const res = await c.queryAll('SELECT Id FROM Account');
    expect(c.usage).toEqual({ used: 14000, max: 15000 });
    expect(res.stoppedForLimits).toBe(true);
    expect(res.records).toHaveLength(1);
  });

  it('refreshes the token once on 401 and retries', async () => {
    let n = 0;
    const { c, calls } = client(
      () => (n++ === 0 ? json([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }], 401) : json({ ok: true })),
      { current: 'old', next: 'new' },
    );
    await expect(c.request('/services/data/v62.0/limits')).resolves.toEqual({ ok: true });
    expect(calls.map((x) => x.auth)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('fails with a typed auth error when refresh is impossible', async () => {
    const { c } = client(() => json([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }], 401));
    const err = await c.request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(explainError(err).kind).toBe('auth');
  });

  it('retries GETs on 503 and surfaces permission errors clearly', async () => {
    let n = 0;
    const { c } = client(() => (n++ < 1 ? new Response('busy', { status: 503 }) : json({ ok: 1 })));
    await expect(c.request('/x')).resolves.toEqual({ ok: 1 });

    const { c: c2 } = client(() => json([{ errorCode: 'INSUFFICIENT_ACCESS', message: 'no' }], 403));
    expect(explainError(await c2.request('/x').catch((e) => e))).toMatchObject({ kind: 'permission', title: 'Insufficient permissions' });

    const { c: c3 } = client(() => json([{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }], 403));
    expect(explainError(await c3.request('/x').catch((e) => e)).kind).toBe('limit');
  });

  it('supports cancellation', async () => {
    const { c } = client(() => json({}));
    const ctrl = new AbortController();
    ctrl.abort();
    const err = await c.request('/x', { signal: ctrl.signal }).catch((e) => e);
    expect(isCancelled(err)).toBe(true);
  });

  it('checks freshness before delete without sending a conditional DELETE header', async () => {
    const calls: RequestInit[] = [];
    const { c } = client((_url, init) => {
      calls.push(init);
      return init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ LastModifiedDate: '2026-09-24T17:07:07.000+0000' });
    });
    await c.deleteRecord('Account', '001000000000001AAA', { ifUnmodifiedSince: '2026-09-24T17:07:07.000+0000' });
    expect(calls.map((x) => x.method ?? 'GET')).toEqual(['GET', 'DELETE']);
    expect(new Headers(calls[1]!.headers).has('If-Unmodified-Since')).toBe(false);
  });

  it('does not delete when the record changed after it was loaded', async () => {
    const methods: string[] = [];
    const { c } = client((_url, init) => {
      methods.push(init.method ?? 'GET');
      return json({ LastModifiedDate: '2026-09-24T17:08:00.000+0000' });
    });
    const err = await c.deleteRecord('Account', '001000000000001AAA', { ifUnmodifiedSince: '2026-09-24T17:07:07.000+0000' }).catch((e) => e);
    expect(explainError(err).kind).toBe('conflict');
    expect(methods).toEqual(['GET']);
  });

  it('never sends the token to another host', async () => {
    const { c, calls } = client(() => json({}));
    await expect(c.request('https://evil.example.com/steal')).rejects.toThrow(/Refusing/);
    await expect(c.queryMore('https://acme.my.salesforce.com.evil.com/x')).rejects.toThrow(/Refusing/);
    expect(calls).toHaveLength(0);
  });

  it('limits concurrent requests', async () => {
    let active = 0;
    let peak = 0;
    const { c } = client(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return json({});
    });
    await Promise.all(Array.from({ length: 12 }, () => c.request('/x')));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('parses limit headers and escapes SOQL strings', () => {
    expect(parseLimitInfo('api-usage=25/15000')).toEqual({ used: 25, max: 15000 });
    expect(parseLimitInfo(null)).toBeUndefined();
    expect(soqlString("O'Brien \\ x")).toBe("'O\\'Brien \\\\ x'");
  });
});

describe('OAuth helpers', () => {
  it('allows only credential-safe Salesforce session origins', () => {
    expect(safeSalesforceOrigin('https://acme.my.salesforce.com/lightning')).toBe('https://acme.my.salesforce.com');
    expect(safeSalesforceOrigin('https://acme.my.salesforce-setup.com/lightning/setup/SetupOneHome/home')).toBe('https://acme.my.salesforce-setup.com');
    expect(safeSalesforceOrigin('.na123.salesforce.com')).toBe('https://na123.salesforce.com');
    expect(safeSalesforceOrigin('https://salesforce.com.evil.example')).toBeUndefined();
    expect(safeSalesforceOrigin('https://acme.my.salesforce-setup.com.evil.example')).toBeUndefined();
    expect(safeSalesforceOrigin('http://acme.my.salesforce.com')).toBeUndefined();
    expect(safeSalesforceOrigin('https://user:pass@acme.my.salesforce.com')).toBeUndefined();
    expect(safeSalesforceOrigin('https://login.salesforce.com')).toBeUndefined();
  });
  it('builds a PKCE authorize URL with minimal scopes', async () => {
    const challenge = await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // RFC 7636 test vector
    const url = new URL(
      buildAuthorizeUrl({ authHost: 'acme.my.salesforce.com', clientId: 'KEY', redirectUri: 'https://abc.chromiumapp.org/', state: 'S', codeChallenge: challenge }),
    );
    expect(url.origin).toBe('https://acme.my.salesforce.com');
    expect(url.searchParams.get('scope')).toBe('api refresh_token');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('validates state and surfaces OAuth errors', () => {
    expect(parseAuthRedirect('https://abc.chromiumapp.org/?code=C1&state=S', 'S')).toBe('C1');
    expect(() => parseAuthRedirect('https://abc.chromiumapp.org/?code=C1&state=X', 'S')).toThrow(/did not match/);
    const err = (() => {
      try {
        parseAuthRedirect('https://abc.chromiumapp.org/?error=redirect_uri_mismatch&error_description=bad', 'S');
      } catch (e) {
        return e as OAuthError;
      }
    })();
    expect(err?.code).toBe('redirect_uri_mismatch');
    expect(err?.message).toMatch(/callback URL/);
  });

  it('parses token responses and keeps the previous refresh token on refresh', () => {
    expect(parseIdentityUrl('https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA')).toEqual({
      orgId: '00D000000000001AAA',
      userId: '005000000000001AAA',
    });
    const first = parseTokenResponse({
      access_token: 'a1',
      refresh_token: 'r1',
      instance_url: 'https://acme.my.salesforce.com',
      id: 'https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA',
      issued_at: '1700000000000',
    });
    const refreshed = parseTokenResponse(
      { access_token: 'a2', instance_url: 'https://acme.my.salesforce.com', id: 'https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA' },
      first,
    );
    expect(refreshed.refreshToken).toBe('r1');
    expect(refreshed.accessToken).toBe('a2');
    expect(() => parseTokenResponse({ error: 'invalid_grant', error_description: 'expired access/refresh token' })).toThrow(/expired/);
  });
});
