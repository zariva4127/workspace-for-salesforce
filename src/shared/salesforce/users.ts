/**
 * Users and their assigned access (profile, permission sets, permission set
 * groups, permission set licenses, public groups/queues).
 *
 * Everything here describes ASSIGNED access. It is not a user's full effective
 * access: sharing, role hierarchy, muting nuances, session activation, and
 * record ownership all affect what a user can actually do. The access explainer
 * evaluates specific object/field/record questions.
 */
import { soqlLike, soqlString, type SalesforceClient } from '../api/client';
import { explainError } from '../api/errors';

export const USER_PAGE_SIZE = 25;
/** SOQL OFFSET can't exceed 2,000 rows. */
export const MAX_OFFSET = 2000;

export type SortKey = 'name' | 'lastLogin' | 'created';

export interface UserFilters {
  search: string;
  active: 'active' | 'inactive' | 'all';
  profileId: string;
  userType: string;
  sort: SortKey;
}

export const DEFAULT_USER_FILTERS: UserFilters = { search: '', active: 'active', profileId: '', userType: '', sort: 'name' };

export const USER_TYPE_LABELS: Record<string, string> = {
  Standard: 'Standard (internal)',
  PowerPartner: 'Partner',
  PowerCustomerSuccess: 'Customer (Customer Community Plus)',
  CustomerSuccess: 'Customer portal',
  CspLitePortal: 'Customer (Customer Community)',
  CsnOnly: 'Chatter Free',
  Guest: 'Guest',
  AutomatedProcess: 'Automated process',
  LicenseManager: 'License manager',
  SelfService: 'Self-service',
};

export function userWhere(f: UserFilters): string {
  const parts: string[] = [];
  const t = f.search.trim();
  if (t) {
    const like = soqlLike(t);
    parts.push(`(Name LIKE ${like} OR Username LIKE ${like} OR Email LIKE ${like})`);
  }
  if (f.active === 'active') parts.push('IsActive = true');
  if (f.active === 'inactive') parts.push('IsActive = false');
  if (f.profileId) parts.push(`ProfileId = ${soqlString(f.profileId)}`);
  if (f.userType) parts.push(`UserType = ${soqlString(f.userType)}`);
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

const ORDER: Record<SortKey, string> = { name: 'Name ASC', lastLogin: 'LastLoginDate DESC NULLS LAST, Name ASC', created: 'CreatedDate DESC' };

export function buildUserQueries(f: UserFilters, page: number): { list: string; count: string; offset: number } {
  const offset = Math.min(Math.max(0, page) * USER_PAGE_SIZE, MAX_OFFSET);
  const where = userWhere(f);
  return {
    list: `SELECT Id, Name, Username, Email, IsActive, UserType, Title, Profile.Name, UserRole.Name, LastLoginDate FROM User${where} ORDER BY ${ORDER[f.sort]} LIMIT ${USER_PAGE_SIZE} OFFSET ${offset}`,
    count: `SELECT COUNT() FROM User${where}`,
    offset,
  };
}

export interface UserRow {
  Id: string;
  Name: string;
  Username: string;
  Email: string;
  IsActive: boolean;
  UserType: string;
  Title?: string | null;
  Profile?: { Name: string } | null;
  UserRole?: { Name: string } | null;
  LastLoginDate?: string | null;
}

export async function listUsers(client: SalesforceClient, f: UserFilters, page: number, signal?: AbortSignal): Promise<{ rows: UserRow[]; total: number; offset: number }> {
  const q = buildUserQueries(f, page);
  const opt = signal ? { signal } : {};
  const [list, count] = await Promise.all([client.query<UserRow>(q.list, opt), client.query(q.count, opt)]);
  return { rows: list.records, total: count.totalSize, offset: q.offset };
}

export async function listProfiles(client: SalesforceClient, signal?: AbortSignal): Promise<Array<{ Id: string; Name: string }>> {
  return (await client.queryAll<{ Id: string; Name: string }>('SELECT Id, Name FROM Profile ORDER BY Name', { ...(signal ? { signal } : {}), maxRecords: 1000 })).records;
}

// ---- User detail ---------------------------------------------------------------

/** A query that may fail independently (e.g. without "View Setup and Configuration"). */
export type Part<T> = { ok: true; value: T } | { ok: false; error: string };

async function part<T>(fn: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const ex = explainError(e);
    if (ex.kind === 'cancelled') throw e;
    return { ok: false, error: ex.kind === 'permission' || ex.kind === 'query' ? `${ex.detail} This usually requires "View Setup and Configuration" or "View All Users".` : `${ex.title}: ${ex.detail}` };
  }
}

export interface UserDetail {
  Id: string;
  Name: string;
  Username: string;
  Email: string;
  IsActive: boolean;
  UserType: string;
  Title?: string | null;
  Department?: string | null;
  CompanyName?: string | null;
  Phone?: string | null;
  MobilePhone?: string | null;
  FederationIdentifier?: string | null;
  TimeZoneSidKey?: string;
  LocaleSidKey?: string;
  LanguageLocaleKey?: string;
  LastLoginDate?: string | null;
  CreatedDate?: string;
  ProfileId?: string;
  Profile?: { Name: string; UserLicense?: { Name: string } | null } | null;
  UserRoleId?: string | null;
  UserRole?: { Name: string } | null;
  ManagerId?: string | null;
  Manager?: { Name: string } | null;
}

export interface AssignedSet {
  permissionSetId: string;
  label: string;
  apiName: string;
  kind: 'profile' | 'permissionSet' | 'group';
  groupId?: string;
  license?: string;
  expires?: string;
  sessionActivation?: boolean;
}

export interface GroupMembership {
  id: string;
  name: string;
  type: string;
}

export const KEY_SYSTEM_PERMISSIONS: Array<[string, string]> = [
  ['PermissionsModifyAllData', 'Modify All Data'],
  ['PermissionsViewAllData', 'View All Data'],
  ['PermissionsViewSetup', 'View Setup and Configuration'],
  ['PermissionsManageUsers', 'Manage Users'],
  ['PermissionsCustomizeApplication', 'Customize Application'],
  ['PermissionsAuthorApex', 'Author Apex'],
  ['PermissionsApiEnabled', 'API Enabled'],
  ['PermissionsViewAllUsers', 'View All Users'],
];

export interface SystemPermission {
  field: string;
  label: string;
  /** Labels of the assignments that grant it. */
  grantedBy: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Which key system permissions are granted, and by which assignment. Pure. */
export function summarizeSystemPermissions(rows: any[], sets: AssignedSet[]): SystemPermission[] {
  const byId = new Map(sets.map((s) => [s.permissionSetId, s]));
  return KEY_SYSTEM_PERMISSIONS.map(([field, label]) => ({
    field,
    label,
    grantedBy: rows
      .filter((r) => r[field] === true)
      .map((r) => {
        const s = byId.get(r.Id);
        return s ? `${s.kind === 'profile' ? 'Profile' : s.kind === 'group' ? 'Group' : 'Permission set'}: ${s.label}${s.sessionActivation ? ' (session activation)' : ''}` : r.Id;
      }),
  }));
}

export function toAssignedSets(rows: any[], now = Date.now()): AssignedSet[] {
  return rows
    .filter((r) => !r.ExpirationDate || Date.parse(r.ExpirationDate) > now)
    .map((r): AssignedSet => {
      const ps = r.PermissionSet ?? {};
      const kind: AssignedSet['kind'] = ps.IsOwnedByProfile ? 'profile' : r.PermissionSetGroupId ? 'group' : 'permissionSet';
      return {
        permissionSetId: r.PermissionSetId,
        label: kind === 'profile' ? (ps.Profile?.Name ?? ps.Label) : kind === 'group' ? (r.PermissionSetGroup?.MasterLabel ?? ps.Label) : ps.Label,
        apiName: kind === 'group' ? (r.PermissionSetGroup?.DeveloperName ?? ps.Name) : ps.Name,
        kind,
        ...(r.PermissionSetGroupId ? { groupId: r.PermissionSetGroupId } : {}),
        ...(ps.License?.Name ? { license: ps.License.Name } : {}),
        ...(r.ExpirationDate ? { expires: r.ExpirationDate } : {}),
        ...(ps.HasActivationRequired ? { sessionActivation: true } : {}),
      };
    })
    .sort((a, b) => ['profile', 'group', 'permissionSet'].indexOf(a.kind) - ['profile', 'group', 'permissionSet'].indexOf(b.kind) || a.label.localeCompare(b.label));
}

async function withFallback<T>(client: SalesforceClient, queries: string[], signal?: AbortSignal): Promise<T[]> {
  let last: unknown;
  for (const q of queries) {
    try {
      return (await client.queryAll<T>(q, { ...(signal ? { signal } : {}), maxRecords: 2000 })).records;
    } catch (e) {
      last = e;
      if (explainError(e).kind !== 'query') throw e;
    }
  }
  throw last;
}

export async function loadUserDetail(client: SalesforceClient, userId: string, signal?: AbortSignal) {
  const id = soqlString(userId);
  const user = await withFallback<UserDetail>(
    client,
    [
      `SELECT Id, Name, Username, Email, IsActive, UserType, Title, Department, CompanyName, Phone, MobilePhone, FederationIdentifier, TimeZoneSidKey, LocaleSidKey, LanguageLocaleKey, LastLoginDate, CreatedDate, ProfileId, Profile.Name, Profile.UserLicense.Name, UserRoleId, UserRole.Name, ManagerId, Manager.Name FROM User WHERE Id = ${id}`,
      `SELECT Id, Name, Username, Email, IsActive, UserType, Title, LastLoginDate, CreatedDate, ProfileId, Profile.Name, UserRoleId, UserRole.Name FROM User WHERE Id = ${id}`,
    ],
    signal,
  ).then((r) => r[0]);

  const assigned = await part(async () =>
    toAssignedSets(
      await withFallback<any>(
        client,
        [
          `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSet.License.Name, PermissionSet.HasActivationRequired, PermissionSetGroupId, PermissionSetGroup.MasterLabel, PermissionSetGroup.DeveloperName, ExpirationDate FROM PermissionSetAssignment WHERE AssigneeId = ${id}`,
          `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSetGroupId, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment WHERE AssigneeId = ${id}`,
        ],
        signal,
      ),
    ),
  );

  const [licenses, groups, system] = await Promise.all([
    part(async () =>
      (await client.queryAll<any>(`SELECT PermissionSetLicense.MasterLabel FROM PermissionSetLicenseAssign WHERE AssigneeId = ${id}`, { ...(signal ? { signal } : {}) })).records.map(
        (r) => String(r.PermissionSetLicense?.MasterLabel ?? ''),
      ),
    ),
    part(async () =>
      (await client.queryAll<any>(`SELECT GroupId, Group.Name, Group.DeveloperName, Group.Type FROM GroupMember WHERE UserOrGroupId = ${id}`, { ...(signal ? { signal } : {}) })).records
        .map((r): GroupMembership => ({ id: r.GroupId, name: r.Group?.Name || r.Group?.DeveloperName || r.GroupId, type: r.Group?.Type ?? 'Group' }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    ),
    assigned.ok && assigned.value.length
      ? part(async () =>
          summarizeSystemPermissions(
            (
              await client.queryAll<any>(
                `SELECT Id, ${KEY_SYSTEM_PERMISSIONS.map(([f]) => f).join(', ')} FROM PermissionSet WHERE Id IN (${assigned.value.map((s) => soqlString(s.permissionSetId)).join(',')})`,
                { ...(signal ? { signal } : {}) },
              )
            ).records,
            assigned.value,
          ),
        )
      : Promise.resolve<Part<SystemPermission[]>>(assigned.ok ? { ok: true, value: [] } : assigned),
  ]);
  return { user, assigned, licenses, groups, system };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
