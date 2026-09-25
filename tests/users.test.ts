import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_FILTERS, MAX_OFFSET, USER_PAGE_SIZE, buildUserQueries, summarizeSystemPermissions, toAssignedSets, userWhere } from '../src/shared/salesforce/users';

describe('user list queries', () => {
  it('defaults to active users sorted by name', () => {
    const q = buildUserQueries(DEFAULT_USER_FILTERS, 0);
    expect(q.list).toContain('WHERE IsActive = true');
    expect(q.list).toContain(`ORDER BY Name ASC LIMIT ${USER_PAGE_SIZE} OFFSET 0`);
    expect(q.count).toBe('SELECT COUNT() FROM User WHERE IsActive = true');
  });

  it('combines search, status, profile, and user type filters safely', () => {
    const where = userWhere({ search: "o'brien_%", active: 'inactive', profileId: '00e000000000001AAA', userType: 'PowerPartner', sort: 'name' });
    expect(where).toBe(
      " WHERE (Name LIKE '%o\\'brien\\_\\%%' OR Username LIKE '%o\\'brien\\_\\%%' OR Email LIKE '%o\\'brien\\_\\%%') AND IsActive = false AND ProfileId = '00e000000000001AAA' AND UserType = 'PowerPartner'",
    );
    expect(userWhere({ ...DEFAULT_USER_FILTERS, active: 'all' })).toBe('');
  });

  it('pages with OFFSET and caps at the SOQL maximum', () => {
    expect(buildUserQueries(DEFAULT_USER_FILTERS, 2).offset).toBe(2 * USER_PAGE_SIZE);
    expect(buildUserQueries(DEFAULT_USER_FILTERS, 1000).offset).toBe(MAX_OFFSET);
    expect(buildUserQueries({ ...DEFAULT_USER_FILTERS, sort: 'lastLogin' }, 0).list).toContain('ORDER BY LastLoginDate DESC NULLS LAST');
  });
});

describe('assigned access', () => {
  const rows = [
    { PermissionSetId: 'PS3', PermissionSet: { Name: 'Sales_Ops', Label: 'Sales Ops', License: { Name: 'Salesforce' } } },
    { PermissionSetId: 'PS1', PermissionSet: { Name: 'X00e', Label: 'X00e', IsOwnedByProfile: true, Profile: { Name: 'System Administrator' } } },
    { PermissionSetId: 'PS2', PermissionSetGroupId: 'PSG1', PermissionSet: { Name: 'agg', Label: 'agg' }, PermissionSetGroup: { MasterLabel: 'Support Team', DeveloperName: 'Support_Team' } },
    { PermissionSetId: 'PS4', PermissionSet: { Name: 'Old', Label: 'Old' }, ExpirationDate: '2000-01-01T00:00:00.000Z' },
    { PermissionSetId: 'PS5', PermissionSet: { Name: 'Break_Glass', Label: 'Break Glass', HasActivationRequired: true } },
  ];

  it('orders profile, groups, then permission sets and drops expired assignments', () => {
    const sets = toAssignedSets(rows, Date.parse('2026-01-01'));
    expect(sets.map((s) => `${s.kind}:${s.label}`)).toEqual(['profile:System Administrator', 'group:Support Team', 'permissionSet:Break Glass', 'permissionSet:Sales Ops']);
    expect(sets.find((s) => s.label === 'Support Team')).toMatchObject({ apiName: 'Support_Team', groupId: 'PSG1' });
    expect(sets.find((s) => s.label === 'Sales Ops')?.license).toBe('Salesforce');
    expect(sets.find((s) => s.label === 'Break Glass')?.sessionActivation).toBe(true);
  });

  it('shows which assignment grants each key system permission', () => {
    const sets = toAssignedSets(rows, Date.parse('2026-01-01'));
    const perms = summarizeSystemPermissions(
      [
        { Id: 'PS1', PermissionsModifyAllData: true, PermissionsApiEnabled: true },
        { Id: 'PS5', PermissionsModifyAllData: true },
        { Id: 'PS3', PermissionsApiEnabled: false },
      ],
      sets,
    );
    expect(perms.find((p) => p.label === 'Modify All Data')?.grantedBy).toEqual(['Profile: System Administrator', 'Permission set: Break Glass (session activation)']);
    expect(perms.find((p) => p.label === 'API Enabled')?.grantedBy).toEqual(['Profile: System Administrator']);
    expect(perms.find((p) => p.label === 'Author Apex')?.grantedBy).toEqual([]);
  });
});

describe('LIKE escaping', () => {
  it('escapes quotes, backslashes, and wildcards exactly once', async () => {
    const { soqlLike } = await import('../src/shared/api/client');
    expect(soqlLike('a_b%c')).toBe("'%a\\_b\\%c%'");
    expect(soqlLike("O'Brien")).toBe("'%O\\'Brien%'");
    expect(soqlLike('back\\slash')).toBe("'%back\\\\slash%'");
  });
});
