/**
 * "Where is this used?" via the Tooling API MetadataComponentDependency object.
 *
 * Known Salesforce limitations (surfaced in the UI):
 * - The object is Beta and returns at most 2,000 rows per query.
 * - Not all metadata types are tracked (e.g. many standard fields, some
 *   references from reports, dynamic Apex/SOQL, and managed-package internals).
 * - Standard fields and standard objects have no Tooling IDs to query by.
 * Results are therefore always labelled "may be incomplete".
 */
import { soqlString, type SalesforceClient } from '../api/client';

export interface DependencyRow {
  id: string;
  name: string;
  type: string;
}

export interface DependencyResult {
  componentId: string;
  usedBy: DependencyRow[];
  uses: DependencyRow[];
  truncated: boolean;
}

/** Component kinds for which Salesforce exposes a Tooling API metadata ID. */
export function isDependencyObject(apiName: string): boolean {
  return /__(c|mdt|e|x|b)$/.test(apiName);
}

export function isDependencyField(apiName: string): boolean {
  return apiName.endsWith('__c');
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Finds the Tooling ID for a custom field or custom object. Returns undefined for standard components. */
export async function resolveComponentId(
  client: SalesforceClient,
  objectApiName: string,
  fieldApiName: string | undefined,
  signal?: AbortSignal,
): Promise<{ id?: string; reason?: string }> {
  const opt = { tooling: true, ...(signal ? { signal } : {}) };
  const isCustomObject = isDependencyObject(objectApiName);
  const devName = (api: string) => api.replace(/__(c|mdt|e|x|b)$/, '').replace(/^[a-zA-Z0-9]+__(?=\w+$)/, '');
  const ns = (api: string) => /^([a-zA-Z0-9]+)__\w+__/.exec(api)?.[1];

  let objectRef = objectApiName;
  if (isCustomObject) {
    const nsPrefix = ns(objectApiName);
    const res = await client.query<any>(
      `SELECT Id FROM CustomObject WHERE DeveloperName = ${soqlString(devName(objectApiName))}${nsPrefix ? ` AND NamespacePrefix = ${soqlString(nsPrefix)}` : ' AND NamespacePrefix = null'}`,
      opt,
    );
    const id = res.records[0]?.Id as string | undefined;
    if (!fieldApiName) return id ? { id } : { reason: 'Custom object not found in the Tooling API.' };
    if (!id) return { reason: 'Custom object not found in the Tooling API.' };
    objectRef = id;
  } else if (!fieldApiName) {
    return { reason: 'Standard objects are not tracked by MetadataComponentDependency.' };
  }

  if (fieldApiName) {
    if (!isDependencyField(fieldApiName)) return { reason: 'Standard fields are not tracked by MetadataComponentDependency.' };
    const nsPrefix = ns(fieldApiName);
    const res = await client.query<any>(
      `SELECT Id FROM CustomField WHERE TableEnumOrId = ${soqlString(objectRef)} AND DeveloperName = ${soqlString(devName(fieldApiName))}${nsPrefix ? ` AND NamespacePrefix = ${soqlString(nsPrefix)}` : ''}`,
      opt,
    );
    const id = res.records[0]?.Id as string | undefined;
    return id ? { id } : { reason: 'Custom field not found in the Tooling API.' };
  }
  return { reason: 'Unsupported component.' };
}

export async function loadDependencies(client: SalesforceClient, componentId: string, signal?: AbortSignal): Promise<DependencyResult> {
  const opt = { tooling: true, maxRecords: 2000, ...(signal ? { signal } : {}) };
  const cols = 'MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType';
  const [usedBy, uses] = await Promise.all([
    client.queryAll<any>(`SELECT ${cols} FROM MetadataComponentDependency WHERE RefMetadataComponentId = ${soqlString(componentId)}`, opt),
    client.queryAll<any>(`SELECT ${cols} FROM MetadataComponentDependency WHERE MetadataComponentId = ${soqlString(componentId)}`, opt),
  ]);
  return {
    componentId,
    usedBy: usedBy.records.map((r) => ({ id: r.MetadataComponentId, name: r.MetadataComponentName, type: r.MetadataComponentType })),
    uses: uses.records.map((r) => ({ id: r.RefMetadataComponentId, name: r.RefMetadataComponentName, type: r.RefMetadataComponentType })),
    truncated: usedBy.truncated || uses.truncated,
  };
}
