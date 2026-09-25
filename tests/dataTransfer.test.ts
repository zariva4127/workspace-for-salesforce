import { describe, expect, it } from 'vitest';
import { autoMap, parseCsv, prepareImport, rowsToCsv } from '../src/shared/salesforce/dataTransfer';
import type { FieldInfo, ObjectDescribe } from '../src/shared/salesforce/metadata';

const field = (name: string, type = 'string', extra: Partial<FieldInfo> = {}): FieldInfo => ({
  name, label: name, type, length: 255, precision: 0, scale: 0, digits: 0, custom: false, nillable: true,
  createable: true, updateable: true, calculated: false, autoNumber: false, unique: false, externalId: false,
  defaultedOnCreate: false, nameField: name === 'Name', permissionable: true, referenceTo: [], relationshipName: null,
  polymorphic: false, cascadeDelete: false, restrictedPicklist: false, picklistValues: [], inlineHelpText: null,
  compoundFieldName: null, controllerName: null, dependentPicklist: false, htmlFormatted: false, ...extra,
});
const objectDescribe: ObjectDescribe = { name: 'Account', label: 'Account', keyPrefix: '001', custom: false, queryable: true, createable: true, updateable: true, deletable: true, childRelationships: [], recordTypeCount: 0, recordTypes: [], fields: [field('Id', 'id', { createable: false }), field('Name'), field('Employees', 'int'), field('External__c', 'string', { externalId: true })] };

describe('data import/export', () => {
  it('parses quotes, escaped quotes, CRLF, and missing cells', () => {
    expect(parseCsv('Name,Note\r\n"Acme, Inc.","said ""hi"""\r\nBeta')).toEqual({ headers: ['Name','Note'], rows: [['Acme, Inc.','said "hi"'],['Beta','']] });
  });
  it('maps headers and validates typed rows', () => {
    const table = parseCsv('Name,Employees\nAcme,12\nBad,nope');
    const mapping = autoMap(table.headers, objectDescribe.fields, 'insert');
    const prepared = prepareImport(table, objectDescribe, mapping, 'insert');
    expect(mapping).toEqual({ Name: 'Name', Employees: 'Employees' });
    expect(prepared.records[0]).toEqual({ Name: 'Acme', Employees: 12 });
    expect(prepared.issues[0]).toMatchObject({ row: 3, field: 'Employees' });
  });
  it('requires identifiers for update and upsert', () => {
    const table = parseCsv('Name\nAcme');
    expect(prepareImport(table, objectDescribe, { Name: 'Name' }, 'update').issues[0]?.field).toBe('Id');
    expect(prepareImport(table, objectDescribe, { Name: 'Name' }, 'upsert', 'External__c').issues[0]?.field).toBe('External__c');
  });
  it('generates safe CSV cells', () => {
    expect(rowsToCsv(['Name','Note'], [{ Name: 'Acme, Inc.', Note: 'a"b' }])).toBe('Name,Note\r\n"Acme, Inc.","a""b"\r\n');
  });
});
