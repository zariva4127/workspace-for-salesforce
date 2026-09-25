/**
 * Salesforce sign-in via chrome.identity.launchWebAuthFlow (Authorization Code + PKCE).
 *
 * The user signs in on Salesforce's own login page in a Chrome-managed window.
 * The extension never sees the password and never reads Salesforce cookies.
 */
import {
  OAuthError,
  buildAuthorizeUrl,
  exchangeCode,
  parseAuthRedirect,
  pkceChallenge,
  randomString,
  refreshAccessToken,
  revokeToken,
  type TokenSet,
} from '../../shared/auth/oauth';
import { instanceMatchesOrg } from '../../shared/org/identity';
import type { GlobalSettings, OrgProfile } from '../../shared/org/profiles';
import { NetworkError } from '../../shared/api/errors';
import { tokenStore } from './platform';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function redirectUri(): string {
  return chrome.identity.getRedirectURL();
}

export function clientIdFor(profile: OrgProfile, settings: GlobalSettings): string {
  return (profile.clientIdOverride || settings.clientId).trim();
}

export async function connectOrg(profile: OrgProfile, settings: GlobalSettings, opts: { switchUser?: boolean } = {}): Promise<TokenSet> {
  const clientId = clientIdFor(profile, settings);
  if (!clientId) {
    throw new ConfigError('Add your Connected App or External Client App Consumer Key in Settings → Connection before connecting.');
  }
  const verifier = randomString(48);
  const state = randomString(16);
  const url = buildAuthorizeUrl({
    authHost: profile.apiHost,
    clientId,
    redirectUri: redirectUri(),
    state,
    codeChallenge: await pkceChallenge(verifier),
    ...(opts.switchUser ? { prompt: 'login' as const } : {}),
  });

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new OAuthError('flow_failed', /did not approve|canceled|cancelled/i.test(msg) ? 'Sign-in was cancelled.' : `The Salesforce sign-in window could not complete: ${msg}`);
  }
  if (!responseUrl) throw new OAuthError('flow_failed', 'Sign-in was cancelled.');

  const code = parseAuthRedirect(responseUrl, state);
  let tokens: TokenSet;
  try {
    tokens = await exchangeCode({ tokenHost: profile.apiHost, clientId, redirectUri: redirectUri(), code, codeVerifier: verifier });
  } catch (e) {
    if (e instanceof TypeError) throw new NetworkError('Could not reach the Salesforce token endpoint.');
    throw e;
  }

  if (!instanceMatchesOrg(tokens.instanceUrl, profile)) {
    await revokeToken(profile.apiHost, tokens.refreshToken ?? tokens.accessToken).catch(() => undefined);
    throw new OAuthError(
      'org_mismatch',
      `You signed in to ${new URL(tokens.instanceUrl).hostname}, but this tab belongs to ${profile.apiHost}. The connection was discarded; sign in to the matching org.`,
    );
  }
  await tokenStore.save(profile.key, tokens, settings.rememberConnection);
  return tokens;
}

const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_client',
  'invalid_client_id',
  'unauthorized_client',
  'inactive_user',
  'inactive_org',
  'no_refresh_token',
]);

/**
 * Exchanges the refresh token for a new access token. A Web Lock ensures only
 * one refresh runs per org across all side panels; callers that lost the race
 * get the already-refreshed token.
 */
export async function refreshOrg(profile: OrgProfile, settings: GlobalSettings, failedAccessToken?: string): Promise<TokenSet | undefined> {
  return navigator.locks.request(`sfw-refresh:${profile.key}`, async () => {
    const current = await tokenStore.get(profile.key);
    if (current && failedAccessToken !== undefined && current.accessToken !== failedAccessToken) return current;
    const persisted = current ?? (await tokenStore.getPersistedRefresh(profile.key));
    if (!persisted?.refreshToken) return undefined;
    try {
      const next = await refreshAccessToken({
        tokenHost: profile.apiHost,
        clientId: clientIdFor(profile, settings),
        previous: { accessToken: '', ...persisted },
      });
      await tokenStore.save(profile.key, next, settings.rememberConnection);
      return next;
    } catch (e) {
      if (e instanceof OAuthError && TERMINAL_REFRESH_ERRORS.has(e.code)) {
        // The refresh token was revoked, expired by policy, or the user/org is inactive.
        await tokenStore.clear(profile.key);
        return undefined;
      }
      if (e instanceof TypeError) throw new NetworkError('Could not reach Salesforce to renew the session.');
      throw e;
    }
  });
}

export async function disconnectOrg(profile: OrgProfile): Promise<void> {
  const current = await tokenStore.get(profile.key);
  const persisted = await tokenStore.getPersistedRefresh(profile.key);
  const token = current?.refreshToken ?? persisted?.refreshToken ?? current?.accessToken;
  await tokenStore.clear(profile.key);
  // A tab-session SID belongs to the user's Salesforce browser login. Revoking
  // it would sign the user out of Salesforce, so disconnect only forgets it.
  if (token && current?.authSource !== 'tab-session') await revokeToken(profile.apiHost, token).catch(() => undefined);
}
