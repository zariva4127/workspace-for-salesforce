import { describe, expect, it } from 'vitest';
import { interpretAccess, type AccessInput, type PermissionSource } from '../src/shared/access/interpret';

const profile: PermissionSource = { id: 'PS_PROFILE', label: 'Profile: Standard User', kind: 'profile' };
const permset: PermissionSource = { id: 'PS_SALES', label: 'Permission set: Sales Ops', kind: 'permissionSet' };
const session: PermissionSource = { id: 'PS_SESSION', label: 'Permission set: Break Glass', kind: 'session', requiresActivation: true };

const objRow = (parentId: string, over: Partial<Record<'read' | 'create' | 'edit' | 'delete' | 'viewAll' | 'modifyAll', boolean>> = {}) => ({
  parentId,
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
  ...over,
});

function base(over: Partial<AccessInput> = {}): AccessInput {
  return {
    user: { isActive: true, name: 'Jane' },
    sources: { ok: true, value: [profile, permset] },
    objectApiName: 'Account',
    objectPerms: { ok: true, value: [] },
    objectPermissionable: true,
    systemPerms: { ok: true, value: [] },
    ...over,
  };
}

describe('interpretAccess', () => {
  it('confirms object read and names the granting permission set', () => {
    const r = interpretAccess(base({ objectPerms: { ok: true, value: [objRow('PS_SALES', { read: true })] } }));
    expect(r.object.read).toMatchObject({ status: 'granted', confidence: 'confirmed' });
    expect(r.object.read.grantedBy).toEqual(['Permission set: Sales Ops']);
    expect(r.object.edit).toMatchObject({ status: 'denied', confidence: 'confirmed' });
  });

  it('does not treat field access as proof of record access', () => {
    const r = interpretAccess(
      base({
        objectPerms: { ok: true, value: [objRow('PS_PROFILE', { read: true, edit: true })] },
        field: { apiName: 'Industry', permissionable: true, calculated: false, updateable: true, perms: { ok: true, value: [{ parentId: 'PS_PROFILE', read: true, edit: true }] } },
      }),
    );
    expect(r.field?.read).toMatchObject({ status: 'granted', confidence: 'confirmed' });
    expect(r.record.read.status).toBe('notEvaluated');
    expect(r.record.read.reason).toMatch(/sharing/i);
    expect(r.notes.join(' ')).toMatch(/does not grant access to any record/);
    expect(r.summary).toMatch(/record-level access was not checked/);
  });

  it('confirms record access only from UserRecordAccess', () => {
    const r = interpretAccess(
      base({
        objectPerms: { ok: true, value: [objRow('PS_PROFILE', { read: true })] },
        record: { id: '001', access: { ok: true, value: { read: true, edit: false, delete: false, transfer: false, all: false, maxAccessLevel: 'Read' } } },
      }),
    );
    expect(r.record.read).toMatchObject({ status: 'granted', confidence: 'confirmed' });
    expect(r.record.edit).toMatchObject({ status: 'denied', confidence: 'confirmed' });
  });

  it('flags sharing without object permission as not effective', () => {
    const r = interpretAccess(
      base({
        objectPerms: { ok: true, value: [objRow('PS_PROFILE', { read: true })] },
        record: { id: '001', access: { ok: true, value: { read: true, edit: true, delete: false, transfer: false, all: false, maxAccessLevel: 'Edit' } } },
      }),
    );
    expect(r.record.edit).toMatchObject({ status: 'denied', confidence: 'likely' });
  });

  it('reports unknown (never denied) when queries fail', () => {
    const r = interpretAccess(
      base({
        objectPerms: { ok: false, error: 'Insufficient permissions' },
        field: { apiName: 'Industry', permissionable: true, calculated: false, updateable: true, perms: { ok: false, error: 'Insufficient permissions' } },
        record: { id: '001', access: { ok: false, error: 'Insufficient permissions' } },
      }),
    );
    expect(r.object.read.status).toBe('unknown');
    expect(r.field?.read.status).toBe('unknown');
    expect(r.record.read.status).toBe('unknown');
  });

  it('reports unknown when assignments cannot be read', () => {
    const r = interpretAccess(base({ sources: { ok: false, error: 'nope' }, objectPerms: { ok: true, value: [] } }));
    expect(r.object.read.status).toBe('unknown');
    expect(r.notes.join(' ')).toMatch(/Could not read permission set assignments/);
  });

  it('treats View All Data as a confirmed read grant', () => {
    const r = interpretAccess(base({ systemPerms: { ok: true, value: [{ parentId: 'PS_PROFILE', viewAllData: true, modifyAllData: false }] } }));
    expect(r.object.read).toMatchObject({ status: 'granted', confidence: 'confirmed' });
    expect(r.object.edit.status).toBe('denied');
  });

  it('marks grants from session-based permission sets as only likely', () => {
    const r = interpretAccess(
      base({ sources: { ok: true, value: [profile, session] }, objectPerms: { ok: true, value: [objRow('PS_SESSION', { read: true })] } }),
    );
    expect(r.object.read).toMatchObject({ status: 'granted', confidence: 'likely' });
    expect(r.object.read.grantedBy[0]).toMatch(/session activation required/);
  });

  it('is uncertain for objects not governed by object permissions', () => {
    const r = interpretAccess(base({ objectApiName: 'Task', objectPermissionable: false }));
    expect(r.object.read).toMatchObject({ status: 'unknown', confidence: 'uncertain' });
  });

  it('handles non-permissionable and formula fields', () => {
    const r = interpretAccess(
      base({
        objectPerms: { ok: true, value: [objRow('PS_PROFILE', { read: true })] },
        field: { apiName: 'Name', permissionable: false, calculated: false, updateable: true, perms: { ok: true, value: [] } },
      }),
    );
    expect(r.field?.read).toMatchObject({ status: 'granted', confidence: 'likely' });

    const formula = interpretAccess(
      base({
        objectPerms: { ok: true, value: [objRow('PS_PROFILE', { read: true, edit: true })] },
        field: { apiName: 'Score__c', permissionable: true, calculated: true, updateable: false, perms: { ok: true, value: [{ parentId: 'PS_PROFILE', read: true, edit: false }] } },
      }),
    );
    expect(formula.field?.edit.status).toBe('notApplicable');
  });

  it('denies field access when the object is not readable', () => {
    const r = interpretAccess(
      base({
        field: { apiName: 'Industry', permissionable: true, calculated: false, updateable: true, perms: { ok: true, value: [{ parentId: 'PS_PROFILE', read: true, edit: true }] } },
      }),
    );
    expect(r.object.read.status).toBe('denied');
    expect(r.field?.read.status).toBe('denied');
  });

  it('notes inactive users', () => {
    const r = interpretAccess(base({ user: { isActive: false, name: 'Old' } }));
    expect(r.notes[0]).toMatch(/inactive/);
  });
});
