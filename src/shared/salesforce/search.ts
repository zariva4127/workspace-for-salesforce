/**
 * Record search helpers: SOSL building/escaping and result normalization.
 * SOSL runs as the current user, so results respect sharing and FLS.
 */
import { soqlString, type SalesforceClient } from '../api/client';
import { isSalesforceId, to18 } from './ids';
import type { ObjectSummary } from './metadata';

/** Objects searched when the user doesn't pick one, with the field used as the display name. */
export const DEFAULT_SEARCH_OBJECTS: Array<{ name: string; nameField: string; extra?: string }> = [
  { name: 'Account', nameField: 'Name' },
  { name: 'Contact', nameField: 'Name', extra: 'Email' },
  { name: 'Lead', nameField: 'Name', extra: 'Company' },
  { name: 'Opportunity', nameField: 'Name', extra: 'StageName' },
  { name: 'Case', nameField: 'CaseNumber', extra: 'Subject' },
  { name: 'User', nameField: 'Name', extra: 'Username' },
];

const SOSL_RESERVED = /[?&|!{}[\]()^~*:\\"'+-]/g;

/** Escapes SOSL reserved characters so user input is always treated as text. */
export function escapeSosl(term: string): string {
  return term.replace(SOSL_RESERVED, (c) => `\\${c}`);
}

export type SearchInput = { kind: 'id'; id: string } | { kind: 'text'; term: string } | { kind: 'invalid'; reason: string };

export function classifySearchInput(raw: string): SearchInput {
  const t = raw.trim();
  if (!t) return { kind: 'invalid', reason: 'Enter a name, number, email, or record ID.' };
  const looksLikeId: boolean = isSalesforceId(t);
  if (looksLikeId) return { kind: 'id', id: to18(t) };
  // SOSL requires at least two characters, not counting wildcards.
  if (t.replace(/[*?]/g, '').length < 2) return { kind: 'invalid', reason: 'Enter at least 2 characters.' };
  if (t.length > 100) return { kind: 'invalid', reason: 'Use 100 characters or fewer.' };
  return { kind: 'text', term: t };
}

export interface SearchTarget {
  name: string;
  nameField: string;
  extra?: string;
}

export function buildSosl(term: string, targets: SearchTarget[], limitPerObject = 10): string {
  const returning = targets
    .map((t) => {
      const fields = [...new Set(['Id', t.nameField, ...(t.extra ? [t.extra] : [])])].join(', ');
      return `${t.name}(${fields} LIMIT ${limitPerObject})`;
    })
    .join(', ');
  return `FIND {${escapeSosl(term)}} IN ALL FIELDS RETURNING ${returning}`;
}

export interface SearchHit {
  id: string;
  objectApiName: string;
  title: string;
  subtitle?: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeSearchResults(raw: any, targets: SearchTarget[]): SearchHit[] {
  const byName = new Map(targets.map((t) => [t.name.toLowerCase(), t]));
  const rows: any[] = Array.isArray(raw) ? raw : (raw?.searchRecords ?? []);
  return rows
    .filter((r) => r && typeof r.Id === 'string')
    .map((r) => {
      const type: string = r.attributes?.type ?? '';
      const t = byName.get(type.toLowerCase());
      const title = String((t && r[t.nameField]) ?? r.Name ?? r.Id);
      const extra = t?.extra ? r[t.extra] : undefined;
      return { id: r.Id, objectApiName: type, title, ...(extra ? { subtitle: String(extra) } : {}) };
    });
}

export async function searchRecords(client: SalesforceClient, term: string, targets: SearchTarget[], signal?: AbortSignal): Promise<SearchHit[]> {
  const sosl = buildSosl(term, targets);
  const res = await client.request<unknown>(`${client.dataPath}/search/?q=${encodeURIComponent(sosl)}`, { ...(signal ? { signal } : {}) });
  return normalizeSearchResults(res, targets);
}

export interface RecentItem {
  id: string;
  name: string;
  objectApiName: string;
  lastViewed?: string;
}

/** Records the user recently viewed in Salesforce (RecentlyViewed object, per user). */
export async function recentlyViewed(client: SalesforceClient, objectApiName?: string, signal?: AbortSignal): Promise<RecentItem[]> {
  const where = objectApiName ? ` WHERE Type = ${soqlString(objectApiName)}` : '';
  const res = await client.query<{ Id: string; Name: string; Type: string; LastViewedDate?: string }>(
    `SELECT Id, Name, Type, LastViewedDate FROM RecentlyViewed${where} ORDER BY LastViewedDate DESC LIMIT 15`,
    { ...(signal ? { signal } : {}) },
  );
  return res.records.map((r) => ({ id: r.Id, name: r.Name, objectApiName: r.Type, ...(r.LastViewedDate ? { lastViewed: r.LastViewedDate } : {}) }));
}

/** Search targets for one chosen object, using its describe-derived name field. */
export function targetFor(object: Pick<ObjectSummary, 'name'>, nameField: string): SearchTarget {
  const known = DEFAULT_SEARCH_OBJECTS.find((d) => d.name === object.name);
  return known ?? { name: object.name, nameField };
}
