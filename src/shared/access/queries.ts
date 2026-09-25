/**
 * Collects the raw data for the access explainer using standard SOQL objects:
 * PermissionSetAssignment, PermissionSet, ObjectPermissions, FieldPermissions,
 * and UserRecordAccess. Each query is independent so one failure (e.g. missing
 * "View Setup" permission) degrades to "unknown" rather than failing everything.
 */
import { soqlLike, soqlString, type SalesforceClient } from '../api/client';
import { explainError } from '../api/errors';
import type {
  AccessInput,
  Fetched,
  FieldPermRow,
  ObjectPermRow,
  PermissionSource,
  RecordAccessRow,
  SystemPermRow,
} from './interpret';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function attempt<T>(fn: () => Promise<T>): Promise<Fetched<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const ex = explainError(e);
    if (ex.kind === 'cancelled') throw e;
    return { ok: false, error: `${ex.title}: ${ex.detail}` };
  }
}

/** Tries queries in order; later ones omit fields that older API versions lack. */
async function queryWithFallback<T>(client: SalesforceClient, queries: string[], signal?: AbortSignal): Promise<T[]> {
  let lastError: unknown;
  for (const q of queries) {
    try {
      return (await client.queryAll<T>(q, { ...(signal ? { signal } : {}), maxRecords: 2000 })).records;
    } catch (e) {
      lastError = e;
      const kind = explainError(e).kind;
      if (kind !== 'query') throw e;
    }
  }
  throw lastError;
}

export interface UserOption {
  Id: string;
  Name: string;
  Username: string;
  IsActive: boolean;
  Profile?: { Name: string } | null;
}

export async function searchUsers(client: SalesforceClient, term: string, signal?: AbortSignal): Promise<UserOption[]> {
  const like = soqlLike(term);
  const q = `SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE (Name LIKE ${like} OR Username LIKE ${like}) ORDER BY IsActive DESC, Name LIMIT 20`;
  return (await client.query<UserOption>(q, { ...(signal ? { signal } : {}) })).records;
}

export async function loadSources(client: SalesforceClient, userId: string, signal?: AbortSignal): Promise<PermissionSource[]> {
  const base = `FROM PermissionSetAssignment WHERE AssigneeId = ${soqlString(userId)}`;
  const rows = await queryWithFallback<any>(
    client,
    [
      `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSet.Type, PermissionSet.HasActivationRequired, PermissionSetGroupId, PermissionSetGroup.MasterLabel, ExpirationDate ${base}`,
      `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSetGroupId, PermissionSetGroup.MasterLabel ${base}`,
      `SELECT PermissionSetId, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name ${base}`,
    ],
    signal,
  );
  const now = Date.now();
  return rows
    .filter((r) => !r.ExpirationDate || Date.parse(r.ExpirationDate) > now)
    .map((r): PermissionSource => {
      const ps = r.PermissionSet ?? {};
      if (ps.IsOwnedByProfile) return { id: r.PermissionSetId, label: `Profile: ${ps.Profile?.Name ?? ps.Label}`, kind: 'profile' };
      if (r.PermissionSetGroupId) {
        return { id: r.PermissionSetId, label: `Permission set group: ${r.PermissionSetGroup?.MasterLabel ?? ps.Label}`, kind: 'permissionSetGroup' };
      }
      const session = ps.Type === 'Session' || ps.HasActivationRequired === true;
      return {
        id: r.PermissionSetId,
        label: `Permission set: ${ps.Label}`,
        kind: session ? 'session' : 'permissionSet',
        ...(session ? { requiresActivation: true } : {}),
      };
    });
}

function idList(ids: string[]): string {
  return ids.map(soqlString).join(',');
}

export async function loadObjectPerms(client: SalesforceClient, objectApiName: string, parentIds: string[], signal?: AbortSignal): Promise<ObjectPermRow[]> {
  if (!parentIds.length) return [];
  const where = `FROM ObjectPermissions WHERE SobjectType = ${soqlString(objectApiName)} AND ParentId IN (${idList(parentIds)})`;
  const cols = 'ParentId, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords';
  const rows = await queryWithFallback<any>(client, [`SELECT ${cols}, PermissionsViewAllFields ${where}`, `SELECT ${cols} ${where}`], signal);
  return rows.map((r) => ({
    parentId: r.ParentId,
    read: !!r.PermissionsRead,
    create: !!r.PermissionsCreate,
    edit: !!r.PermissionsEdit,
    delete: !!r.PermissionsDelete,
    viewAll: !!r.PermissionsViewAllRecords,
    modifyAll: !!r.PermissionsModifyAllRecords,
    ...(r.PermissionsViewAllFields !== undefined ? { viewAllFields: !!r.PermissionsViewAllFields } : {}),
  }));
}

export async function isObjectPermissionable(client: SalesforceClient, objectApiName: string, signal?: AbortSignal): Promise<boolean> {
  const res = await client.query(`SELECT Id FROM ObjectPermissions WHERE SobjectType = ${soqlString(objectApiName)} LIMIT 1`, {
    ...(signal ? { signal } : {}),
  });
  return res.totalSize > 0;
}

export async function loadSystemPerms(client: SalesforceClient, parentIds: string[], signal?: AbortSignal): Promise<SystemPermRow[]> {
  if (!parentIds.length) return [];
  const rows = await client.queryAll<any>(
    `SELECT Id, PermissionsViewAllData, PermissionsModifyAllData FROM PermissionSet WHERE Id IN (${idList(parentIds)})`,
    { ...(signal ? { signal } : {}) },
  );
  return rows.records.map((r) => ({ parentId: r.Id, viewAllData: !!r.PermissionsViewAllData, modifyAllData: !!r.PermissionsModifyAllData }));
}

export async function loadFieldPerms(
  client: SalesforceClient,
  objectApiName: string,
  fieldApiName: string,
  parentIds: string[],
  signal?: AbortSignal,
): Promise<FieldPermRow[]> {
  if (!parentIds.length) return [];
  const rows = await client.queryAll<any>(
    `SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = ${soqlString(objectApiName)} AND Field = ${soqlString(`${objectApiName}.${fieldApiName}`)} AND ParentId IN (${idList(parentIds)})`,
    { ...(signal ? { signal } : {}) },
  );
  return rows.records.map((r) => ({ parentId: r.ParentId, read: !!r.PermissionsRead, edit: !!r.PermissionsEdit }));
}

export async function loadRecordAccess(client: SalesforceClient, userId: string, recordId: string, signal?: AbortSignal): Promise<RecordAccessRow | null> {
  const res = await client.query<any>(
    `SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess, HasAllAccess, MaxAccessLevel FROM UserRecordAccess WHERE UserId = ${soqlString(userId)} AND RecordId = ${soqlString(recordId)}`,
    { ...(signal ? { signal } : {}) },
  );
  const r = res.records[0];
  if (!r) return null;
  return {
    read: !!r.HasReadAccess,
    edit: !!r.HasEditAccess,
    delete: !!r.HasDeleteAccess,
    transfer: !!r.HasTransferAccess,
    all: !!r.HasAllAccess,
    maxAccessLevel: String(r.MaxAccessLevel ?? 'None'),
  };
}

export interface AccessRequest {
  user: UserOption;
  objectApiName: string;
  field?: { apiName: string; permissionable: boolean; calculated: boolean; updateable: boolean };
  recordId?: string;
}

export async function collectAccessInput(client: SalesforceClient, req: AccessRequest, signal?: AbortSignal): Promise<AccessInput> {
  const sources = await attempt(() => loadSources(client, req.user.Id, signal));
  const ids = sources.ok ? sources.value.map((s) => s.id) : [];

  const [objectPerms, systemPerms, permissionable, fieldPerms, recordAccess] = await Promise.all([
    sources.ok ? attempt(() => loadObjectPerms(client, req.objectApiName, ids, signal)) : Promise.resolve(sources as Fetched<ObjectPermRow[]>),
    sources.ok ? attempt(() => loadSystemPerms(client, ids, signal)) : Promise.resolve(sources as Fetched<SystemPermRow[]>),
    attempt(() => isObjectPermissionable(client, req.objectApiName, signal)),
    req.field && req.field.permissionable && sources.ok
      ? attempt(() => loadFieldPerms(client, req.objectApiName, req.field!.apiName, ids, signal))
      : Promise.resolve<Fetched<FieldPermRow[]>>({ ok: true, value: [] }),
    req.recordId ? attempt(() => loadRecordAccess(client, req.user.Id, req.recordId!, signal)) : Promise.resolve(undefined),
  ]);

  return {
    user: { isActive: req.user.IsActive, name: req.user.Name, ...(req.user.Profile?.Name ? { profileName: req.user.Profile.Name } : {}) },
    sources,
    objectApiName: req.objectApiName,
    objectPerms,
    ...(permissionable.ok ? { objectPermissionable: permissionable.value } : {}),
    systemPerms,
    ...(req.field ? { field: { ...req.field, perms: fieldPerms } } : {}),
    ...(req.recordId && recordAccess ? { record: { id: req.recordId, access: recordAccess } } : {}),
  };
}
