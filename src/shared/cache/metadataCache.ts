/**
 * Per-org TTL cache. Entries live in an OrgScopedStore (IndexedDB in the
 * extension), so caches for different orgs never mix. Concurrent loads of the
 * same key share one in-flight request.
 */
import type { OrgScopedStore } from '../storage/kv';

interface Entry<T> {
  value: T;
  fetchedAt: number;
}

export interface CacheResult<T> {
  value: T;
  fetchedAt: number;
  fromCache: boolean;
}

const CACHE_PREFIX = 'cache:';

export class MetadataCache {
  private readonly inflight = new Map<string, Promise<CacheResult<unknown>>>();

  constructor(
    private readonly store: OrgScopedStore,
    private ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get orgKey(): string {
    return this.store.orgKey;
  }

  setTtl(ms: number): void {
    this.ttlMs = ms;
  }

  async get<T>(key: string, loader: () => Promise<T>, opts: { force?: boolean } = {}): Promise<CacheResult<T>> {
    const storageKey = CACHE_PREFIX + key;
    if (!opts.force) {
      const hit = await this.store.get<Entry<T>>(storageKey);
      if (hit && this.now() - hit.fetchedAt < this.ttlMs) {
        return { value: hit.value, fetchedAt: hit.fetchedAt, fromCache: true };
      }
    }
    const pending = this.inflight.get(storageKey);
    if (pending) return pending as Promise<CacheResult<T>>;

    const p = (async () => {
      const value = await loader();
      const fetchedAt = this.now();
      await this.store.set<Entry<T>>(storageKey, { value, fetchedAt });
      return { value, fetchedAt, fromCache: false };
    })();
    this.inflight.set(storageKey, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(storageKey);
    }
  }

  async invalidate(prefix = ''): Promise<void> {
    await this.store.clear(CACHE_PREFIX + prefix);
  }
}
