import { describe, expect, it } from 'vitest';
import { addFavorite, groupFavorites, isFavorite, removeFavorite, renameFavorite, validateLabel, type Favorite } from '../src/shared/workspace/favorites';
import { buildSosl, classifySearchInput, escapeSosl, normalizeSearchResults, DEFAULT_SEARCH_OBJECTS } from '../src/shared/salesforce/search';
import { isSystemObject, isSystemRelationship, objectLabel, rankObjects } from '../src/shared/salesforce/metadata';

describe('favorites', () => {
  it('adds, dedupes, and moves existing items to the top', () => {
    let list: Favorite[] = [];
    list = addFavorite(list, { kind: 'object', label: 'Accounts', value: 'Account' }, 1, 'a');
    list = addFavorite(list, { kind: 'query', label: 'Open cases', value: 'SELECT Id FROM Case' }, 2, 'b');
    list = addFavorite(list, { kind: 'object', label: 'Accounts', value: 'account' }, 3, 'c');
    expect(list.map((f) => f.id)).toEqual(['a', 'b']);
    expect(isFavorite(list, 'object', 'ACCOUNT')).toBe(true);
    expect(isFavorite(list, 'query', 'SELECT  Id\nFROM Case')).toBe(true);
    expect(isFavorite(list, 'record', 'Account')).toBe(false);
  });

  it('validates names', () => {
    const list = addFavorite([], { kind: 'query', label: 'Open cases', value: 'SELECT Id FROM Case' }, 1, 'a');
    expect(validateLabel(list, '  ', 'query')).toMatch(/Enter a name/);
    expect(validateLabel(list, 'open CASES', 'query')).toMatch(/already/);
    expect(validateLabel(list, 'open CASES', 'query', 'a')).toBeUndefined();
    expect(validateLabel(list, 'x'.repeat(81), 'query')).toMatch(/80/);
    expect(validateLabel(list, 'Open cases', 'object')).toBeUndefined();
  });

  it('renames, removes, and groups', () => {
    let list = addFavorite([], { kind: 'record', label: 'Acme', value: '001000000000001AAA', objectApiName: 'Account' }, 1, 'r');
    list = addFavorite(list, { kind: 'object', label: 'Case', value: 'Case' }, 2, 'o');
    list = renameFavorite(list, 'r', '  Acme Corp ');
    expect(list.find((f) => f.id === 'r')?.label).toBe('Acme Corp');
    const g = groupFavorites(list);
    expect(g.record).toHaveLength(1);
    expect(g.object).toHaveLength(1);
    expect(removeFavorite(list, 'r').map((f) => f.id)).toEqual(['o']);
  });
});

describe('record search', () => {
  it('classifies IDs, text, and invalid input', () => {
    expect(classifySearchInput('001D000000IqhSL')).toEqual({ kind: 'id', id: '001D000000IqhSLIAZ' });
    expect(classifySearchInput(' acme ')).toEqual({ kind: 'text', term: 'acme' });
    expect(classifySearchInput('a*').kind).toBe('invalid');
    expect(classifySearchInput('').kind).toBe('invalid');
  });

  it('escapes SOSL reserved characters so input cannot change the query', () => {
    expect(escapeSosl('a} RETURNING User(Id')).toBe('a\\} RETURNING User\\(Id');
    expect(escapeSosl("O'Brien & Co - x")).toBe("O\\'Brien \\& Co \\- x");
    const sosl = buildSosl('acme}', [{ name: 'Account', nameField: 'Name' }]);
    expect(sosl).toBe('FIND {acme\\}} IN ALL FIELDS RETURNING Account(Id, Name LIMIT 10)');
  });

  it('normalizes results with display names per object', () => {
    const hits = normalizeSearchResults(
      {
        searchRecords: [
          { attributes: { type: 'Case' }, Id: '500000000000001AAA', CaseNumber: '00001001', Subject: 'Broken' },
          { attributes: { type: 'Account' }, Id: '001000000000001AAA', Name: 'Acme' },
        ],
      },
      DEFAULT_SEARCH_OBJECTS,
    );
    expect(hits).toEqual([
      { id: '500000000000001AAA', objectApiName: 'Case', title: '00001001', subtitle: 'Broken' },
      { id: '001000000000001AAA', objectApiName: 'Account', title: 'Acme' },
    ]);
  });
});

describe('object ranking', () => {
  const o = (name: string, label: string) => ({ name, label, layoutable: true });
  const objects = [
    o('AccountShare', 'Account Share'),
    o('AccountFeed', '__MISSING LABEL__ PropertyFile - val AccountFeed not found'),
    o('Account', 'Account'),
    o('AccountContactRole', 'Account Contact Role'),
    o('Invoice__c', 'Invoice'),
    o('Contact', 'Contact'),
  ];

  it('hides system objects and ranks exact/prefix matches first', () => {
    expect(rankObjects(objects, 'account').map((x) => x.name)).toEqual(['Account', 'AccountContactRole']);
    expect(rankObjects(objects, '').map((x) => x.name)).toEqual(['Account', 'AccountContactRole', 'Contact', 'Invoice__c']);
  });

  it('shows system objects on request or on exact API name', () => {
    expect(rankObjects(objects, 'accountshare').map((x) => x.name)).toEqual(['AccountShare']);
    expect(rankObjects(objects, 'account', { includeSystem: true }).map((x) => x.name)).toContain('AccountFeed');
  });

  it('replaces missing labels and recognizes system relationships', () => {
    expect(objectLabel(objects[1]!)).toBe('AccountFeed');
    expect(isSystemObject(objects[0]!)).toBe(true);
    expect(isSystemObject(objects[4]!)).toBe(false);
    expect(isSystemRelationship('AccountHistory')).toBe(true);
    expect(isSystemRelationship('Contact')).toBe(false);
  });
});

describe('field value formatting', () => {
  it('formats by type and leaves text alone', async () => {
    const { formatFieldValue } = await import('../src/shared/salesforce/records');
    expect(formatFieldValue(true, 'boolean')).toBe('Yes');
    expect(formatFieldValue(false, 'boolean')).toBe('No');
    expect(formatFieldValue(null, 'string')).toBe('');
    expect(formatFieldValue('2026-07-29', 'date', 'en-US')).toBe('Jul 29, 2026');
    expect(formatFieldValue('2026-07-29T21:31:31.000+0000', 'datetime', 'en-US')).toMatch(/2026/);
    expect(formatFieldValue('not a date', 'datetime')).toBe('not a date');
    expect(formatFieldValue(1234567.5, 'currency', 'en-US')).toBe('1,234,567.5');
    expect(formatFieldValue(12.5, 'percent', 'en-US')).toBe('12.5%');
    expect(formatFieldValue('Acme', 'string')).toBe('Acme');
  });
});
