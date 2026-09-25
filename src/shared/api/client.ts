/**
 * Minimal Salesforce REST/Tooling client.
 *
 * - Cancellation: every call accepts an AbortSignal.
 * - Pagination: `queryAll` follows nextRecordsUrl up to a record cap.
 * - Rate-limit awareness: tracks the Sforce-Limit-Info header, caps concurrency,
 *   retries idempotent GETs on 502/503/504 with backoff, and refuses large
 *   multi-page reads when the org is close to its daily API limit.
 * - Auth: on 401 it asks `refresh()` for a new token once, then fails with a
 *   typed error so the UI can show a reconnect prompt.
 */
import { CancelledError, NetworkError, NotConnectedError, SalesforceApiError, parseErrorResponse } from './errors';

export const DEFAULT_API_VERSION = '62.0';

export interface ApiUsage {
  used: number;
  max: number;
}

export interface QueryResult<T> {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: T[];
}

export interface ClientOptions {
  instanceUrl: string;
  apiVersion?: string;
  getAccessToken: () => Promise<string | undefined>;
  /** Called on 401; returns a fresh token or undefined when the session cannot be renewed. */
  refresh: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  maxConcurrent?: number;
  onUsage?: (usage: ApiUsage) => void;
  /** For tests: skip backoff delays. */
  retryDelayMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Extra headers, e.g. If-Unmodified-Since for optimistic concurrency. */
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** Response is text (e.g. ApexLog bodies) rather than JSON. */
  text?: boolean;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // Wait for a slot to be handed over directly by release(); `active` stays unchanged.
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new CancelledError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.queue.push(waiter);
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export function parseLimitInfo(header: string | null): ApiUsage | undefined {
  const m = header && /api-usage=(\d+)\/(\d+)/.exec(header);
  return m ? { used: Number(m[1]), max: Number(m[2]) } : undefined;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new CancelledError());
      },
      { once: true },
    );
  });

export class SalesforceClient {
  readonly instanceUrl: string;
  apiVersion: string;
  usage: ApiUsage | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sem: Semaphore;

  constructor(private readonly opts: ClientOptions) {
    this.instanceUrl = opts.instanceUrl.replace(/\/$/, '');
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.sem = new Semaphore(opts.maxConcurrent ?? 4);
  }

  get dataPath(): string {
    return `/services/data/v${this.apiVersion}`;
  }

  /** Fraction of the daily API allocation used, when known. */
  usageRatio(): number | undefined {
    return this.usage && this.usage.max > 0 ? this.usage.used / this.usage.max : undefined;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) throw new CancelledError();
    const url = path.startsWith('http') ? path : `${this.instanceUrl}${path}`;
    if (!url.startsWith(`${this.instanceUrl}/`)) {
      throw new Error('Refusing to send credentials to a host other than the connected org.');
    }
    const release = await this.sem.acquire(signal);
    try {
      let token = await this.opts.getAccessToken();
      if (!token) throw new NotConnectedError();
      const method = options.method ?? 'GET';
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method,
            signal,
            credentials: 'omit',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: options.text ? 'text/plain, */*' : 'application/json',
              ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              'Sforce-Call-Options': 'client=SalesforceWorkspace',
              ...(options.headers ?? {}),
            },
            ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          });
        } catch (e) {
          if (signal?.aborted) throw new CancelledError();
          throw new NetworkError(e instanceof Error ? e.message : 'Network request failed');
        }

        const usage = parseLimitInfo(res.headers.get('Sforce-Limit-Info'));
        if (usage) {
          this.usage = usage;
          this.opts.onUsage?.(usage);
        }

        if (res.status === 401 && attempt === 0) {
          token = await this.opts.refresh();
          if (!token) throw new SalesforceApiError(401, 'INVALID_SESSION_ID', 'Session expired or was revoked.');
          continue;
        }
        if ([502, 503, 504].includes(res.status) && method === 'GET' && attempt < 2) {
          await sleep((this.opts.retryDelayMs ?? 500) * 2 ** attempt, signal);
          continue;
        }
        if (!res.ok) throw await parseErrorResponse(res);
        if (res.status === 204) return undefined as T;
        return (options.text ? await res.text() : await res.json()) as T;
      }
    } finally {
      release();
    }
  }

  // ---- REST helpers -------------------------------------------------------

  versions(signal?: AbortSignal) {
    return this.request<Array<{ version: string; label: string; url: string }>>('/services/data/', { signal });
  }

  limits(signal?: AbortSignal) {
    return this.request<Record<string, { Max: number; Remaining: number }>>(`${this.dataPath}/limits`, { signal });
  }

  query<T>(soql: string, opts: { tooling?: boolean; signal?: AbortSignal } = {}): Promise<QueryResult<T>> {
    const base = opts.tooling ? `${this.dataPath}/tooling/query` : `${this.dataPath}/query`;
    return this.request<QueryResult<T>>(`${base}?q=${encodeURIComponent(soql)}`, { signal: opts.signal });
  }

  queryMore<T>(nextRecordsUrl: string, signal?: AbortSignal): Promise<QueryResult<T>> {
    return this.request<QueryResult<T>>(nextRecordsUrl, { signal });
  }

  /**
   * Runs a query and follows pagination until `maxRecords` records are loaded.
   * Stops early (and reports it) when the org is above 90% of its daily API limit.
   */
  async queryAll<T>(
    soql: string,
    opts: { tooling?: boolean; signal?: AbortSignal; maxRecords?: number; onPage?: (loaded: number, total: number) => void } = {},
  ): Promise<QueryResult<T> & { truncated: boolean; stoppedForLimits: boolean }> {
    const max = opts.maxRecords ?? 2000;
    let page = await this.query<T>(soql, opts);
    const records = [...page.records];
    opts.onPage?.(records.length, page.totalSize);
    let stoppedForLimits = false;
    while (!page.done && page.nextRecordsUrl && records.length < max) {
      if ((this.usageRatio() ?? 0) > 0.9) {
        stoppedForLimits = true;
        break;
      }
      page = await this.queryMore<T>(page.nextRecordsUrl, opts.signal);
      records.push(...page.records);
      opts.onPage?.(records.length, page.totalSize);
    }
    const truncated = records.length > max || !page.done;
    return {
      totalSize: page.totalSize,
      done: page.done && records.length <= max,
      ...(page.nextRecordsUrl ? { nextRecordsUrl: page.nextRecordsUrl } : {}),
      records: records.slice(0, max),
      truncated,
      stoppedForLimits,
    };
  }

  describeGlobal<T>(signal?: AbortSignal) {
    return this.request<T>(`${this.dataPath}/sobjects/`, { signal });
  }

  describe<T>(objectApiName: string, signal?: AbortSignal) {
    return this.request<T>(`${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/describe/`, { signal });
  }

  getRecord<T>(objectApiName: string, id: string, signal?: AbortSignal) {
    return this.request<T>(`${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/${encodeURIComponent(id)}`, { signal });
  }

  // ---- Record changes (require the user's confirmation in the UI) ---------

  createRecord(objectApiName: string, fields: Record<string, unknown>, signal?: AbortSignal) {
    return this.request<{ id: string; success: boolean }>(`${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/`, {
      method: 'POST',
      body: fields,
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Updates changed fields only. With `ifUnmodifiedSince`, Salesforce rejects the
   * update (412) if someone changed the record after that time.
   */
  updateRecord(objectApiName: string, id: string, fields: Record<string, unknown>, opts: { ifUnmodifiedSince?: string; signal?: AbortSignal } = {}) {
    return this.request<void>(`${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: fields,
      ...(opts.ifUnmodifiedSince ? { headers: { 'If-Unmodified-Since': httpDate(opts.ifUnmodifiedSince) } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** Upserts one row by an external ID. A 204 update has no response body. */
  upsertRecord(objectApiName: string, externalIdField: string, externalId: string, fields: Record<string, unknown>, signal?: AbortSignal) {
    return this.request<{ id?: string; success?: boolean } | undefined>(
      `${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/${encodeURIComponent(externalIdField)}/${encodeURIComponent(externalId)}`,
      { method: 'PATCH', body: fields, ...(signal ? { signal } : {}) },
    );
  }

  deleteRecord(objectApiName: string, id: string, opts: { ifUnmodifiedSince?: string; signal?: AbortSignal } = {}) {
    return this.deleteRecordChecked(objectApiName, id, opts);
  }

  private async deleteRecordChecked(objectApiName: string, id: string, opts: { ifUnmodifiedSince?: string; signal?: AbortSignal }): Promise<void> {
    if (opts.ifUnmodifiedSince) {
      // Salesforce supports If-Unmodified-Since reliably for PATCH, but some orgs
      // return UNKNOWN_EXCEPTION for DELETE with that header. Do the optimistic
      // concurrency check explicitly, then send a plain DELETE.
      const current = await this.request<{ LastModifiedDate?: string }>(
        `${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/${encodeURIComponent(id)}?fields=LastModifiedDate`,
        { ...(opts.signal ? { signal: opts.signal } : {}) },
      );
      const expectedMs = new Date(opts.ifUnmodifiedSince.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime();
      const currentMs = current.LastModifiedDate ? new Date(current.LastModifiedDate.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() : Number.NaN;
      if (!Number.isFinite(expectedMs) || !Number.isFinite(currentMs) || expectedMs !== currentMs) {
        throw new SalesforceApiError(412, 'CONFLICT', 'This record was changed by someone else after you opened it.');
      }
    }
    return this.request<void>(`${this.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  apexLogBody(id: string, signal?: AbortSignal) {
    return this.request<string>(`${this.dataPath}/tooling/sobjects/ApexLog/${encodeURIComponent(id)}/Body`, { signal, text: true });
  }
}

/** Converts a Salesforce timestamp (2026-07-29T21:31:31.000+0000) to an HTTP date. */
export function httpDate(sfTimestamp: string): string {
  const d = new Date(sfTimestamp.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${sfTimestamp}`);
  return d.toUTCString();
}

/**
 * A LIKE pattern matching `term` anywhere: `'%term%'`. Quotes and backslashes are
 * escaped for the string literal, and % / _ are escaped so they match literally.
 */
export function soqlLike(term: string): string {
  const body = term.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, (c) => `\\${c}`);
  return `'%${body}%'`;
}

/** Escapes a value for use inside a single-quoted SOQL string literal. */
export function soqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
