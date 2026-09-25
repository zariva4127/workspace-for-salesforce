/**
 * Small async key-value abstraction so feature code never talks to chrome.storage
 * or IndexedDB directly. `OrgScopedStore` guarantees that data for one org cannot
 * be read, overwritten, or cleared through another org's store.
 */
import { isValidOrgKey } from '../org/identity';

export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Lists keys that start with `prefix`. */
  keys(prefix?: string): Promise<string[]>;
}

export class MemoryStore implements KVStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async keys(prefix = ''): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** Wraps chrome.storage.local or chrome.storage.session. */
export class ChromeStorageStore implements KVStore {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get<T>(key: string): Promise<T | undefined> {
    const res = await this.area.get(key);
    return res[key] as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.area.set({ [key]: value });
  }
  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }
  async keys(prefix = ''): Promise<string[]> {
    const all = await this.area.get(null);
    return Object.keys(all).filter((k) => k.startsWith(prefix));
  }
}

/** IndexedDB-backed store for large data (metadata caches, test sessions, screenshots). */
export class IndexedDbStore implements KVStore {
  private dbPromise: Promise<IDBDatabase> | undefined;

  constructor(
    private readonly dbName = 'salesforce-workspace',
    private readonly storeName = 'kv',
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const req = fn(tx.objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.run<T | undefined>('readonly', (s) => s.get(key));
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.run('readwrite', (s) => s.put(value, key));
  }
  async remove(key: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(key));
  }
  async keys(prefix = ''): Promise<string[]> {
    const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
    const keys = await this.run<IDBValidKey[]>('readonly', (s) => s.getAllKeys(range));
    return keys.map(String);
  }
}

export function orgPrefix(orgKey: string): string {
  if (!isValidOrgKey(orgKey)) throw new Error(`Invalid org key: ${orgKey}`);
  return `org:${orgKey}:`;
}

/** A view of a KVStore restricted to a single org's namespace. */
export class OrgScopedStore implements KVStore {
  private readonly prefix: string;

  constructor(
    private readonly base: KVStore,
    readonly orgKey: string,
  ) {
    this.prefix = orgPrefix(orgKey);
  }

  private k(key: string): string {
    return this.prefix + key;
  }
  get<T>(key: string): Promise<T | undefined> {
    return this.base.get<T>(this.k(key));
  }
  set<T>(key: string, value: T): Promise<void> {
    return this.base.set(this.k(key), value);
  }
  remove(key: string): Promise<void> {
    return this.base.remove(this.k(key));
  }
  async keys(prefix = ''): Promise<string[]> {
    const full = await this.base.keys(this.k(prefix));
    return full.map((k) => k.slice(this.prefix.length));
  }
  /** Removes every key belonging to this org, and nothing else. */
  async clear(prefix = ''): Promise<void> {
    const keys = await this.base.keys(this.k(prefix));
    await Promise.all(keys.map((k) => this.base.remove(k)));
  }
}
