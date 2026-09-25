/**
 * Org-scoped token storage.
 *
 * - Access tokens live only in chrome.storage.session (memory, cleared when the
 *   browser closes, not exposed to content scripts).
 * - Refresh tokens are kept in session storage too, and copied to local storage
 *   only when the user enables "Remember connection".
 * - Tokens are never logged or included in exports.
 */
import { OrgScopedStore, type KVStore } from '../storage/kv';
import type { TokenSet } from './oauth';

const TOKENS = 'tokens';
const REFRESH = 'refreshToken';

export class TokenStore {
  constructor(
    private readonly session: KVStore,
    private readonly local: KVStore,
  ) {}

  async get(orgKey: string): Promise<TokenSet | undefined> {
    const sessionTokens = await new OrgScopedStore(this.session, orgKey).get<TokenSet>(TOKENS);
    if (sessionTokens) return sessionTokens;
    return undefined;
  }

  /** A persisted refresh token (only present when "Remember connection" is on). */
  async getPersistedRefresh(orgKey: string): Promise<Omit<TokenSet, 'accessToken'> | undefined> {
    return new OrgScopedStore(this.local, orgKey).get(REFRESH);
  }

  async save(orgKey: string, tokens: TokenSet, remember: boolean): Promise<void> {
    await new OrgScopedStore(this.session, orgKey).set(TOKENS, tokens);
    const local = new OrgScopedStore(this.local, orgKey);
    if (remember && tokens.refreshToken) {
      const { accessToken: _omit, ...persisted } = tokens;
      await local.set(REFRESH, persisted);
    } else {
      await local.remove(REFRESH);
    }
  }

  async clear(orgKey: string): Promise<void> {
    await new OrgScopedStore(this.session, orgKey).remove(TOKENS);
    await new OrgScopedStore(this.local, orgKey).remove(REFRESH);
  }
}
