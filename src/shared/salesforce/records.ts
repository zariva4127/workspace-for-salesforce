/**
 * Loads a record for the record navigator. Uses the REST sObject endpoint, which
 * only returns fields the current user can read (field-level security) and fails
 * when sharing hides the record — so results always respect the user's access.
 */
import { soqlLike, soqlString, type SalesforceClient } from '../api/client';
import { SalesforceApiError } from '../api/errors';
import type { FieldInfo, MetadataService, ObjectDescribe } from './metadata';

export interface ParentLookup {
  field: FieldInfo;
  id: string;
  objectApiName?: string;
  name?: string;
}

export interface LoadedRecord {
  objectApiName: string;
  describe: ObjectDescribe;
  values: Record<string, unknown>;
  lookups: ParentLookup[];
  /** Fields present in describe but not returned (hidden by FLS or not retrievable). */
  hiddenFieldCount: number;
  nameValue?: string;
}

const KEY_FIELD_NAMES = ['Id', 'RecordTypeId', 'OwnerId', 'Status', 'StageName', 'Type', 'CreatedById', 'CreatedDate', 'LastModifiedById', 'LastModifiedDate'];

export function keyFields(describe: ObjectDescribe): FieldInfo[] {
  const nameField = describe.fields.filter((f) => f.nameField);
  const rest = KEY_FIELD_NAMES.map((n) => describe.fields.find((f) => f.name === n)).filter((f): f is FieldInfo => !!f);
  return [...nameField, ...rest.filter((f) => !f.nameField)];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadRecord(
  client: SalesforceClient,
  metadata: MetadataService,
  recordId: string,
  objectHint: string | undefined,
  signal?: AbortSignal,
): Promise<LoadedRecord> {
  let objectApiName = objectHint;
  if (!objectApiName) {
    const obj = await metadata.objectForId(recordId, signal);
    if (!obj) throw new SalesforceApiError(404, 'NOT_FOUND', `No object with key prefix ${recordId.slice(0, 3)} is visible to you.`);
    objectApiName = obj.name;
  }
  const { value: describe } = await metadata.describe(objectApiName, { ...(signal ? { signal } : {}) });
  const raw = await client.getRecord<Record<string, unknown>>(describe.name, recordId, signal);
  const { attributes: _a, ...values } = raw as Record<string, unknown> & { attributes?: unknown };

  const returned = new Set(Object.keys(values));
  const hiddenFieldCount = describe.fields.filter((f) => f.type !== 'address' && f.type !== 'location' && !f.compoundFieldName && !returned.has(f.name)).length;

  const lookups: ParentLookup[] = describe.fields
    .filter((f) => f.type === 'reference' && typeof values[f.name] === 'string' && values[f.name])
    .map((f) => ({ field: f, id: values[f.name] as string, ...(f.referenceTo.length === 1 ? { objectApiName: f.referenceTo[0]! } : {}) }));

  await resolveLookupNames(client, metadata, describe, recordId, lookups, signal);

  const nameField = describe.fields.find((f) => f.nameField);
  const nameValue = nameField ? values[nameField.name] : undefined;
  return {
    objectApiName: describe.name,
    describe,
    values,
    lookups,
    hiddenFieldCount,
    ...(typeof nameValue === 'string' ? { nameValue } : {}),
  };
}

/**
 * Resolves display names for lookups in one SOQL query using relationship
 * fields (Owner.Name, Account.Name…). Polymorphic lookups use the Name
 * pseudo-object. If the query fails (e.g. a target has no Name field), names
 * stay unresolved; IDs and links still work.
 */
async function resolveLookupNames(
  client: SalesforceClient,
  metadata: MetadataService,
  describe: ObjectDescribe,
  recordId: string,
  lookups: ParentLookup[],
  signal?: AbortSignal,
): Promise<void> {
  const candidates = lookups.filter((l) => l.field.relationshipName).slice(0, 35);
  if (!candidates.length || !describe.queryable) return;

  const selects: string[] = [];
  const typeSelects: string[] = [];
  for (const l of candidates) {
    const rel = l.field.relationshipName!;
    if (l.field.polymorphic) {
      selects.push(`${rel}.Name`);
      typeSelects.push(`${rel}.Type`);
      continue;
    }
    const target = l.field.referenceTo[0];
    if (!target) continue;
    try {
      const { value: td } = await metadata.describe(target, { ...(signal ? { signal } : {}) });
      const nf = td.fields.find((f) => f.nameField);
      if (nf) selects.push(`${rel}.${nf.name}`);
    } catch {
      // Target not describable for this user; leave unresolved.
    }
  }
  if (!selects.length) return;

  try {
    const res = await client.query<any>(
      `SELECT ${[...new Set([...selects, ...typeSelects])].join(', ')} FROM ${describe.name} WHERE Id = ${soqlString(recordId)}`,
      { ...(signal ? { signal } : {}) },
    );
    const row = res.records[0];
    if (!row) return;
    for (const l of candidates) {
      const relObj = row[l.field.relationshipName!];
      if (!relObj || typeof relObj !== 'object') continue;
      const name = Object.entries(relObj).find(([k]) => k !== 'attributes' && k !== 'Type')?.[1];
      if (typeof name === 'string') l.name = name;
      if (l.field.polymorphic && typeof relObj.Type === 'string') l.objectApiName = relObj.Type;
    }
  } catch {
    // Non-fatal: names are a convenience.
  }
}

export async function countChildren(
  client: SalesforceClient,
  childObject: string,
  field: string,
  parentId: string,
  signal?: AbortSignal,
): Promise<number> {
  const res = await client.query(`SELECT COUNT() FROM ${childObject} WHERE ${field} = ${soqlString(parentId)}`, { ...(signal ? { signal } : {}) });
  return res.totalSize;
}

/** Formats a field value for display. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('street' in v || 'city' in v) return [v.street, v.city, v.state, v.postalCode, v.country].filter(Boolean).join(', ');
    if ('latitude' in v) return `${v.latitude}, ${v.longitude}`;
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Human-friendly value for display (dates in the user's locale, Yes/No for
 * checkboxes, grouped numbers). Copy actions keep using the raw value.
 */
export function formatFieldValue(value: unknown, type: string, locale?: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'boolean') return value ? 'Yes' : 'No';
  if (type === 'datetime' && typeof value === 'string') {
    const d = new Date(value.replace(/\+0000$/, 'Z'));
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y!, m! - 1, d!).toLocaleDateString(locale, { dateStyle: 'medium' });
  }
  if ((type === 'currency' || type === 'double' || type === 'int' || type === 'percent') && typeof value === 'number') {
    const n = value.toLocaleString(locale, { maximumFractionDigits: 6 });
    return type === 'percent' ? `${n}%` : n;
  }
  return displayValue(value);
}

// ---- Helpers for record management -------------------------------------------

/** The field that names records of an object (Name, CaseNumber, Subject…). */
export async function nameFieldOf(metadata: MetadataService, objectApiName: string, signal?: AbortSignal): Promise<string> {
  const { value } = await metadata.describe(objectApiName, { ...(signal ? { signal } : {}) });
  return value.fields.find((f) => f.nameField)?.name ?? 'Id';
}

export interface LookupOption {
  id: string;
  name: string;
  objectApiName: string;
}

/** Records of `objectApiName` whose name contains `term`, for lookup fields. Runs as the user. */
export async function searchLookup(client: SalesforceClient, metadata: MetadataService, objectApiName: string, term: string, signal?: AbortSignal): Promise<LookupOption[]> {
  const nameField = await nameFieldOf(metadata, objectApiName, signal);
  const where = term.trim() ? ` WHERE ${nameField} LIKE ${soqlLike(term.trim())}` : '';
  const res = await client.query<Record<string, unknown>>(`SELECT Id, ${nameField} FROM ${objectApiName}${where} ORDER BY ${nameField} LIMIT 10`, { ...(signal ? { signal } : {}) });
  return res.records.map((r) => ({ id: String(r.Id), name: String(r[nameField] ?? r.Id), objectApiName }));
}

/** Name of a single record, for showing a lookup value the user pasted or that was prefilled. */
export async function recordName(client: SalesforceClient, metadata: MetadataService, id: string, signal?: AbortSignal): Promise<LookupOption | undefined> {
  const obj = await metadata.objectForId(id, signal);
  if (!obj) return undefined;
  const nameField = await nameFieldOf(metadata, obj.name, signal);
  const res = await client.query<Record<string, unknown>>(`SELECT Id, ${nameField} FROM ${obj.name} WHERE Id = ${soqlString(id)}`, { ...(signal ? { signal } : {}) });
  const r = res.records[0];
  return r ? { id: String(r.Id), name: String(r[nameField] ?? r.Id), objectApiName: obj.name } : undefined;
}

/** First few child records of a related list, newest first, for related-record navigation. */
export async function listChildren(
  client: SalesforceClient,
  metadata: MetadataService,
  childObject: string,
  field: string,
  parentId: string,
  signal?: AbortSignal,
): Promise<{ records: LookupOption[]; total: number }> {
  const nameField = await nameFieldOf(metadata, childObject, signal);
  const opt = { ...(signal ? { signal } : {}) };
  const res = await client.query<Record<string, unknown>>(
    `SELECT Id, ${nameField} FROM ${childObject} WHERE ${field} = ${soqlString(parentId)} ORDER BY CreatedDate DESC LIMIT 10`,
    opt,
  );
  const total = res.records.length < 10 ? res.records.length : await countChildren(client, childObject, field, parentId, signal);
  return { records: res.records.map((r) => ({ id: String(r.Id), name: String(r[nameField] ?? r.Id), objectApiName: childObject })), total };
}

/** What the connected user may do with one record (sharing + locks), from UserRecordAccess. */
export async function myRecordAccess(client: SalesforceClient, userId: string, recordId: string, signal?: AbortSignal): Promise<{ edit: boolean; delete: boolean } | null> {
  const res = await client.query<{ HasEditAccess: boolean; HasDeleteAccess: boolean }>(
    `SELECT RecordId, HasEditAccess, HasDeleteAccess FROM UserRecordAccess WHERE UserId = ${soqlString(userId)} AND RecordId = ${soqlString(recordId)}`,
    { ...(signal ? { signal } : {}) },
  );
  const r = res.records[0];
  return r ? { edit: !!r.HasEditAccess, delete: !!r.HasDeleteAccess } : null;
}
