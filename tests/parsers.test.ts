import { describe, expect, it } from 'vitest';
import { limitsNearMax, parseDebugLog } from '../src/shared/parsers/debugLog';
import { buildSelectQuery, flattenRecords, toCsv, validateSoql } from '../src/shared/parsers/soql';
import { checkMapping, suggestMapping, unmappedRequired, worstSeverity, type MappingField } from '../src/shared/mapping/fieldMapping';
import { redact, sanitizeUrl } from '../src/shared/security/redact';
import { toHtml, toMarkdown, type TestSession } from '../src/shared/testing/formSession';

const LOG = `62.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;DB,INFO
12:00:00.001 (1000000)|EXECUTION_STARTED
12:00:00.002 (2000000)|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event BeforeUpdate
12:00:00.003 (3000000)|SOQL_EXECUTE_BEGIN|[5]|Aggregations:0|SELECT Id FROM Contact WHERE AccountId = :tmpVar1
12:00:00.004 (4000000)|SOQL_EXECUTE_END|[5]|Rows:3
12:00:00.005 (5000000)|USER_DEBUG|[7]|DEBUG|first line
second line of debug
12:00:00.006 (6000000)|DML_BEGIN|[9]|Op:Update|Type:Contact|Rows:3
12:00:00.007 (7000000)|EXCEPTION_THROWN|[12]|System.NullPointerException: Attempt to de-reference a null object
12:00:00.008 (8000000)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object
12:00:00.009 (9000000)|LIMIT_USAGE_FOR_NS|(default)|
  Number of SOQL queries: 95 out of 100
  Number of DML statements: 1 out of 150
  Maximum CPU time: 120 out of 10000
12:00:00.010 (1010000000)|EXECUTION_FINISHED`;

describe('parseDebugLog', () => {
  const s = parseDebugLog(LOG);
  it('reads the header and events', () => {
    expect(s.apiVersion).toBe('62.0');
    expect(s.logLevels).toMatch(/APEX_CODE,FINEST/);
    expect(s.events[0]!.type).toBe('EXECUTION_STARTED');
  });
  it('joins multi-line events', () => {
    expect(s.debugStatements[0]!.detail).toContain('second line of debug');
    expect(s.debugStatements[0]!.line).toBe(7);
  });
  it('summarizes SOQL, DML, errors, and limits', () => {
    expect(s.soql[0]).toMatchObject({ query: 'SELECT Id FROM Contact WHERE AccountId = :tmpVar1', rows: 3, line: 5 });
    expect(s.dml[0]).toMatchObject({ operation: 'Update', objectType: 'Contact', rows: 3 });
    expect(s.errors.map((e) => e.type)).toEqual(['EXCEPTION_THROWN', 'FATAL_ERROR']);
    expect(s.limits.find((l) => l.name === 'Number of SOQL queries')).toMatchObject({ used: 95, max: 100 });
    expect(s.limits.find((l) => l.name === 'CPU time')).toMatchObject({ used: 120, max: 10000 });
    expect(limitsNearMax(s.limits).map((l) => l.name)).toEqual(['Number of SOQL queries']);
    expect(s.codeUnits[0]).toMatch(/AccountTrigger/);
    expect(s.durationMs).toBe(1009);
    expect(s.truncated).toBe(false);
  });
  it('detects truncated logs', () => {
    expect(parseDebugLog(`${LOG}\n*** Skipped 12345 bytes of detailed log`).truncated).toBe(true);
  });
});

describe('SOQL helpers', () => {
  it('builds a safe SELECT query from described object and field API names', () => {
    expect(buildSelectQuery('Opportunity', ['Id', 'Name', 'Id'], 250)).toBe('SELECT Id, Name FROM Opportunity LIMIT 250');
    expect(buildSelectQuery('Account', ['Id'], 100_000)).toBe('SELECT Id FROM Account LIMIT 50000');
    expect(() => buildSelectQuery('Account WHERE Id != null', ['Id'])).toThrow();
    expect(() => buildSelectQuery('Account', [])).toThrow();
  });
  it('accepts SELECT queries and detects the object and LIMIT', () => {
    expect(validateSoql('SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account')).toMatchObject({ ok: true, objectName: 'Account', hasLimit: false });
    expect(validateSoql('select Id from Contact limit 10')).toMatchObject({ ok: true, hasLimit: true });
  });
  it('rejects non-SELECT statements and multiple statements', () => {
    expect(validateSoql('DELETE FROM Account').ok).toBe(false);
    expect(validateSoql("UPDATE Account SET Name = 'x'").ok).toBe(false);
    expect(validateSoql('SELECT Id FROM Account; SELECT Id FROM Contact').ok).toBe(false);
    expect(validateSoql("SELECT Id FROM Account WHERE Name = 'a;b'").ok).toBe(true);
    expect(validateSoql('').ok).toBe(false);
  });
  it('flattens relationships and child queries', () => {
    const { columns, rows } = flattenRecords([
      { attributes: { type: 'Contact' }, Id: '1', Account: { attributes: { type: 'Account' }, Name: 'Acme', Owner: { attributes: {}, Name: 'Jo' } } },
      { attributes: { type: 'Contact' }, Id: '2', Account: null, Cases: { totalSize: 2, done: true, records: [{}, {}] } },
    ]);
    expect(columns).toEqual(['Id', 'Account.Name', 'Account.Owner.Name', 'Account', 'Cases']);
    expect(rows[0]!['Account.Owner.Name']).toBe('Jo');
    expect(rows[1]!.Cases).toBe('[2 child records]');
  });
  it('escapes CSV and neutralizes formulas', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'x,"y"', b: '=HYPERLINK("http://evil")' }]);
    expect(csv).toBe('a,b\r\n"x,""y""","\'=HYPERLINK(""http://evil"")"');
  });
});

const field = (over: Partial<MappingField>): MappingField => ({
  name: 'F',
  type: 'string',
  length: 255,
  precision: 0,
  scale: 0,
  digits: 0,
  referenceTo: [],
  picklistValues: [],
  restrictedPicklist: false,
  createable: true,
  updateable: true,
  calculated: false,
  autoNumber: false,
  nillable: true,
  defaultedOnCreate: false,
  ...over,
});

describe('field mapping', () => {
  it('passes identical types', () => {
    expect(checkMapping(field({}), field({}))).toEqual([]);
  });
  it('flags text truncation', () => {
    const issues = checkMapping(field({ length: 255 }), field({ name: 'Short', length: 80 }));
    expect(worstSeverity(issues)).toBe('warning');
  });
  it('flags missing restricted picklist values as errors', () => {
    const src = field({ type: 'picklist', picklistValues: [{ value: 'A', label: 'A', active: true }, { value: 'B', label: 'B', active: true }] });
    const tgt = field({ type: 'picklist', restrictedPicklist: true, picklistValues: [{ value: 'A', label: 'A', active: true }] });
    const issues = checkMapping(src, tgt);
    expect(worstSeverity(issues)).toBe('error');
    expect(issues[0]!.message).toMatch(/B/);
  });
  it('flags lookups to different objects', () => {
    expect(worstSeverity(checkMapping(field({ type: 'reference', referenceTo: ['Contact'] }), field({ type: 'reference', referenceTo: ['Account'] })))).toBe('error');
    expect(checkMapping(field({ type: 'reference', referenceTo: ['Account'] }), field({ type: 'reference', referenceTo: ['Account'] }))).toEqual([]);
  });
  it('flags incompatible and read-only targets', () => {
    expect(worstSeverity(checkMapping(field({ type: 'date' }), field({ type: 'boolean' })))).toBe('error');
    expect(worstSeverity(checkMapping(field({}), field({ calculated: true })))).toBe('error');
    expect(worstSeverity(checkMapping(field({ type: 'double', precision: 18, scale: 4 }), field({ type: 'double', precision: 10, scale: 2 })))).toBe('warning');
  });
  it('finds unmapped required fields and suggests matches', () => {
    const targets = [field({ name: 'Name', nillable: false }), field({ name: 'Tier__c' }), field({ name: 'IsActive__c', type: 'boolean', nillable: false })];
    expect(unmappedRequired(targets, new Set(['Tier__c']))).toEqual(['Name']);
    expect([...suggestMapping([field({ name: 'tier__c' }), field({ name: 'Nope' })], targets)]).toEqual([['tier__c', 'Tier__c']]);
  });
});

describe('redaction', () => {
  it('removes session IDs, bearer tokens, and token parameters', () => {
    const text = 'sid=00D5g000004ABCD!AQ4AQFq1234567890abcdefghijklmnop Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 {"access_token":"secret-value"}';
    const out = redact(text);
    expect(out).not.toMatch(/AQ4AQFq/);
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123/);
    expect(out).not.toMatch(/secret-value/);
  });
  it('optionally redacts emails', () => {
    expect(redact('mail jane@acme.com', { emails: true })).toBe('mail [REDACTED_EMAIL]');
    expect(redact('mail jane@acme.com')).toBe('mail jane@acme.com');
  });
  it('strips unsafe query parameters and fragments from URLs', () => {
    expect(sanitizeUrl('https://acme.lightning.force.com/lightning/r/Account/001/view?sid=abc&tab=detail#access_token=x')).toBe(
      'https://acme.lightning.force.com/lightning/r/Account/001/view?tab=detail',
    );
  });
});

describe('bug report export', () => {
  const session: TestSession = {
    id: 's1',
    title: 'Create invoice <script>',
    description: 'Token 00D5g000004ABCD!AQ4AQFq1234567890abcdefghijklmnop pasted by mistake',
    orgLabel: 'ACME UAT',
    environment: 'Sandbox',
    tester: 'jane@acme.com',
    createdAt: 0,
    updatedAt: 0,
    steps: [
      { id: 'a', action: 'Click Save', expected: 'Saved', actual: 'Error shown', status: 'fail', notes: '', pageUrl: 'https://acme.lightning.force.com/lightning/o/Invoice__c/new?sid=secret', screenshotIds: ['shot1'], createdAt: 0 },
    ],
  };
  const opts = { redactEmails: true, includeUrls: true, includeScreenshots: true };

  it('produces markdown with the result and no secrets', () => {
    const md = toMarkdown(session, opts);
    expect(md).toMatch(/Result:\*\* Failed/);
    expect(md).not.toMatch(/AQ4AQFq/);
    expect(md).not.toMatch(/jane@acme\.com/);
    expect(md).not.toMatch(/sid=secret/);
  });

  it('escapes HTML and embeds only image data URLs', () => {
    const shots = new Map([['shot1', { id: 'shot1', dataUrl: 'data:image/png;base64,AAAA', caption: 'Error <b>', capturedAt: 0 }]]);
    const html = toHtml(session, shots, opts);
    expect(html).toContain('Create invoice &lt;script&gt;');
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).not.toMatch(/AQ4AQFq/);
    const evil = toHtml(session, new Map([['shot1', { id: 'shot1', dataUrl: 'javascript:alert(1)', caption: '', capturedAt: 0 }]]), opts);
    expect(evil).not.toContain('javascript:');
  });
});
