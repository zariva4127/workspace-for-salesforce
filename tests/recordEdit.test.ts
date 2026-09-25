import { describe, expect, it } from 'vitest';
import {
  applyDependencies,
  changedPayload,
  createDraft,
  editDraft,
  formFields,
  isRequired,
  mapServerErrors,
  mergeAfterReload,
  picklistOptions,
  recordActions,
  toApiValue,
  toDraftValue,
  validForIncludes,
  validateDraft,
  validateField,
  type Draft,
} from '../src/shared/records/recordEdit';
import type { FieldInfo } from '../src/shared/salesforce/metadata';
import { httpDate } from '../src/shared/api/client';

const f = (name: string, type: string, over: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  label: name,
  type,
  length: type === 'string' ? 80 : 0,
  precision: 0,
  scale: 0,
  digits: 0,
  custom: false,
  nillable: true,
  createable: true,
  updateable: true,
  calculated: false,
  autoNumber: false,
  unique: false,
  externalId: false,
  defaultedOnCreate: false,
  nameField: false,
  permissionable: true,
  referenceTo: [],
  relationshipName: null,
  polymorphic: false,
  cascadeDelete: false,
  restrictedPicklist: false,
  picklistValues: [],
  inlineHelpText: null,
  compoundFieldName: null,
  controllerName: null,
  dependentPicklist: false,
  htmlFormatted: false,
  ...over,
});

// validFor bitmaps: bit 0 (0x80) = first controller value, bit 1 (0x40) = second.
const ONLY_FIRST = btoa(String.fromCharCode(0x80));
const ONLY_SECOND = btoa(String.fromCharCode(0x40));
const BOTH = btoa(String.fromCharCode(0xc0));

const region = f('Region__c', 'picklist', {
  picklistValues: [
    { value: 'EMEA', label: 'EMEA', active: true },
    { value: 'AMER', label: 'AMER', active: true },
  ],
});
const country = f('Country__c', 'picklist', {
  controllerName: 'Region__c',
  dependentPicklist: true,
  restrictedPicklist: true,
  picklistValues: [
    { value: 'France', label: 'France', active: true, validFor: ONLY_FIRST },
    { value: 'USA', label: 'USA', active: true, validFor: ONLY_SECOND },
    { value: 'Online', label: 'Online', active: true, validFor: BOTH },
  ],
});
const city = f('City__c', 'picklist', {
  controllerName: 'Country__c',
  dependentPicklist: true,
  picklistValues: [{ value: 'Paris', label: 'Paris', active: true, validFor: ONLY_FIRST }],
});

describe('editable fields', () => {
  it('filters by create/update permission and supported type, required first', () => {
    const fields = [
      f('Id', 'id'),
      f('Description', 'textarea'),
      f('Name', 'string', { nillable: false, nameField: true }),
      f('Formula__c', 'string', { createable: false, updateable: false, calculated: true }),
      f('CreatedOnly__c', 'string', { updateable: false }),
      f('Billing', 'address'),
    ];
    expect(formFields(fields, 'create').map((x) => x.name)).toEqual(['Name', 'CreatedOnly__c', 'Description']);
    expect(formFields(fields, 'edit').map((x) => x.name)).toEqual(['Name', 'Description']);
  });

  it('knows which fields are required', () => {
    expect(isRequired(f('Name', 'string', { nillable: false }), 'create')).toBe(true);
    expect(isRequired(f('OwnerId', 'reference', { nillable: false, defaultedOnCreate: true }), 'create')).toBe(false);
    expect(isRequired(f('OwnerId', 'reference', { nillable: false, defaultedOnCreate: true }), 'edit')).toBe(true);
    expect(isRequired(f('IsActive', 'boolean', { nillable: false }), 'create')).toBe(false);
  });
});

describe('value conversion', () => {
  it('round-trips common types', () => {
    expect(toApiValue(f('N', 'int'), '42')).toBe(42);
    expect(toApiValue(f('N', 'currency'), '1,234.50')).toBe(1234.5);
    expect(toApiValue(f('S', 'string'), '  x ')).toBe('x');
    expect(toApiValue(f('S', 'string'), '   ')).toBeNull();
    expect(toApiValue(f('B', 'boolean'), true)).toBe(true);
    expect(toApiValue(f('T', 'time'), '09:30')).toBe('09:30:00.000Z');
    expect(toDraftValue(f('B', 'boolean'), null)).toBe(false);
    expect(toDraftValue(f('N', 'double'), 3.5)).toBe('3.5');
    expect(toDraftValue(f('S', 'string'), null)).toBe('');
  });

  it('converts datetimes between UTC and local input values', () => {
    const local = toDraftValue(f('D', 'datetime'), '2026-07-29T21:31:31.000+0000') as string;
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(toApiValue(f('D', 'datetime'), local) as string).getTime()).toBe(Date.parse('2026-07-29T21:31:00Z'));
  });

  it('formats If-Unmodified-Since dates', () => {
    expect(httpDate('2026-07-29T21:31:31.000+0000')).toBe('Wed, 29 Jul 2026 21:31:31 GMT');
  });
});

describe('validation', () => {
  const ctx = (draft: Draft = {}) => ({ mode: 'create' as const, all: [region, country, city], draft, prefixes: { Account: '001', User: '005' } });

  it('checks required, length, email, and numbers', () => {
    expect(validateField(f('Name', 'string', { nillable: false, label: 'Account Name' }), ' ', ctx())).toBe('Account Name is required.');
    expect(validateField(f('S', 'string', { length: 5 }), 'abcdef', ctx())).toMatch(/5 characters/);
    expect(validateField(f('E', 'email'), 'nope', ctx())).toMatch(/email/);
    expect(validateField(f('E', 'email'), 'a@b.co', ctx())).toBeUndefined();
    expect(validateField(f('I', 'int'), '1.5', ctx())).toMatch(/whole number/);
    expect(validateField(f('C', 'currency', { precision: 5, scale: 2 }), '1234.5', ctx())).toMatch(/3 digits/);
    expect(validateField(f('C', 'currency', { precision: 5, scale: 2 }), '123.45', ctx())).toBeUndefined();
    expect(validateField(f('D', 'date'), '2026-13-45', ctx())).toMatch(/valid date/);
  });

  it('checks lookup IDs and their object type', () => {
    const owner = f('OwnerId', 'reference', { referenceTo: ['User'] });
    expect(validateField(owner, 'abc', ctx())).toMatch(/valid 15- or 18-character ID/);
    expect(validateField(owner, '001000000000001AAA', ctx())).toMatch(/isn't a User record/);
    expect(validateField(owner, '005000000000001AAA', ctx())).toBeUndefined();
  });

  it('checks restricted and dependent picklists', () => {
    expect(validateField(country, 'USA', ctx({ Region__c: 'EMEA', Country__c: 'USA' }))).toMatch(/isn't available for the selected Region__c/);
    expect(validateField(country, 'France', ctx({ Region__c: 'EMEA', Country__c: 'France' }))).toBeUndefined();
    const errors = validateDraft([region, country], { Region__c: 'AMER', Country__c: 'France' }, { mode: 'edit', all: [region, country, city] });
    expect(Object.keys(errors)).toEqual(['Country__c']);
  });
});

describe('dependent picklists', () => {
  it('decodes validFor bitmaps', () => {
    expect(validForIncludes(ONLY_FIRST, 0)).toBe(true);
    expect(validForIncludes(ONLY_FIRST, 1)).toBe(false);
    expect(validForIncludes(BOTH, 1)).toBe(true);
    expect(validForIncludes(undefined, 0)).toBe(false);
    expect(validForIncludes('!!!', 0)).toBe(false);
  });

  it('narrows options by the controlling value', () => {
    const all = [region, country, city];
    expect(picklistOptions(country, all, { Region__c: 'EMEA' }).map((o) => o.value)).toEqual(['France', 'Online']);
    expect(picklistOptions(country, all, { Region__c: 'AMER' }).map((o) => o.value)).toEqual(['USA', 'Online']);
    expect(picklistOptions(country, all, { Region__c: '' })).toEqual([]);
  });

  it('clears invalid dependent values in chains when the controller changes', () => {
    const all = [region, country, city];
    const { draft, cleared } = applyDependencies(all, { Region__c: 'AMER', Country__c: 'France', City__c: 'Paris' }, 'Region__c');
    expect(draft).toEqual({ Region__c: 'AMER', Country__c: '', City__c: '' });
    expect(cleared).toEqual(['Country__c', 'City__c']);
    expect(applyDependencies(all, { Region__c: 'AMER', Country__c: 'Online', City__c: '' }, 'Region__c').cleared).toEqual([]);
  });
});

describe('payloads and errors', () => {
  const fields = [f('Name', 'string'), f('Phone', 'phone'), f('Active__c', 'boolean'), f('Region__c', 'picklist', { picklistValues: [{ value: 'EMEA', label: 'EMEA', active: true, defaultValue: true }] })];

  it('sends only changed fields on edit, and clears emptied ones', () => {
    const original = editDraft(fields, { Name: 'Acme', Phone: '123', Active__c: false, Region__c: 'EMEA' });
    const draft = { ...original, Phone: '', Active__c: true };
    expect(changedPayload(fields, draft, original)).toEqual({ Phone: null, Active__c: true });
    expect(changedPayload(fields, { ...original, Name: ' Acme ' }, original)).toEqual({});
  });

  it('sends defaults and prefilled values on create', () => {
    const draft = createDraft(fields, { Name: 'New Co' });
    expect(draft.Region__c).toBe('EMEA');
    expect(changedPayload(fields, draft, createDraft([], {}))).toMatchObject({ Name: 'New Co', Region__c: 'EMEA' });
  });

  it('maps Salesforce errors to fields when possible', () => {
    const { fieldErrors, formErrors } = mapServerErrors(
      [
        { errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Phone must have 10 digits', fields: ['phone'] },
        { errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Close the case first', fields: [] },
        { errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Secret__c]', fields: ['Secret__c'] },
      ],
      fields,
    );
    expect(fieldErrors).toEqual({ Phone: 'Phone must have 10 digits' });
    expect(formErrors).toEqual(['Close the case first', 'Required fields are missing: [Secret__c]']);
  });

  it('merges edits over the latest version and reports conflicts', () => {
    const original: Draft = { Name: 'Acme', Phone: '1', Active__c: false, Region__c: '' };
    const latest: Draft = { Name: 'Acme Corp', Phone: '2', Active__c: false, Region__c: '' };
    const mine: Draft = { Name: 'Acme', Phone: '3', Active__c: true, Region__c: '' };
    const merged = mergeAfterReload(fields, original, latest, mine);
    expect(merged.draft).toEqual({ Name: 'Acme Corp', Phone: '3', Active__c: true, Region__c: '' });
    expect(merged.conflicts).toEqual(['Phone']);
    expect(merged.theirChanges).toEqual(['Name', 'Phone']);
  });
});

describe('record actions', () => {
  const obj = { label: 'Account', createable: true, updateable: true, deletable: true, fields: [f('Name', 'string')] };
  it('allows actions the user has permission for', () => {
    const a = recordActions(obj, { edit: true, delete: true }, { changesEnabled: true });
    expect([a.edit.allowed, a.delete.allowed, a.create.allowed]).toEqual([true, true, true]);
  });
  it('explains object-level and record-level restrictions', () => {
    const a = recordActions({ ...obj, deletable: false }, { edit: false, delete: false }, { changesEnabled: true });
    expect(a.edit).toMatchObject({ allowed: false, reason: expect.stringMatching(/shared with you/) });
    expect(a.delete.reason).toMatch(/profile or permission sets/);
    const b = recordActions({ ...obj, updateable: false }, undefined, { changesEnabled: true });
    expect(b.edit.reason).toMatch(/don't allow editing/);
    const c = recordActions({ ...obj, fields: [f('Name', 'string', { updateable: false })] }, undefined, { changesEnabled: true });
    expect(c.edit.reason).toMatch(/None of this record/);
  });
  it('lets Salesforce decide when record access is unknown', () => {
    expect(recordActions(obj, undefined, { changesEnabled: true }).delete.allowed).toBe(true);
  });
  it('turns everything off when changes are disabled', () => {
    const a = recordActions(obj, { edit: true, delete: true }, { changesEnabled: false });
    expect(a.edit.reason).toMatch(/turned off/);
    expect(a.create.allowed).toBe(false);
  });
});
