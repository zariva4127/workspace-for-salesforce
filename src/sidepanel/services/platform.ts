/** Singletons wired to real Chrome storage. Feature code receives these through the workspace context. */
import { ChromeStorageStore, IndexedDbStore, OrgScopedStore } from '../../shared/storage/kv';
import { ProfileRepository } from '../../shared/org/profiles';
import { TokenStore } from '../../shared/auth/tokenStore';

export const localStore = new ChromeStorageStore(chrome.storage.local);
export const sessionStore = new ChromeStorageStore(chrome.storage.session);
/** Large data: metadata caches, test sessions, screenshots. */
export const bigStore = new IndexedDbStore();

export const profiles = new ProfileRepository(localStore);
export const tokenStore = new TokenStore(sessionStore, localStore);

export function orgBigStore(orgKey: string): OrgScopedStore {
  return new OrgScopedStore(bigStore, orgKey);
}

/** Removes everything the extension stores for one org: profile, tokens, caches, sessions, screenshots. */
export async function forgetOrgEverywhere(orgKey: string): Promise<void> {
  await tokenStore.clear(orgKey);
  await new OrgScopedStore(sessionStore, orgKey).clear();
  await orgBigStore(orgKey).clear();
  await profiles.forget(orgKey);
}
