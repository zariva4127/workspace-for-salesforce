/**
 * Describe results trimmed to what the UI needs (keeps the cache small), and
 * cached accessors for describeGlobal / describe.
 */
import type { SalesforceClient } from '../api/client';
import type { MetadataCache, CacheResult } from '../cache/metadataCache';
import { parseCompactLayout, parseLayout, type LayoutSummary } from '../records/layout';

export interface ObjectSummary {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  searchable: boolean;
  layoutable: boolean;
}

export interface FieldInfo {
  name: string;
  label: string;
  type: string;
  length: number;
  precision: number;
  scale: number;
  digits: number;
  custom: boolean;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  calculated: boolean;
  autoNumber: boolean;
  unique: boolean;
  externalId: boolean;
  defaultedOnCreate: boolean;
  nameField: boolean;
  permissionable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  polymorphic: boolean;
  cascadeDelete: boolean;
  restrictedPicklist: boolean;
  picklistValues: Array<{ value: string; label: string; active: boolean; defaultValue?: boolean; validFor?: string }>;
  inlineHelpText: string | null;
  compoundFieldName: string | null;
  /** For dependent picklists: API name of the controlling field. */
  controllerName: string | null;
  dependentPicklist: boolean;
  htmlFormatted: boolean;
}

export interface RecordTypeInfo {
  id: string;
  name: string;
  developerName: string;
  available: boolean;
  master: boolean;
  defaultForUser: boolean;
}

export interface ChildRelationshipInfo {
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
}

export interface ObjectDescribe {
  name: string;
  label: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  /** Object permissions for the connected user (from describe). */
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  fields: FieldInfo[];
  childRelationships: ChildRelationshipInfo[];
  recordTypeCount: number;
  recordTypes: RecordTypeInfo[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function trimGlobal(raw: any): ObjectSummary[] {
  return ((raw?.sobjects ?? []) as any[]).map((o) => ({
    name: o.name,
    label: o.label,
    labelPlural: o.labelPlural,
    keyPrefix: o.keyPrefix ?? null,
    custom: !!o.custom,
    queryable: !!o.queryable,
    createable: !!o.createable,
    updateable: !!o.updateable,
    deletable: !!o.deletable,
    searchable: !!o.searchable,
    layoutable: !!o.layoutable,
  }));
}

export function trimField(f: any): FieldInfo {
  const referenceTo: string[] = f.referenceTo ?? [];
  return {
    name: f.name,
    label: f.label,
    type: f.type,
    length: f.length ?? 0,
    precision: f.precision ?? 0,
    scale: f.scale ?? 0,
    digits: f.digits ?? 0,
    custom: !!f.custom,
    nillable: !!f.nillable,
    createable: !!f.createable,
    updateable: !!f.updateable,
    calculated: !!f.calculated,
    autoNumber: !!f.autoNumber,
    unique: !!f.unique,
    externalId: !!f.externalId,
    defaultedOnCreate: !!f.defaultedOnCreate,
    nameField: !!f.nameField,
    permissionable: !!f.permissionable,
    referenceTo,
    relationshipName: f.relationshipName ?? null,
    polymorphic: !!f.polymorphicForeignKey || referenceTo.length > 1,
    cascadeDelete: !!f.cascadeDelete,
    restrictedPicklist: !!f.restrictedPicklist,
    picklistValues: ((f.picklistValues ?? []) as any[]).map((p) => ({
      value: p.value,
      label: p.label,
      active: !!p.active,
      ...(p.defaultValue ? { defaultValue: true } : {}),
      ...(p.validFor ? { validFor: p.validFor } : {}),
    })),
    inlineHelpText: f.inlineHelpText ?? null,
    compoundFieldName: f.compoundFieldName ?? null,
    controllerName: f.controllerName ?? null,
    dependentPicklist: !!f.dependentPicklist,
    htmlFormatted: !!f.htmlFormatted,
  };
}

export function trimDescribe(raw: any): ObjectDescribe {
  return {
    name: raw.name,
    label: raw.label,
    keyPrefix: raw.keyPrefix ?? null,
    custom: !!raw.custom,
    queryable: !!raw.queryable,
    createable: !!raw.createable,
    updateable: !!raw.updateable,
    deletable: !!raw.deletable,
    fields: ((raw.fields ?? []) as any[]).map(trimField),
    childRelationships: ((raw.childRelationships ?? []) as any[]).map((c) => ({
      childSObject: c.childSObject,
      field: c.field,
      relationshipName: c.relationshipName ?? null,
      cascadeDelete: !!c.cascadeDelete,
    })),
    recordTypeCount: (raw.recordTypeInfos ?? []).length,
    recordTypes: ((raw.recordTypeInfos ?? []) as any[]).map((r) => ({
      id: r.recordTypeId,
      name: r.name,
      developerName: r.developerName ?? r.name,
      available: !!r.available,
      master: !!r.master,
      defaultForUser: !!r.defaultRecordTypeMapping,
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class MetadataService {
  constructor(
    private readonly client: SalesforceClient,
    readonly cache: MetadataCache,
  ) {}

  objects(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<CacheResult<ObjectSummary[]>> {
    return this.cache.get(
      `global2:v${this.client.apiVersion}`,
      async () => trimGlobal(await this.client.describeGlobal(opts.signal)),
      opts,
    );
  }

  describe(objectApiName: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<CacheResult<ObjectDescribe>> {
    return this.cache.get(
      `describe2:v${this.client.apiVersion}:${objectApiName.toLowerCase()}`,
      async () => trimDescribe(await this.client.describe(objectApiName, opts.signal)),
      opts,
    );
  }

  /**
   * The detail page layout assigned to the connected user for a record type
   * (undefined when the object has no layouts or the user can't read them).
   */
  async layout(objectApiName: string, recordTypeId: string | undefined, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<LayoutSummary | undefined> {
    const rt = recordTypeId ?? 'default';
    const res = await this.cache.get(
      `layout2:v${this.client.apiVersion}:${objectApiName.toLowerCase()}:${rt}`,
      async () => {
        const path = `${this.client.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/describe/layouts/${recordTypeId ? encodeURIComponent(recordTypeId) : ''}`;
        return parseLayout(await this.client.request<unknown>(path, { ...(opts.signal ? { signal: opts.signal } : {}) }), recordTypeId) ?? null;
      },
      opts,
    );
    return res.value ?? undefined;
  }

  /** Field names of the object's primary compact layout (the "highlights" fields). */
  async compactFields(objectApiName: string, opts: { signal?: AbortSignal } = {}): Promise<string[]> {
    const res = await this.cache.get(
      `compact:v${this.client.apiVersion}:${objectApiName.toLowerCase()}`,
      async () => parseCompactLayout(await this.client.request<unknown>(`${this.client.dataPath}/sobjects/${encodeURIComponent(objectApiName)}/describe/compactLayouts/primary`, { ...(opts.signal ? { signal: opts.signal } : {}) })),
      {},
    );
    return res.value;
  }

  /** The org's corporate currency, for formatting currency fields. */
  async orgCurrency(opts: { signal?: AbortSignal } = {}): Promise<string | undefined> {
    const res = await this.cache.get(
      'orgCurrency',
      async () => (await this.client.query<{ DefaultCurrencyIsoCode?: string }>('SELECT DefaultCurrencyIsoCode FROM Organization LIMIT 1', opts)).records[0]?.DefaultCurrencyIsoCode ?? null,
      {},
    );
    return res.value ?? undefined;
  }

  /** Resolves an object API name from a record ID's key prefix. */
  async objectForId(id: string, signal?: AbortSignal): Promise<ObjectSummary | undefined> {
    const prefix = id.slice(0, 3);
    const { value } = await this.objects({ ...(signal ? { signal } : {}) });
    return value.find((o) => o.keyPrefix === prefix);
  }
}

// ---- Object list presentation ---------------------------------------------

const SYSTEM_SUFFIXES = ['Share', 'Feed', 'History', 'ChangeEvent', 'OwnerSharingRule', '__hd'];

/** Salesforce returns placeholder labels like "__MISSING LABEL__ PropertyFile - …" for some system objects. */
export function objectLabel(o: Pick<ObjectSummary, 'label' | 'name'>): string {
  return !o.label || o.label.startsWith('__MISSING LABEL__') ? o.name : o.label;
}

/** Share, Feed, History, ChangeEvent and similar objects rarely matter for day-to-day work. */
export function isSystemObject(o: Pick<ObjectSummary, 'name' | 'label' | 'layoutable'>): boolean {
  if (o.label?.startsWith('__MISSING LABEL__')) return true;
  if (SYSTEM_SUFFIXES.some((s) => o.name.endsWith(s))) return true;
  return false;
}

/**
 * Filters and ranks objects for a picker: exact API name, then label/API prefix,
 * then word-start, then substring; custom objects are not penalized. System
 * objects are hidden unless requested or the query names one exactly.
 */
export function rankObjects<T extends Pick<ObjectSummary, 'name' | 'label' | 'layoutable'>>(objects: T[], query: string, opts: { includeSystem?: boolean } = {}): T[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ o: T; score: number }> = [];
  for (const o of objects) {
    const name = o.name.toLowerCase();
    const label = objectLabel(o).toLowerCase();
    const system = isSystemObject(o);
    if (system && !opts.includeSystem && name !== q) continue;
    let score: number;
    if (!q) score = 1;
    else if (name === q || label === q) score = 100;
    else if (label.startsWith(q) || name.startsWith(q)) score = 60;
    else if (label.split(/[\s_]+/).some((w) => w.startsWith(q))) score = 40;
    else if (label.includes(q) || name.includes(q)) score = 20;
    else continue;
    if (system) score -= 5;
    scored.push({ o, score });
  }
  return scored.sort((a, b) => b.score - a.score || objectLabel(a.o).localeCompare(objectLabel(b.o))).map((x) => x.o);
}

/** Child relationships to system objects (feeds, histories, shares…) hidden by default. */
export function isSystemRelationship(childSObject: string): boolean {
  return SYSTEM_SUFFIXES.some((s) => childSObject.endsWith(s)) || /^(ProcessInstance|ProcessException|ContentDocumentLink|CombinedAttachment|AttachedContentDocument|EntitySubscription|TopicAssignment|RecordAction|FlowRecordRelation|CollaborationGroupRecord|DuplicateRecordItem|EmailStatus|NoteAndAttachment)/.test(childSObject);
}
