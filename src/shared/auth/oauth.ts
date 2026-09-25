/**
 * Salesforce OAuth 2.0 Authorization Code flow with PKCE, for a public client.
 *
 * - No client secret is used or shipped. The Connected App / External Client App
 *   must have "Require Secret for Web Server Flow" and "Require Secret for Refresh
 *   Token Flow" disabled and "Require PKCE" enabled.
 * - The redirect URI is `https://<extension-id>.chromiumapp.org/`, which
 *   chrome.identity.launchWebAuthFlow intercepts.
 * - Scopes are the minimum needed: `api` (REST + Tooling API) and `refresh_token`
 *   (renew the session without prompting again).
 */

export const OAUTH_SCOPES = ['api', 'refresh_token'] as const;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  instanceUrl: string;
  /** Identity URL, e.g. https://login.salesforce.com/id/00D.../005... */
  idUrl: string;
  orgId: string;
  userId: string;
  issuedAt: number;
  scope?: string;
  /** Browser-session credentials are temporary and must never be refreshed or revoked by this extension. */
  authSource?: 'oauth' | 'tab-session';
  sourceTabId?: number;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface AuthorizeParams {
  authHost: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Force the account chooser/login screen, e.g. to switch users. */
  prompt?: 'login' | 'select_account';
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  const url = new URL(`https://${p.authHost}/services/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (p.prompt) url.searchParams.set('prompt', p.prompt);
  return url.toString();
}

/** Extracts the authorization code from the redirect URL and verifies `state`. */
export function parseAuthRedirect(redirectUrl: string, expectedState: string): string {
  const u = new URL(redirectUrl);
  const params = u.searchParams;
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description') ?? error;
    throw new OAuthError(error, friendlyOAuthError(error, description));
  }
  if (params.get('state') !== expectedState) {
    throw new OAuthError('state_mismatch', 'The sign-in response did not match this request. Please try again.');
  }
  const code = params.get('code');
  if (!code) throw new OAuthError('missing_code', 'Salesforce did not return an authorization code.');
  return code;
}

function friendlyOAuthError(code: string, description: string): string {
  switch (code) {
    case 'access_denied':
      return 'Access was denied. The sign-in was cancelled or the user is not approved for this Connected App.';
    case 'redirect_uri_mismatch':
      return 'The callback URL is not registered on the Connected App. Copy the callback URL from Settings into the app configuration.';
    case 'invalid_client_id':
    case 'invalid_client':
      return 'The Consumer Key is not recognized by this org. Check the Client ID in Settings, and allow a few minutes after creating the app.';
    case 'OAUTH_APP_BLOCKED':
    case 'OAUTH_APPROVAL_ERROR_GENERIC':
      return `This org blocked the app: ${description}`;
    default:
      return `Salesforce sign-in failed (${code}): ${description}`;
  }
}

/** Parses `/id/<orgId>/<userId>` from the identity URL. */
export function parseIdentityUrl(idUrl: string): { orgId: string; userId: string } {
  const m = /\/id\/(00D[a-zA-Z0-9]{12,15})\/(005[a-zA-Z0-9]{12,15})\/?$/.exec(new URL(idUrl).pathname);
  if (!m) throw new OAuthError('invalid_identity', 'Salesforce returned an unexpected identity URL.');
  return { orgId: m[1]!, userId: m[2]! };
}

export interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  instance_url?: string;
  id?: string;
  issued_at?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export function parseTokenResponse(raw: RawTokenResponse, previous?: TokenSet): TokenSet {
  if (raw.error) throw new OAuthError(raw.error, raw.error_description ?? raw.error);
  if (!raw.access_token || !raw.instance_url || !raw.id) {
    throw new OAuthError('invalid_token_response', 'Salesforce returned an incomplete token response.');
  }
  const { orgId, userId } = parseIdentityUrl(raw.id);
  const refreshToken = raw.refresh_token ?? previous?.refreshToken;
  return {
    accessToken: raw.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    instanceUrl: raw.instance_url,
    idUrl: raw.id,
    orgId,
    userId,
    issuedAt: raw.issued_at ? Number(raw.issued_at) : Date.now(),
    ...(raw.scope ? { scope: raw.scope } : {}),
  };
}

async function postForm(url: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<RawTokenResponse> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    credentials: 'omit',
  });
  let json: RawTokenResponse;
  try {
    json = (await res.json()) as RawTokenResponse;
  } catch {
    throw new OAuthError('invalid_response', `Token endpoint returned HTTP ${res.status}.`);
  }
  if (!res.ok && !json.error) json.error = `http_${res.status}`;
  return json;
}

export async function exchangeCode(
  args: { tokenHost: string; clientId: string; redirectUri: string; code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const raw = await postForm(
    `https://${args.tokenHost}/services/oauth2/token`,
    {
      grant_type: 'authorization_code',
      code: args.code,
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    },
    fetchImpl,
  );
  return parseTokenResponse(raw);
}

export async function refreshAccessToken(
  args: { tokenHost: string; clientId: string; previous: TokenSet },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  if (!args.previous.refreshToken) throw new OAuthError('no_refresh_token', 'Session expired. Please reconnect.');
  const raw = await postForm(
    `https://${args.tokenHost}/services/oauth2/token`,
    { grant_type: 'refresh_token', refresh_token: args.previous.refreshToken, client_id: args.clientId },
    fetchImpl,
  );
  return parseTokenResponse(raw, args.previous);
}

export async function revokeToken(tokenHost: string, token: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`https://${tokenHost}/services/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    credentials: 'omit',
  });
}
